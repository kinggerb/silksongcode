/* ============================================================================
 * manifest.js — build description + "is the game data actually there?" checks
 * ----------------------------------------------------------------------------
 * `web/Build/build-manifest.json` is written by tools/prepare-build.mjs and is
 * the single source of truth for what the page must download:
 *
 *   {
 *     "name": "silksong",
 *     "buildId": "silksong-webgl-<stamp>",
 *     "partBytes": 20971520,
 *     "unity": { "loader": "...", "framework": "...", "streamingAssets": "..." },
 *     "datasets": {
 *        "data": { "cacheKey": "...", "mime": "...", "total": 123, "parts": [...] },
 *        "wasm": { "cacheKey": "...", "mime": "...", "total": 123, "parts": [...] }
 *     },
 *     "integrity": { "data": { "sha256": ..., "headSha256": ..., "tailSha256": ... } }
 *   }
 *
 * Nothing about Silksong's build is hard-coded in the page: chunk names, chunk
 * sizes, part counts and digests all come from that file, so a rebuilt game
 * (new patch, different chunk size, cutscenes stripped) works without touching
 * the HTML.
 *
 * The manifest check is deliberately cheap: the parts are probed with HTTP
 * Range requests (`bytes=0-0`), so a 400 MB build is validated in a few KB of
 * traffic. A missing or truncated chunk is reported *before* the download
 * starts instead of surfacing as a black screen inside Unity.
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKManifest = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PATH = 'Build/build-manifest.json';

  /* A build that was not prepared by tools/prepare-build.mjs still gets a
   * chance: this is what the page assumes for a plain Unity WebGL build with
   * the default chunk size. prepare-build.mjs overwrites it with the truth. */
  var FALLBACK = {
    kind: 'fallback',
    buildId: 'unknown-build',
    partBytes: 20 * 1024 * 1024,
    unity: {
      loader: 'Build/silksong.loader.js',
      framework: 'Build/silksong.framework.js',
      streamingAssets: 'StreamingAssets/',
    },
    datasets: {},
  };

  function mb(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function abs(base, path) {
    if (!base) return path;
    return String(base).replace(/\/$/, '') + '/' + path;
  }

  function fail(message) {
    var e = new Error(message);
    e.name = 'ManifestError';
    return e;
  }

  /* ---------------------------------------------------------------- *
   * Loading + shape validation
   * ---------------------------------------------------------------- */

  function validate(manifest) {
    var problems = [];
    if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
    if (!manifest.datasets || typeof manifest.datasets !== 'object') problems.push('no datasets');

    ['data', 'wasm'].forEach(function (key) {
      var set = manifest.datasets && manifest.datasets[key];
      if (!set) return; // a build without a wasm dataset is odd but survivable
      if (!set.cacheKey) problems.push(key + ': missing cacheKey');
      if (!Array.isArray(set.parts) || !set.parts.length) problems.push(key + ': no parts');
      else {
        var sum = 0;
        set.parts.forEach(function (part, i) {
          if (typeof part.bytes !== 'number' || part.bytes <= 0) problems.push(key + ' part ' + (i + 1) + ': bad size');
          if (!part.path) problems.push(key + ' part ' + (i + 1) + ': missing path');
          sum += part.bytes || 0;
        });
        set.total = set.total || sum;
        if (set.total !== sum) problems.push(key + ': total ' + set.total + ' != sum of parts ' + sum);
      }
    });

    if (!manifest.unity || !manifest.unity.loader) problems.push('no unity.loader');
    return problems;
  }

  function normalize(manifest, base) {
    var out = JSON.parse(JSON.stringify(manifest));
    out.base = base || '';
    Object.keys(out.datasets || {}).forEach(function (key) {
      var set = out.datasets[key];
      set.total = set.total || (set.parts || []).reduce(function (a, p) {
        return a + (p.bytes || 0);
      }, 0);
      set.url = abs(out.base, set.parts && set.parts.length ? set.parts[0].path : '');
    });
    out.unity.loaderUrl = abs(out.base, out.unity.loader);
    out.unity.frameworkUrl = abs(out.base, out.unity.framework);
    out.unity.streamingAssetsUrl = abs(out.base, out.unity.streamingAssets || 'StreamingAssets/');
    return out;
  }

  /**
   * Fetch and validate the manifest. Never rejects: a missing manifest falls
   * back to the baked-in defaults with `kind: 'fallback'` (and a `problems`
   * list) so the page can still explain what is wrong.
   */
  async function load(opts) {
    opts = opts || {};
    var url = abs(opts.base, opts.path || DEFAULT_PATH);
    var fetchImpl = opts.fetch || fetch;
    var log = opts.log || function () {};

    try {
      var res = await fetchImpl(url, { cache: 'no-cache' });
      if (!res.ok) {
        log('no build manifest at ' + url + ' (HTTP ' + res.status + ')');
        return Object.assign({}, FALLBACK, { problems: ['missing ' + (opts.path || DEFAULT_PATH)] });
      }
      var text = await res.text();
      var manifest = JSON.parse(text);
      var problems = validate(manifest);
      if (problems.length) log('manifest problems: ' + problems.join('; '));
      var normalized = normalize(manifest, opts.base);
      normalized.problems = problems;
      normalized.kind = problems.length ? 'partial' : 'manifest';
      log(
        'manifest: ' + normalized.buildId + ' — data ' + mb(normalized.datasets.data ? normalized.datasets.data.total : 0) +
          ' in ' + ((normalized.datasets.data || {}).parts || []).length + ' chunks' +
          (normalized.datasets.wasm ? ', wasm ' + mb(normalized.datasets.wasm.total) : '')
      );
      return normalized;
    } catch (e) {
      log('could not read the build manifest: ' + ((e && e.message) || e));
      return Object.assign({}, FALLBACK, { problems: ['unreadable manifest: ' + ((e && e.message) || e)] });
    }
  }

  /* ---------------------------------------------------------------- *
   * Probing the chunks (cheap: one Range request per part)
   * ---------------------------------------------------------------- */

  async function probePart(url, expectedBytes, fetchImpl) {
    try {
      var res = await fetchImpl(url, { headers: { range: 'bytes=0-0' }, cache: 'no-cache' });
      if (res.status === 416) return { url: url, ok: false, reason: 'empty (416)' };
      if (!res.ok && res.status !== 206) return { url: url, ok: false, reason: 'HTTP ' + res.status };
      var range = res.headers && res.headers.get ? res.headers.get('content-range') : null;
      var total = 0;
      if (range && /\/(\d+)\s*$/.test(range)) total = Number(RegExp.$1);
      else if (res.headers && res.headers.get) total = Number(res.headers.get('content-length') || 0);
      if (res.body && res.body.cancel) {
        try {
          await res.body.cancel();
        } catch (e) {
          /* ignore */
        }
      }
      if (!total) return { url: url, ok: true, reason: 'size unknown' };
      if (expectedBytes && total !== expectedBytes) {
        return { url: url, ok: false, reason: 'is ' + total + ' bytes, manifest says ' + expectedBytes };
      }
      return { url: url, ok: true, bytes: total };
    } catch (e) {
      return { url: url, ok: false, reason: String((e && e.message) || e) };
    }
  }

  /**
   * Check every chunk of `dataset` with a Range request.
   * Returns {ok, checked, bad:[...], missing:[...]}.
   */
  async function checkDataset(dataset, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetch || fetch;
    if (!dataset || !dataset.parts || !dataset.parts.length) return { ok: false, checked: 0, bad: [], missing: ['no parts'] };
    var parts = dataset.parts.map(function (p) {
      return { url: abs(opts.base, p.path), bytes: p.bytes };
    });
    var results = [];
    var concurrency = Math.max(1, Math.min(opts.concurrency || 4, 6));
    for (var i = 0; i < parts.length; i += concurrency) {
      var slice = parts.slice(i, i + concurrency);
      results = results.concat(
        await Promise.all(
          slice.map(function (p) {
            return probePart(p.url, p.bytes, fetchImpl);
          })
        )
      );
    }
    var bad = results.filter(function (r) {
      return !r.ok;
    });
    return {
      ok: bad.length === 0,
      checked: results.length,
      total: parts.length,
      bad: bad,
      missing: bad.map(function (b) {
        return b.url;
      }),
    };
  }

  /** Sanity check the whole build: manifest + every dataset + the JS entry points. */
  async function checkBuild(manifest, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetch || fetch;
    var report = { ok: true, datasets: {}, unity: {}, notes: [] };

    var keys = Object.keys(manifest.datasets || {});
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var res = await checkDataset(manifest.datasets[key], { base: manifest.base, fetch: fetchImpl });
      report.datasets[key] = res;
      if (!res.ok) report.ok = false;
    }

    // The JS entry points are small: fetch them for real and look for the
    // expected symbols, which catches an HTML error page served instead.
    for (var name of ['loader', 'framework']) {
      var url = manifest.unity[name + 'Url'];
      if (!url) continue;
      try {
        var res2 = await fetchImpl(url, { cache: 'no-cache' });
        if (!res2.ok) {
          report.unity[name] = { ok: false, reason: 'HTTP ' + res2.status };
          report.ok = false;
          continue;
        }
        var text = await res2.text();
        var marker = name === 'loader' ? 'createUnityInstance' : 'Unity';
        var okMark = text.indexOf(marker) !== -1;
        report.unity[name] = { ok: okMark, bytes: text.length, reason: okMark ? '' : 'no "' + marker + '" in the file' };
        if (!okMark) report.ok = false;
      } catch (e) {
        report.unity[name] = { ok: false, reason: String((e && e.message) || e) };
        report.ok = false;
      }
    }

    if (manifest.kind === 'fallback') {
      report.notes.push('no prepared manifest — using the default chunk layout');
    }
    return report;
  }

  return {
    DEFAULT_PATH: DEFAULT_PATH,
    FALLBACK: FALLBACK,
    load: load,
    validate: validate,
    normalize: normalize,
    probePart: probePart,
    checkDataset: checkDataset,
    checkBuild: checkBuild,
    mb: mb,
  };
});
