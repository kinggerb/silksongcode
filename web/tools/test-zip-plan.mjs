/* ============================================================================
 * test-zip-plan.mjs — the smaller archive
 * ----------------------------------------------------------------------------
 *   node web/tools/test-zip-plan.mjs
 *
 * Covers: reading a remote ZIP's index with two range requests, deciding
 * what to leave out (the cutscenes, another platform's bundles), writing
 * the smaller archive back out as an ordinary ZIP that zip.js can read, the
 * bytes of the entries that were kept staying byte for byte the same, the
 * download being smaller than the archive it replaces, the fallback to the
 * whole archive when the server does not honour byte ranges, and a pruned
 * download that can be resumed like any other.
 * ==========================================================================*/

import { section, test, eq, ok, close, done, serveDir, tmpDir } from './testkit.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const zip = require('../js/zip.min.js');
const plan = require('../js/zip-plan.js');
const community = require('../js/community-build.js');
const SKStream = require('../js/stream.js');

const TMP = tmpDir('zip-plan');
await fsp.mkdir(TMP, { recursive: true });

/* ---------------------------------------------------------------- *
 * A fixture archive that looks like the community one: a WebGL
 * bundle, two cutscenes, and another platform's bundle.
 * ---------------------------------------------------------------- */

/* The fixture holds real (incompressible) bytes: a run of the same letter
 * would be deflated away, and then the cutscenes would be a few hundred
 * bytes instead of the megabytes they are in the real archive. */
const FIXTURE = {
  'aa/WebGL/catalog.json': Buffer.from('{"m_InternalIds":[],"m_EntryDataString":""}'),
  'aa/WebGL/packed-scene.bundle': crypto.randomBytes(200000),
  'aa/WebGL/packed-ui.bundle': crypto.randomBytes(100000),
  'aa/WebGL/intro_01.mp4': crypto.randomBytes(700000),
  'aa/WebGL/Videos/boss_intro.webm': crypto.randomBytes(500000),
  'aa/Android/packed-scene.bundle': crypto.randomBytes(200000),
  'aa/WebGL/sounds.bundle': crypto.randomBytes(50000),
  // A cutscene that is not called one: only its bytes give it away.
  'aa/WebGL/packed-mystery.bundle': Buffer.concat([
    Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    crypto.randomBytes(2000000),
  ]),
};

async function buildFixture() {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  for (const [name, data] of Object.entries(FIXTURE)) {
    await writer.add(name, new zip.Uint8ArrayReader(new Uint8Array(data)));
  }
  const blob = await writer.close();
  return Buffer.from(await blob.arrayBuffer());
}

/** Write the archive out as a list of files, the way the community build is. */
async function serveArchive(bytes, parts = 4) {
  const dir = path.join(TMP, 'archive-' + Math.random().toString(36).slice(2));
  await fsp.mkdir(dir, { recursive: true });
  const size = Math.ceil(bytes.length / parts);
  const list = [];
  for (let i = 0; i < parts; i++) {
    const slice = bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size));
    if (!slice.length) break;
    const name = 'WebGL.zip.part' + (i + 1);
    fs.writeFileSync(path.join(dir, name), slice);
    list.push({ url: name, bytes: slice.length });
  }
  const server = await serveDir(dir);
  return {
    server,
    bytes,
    parts: list.map((part) => ({ url: server.url + part.url, bytes: part.bytes })),
    stop() { server.stop(); },
  };
}

/* A sink that behaves like OPFS but lives in memory. */
class FakeOpfsSink {
  constructor(opts = {}) {
    this.name = opts.name;
    this.buffer = opts.initial || null;
    this.files = new Map();
    this.sequentialOnly = false;
  }
  async open(resume) {
    if (!resume) this.buffer = null;
    return { size: this.buffer ? this.buffer.length : 0, canResume: !!this.buffer && this.buffer.length > 0 };
  }
  async write(u8, at) {
    if (!this.buffer) this.buffer = Buffer.alloc(0);
    if (at + u8.byteLength > this.buffer.length) {
      const bigger = Buffer.alloc(at + u8.byteLength);
      this.buffer.copy(bigger, 0);
      this.buffer = bigger;
    }
    Buffer.from(u8).copy(this.buffer, at);
  }
  async finish() { return { size: this.buffer ? this.buffer.length : 0 }; }
  async abort() {}
  destroy() {}
  async getFile() { return this.buffer ? new Blob([this.buffer]) : null; }
  async stat(name) {
    if (name === this.name) return this.buffer ? this.buffer.length : -1;
    const text = this.files.get(name);
    return text ? text.length : -1;
  }
  async putText(name, text) { this.files.set(name, text); }
  async getText(name) { return this.files.has(name) ? this.files.get(name) : null; }
  async remove(name) {
    if (name === this.name) this.buffer = null;
    this.files.delete(name);
  }
}

/* A fetch that counts the bytes it hands out, so a test can see how much of
 * the archive the plan really touched. */
function countingFetch(counter) {
  return async (url, opts) => {
    const res = await fetch(String(url), opts);
    counter.requests++;
    const range = opts && opts.headers && opts.headers.Range;
    counter.ranged++;
    counter.bytes += Number(res.headers.get('content-length') || 0);
    if (range) counter.ranges.push(String(range));
    return res;
  };
}

const fixture = await buildFixture();

section('the archive index');

await test('the ZIP index is read from the tail, without downloading the archive', async () => {
  const archive = await serveArchive(fixture, 4);
  const counter = { requests: 0, ranged: 0, bytes: 0, ranges: [] };
  const reader = plan.createReader(archive.parts, { fetchImpl: countingFetch(counter) });
  const index = await plan.readIndex(reader);
  archive.stop();

  ok(index, 'the index was read');
  eq(index.entries.length, Object.keys(FIXTURE).length, 'every entry was found');
  eq(index.total, fixture.length, 'the archive size is known');
  ok(counter.requests <= 4, 'only a couple of requests were needed (' + counter.requests + ')');
  ok(counter.bytes < fixture.length / 2, 'and they were small (' + counter.bytes + ' of ' + fixture.length + ' bytes)');
  ok(counter.ranged === counter.requests, 'every request asked for a byte range');
  eq(reader.ranges, true, 'the server honoured the ranges');
});

await test('the entries are found with their names, sizes and offsets', async () => {
  const archive = await serveArchive(fixture, 3);
  const reader = plan.createReader(archive.parts, {});
  const index = await plan.readIndex(reader);
  archive.stop();
  const names = index.entries.map((entry) => entry.name).sort();
  eq(names.join('|'), Object.keys(FIXTURE).sort().join('|'), 'the names match');
  const scene = index.entries.find((entry) => entry.name === 'aa/WebGL/packed-scene.bundle');
  ok(scene, 'the scene bundle was found');
  eq(scene.uncompSize, Buffer.byteLength(FIXTURE['aa/WebGL/packed-scene.bundle']), 'its size is known');
  ok(scene.localOffset > 0, 'and where it lives in the archive');
  ok(scene.recordEnd > scene.localOffset, 'and how far its record reaches');
});

section('what is left out');

await test('the cutscenes and another platform\'s bundles are the ones to leave out', () => {
  eq(plan.isVideoEntry('aa/WebGL/intro_01.mp4'), true, 'a video file');
  eq(plan.isVideoEntry('aa/WebGL/Videos/boss_intro.webm'), true, 'a video in a Videos folder');
  eq(plan.isVideoEntry('aa/WebGL/cutscene_hook'), true, 'a name that starts with "cutscene"');
  eq(plan.isVideoEntry('aa/WebGL/packed-scene.bundle'), false, 'a bundle is not a video');
  eq(plan.isVideoEntry('aa/WebGL/catalogue.json'), false, 'a catalogue is not a video');
  eq(plan.isVideoEntry('aa/WebGL/video_intro.bundle'), false, 'nor is a bundle called video_*');
  eq(plan.isOtherPlatformEntry('aa/Android/packed-scene.bundle'), true, 'another platform');
  eq(plan.isOtherPlatformEntry('aa/iOS/packed-scene.bundle'), true, 'and another one');
  eq(plan.isOtherPlatformEntry('aa/WebGL/packed-scene.bundle'), false, 'the WebGL one stays');
});

await test('the plan leaves out the cutscenes and keeps the game', async () => {
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  archive.stop();
  ok(result, 'a plan was made');
  eq(result.skippedCount, 4, 'the three cutscenes and the Android bundle are left out');
  eq(result.skippedNames.includes('aa/WebGL/intro_01.mp4'), true, 'the intro video is one of them');
  eq(result.skippedNames.includes('aa/Android/packed-scene.bundle'), true, 'and the Android bundle');
  eq(result.skippedNames.includes('aa/WebGL/packed-mystery.bundle'), true, 'and the cutscene that is not called one');
  eq(result.skippedNames.includes('aa/WebGL/packed-scene.bundle'), false, 'the game data stays');
  eq(result.videoNames.includes('packed-mystery.bundle'), true, 'the cutscene is known by its name for the mount');
  eq(result.videoNames.includes('packed-scene.bundle'), false, 'the game data is not');
  ok(result.skippedBytes > 200000, 'a good deal of megabytes is saved (' + result.skippedBytes + ' bytes)');
  ok(result.downloadBytes < fixture.length, 'less is downloaded than the whole archive');
  ok(result.outputSize < fixture.length, 'and the file on the device is smaller too');
});

section('the smaller archive');

await test('the pruned archive is an ordinary ZIP that zip.js can read', async () => {
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  ok(result, 'a plan was made');

  // Put the plan together the way the downloader does.
  const out = Buffer.alloc(result.outputSize);
  for (const segment of result.segments) {
    if (segment.data) {
      Buffer.from(segment.data).copy(out, segment.outOffset);
      continue;
    }
    const res = await fetch(segment.url, { headers: { Range: 'bytes=' + segment.rangeStart + '-' + (segment.rangeEnd - 1) } });
    eq(res.status, 206, 'the segment was served as a range');
    const bytes = Buffer.from(await res.arrayBuffer());
    eq(bytes.length, segment.bytes, 'the segment is the size the plan said');
    bytes.copy(out, segment.outOffset);
  }
  eq(out.length, result.outputSize, 'the archive is exactly the planned size');

  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([out])), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const names = entries.filter((entry) => !entry.directory).map((entry) => entry.filename).sort();
  eq(
    names.join('|'),
    ['aa/WebGL/catalog.json', 'aa/WebGL/packed-scene.bundle', 'aa/WebGL/packed-ui.bundle', 'aa/WebGL/sounds.bundle'].join('|'),
    'the cutscenes are gone and the game is still there'
  );

  // The bytes of the entries that were kept are the very same bytes.
  for (const entry of entries) {
    if (entry.directory) continue;
    const data = await entry.getData(new zip.BlobWriter('application/octet-stream'), { useWebWorkers: false });
    const bytes = Buffer.from(await data.arrayBuffer());
    eq(bytes.equals(FIXTURE[entry.filename]), true, 'the content of ' + entry.filename + ' is unchanged');
  }
  await reader.close();
});

await test('the download really is smaller than the archive it replaces', async () => {
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  archive.stop();
  const whole = fixture.length;
  const saved = whole - result.downloadBytes;
  ok(saved > 0, 'the download is smaller by ' + saved + ' bytes');
  eq(result.downloadBytes, result.outputSize - (result.outputSize - result.downloadBytes), 'the arithmetic holds');
  ok(result.outputSize <= result.downloadBytes + 4096, 'the rebuilt archive is only the directory on top');
});

await test('the download still takes about as many requests as the archive has parts', async () => {
  // One request per file inside the archive would be a thousand round trips;
  // the pieces that follow each other are merged into one range instead.
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  archive.stop();
  const remote = result.segments.filter((segment) => !segment.data);
  ok(remote.length <= 8, 'the segments were merged (' + remote.length + ' requests for 4 parts)');
  const bytes = result.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  eq(bytes, result.outputSize, 'the segments cover the whole new archive');
  // The ranges do not overlap and they are in order.
  let at = 0;
  for (const segment of result.segments) {
    eq(segment.outOffset, at, 'the segments follow each other in the new file');
    at += segment.bytes;
  }
});

await test('a cutscene that is not called one is answered with a placeholder', async () => {
  // The archive no longer holds the video, so the mount has to answer for
  // it — the plan says which files those are.
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  archive.stop();
  const mount = await community.openArchive(new Blob([fixture]), zip);
  const target = { fetch: async () => new Response('network fallback') };
  const restore = community.installFetchMount(target, mount, { videoNames: result.videoNames });
  const res = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-mystery.bundle');
  eq(res.headers.get('content-type'), 'video/mp4', 'the cutscene is answered with a placeholder');
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(bytes.length < 2048, 'and it is a tiny one (' + bytes.length + ' bytes)');
  restore();
  await mount.close();
});

await test('the cutscenes that were found once are remembered', async () => {
  // Looking at the bytes of every big file takes a few hundred requests.
  // The answer is the same for every launch, so it is remembered and the
  // next launch only reads the archive's own index.
  const archive = await serveArchive(fixture, 4);
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  const counter = { requests: 0 };
  const fetchImpl = async (url, opts) => {
    counter.requests++;
    return fetch(String(url), opts);
  };
  const first = await community.planArchive(archive.parts, { key: 'build-1', storage, fetchImpl });
  eq(first.skippedNames.includes('aa/WebGL/packed-mystery.bundle'), true, 'the cutscene was found');
  eq(store.size, 1, 'and remembered for the next launch');
  const firstRequests = counter.requests;
  ok(firstRequests > 2, 'the first launch looked at the files (' + firstRequests + ' requests)');

  counter.requests = 0;
  const second = await community.planArchive(archive.parts, { key: 'build-1', storage, fetchImpl });
  eq(second.skippedNames.includes('aa/WebGL/packed-mystery.bundle'), true, 'the cutscene is left out again');
  eq(second.skippedCount, first.skippedCount, 'and the same files are left out');
  ok(counter.requests < firstRequests, 'the second launch did not have to look at the files again (' +
    counter.requests + ' requests)');
  archive.stop();
});

section('the fallback');

await test('a server that ignores byte ranges gets the whole archive', async () => {
  // Without ranges there is no way to skip anything, so the plan has to give
  // up and the archive is downloaded as it always was.
  const archive = await serveArchive(fixture, 4);
  const noRanges = async (url, opts) => {
    const headers = new Headers((opts && opts.headers) || undefined);
    headers.delete('Range');
    return fetch(String(url), { headers, signal: opts && opts.signal });
  };
  const result = await community.planArchive(archive.parts, { fetchImpl: noRanges });
  archive.stop();
  eq(result, null, 'no plan is made');
});

await test('the whole archive is downloaded when the plan cannot be made', async () => {
  const archive = await serveArchive(fixture, 4);
  let seen = null;
  const fakeStream = {
    ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; },
  };
  await community.ensureArchive(
    {
      schema: 1,
      buildId: 'test-build',
      source: 'https://example.test/repo',
      base: 'https://example.test/',
      unity: { loader: 'a', framework: 'b', data: 'c', wasm: 'd', streamingAssets: 'e' },
      fileBytes: { loader: 1, framework: 1, data: 1, wasm: 1 },
      assetArchive: {
        cacheKey: 'archive.zip',
        total: archive.bytes.length,
        mime: 'application/zip',
        parts: archive.parts.map((part, index) => ({ path: 'part' + (index + 1), bytes: part.bytes })),
      },
    },
    { stream: fakeStream, base: 'https://example.test/', fetchImpl: async () => new Response('x') }
  );
  eq(seen.parts.length, 4, 'every shard is downloaded');
  eq(seen.expectedSize, archive.bytes.length, 'the whole archive is expected');
  eq(seen.segments, undefined, 'no segment list is used');
  archive.stop();
});

section('the pruned download');

await test('the pruned archive is downloaded like any other file', async () => {
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  const sink = new FakeOpfsSink({ name: 'pruned.zip' });
  const set = await SKStream.ensureDataset({
    segments: result.segments,
    expectedSize: result.outputSize,
    cacheKey: 'pruned.zip',
    buildId: 'test-build',
    mime: 'application/zip',
    writerFactory: async () => sink,
    allowMemoryFallback: false,
  });
  archive.stop();

  eq(set.size, result.outputSize, 'the file is the size the plan said');
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([sink.buffer])), { useWebWorkers: false });
  const entries = await reader.getEntries();
  eq(entries.filter((entry) => !entry.directory).length, 4, 'the game files are in there');
  await reader.close();
});

await test('a pruned download that was interrupted resumes', async () => {
  const archive = await serveArchive(fixture, 4);
  const result = await community.planArchive(archive.parts, {});
  // Pretend the first half of the pruned archive is already on disk.
  const half = Math.floor(result.outputSize / 2);
  const sink = new FakeOpfsSink({ name: 'resume.zip', initial: Buffer.alloc(half) });
  await sink.putText('resume.zip.building', 'test-build');
  const set = await SKStream.ensureDataset({
    segments: result.segments,
    expectedSize: result.outputSize,
    cacheKey: 'resume.zip',
    buildId: 'test-build',
    mime: 'application/zip',
    writerFactory: async () => sink,
    allowMemoryFallback: false,
  });
  archive.stop();
  eq(set.size, result.outputSize, 'the file was finished');
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([sink.buffer])), { useWebWorkers: false });
  const entries = await reader.getEntries();
  eq(entries.filter((entry) => !entry.directory).length, 4, 'and it is a readable archive');
  await reader.close();
});

await test('the pruned archive and the whole one never get mixed up', async () => {
  // Both live in the same cache file, so the loader has to be able to tell
  // them apart: a half-downloaded pruned archive must never be continued as
  // the whole one (or the other way round).
  const archive = await serveArchive(fixture, 4);
  const config = {
    schema: 1,
    buildId: 'test-build',
    source: 'https://example.test/repo',
    base: 'https://example.test/',
    unity: { loader: 'a', framework: 'b', data: 'c', wasm: 'd', streamingAssets: 'e' },
    fileBytes: { loader: 1, framework: 1, data: 1, wasm: 1 },
    assetArchive: {
      cacheKey: 'mixed.zip',
      total: archive.bytes.length,
      mime: 'application/zip',
      parts: archive.parts.map((part, index) => ({ path: 'WebGL.zip.part' + (index + 1), bytes: part.bytes })),
    },
  };
  const base = 'https://example.test/';
  const partPaths = archive.parts.map((part, index) => 'WebGL.zip.part' + (index + 1));
  const sink = new FakeOpfsSink({ name: 'mixed.zip' });
  const writerFactory = async () => sink;
  const fetchImpl = async (url, opts) => {
    const name = String(url).replace(/^https?:\/\/[^/]+\//, '');
    const part = partPaths.indexOf(name);
    if (part < 0) throw new Error('unexpected request: ' + url);
    const body = archive.bytes.subarray(
      archive.parts.slice(0, part).reduce((sum, p) => sum + p.bytes, 0),
      archive.parts.slice(0, part + 1).reduce((sum, p) => sum + p.bytes, 0)
    );
    const headers = new Headers((opts && opts.headers) || undefined);
    const range = headers.get('range');
    if (!range) return new Response(body, { status: 200 });
    const m = /^bytes=(\d+)-(\d+)/.exec(range);
    return new Response(body.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  };

  await community.ensureArchive(config, { stream: SKStream, writerFactory, fetchImpl, base });
  ok(sink.buffer.length < archive.bytes.length, 'the pruned archive is cached (' + sink.buffer.length + ' bytes)');

  // Now the whole archive: it must replace the pruned one, not continue it.
  await community.ensureArchive(config, { stream: SKStream, writerFactory, fetchImpl, base, prune: false });
  archive.stop();
  eq(sink.buffer.length, archive.bytes.length, 'the whole archive is cached');
  ok(sink.buffer.equals(archive.bytes), 'and it is the whole archive, byte for byte');
});

section('the numbers');

await test('the community archive is 1986.6 MB of cutscenes and game data', async () => {
  // The number the page shows. The pruned archive has to be smaller, or the
  // whole exercise is pointless.
  const source = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'community-build.json'), 'utf8'));
  eq(source.assetArchive.total, 2083139638, 'the whole archive is 1986.6 MB');
  eq(source.assetArchive.parts.length, 100, 'in 100 shards');
});

await fsp.rm(TMP, { recursive: true, force: true });
await done('zip plan tests');
