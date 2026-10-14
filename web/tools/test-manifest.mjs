/* ============================================================================
 * test-manifest.mjs — the build manifest and the pre-download data check
 * ----------------------------------------------------------------------------
 *   node web/tools/test-manifest.mjs
 *
 * js/manifest.js is what the page uses to answer "is the game data actually
 * there?" before a single chunk is downloaded: the chunk list, the totals, and
 * one cheap HTTP Range request per chunk. These tests drive it with a fake
 * fetch, including the cases that used to show up as a black screen inside
 * Unity (a chunk that is a different size than the manifest says, an HTML error
 * page where the loader should be, a missing manifest).
 * ==========================================================================*/

import { section, test, eq, ok, done } from './testkit.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SKManifest = require('../js/manifest.js');

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    // the manifest hands out paths with and without a leading slash ("Build/…"
    // when there is no base url, "/Build/…" after one)
    const keys = [path, '/' + path.replace(/^\//, ''), decodeURIComponent(path)];
    let entry;
    for (const key of keys) {
      if (routes[key] !== undefined) {
        entry = routes[key];
        break;
      }
    }
    if (entry === undefined) return { ok: false, status: 404, headers: new Map(), text: async () => 'not found' };
    if (entry === null) return { ok: false, status: 500, headers: new Map(), text: async () => '' };
    if (typeof entry === 'string') {
      return { ok: true, status: 200, headers: new Map([['content-length', String(entry.length)]]), text: async () => entry };
    }
    if (entry.json !== undefined) {
      const text = JSON.stringify(entry.json);
      return { ok: true, status: 200, headers: new Map([['content-length', String(text.length)]]), text: async () => text };
    }
    // a "file": answer Range requests like a real server
    const headers = new Map([
      ['content-length', String(entry.bytes)],
      ['content-range', 'bytes 0-0/' + entry.bytes],
    ]);
    return { ok: true, status: 206, headers, body: { cancel: async () => {} }, text: async () => '' };
  };
}

const GOOD = {
  schema: 2,
  name: 'silksong',
  buildId: 'silksong-webgl-test',
  partBytes: 100,
  unity: {
    loader: 'Build/silksong.loader.js',
    framework: 'Build/silksong.framework.js',
    streamingAssets: 'StreamingAssets/',
  },
  datasets: {
    data: {
      cacheKey: 'silksong.data',
      mime: 'application/octet-stream',
      total: 250,
      parts: [
        { path: 'Build/silksong.data.part1', bytes: 100 },
        { path: 'Build/silksong.data.part2', bytes: 100 },
        { path: 'Build/silksong.data.part3', bytes: 50 },
      ],
    },
    wasm: {
      cacheKey: 'silksong.wasm',
      mime: 'application/wasm',
      total: 80,
      parts: [{ path: 'Build/silksong.wasm.part1', bytes: 80 }],
    },
  },
};

section('shape validation');

await test('a well-formed manifest loads and is normalised', async () => {
  const manifest = await SKManifest.load({ fetch: fakeFetch({ '/Build/build-manifest.json': { json: GOOD } }) });
  eq(manifest.kind, 'manifest', 'kind');
  eq(manifest.problems.length, 0, 'no problems');
  eq(manifest.datasets.data.total, 250, 'data total');
  eq(manifest.datasets.wasm.total, 80, 'wasm total');
  eq(manifest.unity.loaderUrl, 'Build/silksong.loader.js', 'loader url resolved');
  eq(manifest.datasets.data.parts.length, 3, 'chunk count');
});

await test('a base url is applied to every path', async () => {
  const manifest = await SKManifest.load({
    base: 'https://cdn.example.com/silksong/',
    fetch: fakeFetch({ '/silksong/Build/build-manifest.json': { json: GOOD } }),
  });
  eq(manifest.unity.loaderUrl, 'https://cdn.example.com/silksong/Build/silksong.loader.js', 'loader url');
  eq(manifest.datasets.data.parts[0].path, 'Build/silksong.data.part1', 'chunk paths stay relative');
  eq(manifest.base, 'https://cdn.example.com/silksong/', 'base remembered');
});

await test('a missing manifest falls back to the default layout instead of throwing', async () => {
  const manifest = await SKManifest.load({ fetch: fakeFetch({}) });
  eq(manifest.kind, 'fallback', 'fallback kind');
  eq(manifest.datasets && Object.keys(manifest.datasets).length, 0, 'no datasets invented');
  ok(manifest.problems.length > 0, 'the problem is recorded');
});

await test('arithmetic that does not add up is reported', () => {
  const broken = JSON.parse(JSON.stringify(GOOD));
  broken.datasets.data.total = 999;
  const problems = SKManifest.validate(broken);
  ok(problems.some((p) => /total 999/.test(p)), 'the total mismatch is named: ' + problems.join('; '));
});

await test('a manifest with no chunk list is reported, not guessed at', () => {
  const problems = SKManifest.validate({ datasets: { data: { cacheKey: 'x' } }, unity: { loader: 'a.js' } });
  ok(problems.some((p) => /no parts/.test(p)), problems.join('; '));
});

section('chunk probing');

await test('every chunk is probed with a Range request and sizes are compared', async () => {
  const asked = [];
  const routes = {
    '/Build/silksong.data.part1': { bytes: 100 },
    '/Build/silksong.data.part2': { bytes: 100 },
    '/Build/silksong.data.part3': { bytes: 50 },
    '/Build/silksong.wasm.part1': { bytes: 80 },
  };
  const base = fakeFetch(routes);
  const fetchImpl = async (url, opts) => {
    asked.push({ url, range: (opts && opts.headers && opts.headers.range) || null });
    return base(url, opts);
  };
  const manifest = await SKManifest.load({ fetch: async (u, o) => fakeFetch({ '/Build/build-manifest.json': { json: GOOD } })(u, o) });
  const report = await SKManifest.checkBuild(manifest, { fetch: fetchImpl, loaderText: () => {} });
  ok(report.datasets.data.checked === 3, 'three data chunks checked');
  ok(report.datasets.wasm.checked === 1, 'one wasm chunk checked');
  const chunkAsks = asked.filter((a) => /\.part\d+$/.test(a.url));
  eq(chunkAsks.length, 4, 'one request per chunk');
  ok(chunkAsks.every((a) => a.range === 'bytes=0-0'), 'and each asks for a single byte (no chunk is downloaded)');
  ok(asked.filter((a) => /loader\.js$/.test(a.url)).every((a) => a.range === null), 'the loader js is fetched whole');
  ok(report.datasets.data.ok, 'all chunks look right');
});

await test('a chunk of the wrong size is caught before booting', async () => {
  const manifest = await SKManifest.load({ fetch: fakeFetch({ '/Build/build-manifest.json': { json: GOOD } }) });
  const report = await SKManifest.checkDataset(manifest.datasets.data, {
    fetch: fakeFetch({
      '/Build/silksong.data.part1': { bytes: 100 },
      '/Build/silksong.data.part2': { bytes: 42 }, // wrong
      '/Build/silksong.data.part3': { bytes: 50 },
    }),
  });
  eq(report.ok, false, 'the build is reported as broken');
  eq(report.bad.length, 1, 'exactly one bad chunk');
  ok(/is 42 bytes, manifest says 100/.test(report.bad[0].reason), 'the reason is specific: ' + report.bad[0].reason);
});

await test('a missing chunk is caught', async () => {
  const manifest = await SKManifest.load({ fetch: fakeFetch({ '/Build/build-manifest.json': { json: GOOD } }) });
  const report = await SKManifest.checkDataset(manifest.datasets.data, {
    fetch: fakeFetch({ '/Build/silksong.data.part1': { bytes: 100 }, '/Build/silksong.data.part3': { bytes: 50 } }),
  });
  eq(report.ok, false, 'reported as broken');
  ok(report.bad.some((b) => /404/.test(b.reason)), 'the 404 is named');
});

await test('an HTML error page served as the loader is caught', async () => {
  const manifest = await SKManifest.load({ fetch: fakeFetch({ '/Build/build-manifest.json': { json: GOOD } }) });
  const report = await SKManifest.checkBuild(manifest, {
    fetch: fakeFetch({
      '/Build/silksong.loader.js': '<!DOCTYPE html><html>404</html>',
      '/Build/silksong.framework.js': 'var Unity = {};',
      '/Build/silksong.data.part1': { bytes: 100 },
      '/Build/silksong.data.part2': { bytes: 100 },
      '/Build/silksong.data.part3': { bytes: 50 },
      '/Build/silksong.wasm.part1': { bytes: 80 },
    }),
  });
  eq(report.ok, false, 'the build check fails');
  eq(report.unity.loader.ok, false, 'the loader is flagged');
  ok(/createUnityInstance/.test(report.unity.loader.reason), 'and says what was missing');
});

await done('manifest tests');
