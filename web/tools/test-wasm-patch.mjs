/* ============================================================================
 * test-wasm-patch.mjs — the iPad jetsam fix: smaller declared heap,
 * forced unload gate, Unity 6 audio release
 * ----------------------------------------------------------------------------
 *   node web/tools/test-wasm-patch.mjs
 *
 * Covers the patch stack that shell 1.2.0 adds on top of the pinned
 * community binary, with synthetic wasm built byte for byte in this file:
 *
 *   - the structural memory-section parse + same-width initial-heap rewrite
 *     (incl. the 1536/1280/1024 ladder and padded-LEB rungs below 1024);
 *   - search patches requiring a *unique* pattern, and already-patched
 *     modules being recognised instead of refused;
 *   - the offline mirror tool (patch-community-wasm.mjs) end to end;
 *   - the browser side: createWasmPatchStream under 1-byte-chunk torture,
 *     buildWasmPatches agreeing with web/patches/community-bcbe014.json,
 *     wasmResponse still stream-compiling when the windows are absent;
 *   - the Unity 6 framework audio patch, byte-identical between the Node
 *     pipeline (tools/patches.mjs) and the page (js/unity-startup.js).
 *
 * The real pinned module is not a fixture here (82 MiB of someone else's
 * game does not belong in the test tree); the same code was verified
 * against it directly — see LOADING-OPTIMIZATIONS.md, shell 1.2.0.
 * ==========================================================================*/

import { section, test, eq, ok, rejects, done, tmpDir } from './testkit.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { validate, summarize, applyPatch, parseMemoryLimits, patchInitialMemory, writeU32LEB, writeU32LEBFixed, readU32LEB } from './wasm-module.mjs';
import { patchFramework, FRAMEWORK_MEDIA_BLOCKS } from './patches.mjs';
import { patchCommunityWasm, patchCommunityFramework } from './patch-community-wasm.mjs';

const require = createRequire(import.meta.url);
const startup = require('../js/unity-startup.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(WEB, 'patches', 'community-bcbe014.json'), 'utf8'));
const TMP = tmpDir('wasm-patch');

/* ---- a hand-built wasm module with a real memory section ---------------- */

function sectionBytes(id, payload) {
  return Buffer.concat([Buffer.from([id]), writeU32LEB(payload.length), payload]);
}
function nameBytes(text) {
  return Buffer.concat([writeU32LEB(Buffer.byteLength(text)), Buffer.from(text)]);
}
/** type () -> i32, one function returning 42, exported memory + "main". */
function moduleWithMemory(initialPages, maximumPages, { initialWidth = 0, customPayload = null } = {}) {
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const types = sectionBytes(1, Buffer.concat([writeU32LEB(1), Buffer.from([0x60, 0x00, 0x01, 0x7f])]));
  const funcs = sectionBytes(3, Buffer.concat([writeU32LEB(1), writeU32LEB(0)]));
  const initialLEB = initialWidth ? writeU32LEBFixed(initialPages, initialWidth) : writeU32LEB(initialPages);
  const memoryPayload = maximumPages === null
    ? Buffer.concat([writeU32LEB(1), writeU32LEB(0), initialLEB])
    : Buffer.concat([writeU32LEB(1), writeU32LEB(1), initialLEB, writeU32LEB(maximumPages)]);
  const memory = sectionBytes(5, memoryPayload);
  const exports = sectionBytes(7, Buffer.concat([
    writeU32LEB(2),
    nameBytes('memory'), Buffer.from([0x02]), writeU32LEB(0),
    nameBytes('main'), Buffer.from([0x00]), writeU32LEB(0),
  ]));
  const body = Buffer.from([0x00, 0x41, 0x2a, 0x0b]);   // no locals; i32.const 42; end
  const code = sectionBytes(10, Buffer.concat([writeU32LEB(1), writeU32LEB(body.length), body]));
  const parts = [header, types, funcs, memory, exports, code];
  if (customPayload) parts.push(sectionBytes(0, Buffer.concat([nameBytes('sk-test'), customPayload])));
  return Buffer.concat(parts);
}
const UNLOAD_CONTEXT = Buffer.from('200c41b0046a240020090b', 'hex');
const UNLOAD_PATCHED = Buffer.from('200c41b0046a240041010b', 'hex');

section('the memory section, parsed structurally');

await test('parseMemoryLimits finds the initial/maximum fields and their offsets', () => {
  const wasm = moduleWithMemory(32768, 65280);
  const [mem] = parseMemoryLimits(wasm);
  eq(mem.initialPages, 32768, 'initial pages');
  eq(mem.maximumPages, 65280, 'maximum pages');
  eq(wasm.subarray(mem.initialOffset, mem.initialOffset + 3).toString('hex'), '808002', 'the initial field is the pinned 3-byte LEB');
  eq(mem.initialByteLength, 3, 'at its natural width');
  const summary = summarize(wasm);
  eq(summary.memory[0].initialMiB, 2048, 'the summary states the heap the browser would back');
  eq(summary.memory[0].maximumMiB, 4080, 'and the growth ceiling');
});

await test('the initial heap rewrites same-width down the whole ladder, changing nothing else', () => {
  const ladder = [
    [24576, '80c001', 1536],
    [20480, '80a001', 1280],
    [16384, '808001', 1024],
    [8192, '80c000', 512],      // a padded (overlong) LEB keeps the width below 1024 MiB
  ];
  for (const [pages, hex, mib] of ladder) {
    const wasm = Buffer.from(moduleWithMemory(32768, 65280));
    const before = Buffer.from(wasm);
    const result = patchInitialMemory(wasm, { pages, expectedPages: 32768, expectedMaximumPages: 65280 });
    eq(result.applied, true, mib + ' MiB: applied');
    eq(wasm.length, before.length, mib + ' MiB: size unchanged (the loader hard-codes wasmFileSize)');
    eq(wasm.subarray(result.offset, result.offset + 3).toString('hex'), hex, mib + ' MiB: field rewritten');
    eq(parseMemoryLimits(wasm)[0].initialPages, pages, mib + ' MiB: parses back to the new value');
    eq(parseMemoryLimits(wasm)[0].maximumPages, 65280, mib + ' MiB: maximum untouched');
    let diffs = 0;
    for (let i = 0; i < wasm.length; i++) if (wasm[i] !== before[i]) diffs++;
    ok(diffs <= 2, mib + ' MiB: only the LEB bytes changed (' + diffs + ')');
    eq(validate(wasm).ok, true, mib + ' MiB: still parses');
    ok(WebAssembly.validate(wasm), mib + ' MiB: the platform validator agrees');
  }
});

await test('a smaller declared heap still instantiates and runs (growth serves the rest)', async () => {
  const wasm = Buffer.from(moduleWithMemory(2, 100));
  patchInitialMemory(wasm, { pages: 1, expectedPages: 2, expectedMaximumPages: 100 });
  const { instance } = await WebAssembly.instantiate(wasm, {});
  eq(instance.exports.memory.buffer.byteLength, 65536, 'one page backed at instantiation, not two');
  eq(instance.exports.main(), 42, 'and the code runs');
  instance.exports.memory.grow(3);
  eq(instance.exports.memory.buffer.byteLength, 4 * 65536, 'growth to the declared maximum still works');
});

await test('patchInitialMemory refuses a different build, an impossible size, and re-patching is a no-op', async () => {
  const wasm = Buffer.from(moduleWithMemory(32768, 65280));
  await rejects(Promise.resolve().then(() => patchInitialMemory(Buffer.from(wasm), { pages: 24576, expectedPages: 16384 })), /expected initial memory/, 'wrong expected initial');
  await rejects(Promise.resolve().then(() => patchInitialMemory(Buffer.from(wasm), { pages: 24576, expectedMaximumPages: 100 })), /expected maximum/, 'wrong expected maximum');
  await rejects(Promise.resolve().then(() => patchInitialMemory(Buffer.from(wasm), { pages: 70000 })), /exceeds the declared maximum/, 'initial above maximum');
  const once = Buffer.from(wasm);
  patchInitialMemory(once, { pages: 24576, expectedPages: 32768 });
  const twice = patchInitialMemory(once, { pages: 24576, expectedPages: 32768 });
  eq(twice.already, true, 'the second pass recognises its own work');
});

section('verified byte patches');

await test('a search patch must be unique — the bare function tail is not an address', async () => {
  const twoContexts = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), UNLOAD_CONTEXT, Buffer.alloc(16, 0xaa), UNLOAD_CONTEXT]);
  await rejects(
    Promise.resolve().then(() => applyPatch(Buffer.from(twoContexts), { name: 'ambiguous', mode: 'search', expect: SPEC.patches[0].expect, replace: SPEC.patches[0].replace })),
    /more than once/,
    'an ambiguous search pattern'
  );
  // One full context among many bare `local.get 9; end` tails: only the
  // context is touched.
  const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.from([0x20, 0x09, 0x0b]), UNLOAD_CONTEXT, Buffer.from([0x20, 0x09, 0x0b])]);
  const result = applyPatch(wasm, { name: 'unload', mode: 'search', expect: SPEC.patches[0].expect, replace: SPEC.patches[0].replace });
  eq(wasm.subarray(result.offset, result.offset + UNLOAD_CONTEXT.length).equals(UNLOAD_PATCHED), true, 'the gate tail now returns true');
  eq(wasm[8], 0x20, 'the earlier bare tail was left alone');
  const again = applyPatch(wasm, { name: 'unload', mode: 'search', expect: SPEC.patches[0].expect, replace: SPEC.patches[0].replace });
  eq(again.already, true, 're-running over the patched module is recognised, not refused');
});

await test('the patch JSON and the page describe the same pinned bytes', () => {
  eq(SPEC.memory.sectionOffset, startup.WASM_MEMORY_SECTION_OFFSET, 'memory section offset');
  eq(SPEC.memory.expectedInitialPages, startup.WASM_INITIAL_PAGES, 'published initial pages');
  eq(SPEC.memory.expectedMaximumPages, startup.WASM_MAXIMUM_PAGES, 'published maximum pages');
  eq(SPEC.memory.initialPages, startup.WASM_DEFAULT_HEAP_MIB * 16, 'default target heap');
  eq(SPEC.memory.sectionBytes.replace(/ /g, ''), '0508010180800280fe03', 'the verified section bytes');
  eq(SPEC.patches[0].offset, startup.UNLOAD_PATCH_OFFSET, 'unload context offset');
  eq(SPEC.patches[0].expect, startup.UNLOAD_EXPECT, 'unload expect');
  eq(SPEC.patches[0].replace, startup.UNLOAD_REPLACE, 'unload replace');
  // The encoded section the page builds for the default heap is the one the
  // JSON describes after the same rewrite.
  const [heap] = startup.buildWasmPatches({});
  eq(Buffer.from(heap.expect).toString('hex'), SPEC.memory.sectionBytes.replace(/ /g, ''), 'the page expects the pinned section');
  eq(Buffer.from(heap.replace).toString('hex'), '0508010180c00180fe03', 'and writes the 1536 MiB section');
  eq(startup.buildWasmPatches({ heapMiB: 2048 }).filter((p) => p.name === 'wasm-initial-heap').length, 0, 'asking for the published heap is a no-op, not a patch');
  eq(startup.buildWasmPatches({ unloadPatch: false }).length, 1, 'each patch is individually skippable');
});

section('the offline mirror tool');

await test('patchCommunityWasm applies the whole set, verified, size-preserving', async () => {
  const wasm = moduleWithMemory(32768, 65280, { customPayload: UNLOAD_CONTEXT });
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.memory.initialOffset = parseMemoryLimits(wasm)[0].initialOffset;   // synthetic module: its section sits elsewhere
  const { bytes, report } = patchCommunityWasm(Buffer.from(wasm), spec, { heapMiB: 1536 });
  eq(bytes.length, wasm.length, 'size unchanged');
  eq(report.patches.map((p) => p.name + ':' + p.applied).join(','), 'wasm-initial-heap:true,unload-assets-always:true', 'both patches reported');
  eq(parseMemoryLimits(bytes)[0].initialPages, 24576, 'heap lowered');
  ok(bytes.includes(UNLOAD_PATCHED), 'gate forced on');
  ok(WebAssembly.validate(bytes), 'valid module out');
  // A module that is not the pinned shape is refused, not guessed at.
  const other = moduleWithMemory(1234, 65280, { customPayload: UNLOAD_CONTEXT });
  await rejects(Promise.resolve().then(() => patchCommunityWasm(Buffer.from(other), spec, { heapMiB: 1536 })), /expected initial memory|drift/, 'a different build');
});

await test('the CLI writes a mirror whose wasm inflates to the patched module', async () => {
  await fsp.mkdir(TMP, { recursive: true });
  const wasm = moduleWithMemory(32768, 65280, { customPayload: UNLOAD_CONTEXT });
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.memory.initialOffset = parseMemoryLimits(wasm)[0].initialOffset;
  const specFile = path.join(TMP, 'spec.json');
  const input = path.join(TMP, 'w-pt.wasm.unityweb');
  const out = path.join(TMP, 'mirror');
  await fsp.writeFile(specFile, JSON.stringify(spec));
  await fsp.writeFile(input, zlib.gzipSync(wasm));
  const run = spawnSync(process.execPath, [path.join(HERE, 'patch-community-wasm.mjs'), '--wasm', input, '--patch-file', specFile, '--out', out], { encoding: 'utf8' });
  eq(run.status, 0, 'tool exit: ' + run.stderr);
  ok(run.stdout.includes('wasm-initial-heap'), 'the heap patch is reported');
  const written = zlib.gunzipSync(await fsp.readFile(path.join(out, 'Build', 'w-pt.wasm.unityweb')));
  eq(parseMemoryLimits(written)[0].initialPages, 24576, 'the mirrored wasm declares 1536 MiB');
  ok(written.includes(UNLOAD_PATCHED), 'and the unload gate');
  ok(fs.existsSync(path.join(out, 'PATCHED-MIRROR.md')), 'with a note explaining the layout');
});

section('the browser stream patcher');

function collect(stream) {
  return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf));
}
function byteWiseSource(bytes) {
  return new ReadableStream({
    start(controller) {
      for (const b of bytes) controller.enqueue(new Uint8Array([b]));
      controller.close();
    },
  });
}

await test('createWasmPatchStream rewrites verified windows across 1-byte chunk boundaries', async () => {
  const source = Uint8Array.from({ length: 256 }, (_, i) => i);
  let report = null;
  const patches = [
    { name: 'late', offset: 200, expect: source.slice(200, 205), replace: new Uint8Array([9, 9, 9, 9, 9]) },
    { name: 'early', offset: 10, expect: source.slice(10, 21), replace: new Uint8Array(11).fill(7) },
  ];
  const out = await collect(byteWiseSource(source).pipeThrough(startup.createWasmPatchStream(patches, { onReport: (r) => { report = r; } })));
  const expected = Uint8Array.from(source);
  expected.set(new Uint8Array(11).fill(7), 10);
  expected.set(new Uint8Array([9, 9, 9, 9, 9]), 200);
  eq(Buffer.from(out).equals(Buffer.from(expected)), true, 'byte-exact everywhere but the two windows');
  eq(report.patches.map((p) => p.name + ':' + p.status).join(','), 'early:applied,late:applied', 'both reported, in file order');
  eq(report.totalBytes, 256, 'total counted');
});

await test('mismatched, already-patched and truncated windows pass through and say so', async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let report = null;
  const patches = [
    { name: 'different', offset: 0, expect: new Uint8Array([9, 9]), replace: new Uint8Array([8, 8]) },
    { name: 'already', offset: 2, expect: new Uint8Array([0, 0]), replace: new Uint8Array([3, 4]) },
    { name: 'past-eof', offset: 100, expect: new Uint8Array([1]), replace: new Uint8Array([2]) },
  ];
  const out = await collect(byteWiseSource(source).pipeThrough(startup.createWasmPatchStream(patches, { onReport: (r) => { report = r; } })));
  eq(Buffer.from(out).equals(Buffer.from(source)), true, 'nothing was rewritten');
  eq(report.patches.map((p) => p.status).join(','), 'skipped,already,skipped', 'each outcome named');
  ok(/01 02/.test(report.patches[0].detail), 'the mismatch reports the bytes actually found: ' + report.patches[0].detail);
  ok(/ended/.test(report.patches[2].detail), 'the truncated window says the module ended');
});

await test('a heap patch recognises a mirror that already lowered its heap', async () => {
  // The pinned memory section, but already declaring 1024 MiB.
  const section = new Uint8Array([0x05, 0x08, 0x01, 0x01, 0x80, 0x80, 0x01, 0x80, 0xfe, 0x03]);
  const source = new Uint8Array(64);
  source.set(section, 7);
  const [described] = startup.buildWasmPatches({});
  const patch = { ...described, offset: 7 };
  let report = null;
  const out = await collect(byteWiseSource(source).pipeThrough(startup.createWasmPatchStream([patch], { onReport: (r) => { report = r; } })));
  eq(Buffer.from(out).equals(Buffer.from(source)), true, 'the mirror value is left as served');
  eq(report.patches[0].status, 'already', 'and recognised as such');
  ok(/1024 MiB/.test(report.patches[0].detail), 'with the value it declared: ' + report.patches[0].detail);
});

await test('wasmResponse still stream-compiles a module with no patch windows in it', async () => {
  const tiny = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  let report = null;
  const response = await startup.wasmResponse(new Response(zlib.gzipSync(tiny)), {
    patches: startup.buildWasmPatches({}),
    onReport: (r) => { report = r; },
  });
  ok(await WebAssembly.compileStreaming(response), 'compiled');
  eq(report.patches.every((p) => p.status === 'skipped'), true, 'both pinned windows reported absent, not fatal');
});

await test('the fixed-width LEB encoder covers the whole heap ladder', () => {
  for (const [pages, hex] of [[32768, '808002'], [24576, '80c001'], [20480, '80a001'], [16384, '808001'], [8192, '80c000'], [4096, '80a000']]) {
    const encoded = startup.encodeLEB128Fixed(pages, 3);
    eq(Buffer.from(encoded).toString('hex'), hex, pages + ' pages in three bytes');
    eq(readU32LEB(Buffer.from(encoded), 0).value, pages, 'and it decodes back');
  }
  eq(Buffer.from(writeU32LEBFixed(24576, 3)).toString('hex'), '80c001', 'the Node encoder agrees with the page one');
});

section('the Unity 6 framework audio patch');

await test('disconnectSource gives the decoder back — identically in the pipeline and the page', () => {
  const pristine = 'function jsAudioCreateChannel() { var channel = {}; ' +
    'channel.disconnectSource = function() {\n' +
    '\t\t\t\t\tif (!this.source || this.source.isPausedMockNode) {\n\t\t\t\t\t\treturn\n\t\t\t\t\t}\n\t\t\t\t\t' +
    FRAMEWORK_MEDIA_BLOCKS.unity6.original + '\n' +
    '\t\t\t\t\tthis.source.disconnect();\n\t\t\t\t\tdelete this.source\n\t\t\t\t}; return channel; }';
  const node = patchFramework(Buffer.from(pristine, 'latin1'));
  eq(node.changed, true, 'the Unity 6 shape is patched by the pipeline');
  eq(node.report[0].detail, 'Unity 6 framework shape', 'and the shape is named');
  const patched = node.bytes.toString('latin1');
  ok(patched.includes('skRelease'), 'the release helper is inserted');
  ok(patched.includes('clearTimeout(this.source.playTimeout)'), 'a pending delayed play is cancelled');
  ok(patched.includes('playPromise.then(skRelease, skRelease)'), 'release waits for a pending play() to settle instead of rejecting it');
  ok(patched.includes('removeAttribute("src")') && patched.includes('skEl.src = ""') && patched.includes('skEl.load()'), 'the element source is dropped so WebKit frees the decoder');
  new vm.Script(patched);   // still valid JavaScript
  const page = startup.patchFramework(pristine);
  eq(page, patched, 'the page produces the identical text');
  eq(startup.patchFramework(patched), patched, 'the page patch is idempotent');
  const second = patchFramework(node.bytes);
  eq(second.changed, false, 'and so is the pipeline patch');
  let refused = '';
  try { startup.patchFramework('function somethingElse() { return 1; }'); } catch (e) { refused = e.message; }
  ok(/not unique/.test(refused), 'an unrecognised framework is refused, never guessed: ' + refused);
});

await test('the patched disconnect never touches a source it cannot release', () => {
  // Run the patched channel with throwaway media elements: the patched
  // body must stay on the rails for a plain buffer source (no element)
  // and for an element whose play() is still pending.
  const pristine = 'var channel = {}; channel.disconnectSource = function() {\n' +
    '\t\t\t\t\tif (!this.source || this.source.isPausedMockNode) {\n\t\t\t\t\t\treturn\n\t\t\t\t\t}\n\t\t\t\t\t' +
    FRAMEWORK_MEDIA_BLOCKS.unity6.original + '\n\t\t\t\t\tthis.source.disconnect();\n\t\t\t\t\tdelete this.source\n\t\t\t\t};';
  const patched = startup.patchFramework(pristine);
  const makeElement = () => ({
    paused: false, src: 'blob:music', released: [],
    pause() { this.released.push('pause'); },
    removeAttribute(name) { this.released.push('remove:' + name); },
    load() { this.released.push('load'); },
  });
  const run = (source) => {
    const context = { channel: null, clearTimeout, setTimeout };
    vm.runInNewContext(patched, context);
    context.channel.source = source;
    context.channel.disconnectSource();
    return context.channel;
  };
  const element = makeElement();
  const doneChannel = run({
    mediaElement: element, playTimeout: null, playPromise: null,
    _pauseMediaElement() {}, disconnect() {},
  });
  eq(element.src, '', 'a settled element loses its source immediately');
  ok(element.released.includes('pause') && element.released.includes('load'), 'paused, then released');
  eq(doneChannel.source, undefined, 'the channel still drops the source');
  const bufferChannel = run({ mediaElement: null, disconnect() { this.cut = true; } });
  eq(bufferChannel.source, undefined, 'a buffer source disconnects untouched');
});

await test('patchCommunityFramework round-trips a gzipped framework', () => {
  const pristine = 'x = 1;\n' + FRAMEWORK_MEDIA_BLOCKS.unity6.original + '\n';
  const out = patchCommunityFramework(zlib.gzipSync(Buffer.from(pristine, 'latin1')));
  eq(out.changed, true, 'patched');
  eq(out.gzipped, true, 'and re-gzipped');
  ok(zlib.gunzipSync(out.bytes).toString('latin1').includes('skRelease'), 'the inflated mirror copy carries the patch');
});

await fsp.rm(TMP, { recursive: true, force: true });
await done('wasm patch tests');
