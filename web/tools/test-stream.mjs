/* ============================================================================
 * test-stream.mjs — the chunked loader
 * ----------------------------------------------------------------------------
 *   node web/tools/test-stream.mjs
 *
 * Covers: byte-exact assembly, chunk size disagreement with the server, a short
 * chunk, retries after a broken part, resume from what is already on disk,
 * cache reuse with the completion marker, cache invalidation when the build id
 * changes, sampled verification, and the manifest → chunk list conversion.
 * ==========================================================================*/

import { section, test, eq, ok, close, rejects, done, serveDir, tmpDir } from './testkit.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SKStream = require('../js/stream.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = tmpDir('stream');
await fsp.mkdir(TMP, { recursive: true });

function chunkBytes(index, size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 97) buf[i] = (index + i) & 0xff;
  return buf;
}

function writeChunks(dir, count, size) {
  const parts = [];
  const payloads = [];
  for (let i = 0; i < count; i++) {
    const data = chunkBytes(i, size);
    payloads.push(data);
    const file = path.join(dir, 'chunk' + (i + 1) + '.bin');
    fs.writeFileSync(file, data);
    parts.push({ url: 'chunk' + (i + 1) + '.bin', bytes: data.length });
  }
  return { parts, expected: Buffer.concat(payloads) };
}

/* ---------------------------------------------------------------- *
 * A sink that behaves like OPFS but lives in memory: positional writes,
 * resume support and the same bookkeeping API as the real sinks.
 * ---------------------------------------------------------------- */

class FakeOpfsSink {
  constructor(opts = {}) {
    this.dir = opts.dirName || 'fake';
    this.name = opts.name;
    this.buffer = opts.initial || null; // what pretends to already be on disk
    this.files = new Map(); // text files (.ok / .building)
    this.sequentialOnly = false;
    this.writes = 0;
  }
  async open(resume) {
    if (!resume) this.buffer = null;
    return { size: this.buffer ? this.buffer.length : 0, canResume: !!this.buffer && this.buffer.length > 0 };
  }
  async write(u8, at) {
    this.writes++;
    if (!this.buffer) this.buffer = Buffer.alloc(0);
    if (at + u8.byteLength > this.buffer.length) {
      const bigger = Buffer.alloc(at + u8.byteLength);
      this.buffer.copy(bigger, 0);
      this.buffer = bigger;
    }
    Buffer.from(u8).copy(this.buffer, at);
  }
  async finish() {
    return { size: this.buffer ? this.buffer.length : 0 };
  }
  async abort() {}
  destroy() {}
  async getFile() {
    return this.buffer ? new Blob([this.buffer]) : null;
  }
  async stat(name) {
    if (name === this.name) return this.buffer ? this.buffer.length : -1;
    const text = this.files.get(name);
    return text ? text.length : -1;
  }
  async putText(name, text) {
    this.files.set(name, text);
  }
  async getText(name) {
    return this.files.has(name) ? this.files.get(name) : null;
  }
  async remove(name) {
    if (name === this.name) this.buffer = null;
    this.files.delete(name);
  }
}

const logs = [];

async function run(opts) {
  logs.length = 0;
  return SKStream.ensureDataset({
    onLog: (line) => logs.push(line),
    writerFactory: async () => opts.sink,
    ...opts.ensure,
  });
}

section('assembly');

await test('streams every chunk into the sink byte for byte', async () => {
  const dir = path.join(TMP, 'a');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 5, 1024);
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 'game.bin' });
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'game.bin',
      buildId: 'build-1',
      mime: 'application/octet-stream',
    },
  });
  eq(set.kind, 'opfs', 'result kind');
  eq(sink.buffer.length, expected.length, 'assembled size');
  ok(sink.buffer.equals(expected), 'assembled bytes match the source');
  eq(sink.files.get('game.bin.ok').startsWith('build-1'), true, 'completion marker written');
  server.stop();
});

await test('reports progress with a part counter and a throughput estimate', async () => {
  const dir = path.join(TMP, 'progress');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 4, 512);
  const server = await serveDir(dir);
  const seen = [];
  const sink = new FakeOpfsSink({ name: 'p.bin' });
  await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'p.bin',
      buildId: 'b',
      onProgress: (p) => seen.push(p),
    },
  });
  ok(seen.length > 0, 'progress callbacks fired');
  const last = seen[seen.length - 1];
  eq(last.total, expected.length, 'total reported');
  eq(last.parts, 4, 'chunk count reported');
  eq(last.loaded, expected.length, 'final loaded count');
  ok(typeof last.bytesPerSecond === 'number', 'throughput reported');
  server.stop();
});

section('checking the data');

await test('a chunk that is a different size than the manifest claims is refused, not downloaded', async () => {
  const dir = path.join(TMP, 'mismatch');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 2, 256);
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 'm.bin' });
  const message = await rejects(
    run({
      sink,
      ensure: {
        parts: [{ url: server.url + parts[0].url, bytes: parts[0].bytes }, { url: server.url + parts[1].url, bytes: 999 }],
        expectedSize: 1255,
        cacheKey: 'm.bin',
        buildId: 'b',
      },
    }),
    /manifest/,
    'loading with a wrong manifest size'
  );
  ok(/999 in the manifest/.test(message), 'the message names the manifest size: ' + message);
  server.stop();
});

await test('a short chunk fails the load and leaves no completion marker', async () => {
  // Serve chunk 2 truncated: the fetch succeeds, the bytes are fewer than promised.
  const dir = path.join(TMP, 'short');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 2, 256);
  fs.truncateSync(path.join(dir, 'chunk2.bin'), 100);
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 's.bin' });
  await rejects(
    run({
      sink,
      ensure: {
        parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
        expectedSize: 512,
        cacheKey: 's.bin',
        buildId: 'b',
      },
    }),
    /ended early|manifest/,
    'loading a short chunk'
  );
  ok(!sink.files.has('s.bin.ok'), 'no completion marker for a broken download');
  server.stop();
});

await test('a missing chunk that comes back on a retry is tolerated', async () => {
  const dir = path.join(TMP, 'retry');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 3, 128);
  let failures = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('chunk2.bin') && failures === 0) {
      failures++;
      throw new Error('connection reset');
    }
    return realFetch(url, opts);
  };
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 'r.bin' });
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'r.bin',
      buildId: 'b',
    },
  });
  globalThis.fetch = realFetch;
  eq(failures, 1, 'the flaky chunk really failed once');
  eq(set.size, expected.length, 'the file still assembled fully');
  ok(sink.buffer.equals(expected), 'and its bytes are right');
  server.stop();
});

section('cache + resume');

await test('a complete file with a matching marker is used without any download', async () => {
  const dir = path.join(TMP, 'cache');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 3, 64);
  const sink = new FakeOpfsSink({ name: 'c.bin', initial: expected });
  await sink.putText('c.bin.ok', 'build-9 2026-01-01');
  let requests = 0;
  const countingFetch = async (url, opts) => {
    requests++;
    return globalThis.fetch(url, opts);
  };
  const server = await serveDir(dir);
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'c.bin',
      buildId: 'build-9',
      fetchImpl: countingFetch,
    },
  });
  eq(set.kind, 'opfs-cached', 'cache hit');
  eq(requests, 0, 'network requests made');
  server.stop();
});

await test('an interrupted download resumes from the byte it reached', async () => {
  const dir = path.join(TMP, 'resume');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 4, 256);
  // Pretend chunk 1 and half of chunk 2 already made it to disk.
  const half = expected.subarray(0, 256 + 128);
  const sink = new FakeOpfsSink({ name: 're.bin', initial: Buffer.from(half) });
  await sink.putText('re.bin.building', 'build-resume');
  const server = await serveDir(dir);
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 're.bin',
      buildId: 'build-resume',
    },
  });
  eq(set.size, expected.length, 'assembled size after resume');
  ok(sink.buffer.equals(expected), 'the resumed file is byte-exact');
  ok(logs.some((l) => /resuming download at/.test(l)), 'the log says it resumed: ' + logs.join(' | '));
  server.stop();
});

await test('a file from another build id is discarded instead of trusted', async () => {
  const dir = path.join(TMP, 'stale');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 2, 32);
  const sink = new FakeOpfsSink({ name: 'st.bin', initial: Buffer.alloc(expected.length, 0x66) });
  await sink.putText('st.bin.ok', 'an-older-build');
  const server = await serveDir(dir);
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'st.bin',
      buildId: 'the-new-build',
    },
  });
  eq(set.kind, 'opfs', 'it downloaded instead of trusting the old file');
  ok(sink.buffer.equals(expected), 'and replaced the stale bytes');
  ok(logs.some((l) => /another build id/.test(l)), 'the log explains why');
  server.stop();
});

await test('a cached file whose sample digest does not match is downloaded again', async () => {
  const dir = path.join(TMP, 'verify');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 2, 2048);
  const sink = new FakeOpfsSink({ name: 'v.bin', initial: Buffer.alloc(expected.length, 0x00) });
  await sink.putText('v.bin.ok', 'build-v');
  const integrity = {
    size: expected.length,
    headSha256: crypto.createHash('sha256').update(expected.subarray(0, 4096)).digest('hex'),
    tailSha256: crypto.createHash('sha256').update(expected.subarray(-4096)).digest('hex'),
    probeBytes: 4096,
  };
  const server = await serveDir(dir);
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'v.bin',
      buildId: 'build-v',
      manifest: integrity,
      verify: 'sample',
    },
  });
  eq(set.kind, 'opfs', 'the bad cache was rebuilt');
  eq(set.verify.mode, 'sample', 'verification ran in sample mode');
  ok(sink.buffer.equals(expected), 'the file is now the real one');
  ok(logs.some((l) => /failed the sample check/.test(l)), 'the log explains the rebuild');
  server.stop();
});

await test('verifyFile catches a size mismatch and accepts a matching file', async () => {
  const blob = new Blob([Buffer.alloc(1000, 3)]);
  const bad = await SKStream.verifyFile(blob, { total: 999 }, 'size');
  eq(bad.ok, false, 'size mismatch detected');
  const good = await SKStream.verifyFile(blob, { total: 1000 }, 'size');
  eq(good.ok, true, 'matching size accepted');
});

section('manifest plumbing');

await test('partsFromManifest turns chunk descriptions into fetchable parts', () => {
  const parts = SKStream.partsFromManifest(
    [
      { path: 'Build/silksong.data.part1', bytes: 10 },
      { path: 'Build/silksong.data.part2', bytes: 5 },
    ],
    'https://example.test/'
  );
  eq(parts.length, 2, 'part count');
  eq(parts[0].url, 'https://example.test/Build/silksong.data.part1', 'url');
  eq(parts[1].bytes, 5, 'size carried over');
});

await test('the in-memory fallback still produces a usable blob when there is no OPFS', async () => {
  const dir = path.join(TMP, 'mem');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 2, 128);
  const server = await serveDir(dir);
  const set = await SKStream.ensureDataset({
    parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
    expectedSize: expected.length,
    cacheKey: 'mem.bin',
    buildId: 'b',
    mime: 'application/octet-stream',
    preferDisk: false, // force the RAM path
  });
  eq(set.kind, 'memory', 'fell back to memory');
  eq(set.size, expected.length, 'assembled size');
  ok(String(set.url).startsWith('blob:'), 'a blob URL was handed back');
  set.dispose();
  server.stop();
});

await fsp.rm(TMP, { recursive: true, force: true });
await done('stream tests');
