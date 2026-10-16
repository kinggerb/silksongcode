/* Real browser integration: real OPFS workers, zip.js, native gzip/Wasm and the
 * exact pinned Unity LOADER, with synthetic game data/framework (not Silksong).
 * CHROME_BIN=/path/to/chrome npm run test:browser
 * Optional: CHROMIUM_MODULE=/absolute/path/to/@sparticuz/chromium/build/index.js
 * Optional offline loader: PINNED_LOADER_PATH=/path/to/w-pt.loader.js */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), zip = require('../js/zip.min.js');
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let launch = { headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_MODULE) {
  const { default: binary } = await import(pathToFileURL(process.env.CHROMIUM_MODULE));
  launch.executablePath = await binary.executablePath();
  launch.args = binary.args.filter(arg => arg !== '--disable-web-security');
} else {
  launch.executablePath = process.env.CHROME_BIN;
  if (!launch.executablePath) for (const bin of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try { await fs.access(bin); launch.executablePath = bin; break; } catch {}
  }
  if (!launch.executablePath) throw new Error('Set CHROME_BIN to an installed Chromium/Chrome executable (see LOADING-OPTIMIZATIONS.md).');
}
const pinned = JSON.parse(await fs.readFile(path.join(WEB, 'community-build.json')));
const loader = process.env.PINNED_LOADER_PATH ? await fs.readFile(process.env.PINNED_LOADER_PATH) : await (async () => {
  const res = await fetch('https://api.github.com/repos/web-ports/hollow-knight-silksong/contents/Build/w-pt.loader.js?ref=' + pinned.commit,
    { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'silksong-loading-tests' } });
  if (!res.ok) throw new Error('Cannot fetch pinned test loader: HTTP ' + res.status + ' (or set PINNED_LOADER_PATH)');
  return Buffer.from(await res.arrayBuffer());
})();
assert.equal(crypto.createHash('sha256').update(loader).digest('hex'), require('../js/unity-startup.js').LOADER_SHA256);
const wasm = Buffer.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,7,11]);
assert.equal((await WebAssembly.instantiate(wasm)).instance.exports.run(), 7);
function randomBytes(length, seed) {
  let x = seed; return Uint8Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 255; });
}
const contents = [randomBytes(210000, 123), randomBytes(800000, 789), randomBytes(150000, 456)];
const expectedHash = crypto.createHash('sha256').update(contents[0]).digest('hex');
const writer = new zip.ZipWriter(new zip.BlobWriter(), { useWebWorkers: false });
for (let i = 0; i < contents.length; i++) await writer.add('bundle-' + i + '.bundle', new zip.Uint8ArrayReader(contents[i]));
const archive = Buffer.from(await (await writer.close()).arrayBuffer()), partSize = 65536;
const parts = [];
for (let at = 0; at < archive.length; at += partSize) parts.push({ path: 'part-' + parts.length, bytes: Math.min(partSize, archive.length - at) });
const magic = Buffer.from('UnityWebData1.0\0'), data = Buffer.alloc(magic.length + 4 + 64); magic.copy(data); data.writeUInt32LE(magic.length + 4, magic.length);
// This implements the upstream framework lifecycle contract, not the game.
const framework = Buffer.from(`function unityFramework(b) {
  var dependencies = new Set(), kernel = null, started = false;
  b.HEAPU8 = new Uint8Array(65536);
  b.SendMessage = function() {}; b.SetFullscreen = function() {};
  b.WebPlayer = { WaitForInitialization: function() { return Promise.resolve(); } };
  b.FS_createPath = function() {}; b.FS_createDataFile = function() {};
  b.addRunDependency = function(id) { dependencies.add(id); };
  b.removeRunDependency = function(id) { dependencies.delete(id); ready(); };
  function ready() {
    if (started || !kernel || dependencies.size) return;
    started = true;
    (async function() {
      if (kernel.exports.run() !== 7) throw Error('Wasm fixture kernel failed');
      var url = b.streamingAssetsUrl + '/aa/WebGL/bundle-0.bundle';
      var bytes = await (await fetch(url)).arrayBuffer();
      var hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), function(b){return b.toString(16).padStart(2,'0');}).join('');
      if (hash !== '${expectedHash}') throw Error('bundle bytes changed in transit');
      var range = await fetch(url, {headers:{Range:'bytes=0-31'}});
      if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 32) throw Error('range response broken');
      var gl = b.canvas.getContext('webgl2');
      if (gl) { gl.clearColor(0.1,0.5,0.2,1); gl.clear(gl.COLOR_BUFFER_BIT); }
      window.__fixture = {bytes:bytes.byteLength, hash:hash, streaming:!!b.instantiateWasm};
      b.postRun.forEach(function(fn) { fn(); });
      if (window.SKLoading) window.SKLoading.markPlayable();
    })().catch(function(error) { console.error('fixture error',error); if(b.startupErrorHandler) b.startupErrorHandler(error); else throw error; });
  }
  b.preRun.forEach(function(fn) { fn(); });
  if (b.instantiateWasm) b.instantiateWasm({}, function(instance) { kernel=instance; ready(); });
  else WebAssembly.instantiate(b.wasmBinary, {}).then(function(result) { kernel=result.instance; ready(); }).catch(b.startupErrorHandler);
}`);
let base, rawWasm = false, partRequests = [], transferred = 0;
let descriptor;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base), name = url.pathname;
    let body, type = 'application/octet-stream', gzip = false;
    if (name === '/community-build.json') { body = Buffer.from(JSON.stringify(descriptor)); type = 'application/json'; }
    else if (name === '/Build/build-manifest.json') { res.writeHead(404).end(); return; }
    else if (name === '/Build/test.loader.js') { body = loader; type = 'text/javascript'; }
    else if (name === '/Build/test.framework.js.unityweb') { body = gzipSync(framework); type = 'text/javascript'; gzip = true; }
    else if (name === '/Build/test.wasm.unityweb') { body = gzipSync(wasm); type = rawWasm ? 'application/octet-stream' : 'application/wasm'; gzip = !rawWasm; }
    else if (name === '/Build/test.data.unityweb') { body = gzipSync(data); gzip = true; }
    else if (/^\/parts\/part-\d+$/.test(name)) {
      const i = Number(name.match(/part-(\d+)/)[1]); partRequests.push(i);
      body = archive.subarray(i * partSize, (i + 1) * partSize); transferred += body.length;
    } else if (name === '/stall') { res.writeHead(200); res.write(Buffer.from([0])); return; }
    else {
      const file = path.resolve(WEB, '.' + name);
      if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
      try { body = await fs.readFile(file); } catch { res.writeHead(404).end(); return; }
      type = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) }); res.end(body);
  } catch (error) { res.writeHead(500).end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = 'http://127.0.0.1:' + server.address().port + '/';
descriptor = { ...pinned, base, buildId: 'browser-fixture-v1',
  unity: { loader: 'Build/test.loader.js', framework: 'Build/test.framework.js.unityweb', data: 'Build/test.data.unityweb', wasm: 'Build/test.wasm.unityweb', streamingAssets: 'StreamingAssets' },
  fileBytes: { loader: loader.length, framework: gzipSync(framework).length, data: gzipSync(data).length, wasm: gzipSync(wasm).length },
  assetArchive: { cacheKey: 'browser-fixture.zip', base: base + 'parts/', total: archive.length, slim: true, parts } };
let browser;
const summaries = [];
try {
  browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage(), errors = [], logs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => logs.push(message.text()));
  async function bootFor(target, query = '') {
    await target.goto(base + 'play.html' + query);
    await target.waitForFunction(() => !document.getElementById('startBtn').disabled);
    const start = Date.now(); await target.click('#startBtn');
    try {
      await target.waitForFunction(() => window.unityInstance || !document.getElementById('err').classList.contains('hidden'), null, { timeout: 20000 });
    } catch (error) { throw new Error(error.message + '\nERRORS: ' + errors.join(' | ') + '\n' + logs.slice(-35).join('\n')); }
    const result = await target.evaluate(() => ({ ready: !!window.unityInstance, fixture: window.__fixture,
      error: document.getElementById('err').textContent, timings: window.SKLoading.timings(), overlayHidden: document.getElementById('screen').classList.contains('hidden') }));
    assert.equal(result.ready, true, result.error + '\n' + logs.slice(-20).join('\n'));
    assert.equal(result.overlayHidden, true); assert.equal(result.fixture.hash, expectedHash);
    assert.ok(result.timings.some(item => item.stage === 'first controllable gameplay'));
    return { elapsedMs: Date.now() - start, result };
  }
  const boot = query => bootFor(page, query);
  const cold = await boot();
  assert.equal(cold.result.fixture.streaming, true, 'real pinned loader must use the custom native compiler');
  assert.ok(transferred < archive.length / 2, 'cold boot should not download unused middle bundles');
  assert.equal(new Set(partRequests).size, partRequests.length, 'deduplicated part requests');
  summaries.push({ test: 'cold lazy + native HTTP gzip + pinned loader', elapsedMs: cold.elapsedMs, archiveBytesFetched: transferred, fullArchiveBytes: archive.length });
  await page.evaluate(async () => {
    localStorage.setItem('save-sentinel', 'preserved');
    await new Promise((resolve, reject) => { const r = indexedDB.open('save-sentinel', 1); r.onupgradeneeded = () => r.result.createObjectStore('saves'); r.onsuccess = () => { const tx = r.result.transaction('saves', 'readwrite'); tx.objectStore('saves').put('preserved', 'slot1'); tx.oncomplete = resolve; tx.onerror = reject; }; });
  });
  transferred = 0; partRequests = []; rawWasm = true;
  const warm = await boot();
  assert.equal(transferred, 0, 'warm load must make zero archive network requests');
  assert.equal(warm.result.fixture.streaming, true, 'native decoder must also support raw gzip .unityweb');
  assert.ok(logs.some(line => line.includes('extracted bundle cache hit')));
  assert.equal(await page.evaluate(() => localStorage.getItem('save-sentinel')), 'preserved');
  assert.equal(await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('save-sentinel'); r.onsuccess = () => { const tx = r.result.transaction('saves'); const get = tx.objectStore('saves').get('slot1'); get.onsuccess = () => resolve(get.result); }; })), 'preserved');
  summaries.push({ test: 'warm lazy + native raw-gzip + saved data preserved', elapsedMs: warm.elapsedMs, archiveBytesFetched: transferred });
  rawWasm = false; transferred = 0; partRequests = [];
  const eager = await boot('?assets=eager&streaming=0');
  assert.equal(eager.result.fixture.streaming, false, 'stock loader path still works');
  assert.equal(transferred, archive.length, 'eager fallback fetches full archive');
  summaries.push({ test: 'eager + stock Wasm path (verified gzip guard)', elapsedMs: eager.elapsedMs, archiveBytesFetched: transferred });
  transferred = 0; partRequests = [];
  await boot('?assets=eager&streaming=0');
  assert.equal(transferred, 0, 'eager warm cache is preserved too');
  const stalled = await page.evaluate(async url => {
    try { await SKStream.ensureDataset({ parts: [{ url, bytes: 4 }], cacheKey: 'stall-test', buildId: '1', expectedSize: 4,
      workerUrl: 'js/writer.js', allowMemoryFallback: false, retryAttempts: 0, stallTimeoutMs: 40 }); return 'unexpected success'; }
    catch (error) { return error.message; }
  }, base + 'stall');
  assert.match(stalled, /stalled/);
  await page.evaluate(() => SKStream.clearCache());
  await page.close(); // release session pins, then test two cold tabs on one origin
  const tabs = await Promise.all([context.newPage(), context.newPage()]);
  tabs.forEach(tab => { tab.on('pageerror', error => errors.push(error.message)); tab.on('console', message => logs.push(message.text())); });
  transferred = 0; partRequests = []; rawWasm = false;
  await Promise.all(tabs.map(tab => bootFor(tab)));
  assert.equal(new Set(partRequests).size, partRequests.length, 'cross-tab part downloads must deduplicate');
  summaries.push({ test: 'two simultaneous cold tabs, shared cache/pins', archiveBytesFetched: transferred, uniquePartRequests: partRequests.length });
  await Promise.all(tabs.map(tab => tab.close()));
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log(JSON.stringify({ browser: await browser.version(), tests: summaries, uncaughtErrors: errors }, null, 2));
  console.log('Browser integration passed: real OPFS/cache/worker, lazy and eager boot, pinned loader hook, native gzip/Wasm, byte-exact bundles/ranges, saved data, and stalled-request cleanup.');
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
