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

section('source descriptor');

await test('the pinned community source has a consistent resumable archive plan', () => {
  eq(community.validate(source), source, 'valid configuration returned');
  eq(source.commit, 'bcbe014765f2f6ca4b1d82ac25755a0299a600ab', 'source commit pinned');
  eq(source.assetArchive.parts.length, 100, 'all remote archive shards listed');
  eq(source.assetArchive.total, 2083139638, 'total size matches shard sizes');
  const parts = community.parts(source, 'https://assets.example/game/');
  eq(parts[0].url, 'https://assets.example/game/StreamingAssets/aa/WebGL.zip.part1', 'first shard resolves at the override base');
  eq(parts.at(-1).bytes, 17340100, 'last shard size is exact');
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
  eq(seen.parts.length, 100, 'all shards provided to the resumable streamer');
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
