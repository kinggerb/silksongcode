/* ============================================================================
 * wasm-module.mjs — just enough WebAssembly binary parsing for this pipeline
 * ----------------------------------------------------------------------------
 * Three jobs:
 *
 *  1. **Check the game data.** `validate()` walks the module structure and
 *     reports the version, the section list and how many functions the code
 *     section really holds, so a truncated or HTML-error-page download is
 *     caught in seconds instead of inside Unity.
 *
 *  2. **Apply documented byte patches.** Some of the memory work has to happen
 *     inside the build (for example the Hollow Knight port forces
 *     `GameManager.IsUnloadAssetsRequired` to `true` so every room transition
 *     runs `Resources.UnloadUnusedAssets`). A patch is `{offset, expect,
 *     replace}`: it is applied only when the bytes at that offset still match
 *     `expect`, so a patch written for one build can never silently corrupt
 *     another.
 *
 *  3. **Find those patches in a new build.** `scanBooleanReturns()` lists
 *     functions whose body ends in `local.get N; end` (a function returning a
 *     local — exactly the shape of a `bool IsSomethingRequired()` compiled to
 *     wasm) and that compare floating-point constants, which is what the
 *     desktop-limit checks look like. The list is a *shortlist to confirm by
 *     hand*, and BUILD.md explains how.
 * ==========================================================================*/

export const SECTION_NAMES = {
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'datacount',
};

export function readU32LEB(buf, p) {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[p + i];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result >>> 0, next: p + i + 1 };
    shift += 7;
  }
  throw new Error('malformed LEB128 at ' + p);
}

export function writeU32LEB(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/**
 * Encode `value` as an unsigned LEB128 padded to exactly `length` bytes.
 * The wasm spec accepts overlong (zero-padded) LEBs, so a smaller value can
 * be written over a wider field without moving a single other offset in the
 * module — 16,384 pages is `80 80 01`, and 8,192 pages in the same three
 * bytes is `80 c0 00`. Same-length patching depends on this.
 */
export function writeU32LEBFixed(value, length) {
  let v = value >>> 0;
  if (!Number.isSafeInteger(length) || length < 1 || length > 5) {
    throw new Error('a fixed-width LEB128 must be 1–5 bytes');
  }
  const out = [];
  for (let i = 0; i < length; i++) {
    let b = v & 0x7f;
    v >>>= 7;
    if (i < length - 1) b |= 0x80;
    out.push(b);
  }
  if (v) throw new Error(value + ' does not fit in a ' + length + '-byte LEB128');
  return Buffer.from(out);
}

function readString(buf, p) {
  const len = readU32LEB(buf, p);
  return { value: buf.subarray(len.next, len.next + len.value).toString('utf8'), next: len.next + len.value };
}

/** Structural walk of a wasm module. Throws when the module is malformed. */
export function inspect(buf) {
  if (buf.length < 8) throw new Error('wasm file is too short (' + buf.length + ' bytes)');
  if (buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
    throw new Error('not a wasm module (magic is ' + buf.subarray(0, 4).toString('hex') + ')');
  }
  const version = buf.readUInt32LE(4);
  if (version !== 1) throw new Error('unsupported wasm version ' + version);

  const sections = [];
  const functions = [];
  const exports = [];
  let p = 8;
  while (p < buf.length) {
    const id = buf[p++];
    const size = readU32LEB(buf, p);
    const start = size.next;
    const end = start + size.value;
    if (end > buf.length) throw new Error('section ' + (SECTION_NAMES[id] || id) + ' runs past the end of the file');
    sections.push({ id, name: SECTION_NAMES[id] || String(id), start, end, size: size.value });

    if (id === 10) {
      // code section: vector of functions, each a size-prefixed body
      let q = start;
      const count = readU32LEB(buf, q);
      q = count.next;
      for (let i = 0; i < count.value; i++) {
        const bodySize = readU32LEB(buf, q);
        const bodyStart = bodySize.next;
        functions.push({ index: i, start: bodyStart, end: bodyStart + bodySize.value });
        q = bodyStart + bodySize.value;
      }
    } else if (id === 7) {
      // export section: name + kind + index - used to find `main`/`_start`
      let q = start;
      const count = readU32LEB(buf, q);
      q = count.next;
      for (let i = 0; i < count.value; i++) {
        const name = readString(buf, q);
        const kind = buf[name.next];
        const index = readU32LEB(buf, name.next + 1);
        exports.push({ name: name.value, kind, index: index.value });
        q = index.next;
      }
    }
    p = end;
  }
  return { version, sections, functions, exports, size: buf.length };
}

/**
 * The declared linear-memory limits: `initial` pages are backed the moment
 * the module is instantiated, `maximum` bounds `memory.grow`. A Unity
 * desktop-profile build can declare thousands of initial MiB (the pinned
 * community binary declares 32,768 pages = exactly 2,048 MiB), which on
 * iPadOS is most of a Safari tab's whole memory budget before a single
 * game asset has loaded. These offsets are the *structural* way to find
 * the field — no patched build should ever be trusted to a bare offset
 * without this parse agreeing with it.
 */
export function parseMemoryLimits(buf) {
  const info = inspect(buf);
  const section = info.sections.find((s) => s.id === 5);
  if (!section) return [];
  const out = [];
  let q = section.start;
  const count = readU32LEB(buf, q);
  q = count.next;
  for (let i = 0; i < count.value; i++) {
    const flagsAt = q;
    const flags = readU32LEB(buf, q);
    q = flags.next;
    const is64 = (flags.value & 0x04) !== 0;
    const initialAt = q;
    const initial = readU32LEB(buf, q);
    q = initial.next;
    let maximum = null;
    if (flags.value & 0x01) {
      const max = readU32LEB(buf, q);
      maximum = { pages: max.value, offset: q, byteLength: max.next - q };
      q = max.next;
    }
    out.push({
      index: i,
      flags: flags.value,
      flagsOffset: flagsAt,
      shared: (flags.value & 0x02) !== 0,
      is64,
      initialPages: initial.value,
      initialOffset: initialAt,
      initialByteLength: initial.next - initialAt,
      maximumPages: maximum ? maximum.pages : null,
      maximumOffset: maximum ? maximum.offset : null,
      maximumByteLength: maximum ? maximum.byteLength : 0,
      pageSize: 65536,
    });
  }
  if (q !== section.end) throw new Error('the memory section has trailing bytes');
  return out;
}

/**
 * Lower (or raise) the *initial* memory, structurally verified and
 * same-length only: the replacement is padded into the exact LEB width
 * the module already uses, so nothing else in the file moves. This edits
 * a declarative section header — how much memory is backed at
 * instantiation — never allocator code. `memory.grow` up to the untouched
 * declared maximum still serves every later allocation, and a growth the
 * browser refuses becomes the framework's visible OOM abort instead of
 * an OS jetsam kill.
 */
export function patchInitialMemory(buf, opts = {}) {
  const memories = parseMemoryLimits(buf);
  if (memories.length !== 1) {
    throw new Error('expected exactly one declared memory, found ' + memories.length);
  }
  const mem = memories[0];
  if (mem.is64) throw new Error('memory64 modules are not patched here');
  const pages = opts.pages >>> 0;
  if (!pages) throw new Error('patchInitialMemory needs a positive page count');
  if (opts.expectedPages !== undefined && mem.initialPages !== opts.expectedPages && mem.initialPages !== pages) {
    throw new Error(
      'the module does not declare the expected initial memory (found ' + mem.initialPages +
      ' pages, expected ' + opts.expectedPages + ') — refusing to patch a different build'
    );
  }
  if (opts.expectedMaximumPages !== undefined && mem.maximumPages !== opts.expectedMaximumPages) {
    throw new Error(
      'the module does not declare the expected maximum memory (found ' + mem.maximumPages +
      ' pages, expected ' + opts.expectedMaximumPages + ') — refusing to patch a different build'
    );
  }
  if (mem.maximumPages !== null && pages > mem.maximumPages) {
    throw new Error('the new initial memory (' + pages + ' pages) exceeds the declared maximum (' + mem.maximumPages + ')');
  }
  if (mem.initialPages === pages) {
    return { applied: true, already: true, offset: mem.initialOffset, previousPages: mem.initialPages, pages };
  }
  writeU32LEBFixed(pages, mem.initialByteLength).copy(buf, mem.initialOffset);
  return { applied: true, already: false, offset: mem.initialOffset, previousPages: mem.initialPages, pages };
}

/** Human-readable summary; used by prepare-build.mjs and verify-build.mjs. */
export function summarize(buf) {
  const info = inspect(buf);
  const code = info.sections.find((s) => s.id === 10);
  let memories = [];
  try { memories = parseMemoryLimits(buf); } catch (e) { memories = []; }
  return {
    ok: true,
    version: info.version,
    size: info.size,
    sections: info.sections.map((s) => s.name),
    codeSectionBytes: code ? code.size : 0,
    functionCount: info.functions.length,
    exports: info.exports.map((e) => e.name),
    memory: memories.map((m) => ({
      initialPages: m.initialPages,
      initialMiB: (m.initialPages * 65536) / 1048576,
      maximumPages: m.maximumPages,
      maximumMiB: m.maximumPages === null ? null : (m.maximumPages * 65536) / 1048576,
      initialOffset: m.initialOffset,
    })),
  };
}

/** Validate only: never throws, returns {ok, detail}. */
export function validate(buf) {
  try {
    const summary = summarize(buf);
    return { ok: summary.functionCount > 0, summary: summary, detail: '' };
  } catch (err) {
    return { ok: false, summary: null, detail: String((err && err.message) || err) };
  }
}

/* ---------------------------------------------------------------- *
 * Byte patches
 * ---------------------------------------------------------------- */

/**
 * Apply a byte patch, verified against the original bytes.
 * patch = { name, offset, expect: 'hex or hex-array', replace: 'hex or hex-array' }
 */
export function applyPatch(buf, patch) {
  const expect = toBytes(patch.expect);
  const replace = toBytes(patch.replace);
  if (expect.length !== replace.length) {
    throw new Error(patch.name + ': expect and replace must be the same length (a resize would move every offset)');
  }
  const offset = patch.offset >>> 0;
  if (patch.mode !== 'search' && offset + expect.length > buf.length) {
    throw new Error(patch.name + ': offset is past the end of the module');
  }
  const current = buf.subarray(offset, offset + expect.length);
  // Re-running a patch over an already-patched module is a no-op, not a
  // mismatch: the bytes it would write are already there.
  if (patch.mode !== 'search' && current.equals(replace) && !current.equals(expect)) {
    return { applied: true, already: true, offset: offset, searched: false };
  }
  if (!current.equals(expect)) {
    if (patch.mode === 'search') {
      const at = buf.indexOf(expect);
      if (at < 0) {
        const alreadyAt = buf.indexOf(replace);
        if (alreadyAt >= 0 && buf.indexOf(replace, alreadyAt + 1) < 0) {
          return { applied: true, already: true, offset: alreadyAt, searched: true };
        }
        throw new Error(patch.name + ': the expected bytes were not found anywhere in the module');
      }
      // A pattern that occurs twice is not an address. Search patches must
      // carry enough context bytes to be unique in the whole module (the
      // bare `local.get N; end` tail occurs hundreds of times).
      if (buf.indexOf(expect, at + 1) >= 0) {
        throw new Error(patch.name + ': the expected bytes occur more than once — add context bytes until the pattern is unique');
      }
      // Mutate the caller's buffer, which is what every applyPatch() call site
      // expects. (Writing into a private copy here made "search" patches report
      // success while changing nothing — silently, which is the worst kind.)
      replace.copy(buf, at);
      return { applied: true, offset: at, searched: true };
    }
    throw new Error(
      patch.name + ': the module does not match (found ' + current.toString('hex') + ', expected ' + expect.toString('hex') + ' at ' + offset + ')'
    );
  }
  replace.copy(buf, offset);
  return { applied: true, offset: offset, searched: false };
}

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') {
    const hex = value.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) throw new Error('odd hex string in a patch');
    return Buffer.from(hex, 'hex');
  }
  throw new Error('a patch must provide hex bytes');
}

/* ---------------------------------------------------------------- *
 * Shortlisting "IsUnloadAssetsRequired"-style functions
 * ---------------------------------------------------------------- */

/**
 * List functions whose body ends with `local.get N; end` and which compare
 * floating point constants — the shape of Unity's desktop memory-limit checks.
 *
 * The result is a shortlist for a human (or for a recorded patch), not an
 * automatic edit: the caller has to confirm the offset before patching.
 */
export function scanBooleanReturns(buf, opts = {}) {
  const info = inspect(buf);
  const min = opts.minBytes || 64;
  const max = opts.maxBytes || 4096;
  const out = [];
  for (const fn of info.functions) {
    const size = fn.end - fn.start;
    if (size < min || size > max) continue;
    const body = buf.subarray(fn.start, fn.end);
    // Locals header: count + (count types), then instructions.
    let p = 0;
    const locals = readU32LEB(body, p);
    p = locals.next;
    for (let i = 0; i < locals.value; i++) {
      p = readU32LEB(body, p).next + 1;
    }
    const code = body.subarray(p);
    // Ends with `end` (0x0b) preceded by `local.get N` (0x20 N)?
    const tailIndex = code.length - 1;
    if (tailIndex < 2 || code[tailIndex] !== 0x0b) continue;
    let at = tailIndex - 1;
    if (code[at - 1] !== 0x20) continue;
    const localIndex = code[at];

    let f64 = 0;
    let compare = 0;
    let calls = 0;
    let brIf = 0;
    for (let i = 0; i < code.length; i++) {
      const op = code[i];
      if (op === 0x44) f64++; // f64.const
      else if (op === 0x61 || op === 0x62 || op === 0x63 || op === 0x64 || op === 0x65 || op === 0x66) compare++;
      else if (op === 0x10) calls++;
      else if (op === 0x0d) brIf++;
    }
    if (f64 < 2 || compare < 2) continue;
    out.push({
      index: fn.index,
      bytes: size,
      localReturned: localIndex,
      f64Constants: f64,
      floatCompares: compare,
      calls: calls,
      branches: brIf,
      // The tail of such a function is `... local.get N; end`; patching that
      // into `... i32.const 1; end` is what the Hollow Knight port did.
      tailOffset: fn.end - 3,
      tailBytes: buf.subarray(fn.end - 3, fn.end).toString('hex'),
      bodyStart: fn.start,
    });
  }
  out.sort((a, b) => b.floatCompares - a.floatCompares);
  return out;
}
