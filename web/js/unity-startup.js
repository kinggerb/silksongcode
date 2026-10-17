/* Overlap immutable Unity entry-point downloads and native streaming Wasm
 * compilation with ZIP indexing. Strictly verified loader patch, stock fallback. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SKUnityStartup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LOADER_SHA256 = '6705d6c08f287b6dbd825f3e2c73a104af54a782303f00507e0465194753b7c2';
  var HOOK = '}), T("codeUrl")])';
  var GZIP_HOOK = 'hasUnityMarker: function(e) {\n                return true\n            }';
  // Unity 6 probes WebGPU and, when navigator.gpu answers with an adapter,
  // points the game at a WebGPU renderer. On the affected iPad (Safari,
  // Retina) that adapter was found and the game then died inside
  // `GPUCanvasContext.configure` — "render target: 9440×5872 for a 1180×734
  // screen" — so not one frame was ever drawn and the tab stayed black at
  // 0 fps. This build is a WebGL 2 build; the adapter probe below is the
  // loader's only WebGPU decision point, so it is cut out entirely: no
  // adapter request is made, and SystemInfo.hasWebGPU is hard-set to false,
  // before the framework (which reads it to pick the renderer) ever loads.
  // The exact text is verified against the pinned loader above; a loader
  // whose digest does not match is never patched at all (see prepare()).
  var WEBGPU_PROBE = 'navigator.gpu ? navigator.gpu.requestAdapter().then(function(e) {\n' +
    '                b.SystemInfo.hasWebGPU = !!e,\n' +
    '                t(b.SystemInfo.hasWebGPU)\n' +
    '            }) : t(!1)';
  var WEBGPU_PATCHED = 'b.SystemInfo.hasWebGPU = !1,\n' +
    '                t(!1)';
  function patchLoader(text, streaming) {
    if (text.split(HOOK).length !== 2 || text.split(GZIP_HOOK).length !== 2 || text.split(WEBGPU_PROBE).length !== 2) throw new Error('unsupported Unity loader: compression/streaming hook is not unique');
    // Upstream hard-codes this predicate to true. Native HTTP-decoded JS/data
    // would otherwise be inflated AGAIN into undefined/corrupt bytes.
    text = text.replace(GZIP_HOOK, 'hasUnityMarker: function(e) { return e && e.length > 2 && e[0] === 31 && e[1] === 139; }');
    // Force the WebGL 2 renderer in BOTH Wasm modes: without the adapter
    // request the probe resolves immediately, exactly as on a browser with
    // no navigator.gpu at all, and startup continues through the same .then.
    text = text.replace(WEBGPU_PROBE, WEBGPU_PATCHED);
    return streaming === false ? text : text.replace(HOOK, '}), b.instantiateWasm ? Promise.resolve(null) : T("codeUrl")])');
  }
  async function wasmResponse(response) {
    if (!response.ok || !response.body) throw new Error('Wasm HTTP ' + response.status);
    var reader = response.body.getReader(), chunks = [], length = 0;
    try {
      while (length < 4) {
        var item = await reader.read();
        if (item.done) throw new Error('truncated Wasm response');
        chunks.push(item.value); length += item.value.length;
      }
    } catch (error) { await reader.cancel().catch(function () {}); throw error; }
    var head = new Uint8Array(4), at = 0;
    chunks.forEach(function (chunk) { var n = Math.min(4 - at, chunk.length); if (n > 0) { head.set(chunk.subarray(0, n), at); at += n; } });
    var body = new ReadableStream({
      start: function (controller) { chunks.forEach(function (chunk) { controller.enqueue(chunk); }); chunks = []; },
      async pull(controller) {
        try { var item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
        catch (error) { controller.error(error); }
      },
      cancel: function (reason) { return reader.cancel(reason); },
    });
    if (head[0] === 0x1f && head[1] === 0x8b) body = body.pipeThrough(new DecompressionStream('gzip'));
    else if (!(head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d)) {
      await body.cancel(); throw new Error('unrecognized Wasm encoding; using stock decoder');
    }
    return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
  }
  function preconnect(url, doc) {
    if (!doc) return;
    var origin = new URL(url, doc.baseURI).origin;
    if (Array.from(doc.querySelectorAll('link[rel="preconnect"]')).some(function (link) { return link.href === origin + '/' || link.href === origin; })) return;
    var link = doc.createElement('link'); link.rel = 'preconnect'; link.href = origin; link.crossOrigin = 'anonymous'; doc.head.appendChild(link);
  }
  async function prepare(source, options) {
    options = options || {};
    var base = options.base || source.base, log = options.onLog || function () {};
    var fetchImpl = options.fetchImpl || fetch.bind(globalThis);
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var urls = {};
    ['loader', 'data', 'wasm', 'framework'].forEach(function (key) { urls[key] = new URL(source.unity[key], base).href; });
    preconnect(base, doc);
    // Fetch preloads match Unity's CORS fetch mode, and rely on the browser's
    // cache rather than retaining giant ArrayBuffers in page JavaScript.
    if (doc) ['data', 'framework'].forEach(function (key) {
      var link = doc.createElement('link'); link.rel = 'preload'; link.as = 'fetch';
      link.href = urls[key]; link.crossOrigin = 'anonymous'; doc.head.appendChild(link);
    });
    var runtime = { loaderUrl: urls.loader, configure: function (config) {
      // Pinned immutable URLs do not need a round trip to revalidate on every boot.
      config.cacheControl = function (url) {
        // The OPFS layer already owns bundles. UnityCache would clone and store
        // each response a second time, defeating its bounded extraction budget.
        if (/\.bundle(?:[?#]|$)/i.test(url) || /\/StreamingAssets\//i.test(url)) return 'no-store';
        return url.indexOf(base) === 0 ? 'immutable' : 'no-store';
      };
    }, dispose: function () {} };
    if (typeof crypto === 'undefined' || !crypto.subtle) return runtime;
    var wantStreaming = options.streaming !== false && typeof WebAssembly.compileStreaming === 'function' && typeof DecompressionStream === 'function';
    var compiled, objectUrl;
    var controller = new AbortController();
    var cancel = function () { controller.abort(); };
    if (options.signal && options.signal.aborted) cancel();
    if (options.signal) options.signal.addEventListener('abort', cancel, { once: true });
    var timeout = setTimeout(cancel, options.timeoutMs || 90000);
    try {
      var start = Date.now();
      var result = await Promise.all([
        fetchImpl(urls.loader, { cache: 'force-cache', signal: controller.signal }).then(async function (res) {
          if (!res.ok) throw new Error('loader HTTP ' + res.status);
          var bytes = await res.arrayBuffer();
          var digest = await crypto.subtle.digest('SHA-256', bytes);
          var hex = Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          if (hex !== LOADER_SHA256) throw new Error('loader digest changed; leaving it unmodified');
          return patchLoader(new TextDecoder().decode(bytes), wantStreaming);
        }),
        wantStreaming ? fetchImpl(urls.wasm, { cache: 'force-cache', signal: controller.signal }).then(wasmResponse).then(function (res) { return WebAssembly.compileStreaming(res); }) : Promise.resolve(null),
      ]);
      compiled = result[1];
      objectUrl = URL.createObjectURL(new Blob([result[0]], { type: 'text/javascript' }));
      var fail;
      runtime.failed = new Promise(function (_, reject) { fail = reject; });
      runtime.failed.catch(function () {});
      var configure = runtime.configure;
      runtime.configure = function (config) {
        configure(config);
        if (compiled) config.instantiateWasm = function (imports, receive) {
          WebAssembly.instantiate(compiled, imports).then(function (instance) { receive(instance, compiled); compiled = null; }).catch(fail);
          return {};
        };
      };
      runtime.loaderUrl = objectUrl;
      runtime.dispose = function () { compiled = null; URL.revokeObjectURL(objectUrl); };
      log(wantStreaming
        ? 'Wasm compiled with native streaming in ' + (Date.now() - start) + ' ms (overlapped with asset setup); verified loader forces WebGL 2 (WebGPU probe removed)'
        : 'verified loader: WebGL 2 forced (WebGPU probe removed), native HTTP decoding guard enabled; stock Wasm path');
    } catch (error) {
      controller.abort();
      compiled = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      log('native streaming unavailable — using the unchanged Unity loader: ' + error.message +
        ' (the page preRun guard still forces WebGL 2 at startup)');
    }
    clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener('abort', cancel);
    return runtime;
  }
  return { prepare: prepare, wasmResponse: wasmResponse, patchLoader: patchLoader, preconnect: preconnect, LOADER_SHA256: LOADER_SHA256 };
});
