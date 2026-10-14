/* ============================================================================
 * test-page.mjs — the iPad page in a DOM (jsdom)
 * ----------------------------------------------------------------------------
 *   node web/tools/test-page.mjs        (needs `npm install` in web/ first)
 *
 * The page holds most of the iPad-specific behaviour: the render-scale ladder,
 * the frame limiter, the crash ladder, the memory ladder, the touch pad, the
 * save import/export plumbing and the "check the data first" step. These tests
 * boot play.html in jsdom with a stubbed Unity loader and fake data, and drive
 * the same code the player's fingers drive.
 * ==========================================================================*/

import { section, test, eq, ok, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('jsdom is not installed — run `npm install` in web/ first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- *
 * Boot the page the way a browser would
 * ---------------------------------------------------------------- */

const html = fs.readFileSync(path.join(WEB, 'play.html'), 'utf8');
const libs = ['js/stream.js', 'js/manifest.js', 'js/save-codec.js', 'js/boss-scenes.js'].map((rel) =>
  fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8')
);
// The inline script is what runs the game page: pull it out so the libraries can
// be installed first (a browser gets that ordering from the <script> tags).
const inlineMatch = html.match(/<script>\n([\s\S]*?)<\/script>/);
ok(inlineMatch, 'found the page script');
const inline = inlineMatch[1];
const shell = html.replace(inlineMatch[0], '<script id="page-script" type="text/plain"></script>');

function bootPage({ fetchImpl, touch = true, userAgent } = {}) {
  const dom = new JSDOM(shell, {
    url: 'https://example.test/play.html',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    userAgent: userAgent || (touch ? 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15' : 'Mozilla/5.0 (Macintosh)'),
  });
  const win = dom.window;
  if (touch) {
    Object.defineProperty(win.navigator, 'maxTouchPoints', { value: 5, configurable: true });
  }
  // The page talks to the network through fetch and to the screen through
  // matchMedia; both get quiet stubs here.
  win.fetch = fetchImpl || (async () => ({ ok: false, status: 404, headers: new Map(), text: async () => '' }));
  if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // requestAnimationFrame: jsdom's implementation is driven manually below.
  win.__frames = [];
  win.requestAnimationFrame = (cb) => {
    win.__frames.push(cb);
    return win.__frames.length;
  };
  win.cancelAnimationFrame = () => {};
  win.Symbol = Symbol;
  for (const source of libs) win.eval(source);
  win.eval(inline);
  return win;
}

function manifestFetch(manifest, chunkBytes, extra = {}) {
  // What each chunk should really be, so a probe can be answered honestly.
  const sizes = {};
  Object.values(manifest.datasets || {}).forEach((set) => {
    (set.parts || []).forEach((part) => {
      sizes[part.path] = chunkBytes === 'wrong' ? 42 : chunkBytes !== undefined ? chunkBytes : part.bytes;
    });
  });
  return async (url, opts = {}) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'Build/build-manifest.json') {
      const text = JSON.stringify(manifest);
      return { ok: true, status: 200, headers: new Map([['content-length', String(text.length)]]), text: async () => text };
    }
    if (extra[clean]) return extra[clean];
    if (sizes[clean] !== undefined) {
      const headers = new Map([
        ['content-range', 'bytes 0-0/' + sizes[clean]],
        ['content-length', '1'],
      ]);
      return { ok: true, status: 206, headers, body: { cancel: async () => {} }, text: async () => '' };
    }
    return { ok: false, status: 404, headers: new Map(), text: async () => 'not found' };
  };
}

const MANIFEST = {
  schema: 2,
  name: 'silksong',
  buildId: 'silksong-webgl-test',
  partBytes: 100,
  unity: { loader: 'Build/silksong.loader.js', framework: 'Build/silksong.framework.js', streamingAssets: 'StreamingAssets/' },
  datasets: {
    data: { cacheKey: 'silksong.data', mime: 'application/octet-stream', total: 200, parts: [
      { path: 'Build/silksong.data.part1', bytes: 100 },
      { path: 'Build/silksong.data.part2', bytes: 100 },
    ] },
    wasm: { cacheKey: 'silksong.wasm', mime: 'application/wasm', total: 50, parts: [{ path: 'Build/silksong.wasm.part1', bytes: 50 }] },
  },
  integrity: { api: {} },
};

section('the page boots');

await test('it initialises without throwing and exposes its diagnostics', () => {
  const win = bootPage();
  const perf = win.SKPerf;
  ok(perf, 'SKPerf is exposed for the menu and the tests');
  eq(perf.presets().length, 7, 'seven graphics levels, from High to Rock bottom');
  eq(perf.presets()[0], 'high', 'the first is High');
  eq(perf.presets()[6], 'rock_bottom', 'the last is Rock bottom');
  const settings = perf.settings();
  eq(settings.activeIndex, 1, 'a touch device starts at Balanced');
  eq(settings.scale, 0.85, 'and at 85 % render scale');
  eq(settings.fps, 60, 'with a 60 fps cap');
  ok(settings.frameInterval > 0, 'the frame limiter computed an interval');
  win.close();
});

await test('the save codec, loader and manifest modules really loaded', () => {
  const win = bootPage();
  ok(win.SKStream && win.SKStream.VERSION, 'stream');
  ok(win.SKManifest && win.SKManifest.DEFAULT_PATH, 'manifest');
  ok(win.SKSaveCodec && win.SKSaveCodec.encodeDat, 'save codec');
  ok(win.SKBossScenes && win.SKBossScenes.list, 'boss scenes');
  win.close();
});

await test('the touch pad is on for a touch device and off for a desktop', () => {
  const ipad = bootPage({ touch: true });
  eq(ipad.document.getElementById('pad').classList.contains('on'), true, 'iPad: pad shown');
  ipad.close();
  const mac = bootPage({ touch: false });
  eq(mac.document.getElementById('pad').classList.contains('on'), false, 'desktop: pad hidden');
  mac.close();
});

section('render scale and frame cap');

await test('the canvas shrinks with the render scale and is stretched back with CSS', () => {
  const win = bootPage();
  win.innerWidth = 1024;
  win.innerHeight = 768;
  const internals = win.SKPerf.internals();
  internals.applyResolution();
  const canvas = win.document.getElementById('unity-canvas');
  eq(canvas.width, Math.round(1024 * 0.85), 'backing store is 85 % wide');
  eq(canvas.height, Math.round(768 * 0.85), 'and 85 % tall');
  ok(/scale\(1\.1765\)/.test(canvas.style.transform), 'CSS scales it back up: ' + canvas.style.transform);
  win.close();
});

await test('picking a graphics level changes scale, cap and the stored preference', () => {
  const win = bootPage();
  const button = win.document.getElementById('perfBtn');
  button.click(); // Balanced → Smooth
  const settings = win.SKPerf.settings();
  eq(settings.activeIndex, 2, 'one step down the ladder');
  eq(settings.scale, 0.7, 'render scale followed');
  eq(settings.fps, 45, 'frame cap followed');
  ok(/Smooth/.test(button.textContent), 'the button says so: ' + button.textContent);
  const stored = JSON.parse(win.localStorage.getItem('sk.perf'));
  eq(stored.preset, 2, 'and it is remembered for the next visit');
  win.close();
});

await test('the frame cap can be changed on its own', () => {
  const win = bootPage();
  const button = win.document.getElementById('fpsBtn');
  const before = win.SKPerf.settings().fps;
  button.click();
  const after = win.SKPerf.settings();
  ok(after.fps !== before, 'the cap moved (' + before + ' → ' + after.fps + ')');
  ok(after.frameInterval > 0, 'and the limiter interval followed');
  win.close();
});

await test('auto-degrade can be switched off and is honest about it', () => {
  const win = bootPage();
  const button = win.document.getElementById('autoBtn');
  eq(win.SKPerf.settings().auto, true, 'on by default');
  button.click();
  eq(win.SKPerf.settings().auto, false, 'off after a tap');
  ok(/off/.test(button.textContent), 'and the button says off');
  win.close();
});

section('memory ladder');

await test('the memory limits follow what this device died at', () => {
  const win = bootPage();
  win.localStorage.setItem('sk.crashHeap', '1200');
  const limits = win.SKPerf.internals().memoryLimits();
  eq(limits.warn, 960, 'warns at 80 % of the fatal heap');
  eq(limits.alarm, 1140, 'alarms at 95 %');
  eq(limits.learned, true, 'and says it learned it');
  win.localStorage.removeItem('sk.crashHeap');
  const fallback = win.SKPerf.internals().memoryLimits();
  eq(fallback.warn, 1000, 'without a recorded crash it uses the conservative default');
  win.close();
});

await test('a crash ladder lowers the starting level on the next visit', () => {
  const win = bootPage();
  const internals = win.SKPerf.internals();
  internals.resetStores();
  const clean = win.SKPerf.settings();
  eq(clean.activeIndex, 1, 'a clean exit starts at Balanced on an iPad');

  // A session that booted, then vanished while it was on screen with a 1.1 GB
  // heap: exactly what iPadOS leaves behind when it kills a tab.
  const heartbeat = JSON.stringify({
    at: Date.now() - 1000,
    start: Date.now() - 600000,
    preset: 'balanced',
    heap: 1100,
    visible: true,
  });
  win.localStorage.setItem('sk.heartbeat', heartbeat);
  internals.evaluateLastSession();
  const afterOne = win.SKPerf.settings();
  eq(afterOne.crashSteps, 1, 'the ladder noticed the crash');
  eq(afterOne.activeIndex, 2, 'so the next session starts one step lower');

  win.localStorage.setItem('sk.heartbeat', heartbeat);
  internals.evaluateLastSession();
  const afterTwo = win.SKPerf.settings();
  eq(afterTwo.crashSteps, 2, 'a second crash climbs again');
  eq(afterTwo.activeIndex, 3, 'and the level drops further');
  eq(win.SKPerf.lastSession().crashed, true, 'the panel can say what happened');

  // A tab killed in the background says nothing about the graphics level.
  internals.resetStores();
  win.localStorage.setItem('sk.heartbeat', JSON.stringify({ at: Date.now() - 1000, start: Date.now() - 60000, heap: 900, visible: false }));
  internals.evaluateLastSession();
  eq(win.SKPerf.settings().crashSteps, 0, 'a background kill does not lower the graphics');
  win.close();
});

section('the data plan');

await test('the manifest fills in the chunk list, totals and the start-screen text', async () => {
  const win = bootPage({ fetchImpl: manifestFetch(MANIFEST) });
  const manifest = await win.SKManifest.load({ log: () => {} });
  const plan = win.SKPerf.internals().planFromManifest(win.SKManifest.normalize(manifest, ''));
  eq(plan.data.parts.length, 2, 'two data chunks');
  eq(plan.data.parts[0].url, 'Build/silksong.data.part1', 'resolved against the page');
  eq(plan.data.total, 200, 'data total');
  eq(plan.wasm.total, 50, 'wasm total');
  eq(win.SKPerf.build().buildId, 'silksong-webgl-test', 'the build id is available to the diagnostics');
  win.close();

  // …and the same step with a build the size of a real one, because that is the
  // text the player reads before tapping Start.
  const big = JSON.parse(JSON.stringify(MANIFEST));
  big.datasets.data.total = 20 * 1024 * 1024 * 32;
  big.datasets.wasm.total = 30 * 1024 * 1024;
  big.datasets.data.parts = Array.from({ length: 32 }, (_, i) => ({ path: 'Build/silksong.data.part' + (i + 1), bytes: 20 * 1024 * 1024 }));
  big.datasets.wasm.parts = [{ path: 'Build/silksong.wasm.part1', bytes: 30 * 1024 * 1024 }];
  const win2 = bootPage({ fetchImpl: manifestFetch(big) });
  const loaded = await win2.SKManifest.load({ log: () => {} });
  win2.SKPerf.internals().planFromManifest(win2.SKManifest.normalize(loaded, ''));
  const text = win2.document.getElementById('sub').textContent;
  ok(/\d+\.\d MB/.test(text) && /32 data chunks/.test(text), 'the start screen names the download: ' + text);
  eq(win2.SKPerf.settings().scale, 0.85, 'and the graphics default did not change');
  win2.close();
});

await test('a full data check passes with the chunks in place', async () => {
  const win = bootPage({ fetchImpl: manifestFetch(MANIFEST, undefined, {
    'Build/silksong.loader.js': { ok: true, status: 200, headers: new Map(), text: async () => 'function createUnityInstance(){}' },
    'Build/silksong.framework.js': { ok: true, status: 200, headers: new Map(), text: async () => 'var Unity = {};' },
  }) });
  const manifest = win.SKManifest.normalize(await win.SKManifest.load({ log: () => {} }), '');
  const report = await win.SKManifest.checkBuild(manifest, { fetch: win.fetch });
  eq(report.ok, true, 'everything present: ' + JSON.stringify(report.datasets.data.bad));
  eq(report.datasets.data.checked, 2, 'both chunks probed');
  win.close();
});

await test('a chunk of the wrong size is caught before the download starts', async () => {
  const win = bootPage({ fetchImpl: manifestFetch(MANIFEST, 'wrong') });
  const manifest = win.SKManifest.normalize(await win.SKManifest.load({ log: () => {} }), '');
  const report = await win.SKManifest.checkDataset(manifest.datasets.data, { fetch: win.fetch });
  eq(report.ok, false, 'reported as broken');
  ok(/is 42 bytes/.test(report.bad[0].reason), 'with the size: ' + report.bad[0].reason);
  win.close();
});

section('menu + saves');

await test('the menu opens, shows the graphics controls and the boss section', async () => {
  const win = bootPage({ fetchImpl: manifestFetch(MANIFEST) });
  const menu = win.document.getElementById('menuBtn');
  eq(win.SKPerf.internals().isPaletteOpen(), false, 'starts closed');
  menu.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  eq(win.SKPerf.internals().isPaletteOpen(), true, 'opens');
  ok(win.document.getElementById('bossRows').textContent.length > 0, 'the boss section reports something');
  ok(/Graphics:/.test(win.document.getElementById('perfBtn').textContent), 'the graphics button is labelled');
  win.close();
});

await test('a boss roster that is staged shows up in the picker', async () => {
  const bossFetch = async (url, opts) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'BossScenes/BossSceneConfig.json') {
      const text = JSON.stringify({ BossScenes: [{ SceneName: 'Clover_10', BossName: '苔藓之母', PosX: 1, PosY: 2, PosZ: 0 }] });
      return { ok: true, status: 200, headers: new Map(), text: async () => text, json: async () => JSON.parse(text) };
    }
    return manifestFetch(MANIFEST)(url, opts);
  };
  const win = bootPage({ fetchImpl: bossFetch });
  win.indexedDB = undefined; // no save database in jsdom: the page must cope
  const list = await win.SKBossScenes.list({ base: '' });
  ok(list && list.length === 1, 'the roster loaded');
  eq(list[0].name, '苔藓之母', 'boss name');
  const slots = await win.SKBossScenes.slots();
  eq(slots.hash, null, 'and an absent save database is reported, not thrown');
  win.close();
});

await test('save import accepts a Silksong .dat and rejects nonsense', () => {
  const win = bootPage();
  const json = JSON.stringify({ playerData: { health: 5 } });
  const dat = win.SKSaveCodec.encodeDat(json);
  eq(win.SKSaveCodec.decodeDat(dat), json, 'a .dat round-trips inside the page');
  let refused = false;
  try {
    win.SKSaveCodec.findSave(new Uint8Array([1, 2, 3, 4]));
  } catch (e) {
    refused = true;
  }
  ok(refused, 'garbage is refused');
  win.close();
});

await test('audio failures are relabelled so Unity retries instead of dying', () => {
  const win = bootPage();
  // The guard wraps HTMLMediaElement.play: a rejected play() must come back as
  // NotAllowedError, which is the only error Unity waits out.
  const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
  if (proto && typeof proto.play === 'function') {
    const result = proto.play.call({ pause() {}, load() {} });
    ok(result === undefined || typeof result.then === 'function', 'play() is intercepted');
  }
  win.close();
});

await done('page tests');
