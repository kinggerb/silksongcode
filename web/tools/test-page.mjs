/* ============================================================================
 * test-page.mjs — the iPad page in a DOM (jsdom)
 * ----------------------------------------------------------------------------
 *   node web/tools/test-page.mjs        (needs `npm install` in web/ first)
 *
 * The page holds most of the iPad-specific behaviour: the render-scale ladder,
 * the frame limiter, the crash ladder, the memory ladder, the touch pad, the
 * save import/export plumbing and the "check the data first" step. These tests
 * boot play.html in jsdom with a stubbed Unity loader and fake data, and drive
 * the same code the player's fingers drive — including the hand-off to the
 * community build's loader, which is not stock Unity and reads the page's
 * <base> element (the stub runs that upstream line verbatim).
 * ==========================================================================*/

import { section, test, eq, ok, rejects, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// jsdom's media stub rejects play() with nobody awaiting it. Node treats that
// as a fatal unhandledRejection and kills the suite; log it and keep going.
process.on('unhandledRejection', (reason) => {
  const message = (reason && (reason.stack || reason.message)) || reason;
  console.error('unhandledRejection (logged, not fatal to the suite):', message);
});

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
const libs = ['js/stream.js', 'js/manifest.js', 'js/zip-plan.js', 'js/asset-cache.js', 'js/community-build.js', 'js/unity-startup.js', 'js/save-codec.js', 'js/boss-scenes.js'].map((rel) =>
  fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8')
);
// The inline script is what runs the game page: pull it out so the libraries can
// be installed first (a browser gets that ordering from the <script> tags).
const inlineMatch = html.match(/<script>\n([\s\S]*?)<\/script>/);
ok(inlineMatch, 'found the page script');
const inline = inlineMatch[1];
const shell = html.replace(inlineMatch[0], '<script id="page-script" type="text/plain"></script>');

function bootPage({ fetchImpl, touch = true, userAgent, query = '', seedStorage } = {}) {
  const dom = new JSDOM(shell, {
    url: 'https://example.test/play.html' + query,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    userAgent: userAgent || (touch ? 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15' : 'Mozilla/5.0 (Macintosh)'),
  });
  const win = dom.window;
  if (touch) {
    Object.defineProperty(win.navigator, 'maxTouchPoints', { value: 5, configurable: true });
  }
  // jsdom ignores the `userAgent` option, so it has to be set by hand: the
  // page decides what a phone is by looking at the user agent.
  Object.defineProperty(win.navigator, 'userAgent', {
    value: userAgent || (touch ? 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15' : 'Mozilla/5.0 (Macintosh)'),
    configurable: true,
  });
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
  // Seeded before the page script runs, so init sees a previous session's
  // heartbeat / flight recorder / stage marker the way a reload would.
  if (seedStorage) {
    for (const [key, value] of Object.entries(seedStorage)) {
      win.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
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
  eq(settings.activeIndex, 3, 'a touch device starts at Low');
  eq(settings.scale, 0.55, 'and at 55 % render scale');
  eq(settings.fps, 30, 'with a 30 fps cap');
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

section('the memory ceiling');

await test('the heap size hints are documentation for builds that honour them — the pinned build does not', () => {
  const win = bootPage();
  const config = win.SKPerf.internals().makeUnityConfig('data', 'code', 'framework', 'assets');
  // These two are what a *self-built* standard build honours. The pinned
  // community binary compiles in a ~2 GiB heap and ignores both — the
  // "2048 MB of wasm heap" the iPad reports is real — so the page must not
  // pretend they cap anything. They stay for their honest audience only.
  eq(config.maximumHeapSize, 1073741824, 'a build that honours it gets the 1 GB ceiling');
  ok(config.maximumHeapSize < 1468006400, 'which is below the old 1.4 GB');
  eq(config.INITIAL_MEMORY, 16777216, 'and such a build starts at 16 MB, not 32');
  ok(config.INITIAL_MEMORY < 33554432, 'so no RAM is front-loaded');
  win.close();
});

await test('the WebGL context is configured for a phone, not for a workstation', () => {
  const win = bootPage();
  const attributes = win.SKPerf.internals().makeUnityConfig('d', 'c', 'f', 'a').webglContextAttributes;
  eq(attributes.preserveDrawingBuffer, false, 'the drawing buffer is not kept around');
  eq(attributes.desynchronized, true, 'late frames are dropped instead of queued');
  eq(attributes.powerPreference, 'low-power', 'a touch device asks for the low-power GPU');
  eq(attributes.antialias, false, 'no multisampling');
  win.close();

  const desktop = bootPage({ touch: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  eq(
    desktop.SKPerf.internals().makeUnityConfig('d', 'c', 'f', 'a').webglContextAttributes.powerPreference,
    'high-performance',
    'a desktop keeps the fast GPU'
  );
  desktop.close();
});

await test('the loader never reloads the tab on its own', () => {
  const win = bootPage();
  eq(win.SKPerf.HARD_MEMORY_CAP_MB, Infinity, 'there is no hard memory cap');
  // The countdown that used to reload the tab is gone: the function that
  // armed it does nothing but write a line to the log.
  const source = win.document.querySelector('script:not([src])');
  ok(source, 'the page script is there');
  win.close();
});

await test('the collector runs more often once the heap gets big', () => {
  const win = bootPage();
  const internals = win.SKPerf.internals();
  // A fake Unity module: heapMB() only asks how big the memory is.
  const withHeap = (mb) => {
    win.unityInstance = { Module: { wasmMemory: { buffer: { byteLength: mb * 1048576 } } } };
  };
  withHeap(500);
  eq(internals.isMemoryPressure(), false, '500 MB is not pressure');
  eq(internals.gcIntervalTicks(), 60, 'so the collector runs once a minute');
  withHeap(950);
  eq(internals.isMemoryPressure(), true, '950 MB is pressure');
  eq(internals.gcIntervalTicks(), 15, 'so the collector runs four times a minute');
  win.close();
});

section('the default graphics level');

await test('a phone starts low, a desktop starts high', () => {
  const ipad = bootPage({ touch: true });
  eq(ipad.SKPerf.internals().defaultPresetIndex(), 3, 'an iPad starts at Low');
  ipad.close();

  // A mobile browser that reports no touch points at all (iPadOS in
  // "Request Desktop Website" mode, an Android tablet with a mouse).
  const mobile = bootPage({
    touch: false,
    userAgent: 'Mozilla/5.0 (Linux; U; Mobile; en) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/604.1',
  });
  eq(mobile.SKPerf.internals().defaultPresetIndex(), 3, 'a phone browser starts at Low');
  eq(mobile.SKPerf.internals().isSmallDevice(), true, 'and is treated as a small device');
  mobile.close();

  const desktop = bootPage({ touch: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  eq(desktop.SKPerf.internals().defaultPresetIndex(), 0, 'a desktop starts at High');
  eq(desktop.SKPerf.internals().isSmallDevice(), false, 'and is not a small device');
  desktop.close();
});

await test('the default level is a default, not a cage', () => {
  const win = bootPage();
  // The player can still raise it: the ladder is not locked.
  const button = win.document.getElementById('perfBtn');
  button.click(); // Low → Potato
  button.click(); // → Minimum
  button.click(); // → Rock bottom
  button.click(); // → back around to High
  eq(win.SKPerf.settings().activeIndex, 0, 'the ladder can be walked back up to High');
  eq(win.SKPerf.settings().scale, 1, 'and the render scale follows');
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

await test('a missing game build is explained and Start is disabled', async () => {
  const win = bootPage(); // the default fetch stub returns 404 for local and community builds
  await new Promise((resolve) => setTimeout(resolve, 0));
  const missing = win.document.getElementById('buildMissing');
  const start = win.document.getElementById('startBtn');
  eq(win.document.getElementById('status').textContent, 'Game build not found', 'missing-build status');
  eq(start.disabled, true, 'Start cannot be tapped without a build');
  ok(!missing.classList.contains('hidden'), 'the missing-build help is shown');
  ok(missing.querySelector('a[href="BUILD.md"]'), 'build instructions are linked');
  ok(missing.querySelector('a[href="demo.html"]'), 'the no-build loader demo is linked');
  win.close();
});

await test('the pinned community source enables Start and warns about its first-run download', async () => {
  const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));
  const fetchImpl = async (url) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'community-build.json') {
      return { ok: true, status: 200, json: async () => source };
    }
    return { ok: false, status: 404, headers: new Map(), text: async () => '' };
  };
  const win = bootPage({ fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq(win.document.getElementById('startBtn').disabled, false, 'community build can start');
  ok(/1761\.7 MB/.test(win.document.getElementById('sub').textContent), 'first-run archive size is shown');
  eq(win.SKPerf.internals().buildSource(), 'community', 'the community adapter is selected');
  ok(/cdn\.jsdelivr\.net/.test(win.SKPerf.internals().assetBase()), 'the build source uses the pinned CDN base');
  win.close();
});

await test('a prepared manifest takes priority over the community fallback', async () => {
  const win = bootPage({ fetchImpl: manifestFetch(MANIFEST) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  eq(win.SKPerf.internals().buildSource(), 'prepared', 'the local prepared build remains selected');
  eq(win.document.getElementById('startBtn').disabled, false, 'the prepared build can start');
  win.close();
});

section('starting the community build');

// The community loader (Build/w-pt.loader.js at the pinned commit) is not stock
// Unity: web-ports added one line to createUnityInstance — copied verbatim
// below — that ignores config.streamingAssetsUrl and asks the page's <base>
// instead. Their index.html has <base href="https://cdn.jsdelivr.net/gh/
// web-ports/hollow-knight-silksong@master/">; play.html has none, so on the
// iPad this died with "null is not an object (evaluating
// 'document.querySelector('base').href')" right after the 2 GB archive was cached.
const UPSTREAM_LOADER = `
  window.__upstream = { seen: null, passed: null, later: null, laterError: null };
  function createUnityInstance(t, n, l) {
    var b = {};
    for (var o in n) b[o] = n[o];
    b.streamingAssetsUrl = new URL("StreamingAssets",document.querySelector('base').href).href;
    window.__upstream.seen = b.streamingAssetsUrl;
    window.__upstream.passed = n.streamingAssetsUrl;
    l(0);
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Anything that asks again later (the framework, a jslib) must get the same answer.
        try {
          window.__upstream.later = new URL("StreamingAssets", document.querySelector('base').href).href;
        } catch (e) {
          window.__upstream.laterError = String((e && e.message) || e);
        }
        l(1);
        resolve({ Module: b, SendMessage: function () {}, SetFullscreen: function () {}, Quit: function () { return Promise.resolve(); } });
      }, 0);
    });
  }
`;

await test('the community loader finds the <base> it was written for, and the page is not re-rooted', async () => {
  const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));
  const fetchImpl = async (url) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'community-build.json') return { ok: true, status: 200, json: async () => source };
    return { ok: false, status: 404, headers: new Map(), text: async () => '' };
  };
  const win = bootPage({ fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Storage, the 2 GB archive and its ZIP index have their own suites; here
  // they only have to hand over to Unity the way they do once the archive is cached.
  win.SKStream.detect = async () => ({ opfs: true, available: 4e9, quota: 5e9, usage: 0, secure: true });
  win.SKCommunityBuild.ensureArchive = async () => ({ file: new win.Blob(['zip']), dispose() {} });
  const openedModes = [];
  const mount = { entryCount: 1, entryFor: () => null, blobFor: async () => null, close() {} };
  win.SKCommunityBuild.openArchive = async () => { openedModes.push('eager'); return mount; };
  win.SKCommunityBuild.openLazyArchive = async () => { openedModes.push('lazy'); return mount; };
  // jsdom does not fetch <script src>, so run the loader when the page appends it.
  const loaderUrl = source.base + source.unity.loader;
  const append = win.document.body.appendChild.bind(win.document.body);
  win.document.body.appendChild = (node) => {
    if (node && node.tagName === 'SCRIPT' && node.src === loaderUrl) {
      win.eval(UPSTREAM_LOADER);
      setTimeout(() => node.onload && node.onload(), 0);
      return node;
    }
    return append(node);
  };

  win.document.getElementById('startBtn').click();
  const errEl = win.document.getElementById('err');
  const failure = () => (!errEl.classList.contains('hidden') && errEl.textContent.trim().split('\n')[0]) || '';
  for (let i = 0; i < 400 && !win.unityInstance && !failure(); i++) await new Promise((resolve) => setTimeout(resolve, 5));

  eq(failure(), '', 'the start failed with');
  ok(win.unityInstance, 'Unity was started');
  eq(openedModes.join(','), 'eager', 'the default community archive mode is eager');
  const expected = source.base + 'StreamingAssets';
  eq(win.__upstream.seen, expected, 'the loader derived StreamingAssets from the community asset root');
  eq(win.__upstream.passed, expected, 'which is the URL the page passes in the config anyway');
  eq(win.__upstream.laterError, null, 'a later read of the <base> does not throw either');
  eq(win.__upstream.later, expected, 'and gets the same answer');
  eq(win.document.querySelectorAll('base').length, 1, 'exactly one <base>');
  eq(win.document.querySelector('base').getAttribute('href'), null, 'and it has no href attribute');
  eq(win.document.baseURI, 'https://example.test/play.html', 'so the page keeps its own base URL');
  eq(
    win.document.querySelector('a[href="COMMUNITY-BUILD.md"]').href,
    'https://example.test/COMMUNITY-BUILD.md',
    'and its relative links still point at this site, not at the CDN'
  );
  win.close();
});

await test('lazy archive loading requires ?assets=lazy', async () => {
  const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));
  const fetchImpl = async (url) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'community-build.json') return { ok: true, status: 200, json: async () => source };
    return { ok: false, status: 404, headers: new Map(), text: async () => '' };
  };
  const win = bootPage({ fetchImpl, query: '?assets=lazy' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  win.SKStream.detect = async () => ({ opfs: true, available: 4e9, quota: 5e9, usage: 0, secure: true });
  let lazySelected = false;
  let eagerSelected = false;
  win.SKCommunityBuild.ensureArchive = async () => { eagerSelected = true; return { file: new win.Blob(['zip']) }; };
  win.SKCommunityBuild.openLazyArchive = async () => {
    lazySelected = true;
    throw new Error('test stopped after selecting lazy archive mode');
  };
  win.document.getElementById('startBtn').click();
  const error = win.document.getElementById('err');
  for (let i = 0; i < 400 && error.classList.contains('hidden'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  eq(lazySelected, true, '?assets=lazy selects the lazy ZIP path');
  eq(eagerSelected, false, 'the eager download is not started for that opt-in');
  ok(error.textContent.includes('test stopped after selecting lazy archive mode'), 'the failure is shown on the page');
  win.close();
});

/* Boots the page through the stubbed community loader all the way to
 * `completeUnityBoot` (the loading overlay hidden, Unity "running"), the
 * state the reported iPad failure happened in. `arm` runs inside the page
 * right before Start is clicked, so a failure can be planted that only
 * fires once the boot is under way. */
async function bootToUnity({ arm, expectFailure = false, query = '' } = {}) {
  const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));
  const fetchImpl = async (url) => {
    const clean = String(url).replace(/^https?:\/\/[^/]+\//, '');
    if (clean === 'community-build.json') return { ok: true, status: 200, json: async () => source };
    return { ok: false, status: 404, headers: new Map(), text: async () => '' };
  };
  const win = bootPage({ fetchImpl, query });
  await new Promise((resolve) => setTimeout(resolve, 0));
  win.SKStream.detect = async () => ({ opfs: true, available: 4e9, quota: 5e9, usage: 0, secure: true });
  win.SKCommunityBuild.ensureArchive = async () => ({ file: new win.Blob(['zip']), dispose() {} });
  win.SKCommunityBuild.openArchive = async () => ({ entryCount: 1, entryFor: () => null, blobFor: async () => null, close() {} });
  win.SKCommunityBuild.openLazyArchive = win.SKCommunityBuild.openArchive;
  const loaderUrl = source.base + source.unity.loader;
  const append = win.document.body.appendChild.bind(win.document.body);
  win.document.body.appendChild = (node) => {
    if (node && node.tagName === 'SCRIPT' && node.src === loaderUrl) {
      win.eval(UPSTREAM_LOADER);
      setTimeout(() => node.onload && node.onload(), 0);
      return node;
    }
    return append(node);
  };
  if (arm) arm(win);
  win.document.getElementById('startBtn').click();
  const errEl = win.document.getElementById('err');
  const failure = () => (!errEl.classList.contains('hidden') && errEl.textContent.trim().split('\n')[0]) || '';
  for (let i = 0; i < 400 && !win.unityInstance && !failure(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!expectFailure) {
    eq(failure(), '', 'the start failed with');
    ok(win.unityInstance, 'Unity was started');
  }
  return win;
}

/** Releases every frame the page has queued, with timestamps that pass the
 * frame limiter's spacing. Returns how many callbacks ran. */
function pumpFrames(win, tick = 34) {
  let now = 1000;
  let ran = 0;
  while (win.__frames.length) {
    now += tick;
    const batch = win.__frames.splice(0);
    for (const cb of batch) { cb(now); ran++; }
  }
  return ran;
}

await test('a failed lazy ZIP part produces a visible bundle error', async () => {
  const bundle = 'aa/WebGL/packed-lazy.bundle';
  const win = await bootToUnity({
    query: '?assets=lazy',
    arm(next) {
      next.SKCommunityBuild.openLazyArchive = async () => ({
        entryCount: 1,
        entryFor: (url) => String(url).endsWith(bundle)
          ? ({ filename: bundle, uncompressedSize: 32, signature: 0 })
          : null,
        blobFor: async () => { throw new Error('HTTP 503 for WebGL.zip.part42'); },
        close() {},
      });
    },
  });
  const message = await rejects(
    win.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-lazy.bundle'),
    /HTTP 503/,
    'a failed local ZIP part'
  );
  const overlay = win.document.getElementById('recover');
  ok(!overlay.classList.contains('hidden'), 'the player gets an overlay instead of a silent black screen');
  ok(win.document.getElementById('recoverMsg').textContent.includes(bundle), 'the overlay names the bundle');
  ok(win.document.getElementById('recoverMsg').textContent.includes('HTTP 503'), 'the overlay names the failed part status');
  ok(win.document.getElementById('logbox').textContent.includes('asset from local ZIP: ' + bundle), 'the requested bundle is logged');
  ok(message.includes('WebGL.zip.part42'), 'the rejected fetch keeps its original part error');
  win.close();
});

await test('a graphics frame failure surfaces in the recovery overlay instead of a silent 0 fps black screen', async () => {
  // A throwing frame callback before the game is up is only a log line —
  // the start screen is still there to explain things.
  let early = null;
  const win = await bootToUnity({
    arm(next) {
      next.eval("requestAnimationFrame(function () { throw new Error('GPUCanvasContext.configure: too early'); })");
      eq(pumpFrames(next) > 0, true, 'the queued callback ran');
      early = {
        overlayHidden: next.document.getElementById('recover').classList.contains('hidden'),
        logged: next.document.getElementById('logbox').textContent.includes('frame callback: GPUCanvasContext.configure: too early'),
      };
    },
  });
  ok(early.overlayHidden, 'before boot the overlay stays down');
  ok(early.logged, 'and the failure is only logged');

  // After boot the same failure is what the iPad saw: the loading overlay
  // is gone, every frame dies in the same configure error and nothing else
  // would ever tell the player. It must raise the recovery overlay.
  const recover = win.document.getElementById('recover');
  const recoverMsg = win.document.getElementById('recoverMsg');
  ok(recover.classList.contains('hidden'), 'the overlay still starts hidden after a clean boot');
  win.eval("requestAnimationFrame(function () { throw new Error('GPUCanvasContext.configure: Unable to configure. render target: 9440×5872 for a 1180×734 screen'); })");
  pumpFrames(win);
  ok(!recover.classList.contains('hidden'), 'the recovery overlay is up');
  ok(recoverMsg.textContent.includes('GPUCanvasContext.configure: Unable to configure'), 'and names the graphics failure: ' + recoverMsg.textContent.slice(0, 120));
  ok(win.document.getElementById('logbox').textContent.includes('ERROR'), 'the failure is still logged');
  win.close();
});

await test('a startup failure after the loading overlay was hidden restores the error screen', async () => {
  // Fail the page's second game-canvas style application. The first happens
  // when the page initialises; the second happens inside `completeUnityBoot`
  // — after it has already hidden the loading overlay. That is the late
  // startup failure (renderer/canvas setup dying after the boot resolved)
  // that used to leave nothing but a black screen and a log line.
  const win = await bootToUnity({
    arm(next) {
      // Installed after the page has initialised, so the first style write
      // it sees is the one inside `completeUnityBoot` — which runs right
      // after the loading overlay was hidden.
      const canvas = next.document.getElementById('unity-canvas');
      const realStyle = canvas.style;
      let widthWrites = 0;
      Object.defineProperty(canvas, 'style', {
        configurable: true,
        get() {
          return {
            setProperty: (k, v) => realStyle.setProperty(k, v),
            get width() { return realStyle.width; },
            set width(v) { widthWrites++; throw new Error('canvas style exploded'); },
            set height(v) { realStyle.height = v; },
            set transform(v) { realStyle.transform = v; },
          };
        },
      });
    },
    expectFailure: true,
  });
  ok(win.unityInstance, 'Unity itself got as far as starting');
  const errEl = win.document.getElementById('err');
  ok(!win.document.getElementById('screen').classList.contains('hidden'), 'the start screen came back');
  ok(!errEl.classList.contains('hidden'), 'the error text is shown');
  ok(errEl.textContent.includes('canvas style exploded'), 'and names what failed: ' + errEl.textContent.split('\n')[0]);
  eq(win.document.getElementById('startBtn').textContent, 'Try again', 'Start offers a reload');
  win.close();
});

section('render scale and frame cap');

await test('the render scale owns the backing store; full-viewport CSS owns the display size', () => {
  const win = bootPage();
  win.innerWidth = 1024;
  win.innerHeight = 768;
  const internals = win.SKPerf.internals();
  internals.applyResolution();
  const canvas = win.document.getElementById('unity-canvas');
  eq(canvas.width, Math.round(1024 * 0.55), 'backing store is 55 % wide');
  eq(canvas.height, Math.round(768 * 0.55), 'and 55 % tall');
  eq(canvas.style.width, '100%', 'plain CSS fills the viewport for display');
  eq(canvas.style.height, '100%', 'vertically too');
  eq(canvas.style.transform, 'none', 'and there is deliberately no CSS transform for Unity to mis-measure');
  win.close();
});

await test('the reported iPad scene: 25 % on a 1180×734 Retina screen stays 295×184, and Unity is told not to resize', () => {
  const win = bootPage({ query: '?scale=0.25' });
  win.innerWidth = 1180;
  win.innerHeight = 734;
  const internals = win.SKPerf.internals();
  internals.applyResolution();
  const canvas = win.document.getElementById('unity-canvas');
  eq(canvas.width, 295, 'the buffer is 295 px wide');
  eq(canvas.height, 184, 'and 184 px tall — not 9440×5872');
  ok(canvas.width < win.innerWidth && canvas.height < win.innerHeight, 'the buffer stays inside the viewport');
  eq(canvas.style.width, '100%', 'plain CSS fills the viewport for display');
  eq(canvas.style.transform, 'none', 'with no CSS transform for Unity to mis-measure');

  // What kept Unity's runtime from re-multiplying the size back up.
  const config = internals.makeUnityConfig('d', 'c', 'f', 'a');
  eq(config.devicePixelRatio, 1, 'devicePixelRatio is forced to 1 — no Retina multiplication');
  eq(config.matchWebGLToCanvasSize, false, 'Unity does not size the buffer from the CSS box');

  // Fallback renderer selection: a loader that could not be text-patched
  // still gets WebGL 2, cleared from preRun before Unity's main starts.
  ok(Array.isArray(config.preRun) && config.preRun.length === 1, 'exactly one preRun guard');
  const flagged = { SystemInfo: { hasWebGPU: 1 } };
  config.preRun[0](flagged);
  eq(flagged.SystemInfo.hasWebGPU, false, 'the guard clears a WebGPU-flagged SystemInfo');
  config.preRun[0]({ SystemInfo: { hasWebGPU: false } });
  config.preRun[0]({});
  ok(true, 'and it tolerates modules without WebGPU state');

  // Assigning canvas.width/height — even the same numbers — clears the
  // WebGL drawing buffer, so re-applying an unchanged size must not write
  // it again: the frame already on screen has to survive. Spy on the
  // setters to prove the re-apply is a no-op.
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'width');
  const heightDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'height');
  let writes = 0;
  Object.defineProperty(canvas, 'width', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(v) { writes++; descriptor.set.call(this, v); },
  });
  Object.defineProperty(canvas, 'height', {
    configurable: true,
    get() { return heightDescriptor.get.call(this); },
    set(v) { writes++; heightDescriptor.set.call(this, v); },
  });
  internals.applyResolution();
  eq(writes, 0, 'an unchanged size is never reassigned — the drawn frame survives');
  eq(canvas.width, 295, 'and the buffer kept its width');
  eq(canvas.height, 184, 'and its height');
  win.innerWidth = 800;
  internals.applyResolution();
  ok(writes >= 1, 'a real size change still reassigns');
  eq(canvas.width, 200, 'to follow the viewport');

  // The device log says which shell is running.
  const log = win.document.getElementById('logbox').textContent;
  ok(/shell=1\.1\.2 WebGL2/.test(log), 'the menu log shows the shell and renderer: ' + (log.split('\n').find((l) => l.includes('shell=')) || '').trim());
  win.close();
});

await test('picking a graphics level changes scale, cap and the stored preference', () => {
  const win = bootPage();
  const button = win.document.getElementById('perfBtn');
  button.click(); // Low → Potato
  const settings = win.SKPerf.settings();
  eq(settings.activeIndex, 4, 'one step down the ladder');
  eq(settings.scale, 0.4, 'render scale followed');
  eq(settings.fps, 30, 'frame cap followed');
  ok(/Potato/.test(button.textContent), 'the button says so: ' + button.textContent);
  const stored = JSON.parse(win.localStorage.getItem('sk.perf'));
  eq(stored.preset, 4, 'and it is remembered for the next visit');
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
  eq(clean.activeIndex, 3, 'a clean exit starts at Low on an iPad');

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
  eq(afterOne.activeIndex, 4, 'so the next session starts one step lower');

  win.localStorage.setItem('sk.heartbeat', heartbeat);
  internals.evaluateLastSession();
  const afterTwo = win.SKPerf.settings();
  eq(afterTwo.crashSteps, 2, 'a second crash climbs again');
  eq(afterTwo.activeIndex, 5, 'and the level drops further');
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
  eq(win2.SKPerf.settings().scale, 0.55, 'and the graphics default did not change');
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

await test('an idle media element gives its source back', () => {
  const win = bootPage();
  // WebKit keeps a decoder alive for as long as the element is in the
  // document. Unity creates one element per channel, so the page sweeps the
  // ones nobody is using.
  const idle = win.document.createElement('audio');
  idle.setAttribute('src', 'blob:https://example.test/leftover');
  win.document.body.appendChild(idle);
  const released = win.SKPerf.internals().releaseIdleAudio();
  eq(released, 1, 'the idle element was released');
  eq(idle.getAttribute('src'), null, 'and its source is gone');

  // An element that is playing is left alone.
  const playing = win.document.createElement('audio');
  playing.setAttribute('src', 'blob:https://example.test/music');
  Object.defineProperty(playing, 'paused', { value: false, configurable: true });
  win.document.body.appendChild(playing);
  eq(win.SKPerf.internals().releaseIdleAudio(), 0, 'a playing element is not touched');
  eq(playing.getAttribute('src'), 'blob:https://example.test/music', 'and keeps its source');
  win.close();
});

section('shell 1.1.2: crash report, safe mode, engine failures, payload');

function crashReport(win) {
  return win.document.getElementById('crashReport');
}

await test('a killed session leaves a crash report with the heap, the last log lines and safe mode', () => {
  const lines = Array.from({ length: 20 }, (_, i) => 'saved-line-' + i);
  const win = bootPage({
    seedStorage: {
      'sk.heartbeat': JSON.stringify({
        at: Date.now() - 5000,
        start: Date.now() - 120000,
        preset: 'low',
        heap: 1800,
        visible: true,
      }),
      'sk.lastlog': JSON.stringify(lines),
    },
  });
  const report = crashReport(win);
  ok(!report.classList.contains('hidden'), 'the crash report is on the start screen');
  const outcome = win.document.getElementById('crashOutcome').textContent;
  ok(outcome.includes('heap 1800 MB at death'), 'names the heap at death: ' + outcome);
  ok(!outcome.includes('It never reached the game.'), 'a session that booted did reach the game');
  ok(/Starting preset:/.test(win.document.getElementById('crashPreset').textContent), 'names the starting preset');
  const shown = win.document.getElementById('crashLog').textContent.split('\n');
  eq(shown.length, 14, 'only the last 14 recorded lines');
  eq(shown[0], 'saved-line-6', 'older lines are trimmed');
  eq(shown[13], 'saved-line-19', 'the newest line is kept');
  const safe = win.document.getElementById('safeStartBtn');
  ok(!safe.classList.contains('hidden'), 'Start in safe mode is revealed');
  eq(safe.textContent, 'Start in safe mode', 'the button says what it does');
  eq(win.localStorage.getItem('sk.lastlog'), null, 'the recorder key was consumed so it cannot be shown twice');
  const diagnostics = win.SKPerf.internals().diagnosticsText();
  ok(diagnostics.includes('shell=1.1.2 WebGL2'), 'diagnostics name the shell');
  ok(diagnostics.includes('userAgent:'), 'and the user agent');
  ok(diagnostics.includes('last-session:'), 'and a last-session summary');
  ok(diagnostics.includes('stage:'), 'and the stage');
  ok(diagnostics.includes('saved-line-19'), 'and the previous log');
  ok(diagnostics.includes('--- current log ---'), 'and the current log');
  ok(win.document.getElementById('crashCopyBtn'), 'Copy diagnostics is on the report');
  win.close();
});

await test('a mid-load stage death reports that the game was never reached; a hidden or stale marker does not', () => {
  const win = bootPage({
    seedStorage: {
      'sk.stage': JSON.stringify({ stage: 'community archive 40%', at: Date.now() - 10000 }),
      'sk.lastlog': JSON.stringify(['10:00:01  downloading part 12']),
    },
  });
  const report = crashReport(win);
  ok(!report.classList.contains('hidden'), 'a fresh mid-load stage opens the report');
  const outcome = win.document.getElementById('crashOutcome').textContent;
  ok(outcome.includes('It never reached the game.'), 'stage-only death says the game never started: ' + outcome);
  ok(outcome.includes('community archive 40%'), 'and names the stage');
  ok(win.document.getElementById('crashLog').textContent.includes('downloading part 12'), 'the saved log is shown');
  ok(/Starting preset: Low/.test(win.document.getElementById('crashPreset').textContent), 'no crash ladder step without a heartbeat');
  win.close();

  const hidden = bootPage({
    seedStorage: {
      'sk.stage': JSON.stringify({ stage: 'hidden: download 10%', at: Date.now() - 1000 }),
    },
  });
  ok(crashReport(hidden).classList.contains('hidden'), 'a background stage is not a crash report');
  hidden.close();

  const stale = bootPage({
    seedStorage: {
      'sk.stage': JSON.stringify({ stage: 'community archive 40%', at: Date.now() - 2 * 3600 * 1000 }),
    },
  });
  ok(crashReport(stale).classList.contains('hidden'), 'a stage older than an hour is not a crash report');
  stale.close();
});

await test('a clean pagehide clears the flight recorder so a normal close leaves no report', () => {
  const win = bootPage();
  const internals = win.SKPerf.internals();
  internals.log('still alive');
  internals.flushLog();
  const saved = win.localStorage.getItem('sk.lastlog');
  ok(saved && saved.includes('still alive'), 'the recorder wrote the log before the close');
  win.dispatchEvent(new win.Event('pagehide'));
  eq(win.localStorage.getItem('sk.lastlog'), null, 'pagehide cleared the recorder');
  internals.flushLog();
  eq(win.localStorage.getItem('sk.lastlog'), null, 'a later flush cannot restore a clean exit');
  win.close();
});

await test('a small device downloads 3 archive parts at once, a desktop 6, and ?downloads= still overrides', () => {
  const ipad = bootPage();
  eq(ipad.SKPerf.internals().downloadConcurrency(), 3, 'iPad default is 3 in-flight parts');
  ipad.close();
  const desktop = bootPage({ touch: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  eq(desktop.SKPerf.internals().downloadConcurrency(), 6, 'desktop default stays 6');
  desktop.close();
  const overridden = bootPage({ query: '?downloads=2' });
  eq(overridden.SKPerf.internals().downloadConcurrency(), 2, '?downloads= still overrides the device default');
  overridden.close();
});

await test('safe mode reloads with the rock-bottom memory parameters', () => {
  const win = bootPage({ query: '?community=1&foo=bar' });
  const url = new URL(win.SKPerf.internals().safeStartUrl());
  eq(url.origin + url.pathname, 'https://example.test/play.html', 'same page');
  eq(url.searchParams.get('preset'), 'rock_bottom');
  eq(url.searchParams.get('fps'), '24');
  eq(url.searchParams.get('auto'), '1');
  eq(url.searchParams.get('downloads'), '2');
  eq(url.searchParams.get('bundleCacheMB'), '64');
  eq(url.searchParams.get('foo'), 'bar', 'existing parameters are kept');
  eq(url.searchParams.get('community'), '1', 'and so is the build selector');
  win.close();
});

await test('an engine failure before the first frame raises the overlay, and not after noteEngineFrame', async () => {
  const early = bootPage();
  early.SKPerf.internals().surfaceEngineFailure('too early');
  ok(early.document.getElementById('recover').classList.contains('hidden'), 'before boot the overlay stays down');
  ok(early.document.getElementById('logbox').textContent.includes('too early'), 'and the failure is still logged');
  early.close();

  const win = await bootToUnity();
  const internals = win.SKPerf.internals();
  const recover = win.document.getElementById('recover');
  const recoverMsg = win.document.getElementById('recoverMsg');
  ok(recover.classList.contains('hidden'), 'a clean boot leaves the overlay down');
  internals.surfaceEngineFailure('wasm compile aborted');
  ok(!recover.classList.contains('hidden'), 'a pre-frame failure raises the overlay');
  ok(recoverMsg.textContent.includes('The engine failed while starting and never drew a frame.'), 'says no frame was drawn');
  ok(recoverMsg.textContent.includes('wasm compile aborted'), 'and names the failure: ' + recoverMsg.textContent.slice(0, 160));
  win.document.getElementById('recoverWait').click();
  ok(recover.classList.contains('hidden'), 'the player can dismiss it');
  internals.noteEngineFrame();
  internals.surfaceEngineFailure('later glitch');
  ok(recover.classList.contains('hidden'), 'after a frame the overlay stays down');
  ok(win.document.getElementById('logbox').textContent.includes('later glitch'), 'the later failure is still logged');
  win.close();
});

function headResponse(bytes, status = 206) {
  const copy = Uint8Array.from(bytes);
  const buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buffer,
  };
}

await test('payload magic check accepts real Unity data and rejects a captive-portal page', async () => {
  const win = bootPage();
  const dataMagic = Array.from(new TextEncoder().encode('UnityWebData1.0\0'));
  const wasmMagic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const ranges = [];
  win.fetch = async (url, opts) => {
    const range = (opts && opts.headers && (opts.headers.Range || opts.headers.range)) || '';
    ranges.push(String(url) + ' ' + range);
    return headResponse(String(url).includes('data') ? dataMagic : wasmMagic);
  };
  eq(await win.SKPerf.internals().verifyPayloadMagics('https://cdn.test/game.data', 'https://cdn.test/game.wasm'), true, 'matching magics pass');
  const probes = ranges.filter((line) => line.includes('cdn.test'));
  eq(probes.length, 2, 'one range probe per payload: ' + ranges.join(' | '));
  ok(probes.every((line) => line.endsWith('bytes=0-15')), 'both probes use a 16-byte Range: ' + probes.join(' | '));
  const log = win.document.getElementById('logbox').textContent;
  ok(/payload check:/.test(log) && /the real game data reached Unity/.test(log), 'success is logged: ' + log.split('\n').filter((l) => l.includes('payload check')).join(' | '));

  win.fetch = async (url) => headResponse(new TextEncoder().encode(String(url).includes('data') ? '<!DOCTYPE html><html>' : 'not-wasm-bytes!!'), 200);
  eq(await win.SKPerf.internals().verifyPayloadMagics('https://cdn.test/game.data', 'https://cdn.test/game.wasm'), false, 'captive portal HTML is not game data');
  const errLog = win.document.getElementById('logbox').textContent;
  ok(/does not look like/.test(errLog), 'mismatch says it does not look like game data');
  ok(/\(head:/.test(errLog), 'and includes the head bytes');
  ok(/the cached copy is wrong/.test(errLog), 'and tells the player the cache is wrong');
  ok(/clear this site's website data/.test(errLog), 'and how to recover without pretending the graphics setting will fix it');

  // The pinned .unityweb files are gzip containers. fetch does not unwrap that
  // layer unless the server sets Content-Encoding, so the probe must inflate
  // a small prefix rather than call a good cache corrupt.
  if (typeof DecompressionStream === 'function') {
    win.DecompressionStream = DecompressionStream;
    if (typeof win.ReadableStream !== 'function') win.ReadableStream = ReadableStream;
    const gzipped = zlib.gzipSync(Buffer.concat([
      Buffer.from('UnityWebData1.0\0'),
      Buffer.alloc(64, 7),
    ]));
    const wasmGz = zlib.gzipSync(Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const gzipRanges = [];
    win.fetch = async (url, opts) => {
      gzipRanges.push((opts && opts.headers && opts.headers.Range) || '');
      const which = String(url).includes('data') ? gzipped : wasmGz;
      const match = /bytes=0-(\d+)/.exec((opts && opts.headers && opts.headers.Range) || '');
      const n = match ? Number(match[1]) + 1 : which.length;
      return headResponse(which.subarray(0, n), 206);
    };
    eq(await win.SKPerf.internals().verifyPayloadMagics('https://cdn.test/game.data.unityweb', 'https://cdn.test/game.wasm.unityweb'), true, 'a gzip .unityweb container still counts as the real data');
    ok(gzipRanges.includes('bytes=0-15') && gzipRanges.includes('bytes=0-4095'), 'gzip needs a short follow-up range, not the whole file: ' + gzipRanges.join(','));
    ok(/the real game data reached Unity/.test(win.document.getElementById('logbox').textContent), 'and the success line is still logged');
  }
  win.close();
});

await done('page tests');
