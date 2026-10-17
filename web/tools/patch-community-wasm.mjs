#!/usr/bin/env node
/* ============================================================================
 * patch-community-wasm.mjs — build a patched mirror of the pinned build
 * ----------------------------------------------------------------------------
 *   node web/tools/patch-community-wasm.mjs --fetch --out mirror/
 *   node web/tools/patch-community-wasm.mjs --wasm w-pt.wasm.unityweb --out mirror/
 *   node web/tools/patch-community-wasm.mjs --wasm in.unityweb --heap-mib 1024 --out patched.unityweb
 *
 * The page now applies the same patches at runtime (js/unity-startup.js), so
 * this tool exists for the environments where runtime patching cannot run:
 * a browser with no DecompressionStream/compileStreaming falls back to the
 * stock loader path, which fetches the wasm itself, unpatched. Serving the
 * four Unity entry files from your own host — with only the wasm different —
 * and opening play.html?communityBase=https://your-host/ covers that case.
 *
 * What it does, all verified against web/patches/community-bcbe014.json:
 *
 *   1. reads the wasm (a `.unityweb` gzip container, or a bare `.wasm`),
 *   2. parses the memory section and rewrites the *initial* limit
 *      (default 2048 → 1536 MiB, declared maximum untouched) as a
 *      same-width LEB128 — the file size does not change, which matters
 *      because the pinned loader hard-codes `wasmFileSize: 82574276`,
 *   3. applies the unload-assets-always search patch (unique 11-byte
 *      context, expected-bytes verified),
 *   4. validates the result as a wasm module, re-gzips it, and — with
 *      --fetch — also downloads the other three entry files (loader,
 *      framework, data) unmodified into the same `Build/` layout.
 *
 * Nothing is uploaded anywhere and no game file is written into this
 * repository: `--out` is yours to publish (a GitHub Release works well —
 * release assets have no per-hour request budget). The asset archive is
 * not touched; `assetArchive.base` in community-build.json is independent
 * of `?communityBase=`.
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validate as validateWasm, applyPatch, parseMemoryLimits, patchInitialMemory } from './wasm-module.mjs';
import { patchFramework } from './patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

const USAGE = `Usage: node web/tools/patch-community-wasm.mjs [options]

  --fetch               download the pinned entry files (from community-build.json's base)
  --wasm <file>         local wasm (.unityweb gzip or bare .wasm) instead of fetching it
  --framework <file>    also patch this framework (.unityweb or plain .js) into the mirror
  --patch-framework     with --fetch: patch the fetched framework the same way
  --out <dir|file>      mirror directory (default: wasm-mirror/) — or, when it ends in
                        .unityweb/.wasm, the single patched wasm file to write
  --heap-mib <n>        initial heap to declare (default: 1536; ladder: 1536, 1280, 1024)
  --no-heap-patch       keep the declared initial heap
  --no-unload-patch     keep the stock IsUnloadAssetsRequired-style gate
  --patch-file <file>   patch JSON (default: web/patches/community-bcbe014.json)
  --descriptor <file>   build descriptor for --fetch (default: web/community-build.json)
  --json                print the report as JSON
`;

function parseArgs(argv) {
  const args = { out: 'wasm-mirror', heapMiB: 1536, patchFile: path.join(WEB_ROOT, 'patches', 'community-bcbe014.json'), descriptor: path.join(WEB_ROOT, 'community-build.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--fetch': args.fetch = true; break;
      case '--wasm': args.wasm = next(); break;
      case '--framework': args.framework = next(); break;
      case '--patch-framework': args.patchFramework = true; break;
      case '--out': args.out = next(); break;
      case '--heap-mib': args.heapMiB = Number(next()); break;
      case '--no-heap-patch': args.noHeapPatch = true; break;
      case '--no-unload-patch': args.noUnloadPatch = true; break;
      case '--patch-file': args.patchFile = path.resolve(next()); break;
      case '--descriptor': args.descriptor = path.resolve(next()); break;
      case '--json': args.json = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error('unknown option ' + a + '\n\n' + USAGE);
    }
  }
  return args;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Inflate a `.unityweb` container if that is what this is; pass through otherwise. */
export function inflateUnityweb(buf) {
  return isGzip(buf) ? zlib.gunzipSync(buf) : buf;
}

/**
 * Apply the community patch set to one inflated wasm module, verified.
 * Mutates and returns `buf` together with a report — exported for tests.
 */
export function patchCommunityWasm(buf, spec, opts = {}) {
  const before = validateWasm(buf);
  if (!before.ok) throw new Error('the input is not a valid wasm module: ' + before.detail);
  const report = { patches: [], sizeBefore: buf.length, sizeAfter: buf.length };

  if (opts.heapMiB) {
    const memory = spec.memory || {};
    const pages = Math.round((opts.heapMiB * 1048576) / 65536);
    const result = patchInitialMemory(buf, {
      pages,
      expectedPages: memory.expectedInitialPages,
      expectedMaximumPages: memory.expectedMaximumPages,
    });
    // The structural parse and the recorded byte offset must agree; if a
    // future descriptor disagrees with itself, corrupt nothing quietly.
    if (memory.initialOffset !== undefined && result.offset !== memory.initialOffset) {
      throw new Error('memory section drift: the patch file says the initial-memory field is at ' + memory.initialOffset + ' but the module parses it at ' + result.offset);
    }
    report.patches.push({
      name: memory.name || 'wasm-initial-heap',
      applied: result.applied,
      already: !!result.already,
      offset: result.offset,
      detail: result.previousPages + ' → ' + result.pages + ' pages (' + (result.previousPages / 16) + ' → ' + (result.pages / 16) + ' MiB), maximum untouched',
    });
  }

  if (!opts.skipUnloadPatch) {
    for (const patch of spec.patches || []) {
      const result = applyPatch(buf, patch);
      report.patches.push({ name: patch.name, applied: result.applied, already: !!result.already, offset: result.offset, searched: !!result.searched, detail: patch.why || '' });
    }
  }

  const after = validateWasm(buf);
  if (!after.ok) throw new Error('the patched module no longer parses: ' + after.detail);
  if (buf.length !== report.sizeBefore) throw new Error('patching changed the module size — the pinned loader hard-codes wasmFileSize and would reject it');
  report.memory = parseMemoryLimits(buf).map((m) => ({ initialMiB: m.initialPages / 16, maximumMiB: m.maximumPages === null ? null : m.maximumPages / 16 }));
  return { bytes: buf, report };
}

/** Patch one framework file (gzip container or plain), re-gzipping if it was gzipped. */
export function patchCommunityFramework(buf) {
  const gzipped = isGzip(buf);
  const plain = gzipped ? zlib.gunzipSync(buf) : buf;
  const out = patchFramework(plain);
  return { bytes: gzipped ? zlib.gzipSync(out.bytes, { level: 9 }) : out.bytes, changed: out.changed, report: out.report, gzipped };
}

async function fetchBytes(url, expectedBytes, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(what + ': HTTP ' + response.status + ' for ' + url);
  const buf = Buffer.from(await response.arrayBuffer());
  // fetch transparently decodes Content-Encoding; the size check only means
  // anything for a host that serves the file as a download, so a mismatch is
  // a warning the caller still has to digest-check downstream — except a
  // wildly wrong size, which is a captive portal until proven otherwise.
  if (expectedBytes && buf.length !== expectedBytes && !isGzip(buf) && buf.length < expectedBytes / 2) {
    throw new Error(what + ': got ' + buf.length + ' bytes, expected about ' + expectedBytes + ' — is the network intercepting this?');
  }
  return buf;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (line) => console.log(line);
  if (args.help || (!args.fetch && !args.wasm)) {
    console.log(USAGE);
    if (!args.help) process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(args.heapMiB) || args.heapMiB < 256 || args.heapMiB > 4080) {
    throw new Error('--heap-mib must be between 256 and 4080 (the declared maximum is 4080 MiB)');
  }
  const spec = JSON.parse(await fsp.readFile(args.patchFile, 'utf8'));
  const descriptor = JSON.parse(await fsp.readFile(args.descriptor, 'utf8'));
  const singleFile = /\.(unityweb|wasm)$/i.test(args.out);
  const outDir = singleFile ? path.dirname(path.resolve(args.out)) : path.resolve(args.out);
  const buildDir = path.join(outDir, 'Build');
  const report = { heapMiB: args.noHeapPatch ? null : args.heapMiB, files: [], patches: [] };

  // ---- the wasm -------------------------------------------------------
  let wasmContainer;
  if (args.wasm) {
    wasmContainer = await fsp.readFile(path.resolve(args.wasm));
    log('wasm: ' + args.wasm + ' (' + wasmContainer.length + ' bytes)');
  } else {
    const url = new URL(descriptor.unity.wasm, descriptor.base).href;
    log('wasm: fetching ' + url);
    wasmContainer = await fetchBytes(url, descriptor.fileBytes.wasm, 'wasm');
  }
  const inflated = inflateUnityweb(wasmContainer);
  log('  inflated to ' + inflated.length + ' bytes (the loader expects wasmFileSize 82574276 for the pinned build)');
  const { bytes: patched, report: wasmReport } = patchCommunityWasm(Buffer.from(inflated), spec, {
    heapMiB: args.noHeapPatch ? 0 : args.heapMiB,
    skipUnloadPatch: !!args.noUnloadPatch,
  });
  report.patches.push(...wasmReport.patches);
  for (const p of wasmReport.patches) log('  ✓ ' + p.name + ' @' + p.offset + (p.already ? ' (already)' : '') + ' — ' + p.detail);
  const wasmOut = zlib.gzipSync(patched, { level: 9 });
  const wasmPath = singleFile ? path.resolve(args.out) : path.join(buildDir, path.basename(descriptor.unity.wasm));
  await fsp.mkdir(path.dirname(wasmPath), { recursive: true });
  await fsp.writeFile(wasmPath, wasmOut);
  report.files.push({ path: wasmPath, bytes: wasmOut.length, inflatedBytes: patched.length, sha256: sha256(wasmOut) });
  log('  wrote ' + wasmPath + ' (' + wasmOut.length + ' bytes gzip)');

  // ---- the other entry files: copied, never invented ------------------
  if (!singleFile && (args.fetch || args.framework || args.patchFramework)) {
    await fsp.mkdir(buildDir, { recursive: true });
    if (args.fetch) {
      for (const key of ['loader', 'data']) {
        const url = new URL(descriptor.unity[key], descriptor.base).href;
        const bytes = await fetchBytes(url, descriptor.fileBytes[key], key);
        const dest = path.join(buildDir, path.basename(descriptor.unity[key]));
        await fsp.writeFile(dest, bytes);
        report.files.push({ path: dest, bytes: bytes.length, sha256: sha256(bytes) });
        log('  copied ' + key + ' → ' + dest);
      }
    }
    let frameworkBytes = null;
    if (args.framework) frameworkBytes = await fsp.readFile(path.resolve(args.framework));
    else if (args.fetch) {
      const url = new URL(descriptor.unity.framework, descriptor.base).href;
      frameworkBytes = await fetchBytes(url, descriptor.fileBytes.framework, 'framework');
    }
    if (frameworkBytes) {
      let out = { bytes: frameworkBytes, changed: false, report: [] };
      if (args.patchFramework || args.framework) {
        out = patchCommunityFramework(Buffer.from(frameworkBytes));
        for (const r of out.report) log('  ' + (r.applied ? '✓' : '·') + ' framework: ' + r.name + (r.applied ? '' : ' — ' + r.detail));
        report.patches.push(...out.report.map((r) => ({ ...r, file: 'framework' })));
      }
      const dest = path.join(buildDir, path.basename(descriptor.unity.framework));
      await fsp.writeFile(dest, out.bytes);
      report.files.push({ path: dest, bytes: out.bytes.length, patched: out.changed, sha256: sha256(out.bytes) });
      log('  wrote framework → ' + dest + (out.changed ? ' (patched)' : ''));
    }
  }

  if (!singleFile) {
    const note = path.join(outDir, 'PATCHED-MIRROR.md');
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(note, [
      '# Patched community build mirror',
      '',
      'Built by `web/tools/patch-community-wasm.mjs` from the pinned descriptor',
      '(`web/community-build.json`, ' + descriptor.buildId + '). Only the wasm (and,',
      'when requested, the framework) differs from upstream:',
      '',
      ...report.patches.map((p) => '- ' + p.name + ': ' + (p.detail || (p.applied ? 'applied' : 'not applied'))),
      '',
      'Host this directory statically (a GitHub Release works well) and play with',
      '`play.html?communityBase=https://your-host/` — the layout it expects is',
      'exactly this `Build/` folder. The asset archive is untouched and still',
      'comes from `assetArchive.base`.',
      '',
      'Files:',
      '',
      ...report.files.map((f) => '- `' + path.relative(outDir, f.path) + '` — ' + f.bytes + ' bytes · sha256 `' + f.sha256 + '`'),
      '',
    ].join('\n'));
    log('mirror ready: ' + outDir + ' (see PATCHED-MIRROR.md)');
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('patch-community-wasm failed: ' + ((err && err.stack) || err));
    process.exitCode = 1;
  });
}

export { main, USAGE };
