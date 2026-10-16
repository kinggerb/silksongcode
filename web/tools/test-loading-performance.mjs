import { section, test, eq, ok, rejects, done } from './testkit.mjs';
import { browserStorage } from './browser-storage-fixture.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const stream = require('../js/stream.js'), community = require('../js/community-build.js');
const cache = require('../js/asset-cache.js'), startup = require('../js/unity-startup.js'), zip = require('../js/zip.min.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const common = { caps: { opfs: true, workers: true }, cacheKey: 'game.zip', buildId: 'test-build',
  workerUrl: 'js/writer.js', allowMemoryFallback: false, verify: 'size', retryAttempts: 0 };

section('production worker / durable resume regressions');
await test('a completed cache hit is read-only: no probes, truncation, or downloads', async () => {
  const disk = browserStorage({ 'game.zip': 'ABCD', 'game.zip.ok': 'test-build completed' });
  try {
    const result = await stream.ensureDataset({ ...common, expectedSize: 4, parts: [{ url: 'https://test/part', bytes: 4 }], fetchImpl: () => { throw new Error('must not download'); } });
    eq(result.kind, 'opfs-cached'); eq(await result.file.text(), 'ABCD');
    eq(disk.messages.length, 0, 'cache hit must not start a writer'); result.dispose();
  } finally { disk.restore(); }
});
await test('a cache miss probes a separate file and acknowledges shutdown promptly', async () => {
  const disk = browserStorage({ 'game.zip': 'old interrupted data' }); const start = performance.now();
  try {
    const result = await stream.ensureDataset({ ...common, expectedSize: 4, parts: [{ url: 'https://test/part', bytes: 4 }], fetchImpl: async () => new Response('ABCD') });
    const opens = disk.messages.filter(msg => msg.type === 'open');
    eq(opens[0].name, 'game.zip.probe'); eq(opens[0].expected, 0);
    eq(opens[1].name, 'game.zip'); eq(await result.file.text(), 'ABCD');
    ok(performance.now() - start < 2000, 'shutdown should not hit the old five-second timeout');
    ok(!disk.files.has('game.zip.probe'), 'probe deleted after its handle is closed');
    result.dispose(); eq(disk.locks.size, 0, 'all handles released');
  } finally { disk.restore(); }
});
await test('later parts finishing first never turn a sparse file into a cache hit', async () => {
  const disk = browserStorage();
  const parts = Array.from({ length: 3 }, (_, i) => ({ url: 'https://test/' + i, bytes: 4 }));
  try {
    await rejects(stream.ensureDataset({ ...common, parts, expectedSize: 12, concurrency: 3,
      fetchImpl: async url => { if (url.endsWith('/0')) { await delay(25); throw new Error('interrupted'); } return new Response(url.endsWith('/1') ? 'BBBB' : 'CCCC'); },
    }), /interrupted/);
    eq(disk.files.get('game.zip').length, 12, 'file has final size but still contains a hole');
    ok(!disk.files.has('game.zip.ok'), 'no premature complete marker');
    const journal = JSON.parse(disk.files.get('game.zip.building').toString());
    eq(journal.completed.join(), 'false,true,true');
    const requests = [];
    const result = await stream.ensureDataset({ ...common, parts, expectedSize: 12, concurrency: 3,
      fetchImpl: async url => { requests.push(url); return new Response('AAAA'); },
    });
    eq(requests.join(), 'https://test/0', 'only missing part fetched');
    eq(await result.file.text(), 'AAAABBBBCCCC'); result.dispose();
  } finally { disk.restore(); }
});
await test('an unmarked full-size file with no coverage journal is rebuilt', async () => {
  const disk = browserStorage({ 'game.zip': '\0\0CD' }); let requests = 0;
  try {
    const result = await stream.ensureDataset({ ...common, expectedSize: 4, parts: [{ url: 'https://test/part', bytes: 4 }],
      fetchImpl: async () => { requests++; return new Response('ABCD'); } });
    eq(requests, 1); eq(await result.file.text(), 'ABCD'); result.dispose();
  } finally { disk.restore(); }
});
await test('build marker matching is exact, not a prefix', async () => {
  const disk = browserStorage({ 'game.zip': 'WRNG', 'game.zip.ok': 'test-build-new completed' });
  try {
    const result = await stream.ensureDataset({ ...common, expectedSize: 4, parts: [{ url: 'https://test/part', bytes: 4 }], fetchImpl: async () => new Response('ABCD') });
    eq(result.kind, 'opfs'); eq(await result.file.text(), 'ABCD'); result.dispose();
  } finally { disk.restore(); }
});
await test('six requested concurrent downloads actually run six, bounded at eight', async () => {
  const disk = browserStorage(); let active = 0, peak = 0;
  try {
    const result = await stream.ensureDataset({ ...common, expectedSize: 40, concurrency: 6,
      parts: Array.from({ length: 10 }, (_, i) => ({ url: 'https://test/' + i, bytes: 4 })),
      fetchImpl: async () => { active++; peak = Math.max(peak, active); await delay(15); active--; return new Response('ABCD'); } });
    eq(peak, 6); result.dispose();
  } finally { disk.restore(); }
});
await test('a stalled response body is cancelled and fails without hanging', async () => {
  const disk = browserStorage(); let cancelled = false;
  try {
    await rejects(stream.ensureDataset({ ...common, expectedSize: 4, stallTimeoutMs: 15,
      parts: [{ url: 'https://test/part', bytes: 4 }], fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), /stalled/);
    eq(cancelled, true); eq(disk.locks.size, 0);
  } finally { disk.restore(); }
});

function randomBytes(length, seed) {
  let x = seed; return Uint8Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 255; });
}
async function fixture() {
  const data = [randomBytes(210000, 123), randomBytes(800000, 789), randomBytes(150000, 456)];
  const writer = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
  for (let i = 0; i < data.length; i++) await writer.add('bundle-' + i + '.bundle', new zip.Uint8ArrayReader(data[i]), { level: 6 });
  const file = await writer.close(), bytes = new Uint8Array(await file.arrayBuffer()), partSize = 65536;
  const config = { schema: 1, source: 'https://github.com/test/game', base: 'https://build.test/', buildId: 'fixture-v1',
    unity: { loader: 'loader.js', framework: 'framework.js', data: 'game.data', wasm: 'game.wasm', streamingAssets: 'StreamingAssets' },
    fileBytes: { loader: 1, framework: 1, data: 1, wasm: 1 },
    assetArchive: { cacheKey: 'fixture.zip', slim: true, total: bytes.length, base: 'https://assets.test/', parts: [] } };
  for (let offset = 0; offset < bytes.length; offset += partSize) config.assetArchive.parts.push({ path: 'part-' + config.assetArchive.parts.length, bytes: Math.min(partSize, bytes.length - offset) });
  return { data, file, bytes, config, partSize };
}
section('lazy ZIP and extracted-cache end-to-end');
await test('only requested ZIP parts download; shared requests deduplicate; reopen uses disk', async () => {
  const disk = browserStorage(), f = await fixture(), requests = [];
  const options = { stream, cache, zip, bundleCacheBytes: 0, rateLimit: false, fetchImpl: async url => {
    const i = Number(new URL(url).pathname.match(/part-(\d+)/)[1]); requests.push(i);
    return new Response(f.bytes.slice(i * f.partSize, (i + 1) * f.partSize));
  } };
  try {
    const archive = await community.openLazyArchive(f.config, options);
    ok(requests.length < f.config.assetArchive.parts.length / 2, 'index does not download the whole archive');
    const entry = archive.entryFor('https://build.test/StreamingAssets/aa/WebGL/bundle-0.bundle');
    const [a, b] = await Promise.all([archive.blobFor(entry), archive.blobFor(entry)]);
    eq(a, b, 'same extraction in flight');
    ok(Buffer.from(await a.arrayBuffer()).equals(Buffer.from(f.data[0])), 'requested bundle byte exact');
    eq(new Set(requests).size, requests.length, 'each part fetched only once');
    ok(requests.length < f.config.assetArchive.parts.length / 2, 'unused middle bundles were not fetched');
    await archive.close();
    requests.length = 0;
    const again = await community.openLazyArchive(f.config, options);
    const blob = await again.blobFor(again.entryFor('https://build.test/StreamingAssets/bundle-0.bundle'));
    ok(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(f.data[0])));
    eq(requests.length, 0, 'warm reopen uses cached parts without network'); await again.close();
  } finally { disk.restore(); }
});
await test('verified extracted bundles survive reopen and avoid ZIP inflation', async () => {
  const disk = browserStorage(), f = await fixture();
  const options = { stream, cache, zip, rateLimit: false, bundleCacheBytes: 1000000, fetchImpl: async url => {
    const i = Number(new URL(url).pathname.match(/part-(\d+)/)[1]); return new Response(f.bytes.slice(i * f.partSize, (i + 1) * f.partSize));
  } };
  try {
    const archive = await community.openLazyArchive(f.config, options);
    const entry = archive.entries[0]; const blob = await archive.blobFor(entry);
    ok(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(f.data[0])));
    ok([...disk.files.keys()].some(key => /^unpacked-.*\.ok$/.test(key)), 'CRC-verified output published');
    await archive.close();
    const again = await community.openLazyArchive(f.config, options);
    const warmEntry = again.entries[0]; warmEntry.getData = () => { throw new Error('should not inflate cached bundle'); };
    const warm = await again.blobFor(warmEntry); eq(warm.size, f.data[0].length); await again.close();
    eq(disk.locks.size, 0);
  } finally { disk.restore(); }
});
await test('CRC failures never publish an extracted bundle completion marker', async () => {
  const disk = browserStorage();
  try {
    const c = cache.createBundleCache({ stream, buildId: 'bad-crc', budgetBytes: 1024 });
    await rejects(c.extract({ filename: 'bad.bundle', signature: 1, uncompressedSize: 4,
      async getData(writer) { await writer.init(); await writer.writeUint8Array(new Uint8Array([1, 2, 3, 4])); throw new Error('CRC mismatch'); } }, zip), /CRC/);
    ok(![...disk.files.keys()].some(key => /^unpacked-.*\.ok$/.test(key))); eq(disk.locks.size, 0);
  } finally { disk.restore(); }
});
await test('an existing complete ZIP is reused without downloading split parts', async () => {
  const f = await fixture();
  const disk = browserStorage({ 'fixture.zip': f.bytes, 'fixture.zip.ok': 'fixture-v1 completed' });
  try {
    const archive = await community.openLazyArchive(f.config, { stream, cache, zip, bundleCacheBytes: 0,
      fetchImpl: () => { throw new Error('no network expected'); } });
    const blob = await archive.blobFor(archive.entries[0]); eq(blob.size, f.data[0].length); await archive.close();
  } finally { disk.restore(); }
});
await test('a corrupt legacy complete ZIP recovers automatically without trusting its marker', async () => {
  const f = await fixture(), corrupt = Buffer.from(f.bytes);
  const view = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.length);
  const payload = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  corrupt[payload + 25] ^= 0xff;
  const disk = browserStorage({ 'fixture.zip': corrupt, 'fixture.zip.ok': 'fixture-v1 completed' });
  let requests = 0;
  try {
    const archive = await community.openLazyArchive(f.config, { stream, cache, zip, bundleCacheBytes: 0, rateLimit: false,
      fetchImpl: async url => { requests++; const i = Number(new URL(url).pathname.match(/part-(\d+)/)[1]); return new Response(f.bytes.slice(i * f.partSize, (i + 1) * f.partSize)); } });
    const blob = await archive.blobFor(archive.entries[0]);
    ok(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(f.data[0])));
    ok(requests > 0, 'bad legacy bytes were replaced with verified ZIP entry data');
    ok(!disk.files.has('fixture.zip.ok'), 'bad completion marker removed'); await archive.close();
  } finally { disk.restore(); }
});
await test('part reader rejects out-of-bounds reads', async () => {
  const reader = cache.createPartReader([{ bytes: 5 }], { stream, cacheKey: 'range', buildId: '1' });
  await rejects(reader.readUint8Array(-1, 2), /bounds/); await rejects(reader.readUint8Array(4, 2), /bounds/);
});
await test('a permanently refused mirror is skipped across subsequent parts', async () => {
  let mirrorRequests = 0;
  const fetchImpl = async url => { if (url.startsWith('https://mirror/')) mirrorRequests++; return new Response('', { status: 403 }); };
  const wrapped = community.mirrorFetch(fetchImpl, { base: 'https://primary/', mirror: 'https://mirror/' });
  await wrapped('https://primary/part1'); await wrapped('https://primary/part2'); eq(mirrorRequests, 1);
});

await test('direct bundle hosting uses its small index, not the ZIP, and validates CRC', async () => {
  const f = await fixture(), disk = browserStorage(), calls = [];
  try {
    const reader = new zip.ZipReader(new zip.BlobReader(f.file));
    const entries = (await reader.getEntries()).map(e => ({ filename: e.filename, signature: e.signature, uncompressedSize: e.uncompressedSize }));
    await reader.close(); f.config.assetArchive.index = 'zip-index.json';
    const options = { stream, cache, zip, bundleCacheBytes: 0, bundleBase: 'https://bundles.test/',
      fetchImpl: async url => { calls.push(String(url));
        if (String(url).endsWith('zip-index.json')) return new Response(JSON.stringify({ schema: 1, bytes: f.bytes.length, entries }));
        return new Response(f.data[0]);
      } };
    const archive = await community.openLazyArchive(f.config, options);
    const blob = await archive.blobFor(archive.entries[0]);
    ok(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(f.data[0])));
    eq(calls.length, 2); ok(!calls.some(url => /part-/.test(url)), 'no ZIP parts required in indexed direct mode');
    await archive.close();
    const wrong = await community.openLazyArchive(f.config, { ...options, fetchImpl: async url => {
      if (String(url).endsWith('zip-index.json')) return new Response(JSON.stringify({ schema: 1, bytes: f.bytes.length, entries }));
      return new Response(new Uint8Array(f.data[1].length));
    } });
    await rejects(wrong.blobFor(wrong.entries[1]), /CRC mismatch/);
    ok(![...disk.files.keys()].some(key => key.startsWith('direct-') && key.includes('bundle-1') && key.endsWith('.ok')), 'invalid direct output removed');
    await wrong.close();
  } finally { disk.restore(); }
});
await test('extracted cache stays within budget and never evicts files pinned this session', async () => {
  const disk = browserStorage();
  const entry = n => ({ filename: 'test-' + n, signature: n, uncompressedSize: 400,
    async getData(writer) { await writer.init(); await writer.writeUint8Array(new Uint8Array(400)); } });
  try {
    const first = cache.createBundleCache({ stream, buildId: 'budget-test', budgetBytes: 600 });
    ok(await first.extract(entry(1), zip));
    eq(await first.extract(entry(2), zip), null, 'falls back instead of evicting a pinned File');
    first.dispose(); // simulate closing the prior page (release its shared pins)
    const nextSession = cache.createBundleCache({ stream, buildId: 'budget-test', budgetBytes: 600 });
    ok(await nextSession.extract(entry(2), zip), 'old unpinned entries can be evicted');
    eq([...disk.files.keys()].filter(name => /^unpacked-[a-f0-9]{64}$/.test(name)).length, 1);
  } finally { disk.restore(); }
});
await test('part SHA-256 verification rejects changed host bytes', async () => {
  const disk = browserStorage();
  try {
    const reader = cache.createPartReader([{ url: 'https://test/part', bytes: 4, sha256: '0'.repeat(64) }], {
      stream, cacheKey: 'digest', buildId: 'test', fetchImpl: async () => new Response('ABCD'), retryAttempts: 0 });
    await rejects(reader.readUint8Array(0, 4), /verification/);
    ok(!disk.files.has('digest.part-1.ok'));
  } finally { disk.restore(); }
});
await test('index validation rejects mismatched archives, duplicate names and traversal', async () => {
  for (const entries of [[], [{ filename: '../bad', uncompressedSize: 1, signature: 0 }],
    [{ filename: 'good', uncompressedSize: -1, signature: 0 }],
    [{ filename: 'same', uncompressedSize: 1, signature: 0 }, { filename: 'same', uncompressedSize: 1, signature: 0 }]]) {
    await rejects(Promise.resolve().then(() => community.validateBundleIndex({ schema: 1, bytes: 100, entries }, 100)), /index/);
  }
});
await test('header watchdog aborts an unresponsive host instead of waiting indefinitely', async () => {
  let aborted = false;
  const wrapped = community.timedFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }), 15);
  await rejects(wrapped('https://test/stall'), /stalled/); eq(aborted, true);
});

section('native Wasm startup and safe loader patch');
const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
await test('gzip or browser-decoded Wasm stream-compiles with correct MIME', async () => {
  for (const body of [wasm, gzipSync(wasm)]) {
    const response = await startup.wasmResponse(new Response(body));
    eq(response.headers.get('Content-Type'), 'application/wasm');
    ok(await WebAssembly.compileStreaming(response));
  }
});
await test('Wasm encoding sniffing handles split headers and rejects corrupt files', async () => {
  const body = new ReadableStream({ start(c) { for (const b of wasm) c.enqueue(Uint8Array.of(b)); c.close(); } });
  ok(await WebAssembly.compileStreaming(await startup.wasmResponse(new Response(body))));
  await rejects(startup.wasmResponse(new Response('bad encoding')), /encoding/);
  await rejects(startup.wasmResponse(new Response(new Uint8Array([0, 1]))), /truncated/);
});
await test('unsupported loader patterns fall back rather than guessing a patch', async () => {
  await rejects(Promise.resolve().then(() => startup.patchLoader('new unknown loader')), /not unique/);
  const patched = startup.patchLoader('var A = { hasUnityMarker: function(e) {\n                return true\n            } }; function P() { Promise.all([Promise.resolve(0).then(function(){}), T("codeUrl")]); }');
  ok(patched.includes('b.instantiateWasm ? Promise.resolve(null)')); new vm.Script(patched);
});
await test('a changed upstream digest uses the original loader and never installs a patch', async () => {
  const source = JSON.parse(fs.readFileSync(new URL('../community-build.json', import.meta.url)));
  const runtime = await startup.prepare(source, { fetchImpl: async url => new Response(url.endsWith('loader.js') ? 'changed loader' : wasm), document: null });
  eq(runtime.loaderUrl, source.base + source.unity.loader);
  const config = {}; runtime.configure(config); eq(config.instantiateWasm, undefined); runtime.dispose();
});
await done('loading performance tests');
