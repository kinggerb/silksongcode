/* Tests for the external community-build descriptor and lazy ZIP mount. */
import { section, test, eq, ok, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makePlaceholderVideo } from './unity-webdata.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const community = require('../js/community-build.js');
const zip = require('../js/zip.min.js');
const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));

// The commit the slim archive was published from, and the two hosts that serve
// its parts. Both are pinned to it: `slim-assets` is a tag, and a tag can move.
const PIN = '27e01644b547d353d997ea6b15f0e2d56ef8eb4b';
const RAW_BASE = 'https://raw.githubusercontent.com/kinggerb/silksongcode/' + PIN + '/parts/';
const MIRROR_BASE = 'https://cdn.jsdelivr.net/gh/kinggerb/silksongcode@' + PIN + '/parts/';

/**
 * A fetch stub that answers per host and records every request. A verdict is
 * a status to answer with, `ok`, or `unreachable` to throw the way a host that
 * cannot be reached at all does.
 */
function stubFetch(verdicts) {
  const requests = [];
  const impl = async (url, init) => {
    const target = String(url);
    requests.push({ url: target, init });
    const verdict = verdicts[new URL(target).host] || 'ok';
    if (verdict === 'unreachable') throw new TypeError('Failed to fetch');
    if (verdict === 'ok') return new Response('part bytes', { status: 200 });
    return new Response('refused', { status: verdict });
  };
  return { impl, requests };
}

const urlsOf = (stub) => stub.requests.map((r) => r.url);
const hostCount = (stub, host) => stub.requests.filter((r) => new URL(r.url).host === host).length;

section('source descriptor');

await test('the pinned community source has a consistent resumable archive plan', () => {
  eq(community.validate(source), source, 'valid configuration returned');
  eq(source.commit, 'bcbe014765f2f6ca4b1d82ac25755a0299a600ab', 'source commit pinned');
  eq(source.assetArchive.parts.length, 75, 'all remote archive shards listed');
  eq(source.assetArchive.total, 1252071320, 'total size matches shard sizes');
  const parts = community.parts(source, 'https://assets.example/game/');
  eq(parts[0].url, 'https://assets.example/game/WebGL.zip.part1', 'first shard resolves at the override base');
  eq(parts.at(-1).bytes, 10557336, 'last shard size is exact');
  eq(community.parts(source)[0].url, source.assetArchive.base + 'WebGL.zip.part1', 'the slim archive names its own base');
  eq(source.assetArchive.total < 1400000000, true, 'the published archive is the slim one, not the 1986.6 MB original');
});

await test('the archive parts come from GitHub raw, with jsDelivr as the mirror', () => {
  // jsDelivr refuses a GitHub package larger than its own limit (150 MB, and
  // this archive is 1.19 GB) with `403 Package size exceeded the configured
  // limit` — but only for the parts it has not already cached, so a download
  // gets a few parts in and then dies. raw.githubusercontent.com serves any
  // committed blob under 100 MB and a part is 16 MiB, so it leads now and
  // jsDelivr is the fallback. The bytes did not change; only the order did.
  eq(source.assetArchive.base, RAW_BASE, 'the archive leads with GitHub raw');
  eq(source.assetArchive.mirror, MIRROR_BASE, 'and keeps jsDelivr as its mirror');
  eq(new URL(source.assetArchive.base).host, 'raw.githubusercontent.com', 'base host');
  eq(new URL(source.assetArchive.mirror).host, 'cdn.jsdelivr.net', 'mirror host');
  ok(source.assetArchive.base.includes(PIN), 'the base is pinned to the publish commit');
  ok(source.assetArchive.mirror.includes(PIN), 'and so is the mirror');
  ok(!source.assetArchive.base.includes('slim-assets'), 'pinned to a commit, not to the moving slim-assets tag');
  // The same relative path has to exist on both hosts, or the fallback would
  // ask for a file that is not there. Part 6 is the one that used to 403.
  eq(community.parts(source)[5].url, RAW_BASE + 'WebGL.zip.part6', 'part 6 resolves on GitHub raw');
  // …and everything else about the archive is exactly as it was published.
  eq(source.assetArchive.total, 1252071320, 'total unchanged');
  eq(source.assetArchive.parts.length, 75, 'parts unchanged');
  eq(source.assetArchive.slim, true, 'slim unchanged');
  eq(source.assetArchive.cacheKey, 'webgl-assets-bcbe014.zip', 'cacheKey unchanged');
  eq(source.assetArchive.mime, 'application/zip', 'mime unchanged');
  eq(
    source.base,
    'https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@bcbe014765f2f6ca4b1d82ac25755a0299a600ab/',
    'the Unity build files stay on their own CDN — only the archive moved'
  );
});

await test('a descriptor with an unusable archive host is refused', () => {
  for (const bad of [42, '', {}, null]) {
    for (const field of ['base', 'mirror']) {
      const copy = JSON.parse(JSON.stringify(source));
      copy.assetArchive[field] = bad;
      let refused = false;
      try {
        community.validate(copy);
      } catch (error) {
        refused = new RegExp('invalid asset archive ' + field).test(error.message);
      }
      eq(refused, true, 'a ' + field + ' of ' + JSON.stringify(bad) + ' cannot be downloaded from');
    }
  }
  const optional = JSON.parse(JSON.stringify(source));
  delete optional.assetArchive.mirror;
  eq(community.validate(optional), optional, 'the mirror is optional: without one the descriptor is still valid');
});

await test('a descriptor with incorrect archive arithmetic is refused', () => {
  const bad = JSON.parse(JSON.stringify(source));
  bad.assetArchive.total++;
  let refused = false;
  try { community.validate(bad); } catch (error) { refused = /total does not match/.test(error.message); }
  eq(refused, true, 'mismatched total cannot be downloaded');
});

await test('the archive downloader always requires disk-backed storage', async () => {
  let seen;
  const fakeStream = {
    ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; },
  };
  await community.ensureArchive(source, { stream: fakeStream, base: 'https://assets.example/game/' });
  eq(seen.allowMemoryFallback, false, 'a 2 GB archive is never allowed to spill into RAM');
  eq(seen.preferDisk, true, 'OPFS is preferred');
  eq(seen.expectedSize, source.assetArchive.total, 'expected size carried through');
  eq(seen.parts.length, 75, 'all shards provided to the resumable streamer');
});

section('the mirrored archive hosts');

await test('a part the archive host refuses with 403 is asked for again from the mirror', async () => {
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6', { cache: 'default' });
  eq(res.ok, true, 'the download still gets its bytes');
  eq(stub.requests.length, 2, 'exactly two requests: the refused one and the retry');
  eq(urlsOf(stub)[0], RAW_BASE + 'WebGL.zip.part6', 'the archive host is asked first');
  eq(urlsOf(stub)[1], MIRROR_BASE + 'WebGL.zip.part6', 'the mirror is asked for the very same path');
  eq(stub.requests[1].init, stub.requests[0].init, 'and with the very same request options');
});

await test('a part whose host cannot be reached at all is asked for from the mirror', async () => {
  // A host that is blocked, off the network or fails TLS throws instead of
  // answering, and there is no status to look at — the mirror is still the
  // only second opinion there is.
  const stub = stubFetch({ 'raw.githubusercontent.com': 'unreachable', 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 200, 'the mirror answered');
  eq(urlsOf(stub).join(' | '), RAW_BASE + 'WebGL.zip.part6 | ' + MIRROR_BASE + 'WebGL.zip.part6', 'one retry, at the same path');
});

await test('a retry consults the mirror once and keeps its verdict', async () => {
  // Two hosts that both say no must not be given a third opinion each: the
  // download would ping-pong for ever instead of reporting the failure.
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.ok, false, 'the refusal reaches the downloader');
  eq(res.status, 403, 'as the mirror\'s own answer');
  eq(hostCount(stub, 'raw.githubusercontent.com'), 1, 'the archive host was asked once');
  eq(hostCount(stub, 'cdn.jsdelivr.net'), 1, 'and the mirror was asked once — no ping-pong');
});

await test('the retry covers refusals, missing parts, rate limits and server errors', async () => {
  for (const status of [403, 404, 408, 429, 500, 502, 503, 504]) {
    const stub = stubFetch({ 'raw.githubusercontent.com': status, 'cdn.jsdelivr.net': 'ok' });
    const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
    const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
    eq(res.status, 200, 'HTTP ' + status + ' fell back to the mirror');
    eq(stub.requests.length, 2, 'HTTP ' + status + ' retried exactly once');
  }
  // A 400 is about the request, not about the host: the mirror would answer it
  // the same way, so there is nothing to gain by asking.
  const stub = stubFetch({ 'raw.githubusercontent.com': 400, 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 400, 'a 400 is handed back as it is');
  eq(stub.requests.length, 1, 'and not retried');
});

await test('a URL that is already on the mirror is never mirrored', async () => {
  // `?archiveBase=<the mirror>` puts the download on jsDelivr to begin with.
  // Falling back to the host that just refused would be pointless — and would
  // loop, since the "mirror" of a mirror URL is that same URL.
  const stub = stubFetch({ 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: MIRROR_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(MIRROR_BASE + 'WebGL.zip.part6');
  eq(res.status, 403, 'the refusal stands');
  eq(stub.requests.length, 1, 'the mirror was asked exactly once');
});

await test('a URL outside the archive\'s own root is left alone', async () => {
  // The Unity build files live on a different CDN. A 403 there is not
  // something the archive mirror can answer, and rewriting the host would ask
  // the mirror for a file it has never had.
  const stub = stubFetch({ 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(source.base + 'Build/w-pt.data.unityweb');
  eq(res.status, 403, 'passed through untouched');
  eq(stub.requests.length, 1, 'and not sent to the archive mirror');
  eq(urlsOf(stub)[0], source.base + 'Build/w-pt.data.unityweb', 'the URL was not rewritten');
});

await test('a descriptor without a mirror behaves exactly like the fetch it wraps', async () => {
  const stub = stubFetch({ 'raw.githubusercontent.com': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 403, 'the answer is passed straight through');
  eq(stub.requests.length, 1, 'with nothing asked twice');
});

await test('the resumable streamer is handed the mirrored fetch, not the caller\'s own', async () => {
  let seen;
  const fakeStream = { ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; } };
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  // No `base` override: the download runs from the descriptor's own host.
  await community.ensureArchive(source, { stream: fakeStream, fetchImpl: stub.impl });
  eq(typeof seen.fetchImpl, 'function', 'the streamer got a fetch to download with');
  ok(seen.fetchImpl !== stub.impl, 'and it is the wrapped one, not the caller\'s own');
  eq(seen.parts[5].url, RAW_BASE + 'WebGL.zip.part6', 'the parts it was given are on the archive host');
  const res = await seen.fetchImpl(RAW_BASE + 'WebGL.zip.part6', { cache: 'default' });
  eq(res.status, 200, 'so a refused part is answered from the mirror');
  eq(urlsOf(stub).join(' | '), RAW_BASE + 'WebGL.zip.part6 | ' + MIRROR_BASE + 'WebGL.zip.part6', 'base first, mirror second');
});

await test('the archive plan reads its index through the same mirrored fetch', async () => {
  // The pinned archive is already slim, so the plan step is skipped for it —
  // but a descriptor that still has to be planned reads the ZIP's index with
  // a few hundred range requests against the same hosts, and those are the
  // requests most likely to be refused first.
  const notSlim = JSON.parse(JSON.stringify(source));
  delete notSlim.assetArchive.slim;
  let readerFetch;
  const fakeZip = {
    createReader: (partList, opts) => { readerFetch = opts.fetchImpl; return { ranges: true }; },
    readIndex: async () => null, // nothing to plan here; the fetch is the point
  };
  let seen;
  const fakeStream = { ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; } };
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  await community.ensureArchive(notSlim, { stream: fakeStream, zip: fakeZip, fetchImpl: stub.impl });
  eq(typeof readerFetch, 'function', 'the ZIP reader got a fetch');
  ok(readerFetch !== stub.impl, 'the wrapped one');
  eq(readerFetch, seen.fetchImpl, 'and the plan and the download share a single wrapper');
  const res = await readerFetch(RAW_BASE + 'WebGL.zip.part75', { headers: { Range: 'bytes=0-15' } });
  eq(res.status, 200, 'a refused range request is answered from the mirror');
  eq(stub.requests[1].init.headers.Range, 'bytes=0-15', 'with the very same byte range');
});

section('ZIP-backed Addressables');

await test('it resolves one Unity bundle from the ZIP without expanding the archive', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/packed-test.bundle', new zip.TextReader('test bundle bytes'));
  const file = await writer.close();
  const mount = await community.openArchive(file, zip);
  eq(mount.entryCount, 1, 'the archive directory was read');
  const entry = mount.entryFor('https://game.example/StreamingAssets/aa/WebGL/packed-test.bundle');
  ok(entry, 'Unity StreamingAssets path matched the ZIP entry');
  const blob = await mount.blobFor(entry);
  eq(await blob.text(), 'test bundle bytes', 'only the requested bundle was extracted');
  await mount.close();
});

await test('the fetch adapter serves ZIP entries, supports byte ranges, and passes other URLs through', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('packed-demo.bundle', new zip.TextReader('0123456789'));
  const mount = await community.openArchive(await writer.close(), zip);
  const requests = [];
  const target = {
    fetch: async (url) => { requests.push(String(url)); return new Response('network fallback'); },
  };
  const restore = community.installFetchMount(target, mount);

  const full = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-demo.bundle');
  eq(full.status, 200, 'full bundle response');
  eq(await full.text(), '0123456789', 'bundle came from the ZIP');

  const ranged = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-demo.bundle', {
    headers: { Range: 'bytes=2-5' },
  });
  eq(ranged.status, 206, 'range response');
  eq(await ranged.text(), '2345', 'only the requested byte range was returned');
  eq(ranged.headers.get('content-range'), 'bytes 2-5/10', 'range metadata is correct');

  const fallback = await target.fetch('https://game.example/StreamingAssets/aa/catalog.bin');
  eq(await fallback.text(), 'network fallback', 'regular StreamingAssets still use the CDN');
  eq(requests.length, 1, 'only non-ZIP files reached the network');
  restore();
  await mount.close();
});

section('the cutscene bypass');

await test('a cutscene is answered with a placeholder container, never with the real video', async () => {
  // The community archive still holds the high-definition cutscenes. Reading
  // one out of the ZIP means inflating hundreds of megabytes into memory,
  // which is what empties a phone — so the mount answers with a blank
  // container instead.
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/intro_01.mp4', new zip.TextReader('x'.repeat(4096)));
  const mount = await community.openArchive(await writer.close(), zip);
  const requests = [];
  const target = {
    fetch: async (url) => { requests.push(String(url)); return new Response('network fallback'); },
  };
  const restore = community.installFetchMount(target, mount);

  const res = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/intro_01.mp4');
  eq(res.status, 200, 'the cutscene is answered');
  eq(res.headers.get('content-type'), 'video/mp4', 'with a video content type');
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(bytes.length < 2048, 'with a tiny body (' + bytes.length + ' bytes)');
  eq(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]), 'ftyp', 'and a real MP4 header');
  eq(requests.length, 0, 'the real video never reached the network');

  // …and it is never inflated out of the ZIP either.
  const ranged = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/intro_01.mp4', {
    headers: { Range: 'bytes=0-15' },
  });
  eq(ranged.status, 206, 'a range request is answered too');
  eq((await ranged.arrayBuffer()).byteLength, 16, 'with the requested bytes');
  restore();
  await mount.close();
});

await test('a WebM cutscene gets a WebM placeholder', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/cutscene.webm', new zip.TextReader('x'.repeat(1024)));
  const mount = await community.openArchive(await writer.close(), zip);
  const target = { fetch: async () => new Response('network fallback') };
  const restore = community.installFetchMount(target, mount);
  const res = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/cutscene.webm');
  eq(res.headers.get('content-type'), 'video/webm', 'the content type follows the extension');
  const bytes = new Uint8Array(await res.arrayBuffer());
  eq([bytes[0], bytes[1], bytes[2], bytes[3]].join(','), '26,69,223,163', 'and it is an EBML header');
  restore();
  await mount.close();
});

await test('an ordinary asset bundle is not mistaken for a cutscene', async () => {
  // "video_..." is a perfectly normal name for an Addressables bundle, and
  // serving it a blank video would break the game.
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/packed-test.bundle'), false, 'a bundle is not a video');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/video_intro.bundle'), false, 'not even one called "video_*"');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_scene.bundle'), false, 'nor one called "intro_*"');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_01.mp4'), true, 'but a cutscene is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/movie.webm'), true, 'a movie is');
  eq(community.isVideoPath('/StreamingAssets/Videos/clip.mp4'), true, 'a file in a Videos folder is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_cutscene'), true, 'a name that starts with "intro" is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/catalogue.json'), false, 'a catalogue is not a video');
});

await test('the placeholder is the same container the build pipeline writes', async () => {
  // The prepared build replaces the cutscenes with makePlaceholderVideo()
  // (tools/unity-webdata.mjs). The browser-side bypass has to produce the
  // very same bytes, or the two builds would behave differently.
  const mp4 = community.makePlaceholderVideo('mp4');
  const webm = community.makePlaceholderVideo('webm');
  eq(Buffer.from(mp4).equals(makePlaceholderVideo('mp4')), true, 'the MP4 is byte for byte the same');
  eq(Buffer.from(webm).equals(makePlaceholderVideo('webm')), true, 'and so is the WebM');
  ok(mp4.length < 2048, 'the MP4 placeholder is a few hundred bytes (' + mp4.length + ')');
  ok(webm.length < 2048, 'and so is the WebM one (' + webm.length + ')');
});

await done('community build tests');
