import { section, test, eq, ok, rejects, done, tmpDir } from './testkit.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), zip = require('../js/zip.min.js');
const community = require('../js/community-build.js');
const root = tmpDir('delivery'); await fs.mkdir(root, { recursive: true });
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
await fs.writeFile(path.join(root, 'engine.wasm.unityweb'), gzipSync(wasm));
await fs.writeFile(path.join(root, 'test.js'), 'var test = 1;');
await fs.writeFile(path.join(root, 'game.data.part1'), 'ABCD');
await fs.writeFile(path.join(root, 'empty'), '');
const hashName = 'assets-0123456789abcdef.data.part1'; await fs.writeFile(path.join(root, hashName), 'ABCD');
const child = spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname, '0', root], { stdio: ['ignore', 'pipe', 'pipe'] });
const base = await new Promise((resolve, reject) => {
  let output = ''; const timeout = setTimeout(() => reject(new Error('server did not start')), 10000);
  child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(new Error('server exited: ' + code + ' ' + output)); });
  child.stdout.on('data', data => { output += data; const match = output.match(/local:\s+(http:\/\/127\.0\.0\.1:\d+)\//); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  child.stderr.on('data', data => { output += data; });
});
try {
  section('production asset delivery');
  await test('mutable files revalidate and content-addressed assets are immutable', async () => {
    const js = await fetch(base + '/test.js'); eq(js.headers.get('cache-control'), 'no-cache');
    const cached = await fetch(base + '/test.js', { headers: { 'If-None-Match': js.headers.get('etag') } }); eq(cached.status, 304);
    const asset = await fetch(base + '/' + hashName); ok(asset.headers.get('cache-control').includes('immutable'));
    eq(asset.headers.get('access-control-allow-origin'), '*'); eq(asset.headers.get('timing-allow-origin'), '*');
    eq(js.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });
  await test('ranges have correct lengths, clamp at EOF and reject invalid requests', async () => {
    const range = await fetch(base + '/game.data.part1', { headers: { Range: 'bytes=1-99' } });
    eq(range.status, 206); eq(range.headers.get('content-length'), '3'); eq(range.headers.get('content-range'), 'bytes 1-3/4'); eq(await range.text(), 'BCD');
    eq((await fetch(base + '/game.data.part1', { headers: { Range: 'bytes=4-' } })).status, 416);
    eq((await fetch(base + '/game.data.part1', { headers: { Range: 'bytes=-0' } })).status, 416);
    const head = await fetch(base + '/game.data.part1', { method: 'HEAD', headers: { Range: 'bytes=0-0' } }); eq(head.status, 206); eq(head.headers.get('content-length'), '1');
  });
  await test('precompressed Wasm decodes natively with correct MIME and no invalid gzip ranges', async () => {
    const result = await fetch(base + '/engine.wasm.unityweb', { headers: { Range: 'bytes=0-3' } });
    eq(result.status, 200); eq(result.headers.get('content-type'), 'application/wasm'); eq(result.headers.get('content-encoding'), 'gzip');
    ok(Buffer.from(await result.arrayBuffer()).equals(wasm));
  });
  await test('empty files and unsupported methods do not hang the static server', async () => {
    const empty = await fetch(base + '/empty'); eq(empty.status, 200); eq(await empty.text(), '');
    eq((await fetch(base + '/test.js', { method: 'POST' })).status, 405);
  });
} finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }

section('lossless alternate packaging');
const input = path.join(root, 'input.zip');
const data = crypto.randomBytes(12000);
const writer = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
await writer.add('aa/WebGL/test.bundle', new zip.Uint8ArrayReader(data));
await fs.writeFile(input, Buffer.from(await (await writer.close()).arrayBuffer()));
for (const mode of ['preserve', 'store', 'deflate']) await test(mode + ' packaging preserves asset bytes and writes verifiable part manifests', async () => {
  const out = path.join(root, mode);
  const process = spawnSync('python3', [new URL('./package-assets.py', import.meta.url).pathname, '--zip', input, '--out', out,
    '--asset-base', 'https://cdn.test/v1/', '--bundles', '--bundle-base', 'https://cdn.test/v1/bundles/', '--compression', mode, '--part-bytes', '1024'], { encoding: 'utf8' });
  eq(process.status, 0, process.stderr);
  const descriptor = JSON.parse(await fs.readFile(path.join(out, 'community-build.json'))); community.validate(descriptor);
  const index = JSON.parse(await fs.readFile(path.join(out, 'zip-index.json'))); community.validateBundleIndex(index, descriptor.assetArchive.total);
  const pieces = [];
  for (const part of descriptor.assetArchive.parts) {
    const bytes = await fs.readFile(path.join(out, part.path)); eq(bytes.length, part.bytes); eq(crypto.createHash('sha256').update(bytes).digest('hex'), part.sha256); pieces.push(bytes);
  }
  const assembled = Buffer.concat(pieces); eq(assembled.length, descriptor.assetArchive.total);
  if (mode === 'preserve') ok(assembled.equals(await fs.readFile(input)), 'preserve does not recompress');
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(assembled));
  const entry = (await reader.getEntries())[0];
  ok(Buffer.from(await entry.getData(new zip.Uint8ArrayWriter(), { checkSignature: true })).equals(data));
  if (mode === 'store') eq(entry.compressionMethod, 0);
  ok((await fs.readFile(path.join(out, 'bundles/aa/WebGL/test.bundle'))).equals(data)); await reader.close();
});
await test('packaging refuses traversal paths before creating a publishable descriptor', async () => {
  const bad = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
  await bad.add('../escape.bundle', new zip.Uint8ArrayReader(data));
  const badPath = path.join(root, 'bad.zip'); await fs.writeFile(badPath, Buffer.from(await (await bad.close()).arrayBuffer()));
  const out = path.join(root, 'bad');
  const result = spawnSync('python3', [new URL('./package-assets.py', import.meta.url).pathname, '--zip', badPath, '--out', out, '--asset-base', 'https://cdn.test/'], { encoding: 'utf8' });
  ok(result.status !== 0); await rejects(fs.access(path.join(out, 'community-build.json')));
});
await done('asset delivery tests');
