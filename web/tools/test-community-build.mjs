/* Tests for the external community-build descriptor and lazy ZIP mount. */
import { section, test, eq, ok, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

await done('community build tests');
