/* ============================================================================
 * test-stream.mjs — the chunked loader
 * ----------------------------------------------------------------------------
 *   node web/tools/test-stream.mjs
 *
 * Covers: byte-exact assembly, a part that disagrees with the manifest (in
 * either direction, with or without a usable Content-Length), a CDN that puts a
 * transfer encoding on the response, a short chunk, retries after a broken part,
 * resume from what is already on disk, cache reuse with the completion marker,
 * cache invalidation when the build id changes, sampled verification, and the
 * manifest → chunk list conversion.
 *
 * Plus the exclusive OPFS cache lock: a cache file still locked by a previous
 * holder (WebKit's InvalidStateError and Chromium's NoModificationAllowedError
 * spellings alike) is retried for a few seconds instead of failing the load, a
 * permanently locked file produces a message a player can act on, and a failed
 * or cancelled download releases the lock on the way out instead of leaving
 * the file stuck for the *next* attempt.
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

/* A sink whose open() refuses the exclusive OPFS lock the way a real browser
 * does while a previous holder has not let go yet: WebKit says
 * InvalidStateError ("The object is in an invalid state."), Chromium says
 * NoModificationAllowedError. It also counts aborts, which is how a test can
 * see whether the loader released the lock after a failure. */
class LockySink extends FakeOpfsSink {
  constructor(opts = {}) {
    super(opts);
    this.lockFailures = opts.lockFailures || 0; // Infinity = never lets go
    this.lockName = opts.lockName || 'InvalidStateError';
    this.lockMessage = opts.lockMessage || 'The object is in an invalid state.';
    this.openAttempts = 0;
    this.aborts = 0;
  }
  async open(resume) {
    this.openAttempts++;
    if (this.lockFailures > 0) {
      this.lockFailures--;
      const err = new Error(this.lockMessage);
      err.name = this.lockName;
      throw err;
    }
    return super.open(resume);
  }
  async abort() {
    this.aborts++;
    return super.abort();
  }
}

/* Keep the lock backoff out of the test runtime: the real one waits seconds.
 * A loader that predates the retry has no OPEN_LOCK to tune, so this becomes a
 * no-op and the tests then fail on behaviour instead of on a missing internal. */
function fastLockRetries(attempts = 5) {
  const lock = SKStream._internals.OPEN_LOCK;
  if (!lock) return () => {};
  const saved = { attempts: lock.attempts, delay: lock.delay };
  lock.attempts = attempts;
  lock.delay = 0;
  return () => {
    lock.attempts = saved.attempts;
    lock.delay = saved.delay;
  };
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

await test('a chunk the server reports as bigger than the manifest is refused, not written', async () => {
  // Compression can only shrink the wire size, so a declared size *above* the
  // manifest is a real mismatch: refuse it before a single byte reaches disk.
  const dir = path.join(TMP, 'mismatch');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 1, 256);
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 'm.bin' });
  const message = await rejects(
    run({
      sink,
      ensure: {
        parts: [{ url: server.url + parts[0].url, bytes: 100 }],
        expectedSize: 100,
        cacheKey: 'm.bin',
        buildId: 'b',
      },
    }),
    /manifest/,
    'loading with a manifest smaller than the file'
  );
  ok(/256 bytes on the server but only 100 in the manifest/.test(message), 'the message names both sizes: ' + message);
  eq(sink.writes, 0, 'nothing was written for the refused part');
  eq(sink.buffer, null, 'and no partial file was started');
  server.stop();
});

await test('a chunk bigger than the manifest with no usable header is refused on the bytes received', async () => {
  // Same mismatch, but the response carries no Content-Length at all (chunked
  // transfer), so only counting the bytes that arrive can catch it — and it must
  // not burn the retry budget, because a wrong manifest will not heal itself.
  const dir = path.join(TMP, 'oversize');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 1, 512);
  const server = await serveDir(dir);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const res = await realFetch(url, opts);
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  const sink = new FakeOpfsSink({ name: 'o.bin' });
  const message = await rejects(
    run({
      sink,
      ensure: {
        parts: [{ url: server.url + parts[0].url, bytes: 256 }],
        expectedSize: 256,
        cacheKey: 'o.bin',
        buildId: 'b',
      },
    }),
    /bigger than the manifest/,
    'loading a part that overruns the manifest'
  );
  globalThis.fetch = realFetch;
  ok(/bytes received, 256 expected/.test(message), 'the message names the manifest size: ' + message);
  eq(calls, 1, 'a manifest mismatch is permanent, so it was not retried');
  server.stop();
});

await test('a manifest size the server never reaches still fails the load', async () => {
  const dir = path.join(TMP, 'toobig');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 1, 256);
  const server = await serveDir(dir);
  const sink = new FakeOpfsSink({ name: 't.bin' });
  const message = await rejects(
    run({
      sink,
      ensure: {
        parts: [{ url: server.url + parts[0].url, bytes: 999 }],
        expectedSize: 999,
        cacheKey: 't.bin',
        buildId: 'b',
      },
    }),
    /ended early/,
    'loading with a manifest bigger than the file'
  );
  ok(/256\/999 bytes/.test(message), 'the message reports what arrived: ' + message);
  ok(!sink.files.has('t.bin.ok'), 'no completion marker for a short download');
  server.stop();
});

await test('a CDN that compresses the transfer loads fine despite a smaller Content-Length', async () => {
  // The regression this exists for: a cross-origin CDN answers with
  // Content-Encoding, so Content-Length describes the encoded body while the
  // page reads decoded bytes. Content-Encoding is not CORS-exposed, so the
  // loader cannot tell that apart from a short file — it has to go by the bytes
  // that arrive. This used to abort a good download with "rebuild or re-run
  // prepare-build.mjs".
  const dir = path.join(TMP, 'encoded');
  await fsp.mkdir(dir, { recursive: true });
  const { parts, expected } = writeChunks(dir, 3, 512);
  const server = await serveDir(dir);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const res = await realFetch(url, opts);
    const headers = new Headers(res.headers);
    const real = Number(headers.get('content-length') || 0);
    if (real) headers.set('content-length', String(Math.floor(real * 0.4)));
    headers.set('content-encoding', 'gzip');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  const sink = new FakeOpfsSink({ name: 'e.bin' });
  const set = await run({
    sink,
    ensure: {
      parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
      expectedSize: expected.length,
      cacheKey: 'e.bin',
      buildId: 'b',
    },
  });
  globalThis.fetch = realFetch;
  eq(set.size, expected.length, 'the archive assembled to the manifest size');
  ok(sink.buffer.equals(expected), 'and its bytes are the decoded ones, byte for byte');
  ok(sink.files.get('e.bin.ok').startsWith('b'), 'completion marker written');
  ok(
    logs.some((line) => /compressed transfer/.test(line)),
    'the encoded transfer was noticed in the log instead of being fatal'
  );
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

section('the exclusive cache lock');

await test('a cache file still locked by the previous session opens on a retry', async () => {
  // What Safari does after a reload: the page that just left still holds the
  // exclusive lock, and WebKit releases it asynchronously.
  const restore = fastLockRetries();
  try {
    const dir = path.join(TMP, 'lock-retry');
    await fsp.mkdir(dir, { recursive: true });
    const { parts, expected } = writeChunks(dir, 2, 512);
    const server = await serveDir(dir);
    const sink = new LockySink({ name: 'l.bin', lockFailures: 2 });
    const set = await run({
      sink,
      ensure: {
        parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
        expectedSize: expected.length,
        cacheKey: 'l.bin',
        buildId: 'b',
      },
    });
    eq(sink.openAttempts, 3, 'the open was retried until the lock was released');
    eq(set.size, expected.length, 'and the archive still assembled');
    ok(sink.buffer.equals(expected), 'byte for byte');
    ok(logs.some((line) => /still locked/.test(line)), 'the wait was logged: ' + logs.join(' | '));
    server.stop();
  } finally {
    restore();
  }
});

await test('a Chromium-style lock refusal is retried the same way', async () => {
  const restore = fastLockRetries();
  try {
    const dir = path.join(TMP, 'lock-chromium');
    await fsp.mkdir(dir, { recursive: true });
    const { parts, expected } = writeChunks(dir, 1, 512);
    const server = await serveDir(dir);
    const sink = new LockySink({
      name: 'c.bin',
      lockFailures: 1,
      lockName: 'NoModificationAllowedError',
      lockMessage:
        "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be " +
        'created if there is another open Access Handle or Writable stream associated with the same file.',
    });
    await run({
      sink,
      ensure: {
        parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
        expectedSize: expected.length,
        cacheKey: 'c.bin',
        buildId: 'b',
      },
    });
    eq(sink.openAttempts, 2, 'the other engine\'s spelling of "locked" is retried too');
    ok(sink.buffer.equals(expected), 'and the bytes are right');
    server.stop();
  } finally {
    restore();
  }
});

await test('a lock that never releases explains itself instead of blaming the cache', async () => {
  const restore = fastLockRetries(3);
  try {
    const sink = new LockySink({ name: 'x.bin', lockFailures: Infinity });
    const message = await rejects(
      run({
        sink,
        ensure: {
          parts: [{ url: 'http://127.0.0.1:1/never-fetched', bytes: 10 }],
          expectedSize: 10,
          cacheKey: 'x.bin',
          buildId: 'b',
          allowMemoryFallback: false, // what the community build asks for
        },
      }),
      /locked by another Safari tab/,
      'opening a cache file that stays locked'
    );
    eq(sink.openAttempts, 3, 'it kept trying for the whole backoff');
    ok(/InvalidStateError/.test(message), 'the message names the DOMException: ' + message);
    ok(/Clear cached game data/.test(message), 'and offers the way out: ' + message);
    ok(!/prepare-build/.test(message), 'without telling the player to rebuild anything');
    ok(sink.aborts >= 1, 'the sink was released before the error was thrown');
  } finally {
    restore();
  }
});

await test('a failed download releases the cache file instead of leaving it locked', async () => {
  // The leak behind the bug: a failure used to rethrow with the exclusive lock
  // still held, so the *next* attempt could not open the file at all.
  const dir = path.join(TMP, 'release');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 1, 512);
  const server = await serveDir(dir);
  const sink = new LockySink({ name: 'rel.bin' });
  await rejects(
    run({
      sink,
      ensure: {
        parts: [{ url: server.url + parts[0].url, bytes: 256 }], // the file really is 512
        expectedSize: 256,
        cacheKey: 'rel.bin',
        buildId: 'b',
        allowMemoryFallback: false,
      },
    }),
    /manifest/,
    'loading a part that overruns the manifest'
  );
  eq(sink.aborts, 1, 'the exclusive lock was released on the way out');
  server.stop();
});

await test('cancelling a download releases the cache file too', async () => {
  const dir = path.join(TMP, 'cancel');
  await fsp.mkdir(dir, { recursive: true });
  const { parts } = writeChunks(dir, 3, 512);
  const server = await serveDir(dir);
  const controller = new AbortController();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    if (calls === 2) controller.abort(); // the page's stall watchdog does exactly this
    return realFetch(url, opts);
  };
  const sink = new LockySink({ name: 'canc.bin' });
  await rejects(
    run({
      sink,
      ensure: {
        parts: parts.map((p) => ({ url: server.url + p.url, bytes: p.bytes })),
        expectedSize: 1536,
        cacheKey: 'canc.bin',
        buildId: 'b',
        signal: controller.signal,
        allowMemoryFallback: false,
      },
    }),
    /aborted/i,
    'cancelling mid-download'
  );
  globalThis.fetch = realFetch;
  eq(sink.aborts, 1, 'a cancelled download does not leave the file locked');
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
