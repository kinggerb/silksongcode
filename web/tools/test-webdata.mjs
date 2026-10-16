/* ============================================================================
 * test-webdata.mjs — the Unity WebGL archive tools
 * ----------------------------------------------------------------------------
 *   node web/tools/test-webdata.mjs
 *
 * Covers: writing and re-reading an archive, streaming rebuild with a source
 * entry, pruning entries, the video heuristic, the placeholder videos, and the
 * wasm byte patches (verified, refused when the bytes do not match, and found by
 * --scan's shortlist).
 * ==========================================================================*/

import { section, test, eq, ok, done, tmpDir } from './testkit.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';

import {
  parseHeader,
  openArchive,
  writeArchive,
  rebuildArchive,
  makePlaceholderVideo,
  makeMp4Placeholder,
  makeWebmPlaceholder,
  looksLikeVideo,
  videoKind,
  MAGIC_BYTES,
} from './unity-webdata.mjs';
import { inspect, summarize, validate, applyPatch, scanBooleanReturns } from './wasm-module.mjs';
import { patchFramework, frameWorkPatches } from './patches.mjs';
import { buildWasm } from './make-fixture-build.mjs';

const TMP = tmpDir('webdata');
await fsp.mkdir(TMP, { recursive: true });

section('archive read/write');

await test('writes an archive that parses back with the same entries', async () => {
  const file = path.join(TMP, 'a.data');
  const entries = [
    { path: 'Resources/unity default resources', data: Buffer.alloc(100, 1) },
    { path: 'sharedassets9', data: Buffer.alloc(50, 2) },
    { path: 'cine_intro.mp4', data: makePlaceholderVideo('mp4') },
  ];
  const written = await writeArchive(file, entries, { align: 4 });
  const archive = await openArchive(file);
  eq(archive.header.fileCount, 3, 'entry count');
  eq(archive.header.headerSize % 4, 0, 'header is aligned');
  eq(archive.header.entries.map((e) => e.path).join(','), entries.map((e) => e.path).join(','), 'paths');
  eq(archive.header.entries[1].size, 50, 'second entry size');
  const payload = await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(file, {
      start: archive.header.headerSize + archive.header.entries[2].offset,
      end: archive.header.headerSize + archive.header.entries[2].offset + archive.header.entries[2].size - 1,
    });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  ok(payload.equals(entries[2].data), 'video payload came back byte for byte');
  await archive.handle.close();
  eq(written.size, (await fsp.stat(file)).size, 'reported size matches the file');
});

await test('rejects a file that is not a Unity archive', async () => {
  const file = path.join(TMP, 'nope.data');
  await fsp.writeFile(file, Buffer.alloc(64, 0x41));
  let message = '';
  try {
    await openArchive(file);
  } catch (e) {
    message = e.message;
  }
  ok(/not a UnityWebData1\.0 archive/.test(message), 'clear message: ' + message);
  await fsp.writeFile(file, Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]));
  try {
    await openArchive(file);
  } catch (e) {
    ok(/compressed/.test(e.message), 'points out gzip: ' + e.message);
  }
});

section('streaming rebuild (what prepare-build does)');

await test('copies untouched entries and swaps videos for placeholders', async () => {
  const src = path.join(TMP, 'src.data');
  const dst = path.join(TMP, 'dst.data');
  const bundle = Buffer.alloc(4096, 0xab);
  const video = Buffer.concat([makePlaceholderVideo('mp4'), Buffer.alloc(200000, 0x11)]);
  await writeArchive(
    src,
    [
      { path: 'sharedassets9', data: bundle },
      { path: 'sharedassets200.resource', data: video },
      { path: 'Resources/unity_builtin_extra', data: Buffer.alloc(3000, 7) },
    ],
    { align: 4 }
  );
  const source = await openArchive(src);
  const placeholder = makePlaceholderVideo('mp4');
  await rebuildArchive({
    fromFile: src,
    toFile: dst,
    entries: [
      { path: 'sharedassets9', size: bundle.length, source: { offset: source.header.entries[0].offset } },
      { path: 'sharedassets200.resource', size: placeholder.length, data: placeholder },
      { path: 'Resources/unity_builtin_extra', size: 3000, source: { offset: source.header.entries[2].offset } },
    ],
    align: 4,
  });
  await source.handle.close();

  const rebuilt = await openArchive(dst);
  eq(rebuilt.header.fileCount, 3, 'entry count kept');
  const bytes = await fsp.readFile(dst);
  const at = (i) => rebuilt.header.headerSize + rebuilt.header.entries[i].offset;
  ok(bytes.subarray(at(0), at(0) + 4096).equals(bundle), 'the bundle was copied');
  ok(bytes.subarray(at(1), at(1) + placeholder.length).equals(placeholder), 'the video was replaced');
  ok(bytes.subarray(at(2), at(2) + 3000).equals(Buffer.alloc(3000, 7)), 'entries after the swap are still right');
  eq(rebuilt.header.entries[1].size, placeholder.length, 'shrunken size is in the index');
  const before = (await fsp.stat(src)).size;
  const after = (await fsp.stat(dst)).size;
  ok(after < before - 190000, 'the rebuild really is smaller: ' + before + ' → ' + after);
  await rebuilt.handle.close();
});

await test('truncating a video keeps its container header', async () => {
  const src = path.join(TMP, 'trunc-src.data');
  const dst = path.join(TMP, 'trunc-dst.data');
  const video = Buffer.concat([makePlaceholderVideo('mp4'), Buffer.alloc(50000, 0x22)]);
  await writeArchive(src, [{ path: 'cine_a.mp4', data: video }], { align: 4 });
  const source = await openArchive(src);
  await rebuildArchive({
    fromFile: src,
    toFile: dst,
    entries: [{ path: 'cine_a.mp4', size: 1024, source: { offset: source.header.entries[0].offset } }],
  });
  await source.handle.close();
  const head = await fsp.readFile(dst);
  const rebuilt = await openArchive(dst);
  const start = rebuilt.header.headerSize + rebuilt.header.entries[0].offset;
  eq(rebuilt.header.entries[0].size, 1024, 'kept 1 KB');
  ok(video.subarray(0, 1024).equals(head.subarray(start, start + 1024)), 'the kept bytes are the file head');
  await rebuilt.handle.close();
});

section('video detection + placeholders');

await test('recognises videos by name and by container magic', () => {
  eq(looksLikeVideo('cine_ending.webm', null), true, 'webm by extension');
  eq(looksLikeVideo('Resources/unity default resources1', null), false, 'plain resource');
  eq(looksLikeVideo('sharedassets200.resource', makePlaceholderVideo('mp4')), true, 'mp4 by ftyp box');
  eq(looksLikeVideo('sharedassets201.resource', makePlaceholderVideo('webm')), true, 'webm by EBML');
  eq(videoKind(Buffer.from('not a video at all')), 'unknown', 'unknown kind');
});

await test('placeholders are tiny, structurally valid video containers', () => {
  const mp4 = makeMp4Placeholder(2, 2);
  ok(mp4.length < 1024, 'mp4 placeholder is under 1 KB (' + mp4.length + ' bytes)');
  eq(mp4.subarray(4, 8).toString('latin1'), 'ftyp', 'starts with an ftyp box');
  eq(mp4.readUInt32BE(0), mp4.length >= 32 ? mp4.readUInt32BE(0) : 0, 'first box is complete');
  // box sizes must chain exactly to the end of the file
  let at = 0;
  let boxes = 0;
  while (at < mp4.length) {
    const size = mp4.readUInt32BE(at);
    ok(size >= 8, 'box at ' + at + ' has a sane size');
    at += size;
    boxes++;
  }
  eq(at, mp4.length, 'the mp4 boxes exactly cover the file (' + boxes + ' boxes)');
  const kinds = [];
  let p = 0;
  while (p < mp4.length) {
    kinds.push(mp4.subarray(p + 4, p + 8).toString('latin1'));
    p += mp4.readUInt32BE(p);
  }
  eq(kinds.join(','), 'ftyp,moov,mdat', 'expected top-level boxes');

  const webm = makeWebmPlaceholder();
  ok(webm.length < 512, 'webm placeholder is under 512 bytes (' + webm.length + ' bytes)');
  eq(webm.subarray(0, 4).toString('hex'), '1a45dfa3', 'EBML header id');
  ok(webm.includes(Buffer.from('V_VP8', 'latin1')), 'declares a VP8 video track');
});

section('wasm patches');

await test('the fixture module parses and its candidate function is found', () => {
  const wasm = buildWasm();
  const summary = summarize(wasm);
  eq(summary.version, 1, 'wasm version');
  ok(summary.functionCount >= 1, 'functions found');
  ok(summary.exports.includes('main'), 'exports listed');
  const candidates = scanBooleanReturns(wasm, { minBytes: 16 });
  ok(candidates.length >= 1, 'the unload-check function is shortlisted');
  eq(candidates[0].tailBytes, '20010b', 'its tail is local.get 1; end');
});

await test('a patch applies only when the original bytes are there', () => {
  const wasm = buildWasm();
  const candidate = scanBooleanReturns(wasm, { minBytes: 16 })[0];
  const patch = { name: 'unload-assets-always', offset: candidate.tailOffset, expect: '20010b', replace: '41010b' };
  const copy = Buffer.from(wasm);
  const result = applyPatch(copy, patch);
  eq(result.applied, true, 'applied');
  eq(copy.subarray(candidate.tailOffset, candidate.tailOffset + 3).toString('hex'), '41010b', 'bytes changed');
  eq(validate(copy).ok, true, 'the module still parses');

  let message = '';
  try {
    applyPatch(Buffer.from(wasm), { ...patch, expect: '20020b' });
  } catch (e) {
    message = e.message;
  }
  ok(/does not match/.test(message), 'a mismatched patch is refused: ' + message);

  let resize = '';
  try {
    applyPatch(Buffer.from(wasm), { name: 'grow', offset: 0, expect: '0061', replace: '006173' });
  } catch (e) {
    resize = e.message;
  }
  ok(/same length/.test(resize), 'a resizing patch is refused: ' + resize);
});

await test('search mode finds the bytes anywhere and patches there', () => {
  const wasm = buildWasm();
  const copy = Buffer.from(wasm);
  const result = applyPatch(copy, { name: 'by-pattern', mode: 'search', expect: '20010b', replace: '41010b' });
  eq(result.searched, true, 'searched');
  ok(result.offset > 0, 'found at an offset');
  eq(copy.subarray(result.offset, result.offset + 3).toString('hex'), '41010b', 'patched where it found them');
});

section('framework patches');

await test('the room-audio fix applies once and is idempotent', () => {
  const pristine =
    'channel.disconnectSource=function(){if(!this.source){return}' +
    'if(this.source.mediaElement){this.source._pauseMediaElement();if(this.source.playTimeout){clearTimeout(this.source.playTimeout);this.source.playTimeout=null}}' +
    'this.source.onended=null;this.source.disconnect();delete this.source};';
  const first = patchFramework(Buffer.from(pristine, 'latin1'));
  eq(first.changed, true, 'the pristine framework is patched');
  const patched = first.bytes.toString('latin1');
  ok(patched.includes('mediaElement.src=""'), 'it clears the audio element source');
  ok(patched.includes('mediaElement.load()'), 'and releases the decoder');
  ok(patched.includes('mediaElement.pause()'), 'and stops the element first');
  ok(patched.includes('removeAttribute("src")'), 'and drops the src attribute itself');
  const second = patchFramework(first.bytes);
  eq(second.changed, false, 'a second pass changes nothing');
  const unrelated = patchFramework(Buffer.from('function somethingElse(){return 1}', 'latin1'));
  eq(unrelated.changed, false, 'unrelated code is untouched');
  eq(unrelated.report.every((r) => !r.applied), true, 'and reported as not applicable');
});

await test('a framework that throws on stop gets its variable fixed', () => {
  const broken = 'try{x()}catch(e){console.error("playSoundClip error. Exception: "+error)}';
  const result = patchFramework(Buffer.from(broken, 'latin1'));
  ok(result.bytes.toString('latin1').includes('"+e)'), 'the undefined variable is fixed');
  eq(result.report.find((r) => /undefined error/.test(r.name)).applied, true, 'reported as applied');
});

await fsp.rm(TMP, { recursive: true, force: true });
await done('webdata tests');
