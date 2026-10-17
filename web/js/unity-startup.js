/* Overlap immutable Unity entry-point downloads and native streaming Wasm
 * compilation with ZIP indexing. Strictly verified loader patch, stock fallback.
 *
 * Three verified runtime patches live here, each applied only to bytes that
 * provably are the pinned build, and each individually skippable:
 *
 *   1. the loader (SHA-256 pinned): the WebGPU adapter probe is cut out so
 *      the WebGL 2 renderer is used, and the gzip marker re-checks magic
 *      bytes instead of assuming compression;
 *   2. the wasm (memory-section bytes + unique context verified in-stream):
 *      the declared *initial* memory is lowered (2048 → 1536 MiB by
 *      default, the 4080 MiB maximum untouched) and the unload-assets gate
 *      is forced on — see buildWasmPatches(). Without (2) the tab is
 *      jetsam-killed by iPadOS moments after the engine reports ready;
 *   3. the framework (SHA-256 pinned, either gzip file or inflated text):
 *      channel.disconnectSource gives the <audio> element's decoder back.
 *
 * Any mismatch leaves the original bytes alone and says so in the log —
 * the stock-loader fallback below is the same path the page always had.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SKUnityStartup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LOADER_SHA256 = '6705d6c08f287b6dbd825f3e2c73a104af54a782303f00507e0465194753b7c2';
  // `Build/w-pt.framework.js.unityweb` at the pinned commit: 104,039 bytes
  // of gzip for 631,696 bytes of JavaScript. Which of the two digests a
  // fetch should show depends on the host: a server that sends
  // `Content-Encoding: gzip` gets transparently decoded by fetch and the
  // plain-text digest is what arrives; a download-the-file host delivers
  // the gzip container itself.
  var FRAMEWORK_SHA256_GZIP = '03bf4bc6b7064f08154bcb9d25fd7e9ae395fd6a2dade1c651d04c29c7bedf14';
  var FRAMEWORK_SHA256_PLAIN = '972cecea98ff490043d88adc21afb99497eea64a010a3e2837ad2af5f306dc3b';
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

  /* ---------------------------------------------------------------- *
   * Framework patch: give each room's music decoder back
   *
   * Keep this text identical to tools/patches.mjs (which applies the
   * same patch to framework files at build/mirror time); the test
   * suite compares the two outputs byte for byte.
   * ---------------------------------------------------------------- */
  var FRAMEWORK_MEDIA_BLOCK =
    'if (this.source.mediaElement) {\n' +
    '\t\t\t\t\t\tthis.source._pauseMediaElement()\n' +
    '\t\t\t\t\t}\n' +
    '\t\t\t\t\tthis.source.onended = null;';
  var FRAMEWORK_MEDIA_PATCHED =
    'if (this.source.mediaElement) {\n' +
    '\t\t\t\t\t\tthis.source._pauseMediaElement();\n' +
    '\t\t\t\t\t\ttry {\n' +
    '\t\t\t\t\t\t\tvar skEl = this.source.mediaElement;\n' +
    '\t\t\t\t\t\t\tif (this.source.playTimeout) { clearTimeout(this.source.playTimeout); this.source.playTimeout = null; }\n' +
    '\t\t\t\t\t\t\tvar skRelease = function () { try { skEl.pause(); } catch (e) {} try { skEl.removeAttribute("src"); } catch (e) {} try { skEl.src = ""; } catch (e) {} try { skEl.load(); } catch (e) {} };\n' +
    '\t\t\t\t\t\t\tif (this.source.playPromise && typeof this.source.playPromise.then === "function") this.source.playPromise.then(skRelease, skRelease); else skRelease();\n' +
    '\t\t\t\t\t\t} catch (e) {}\n' +
    '\t\t\t\t\t}\n' +
    '\t\t\t\t\tthis.source.onended = null;';
  function patchFramework(text) {
    if (text.split(FRAMEWORK_MEDIA_PATCHED).length === 2 && text.split(FRAMEWORK_MEDIA_BLOCK).length === 1) return text;
    if (text.split(FRAMEWORK_MEDIA_BLOCK).length !== 2) throw new Error('unsupported Unity framework: disconnectSource block is not unique');
    return text.replace(FRAMEWORK_MEDIA_BLOCK, FRAMEWORK_MEDIA_PATCHED);
  }

  /* ---------------------------------------------------------------- *
   * Wasm patches, applied to the decompression stream in flight
   *
   * The pinned binary declares initial=32,768 pages of wasm memory in
   * its memory section (file offset 207,742: `05 08 01 01 80 80 02
   * 80 fe 03` — verified against the published module, and again by
   * the offline tool's structural parse). A browser backs all 2,048 MiB
   * the moment the module is instantiated, before the first game asset
   * exists; the first scene's bundles and texture uploads then put the
   * Safari process over iPadOS's per-tab ceiling and the OS kills it
   * with no error anywhere. The framework grows the heap on demand
   * (`_emscripten_resize_heap` → `wasmMemory.grow`, maximum 4,080 MiB
   * from `getHeapMax()` = the declared maximum), and the module's
   * static data ends below 10 MiB, so declaring a smaller *initial*
   * heap is a declarative header change — no allocator code is
   * touched, the file size does not change (same-width padded LEB),
   * and a demand the browser refuses now reaches the framework's
   * visible abort("OOM") instead of a silent jetsam kill.
   *
   * The second patch forces the IsUnloadAssetsRequired-style gate
   * (`--scan` func #106897: f64 constants 256 MiB / 4 GiB, tail
   * `local.get 9; end`) to return true so room transitions actually
   * run Resources.UnloadUnusedAssets(). The 11-byte context is unique
   * in the pinned module; the bare tail is not, and is never patched.
   *
   * Both are expressed the same way the offline mirror tool expresses
   * them (web/patches/community-bcbe014.json) and the test suite
   * checks the two against each other.
   * ---------------------------------------------------------------- */
  function hexBytes(text) {
    var hex = String(text).replace(/[^0-9a-fA-F]/g, '');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(' ');
  }
  /** Unsigned LEB128 padded to exactly `length` bytes (spec-legal overlong form). */
  function encodeLEB128Fixed(value, length) {
    var out = new Uint8Array(length);
    var v = value >>> 0;
    for (var i = 0; i < length; i++) {
      var b = v & 0x7f;
      v >>>= 7;
      if (i < length - 1) b |= 0x80;
      out[i] = b;
    }
    if (v) throw new Error(value + ' does not fit in a ' + length + '-byte LEB128');
    return out;
  }
  var WASM_MEMORY_SECTION_OFFSET = 207742;
  var WASM_INITIAL_PAGES = 32768;          // 2048 MiB, as published
  var WASM_MAXIMUM_PAGES = 65280;          // 4080 MiB, never touched
  var WASM_DEFAULT_HEAP_MIB = 1536;
  var UNLOAD_PATCH_OFFSET = 52123552;      // 11-byte context; its tail (last 3 B) is at 52123560
  var UNLOAD_EXPECT = '20 0c 41 b0 04 6a 24 00 20 09 0b';
  var UNLOAD_REPLACE = '20 0c 41 b0 04 6a 24 00 41 01 0b';

  /**
   * The patch list for the pinned module. `options.heapMiB` picks the
   * initial heap (16 pages per MiB); `options.heapPatch === false` or a
   * value equal to the published 2048 omits it. `options.unloadPatch
   * === false` omits the gate patch.
   */
  function buildWasmPatches(options) {
    options = options || {};
    var patches = [];
    var heapMiB = options.heapMiB === undefined ? WASM_DEFAULT_HEAP_MIB : Number(options.heapMiB);
    if (options.heapPatch !== false && heapMiB > 0 && heapMiB !== WASM_INITIAL_PAGES / 16) {
      if (!(heapMiB >= 256 && heapMiB <= WASM_MAXIMUM_PAGES / 16)) throw new Error('wasm heap must be between 256 and ' + (WASM_MAXIMUM_PAGES / 16) + ' MiB');
      var targetLEB = encodeLEB128Fixed(Math.round(heapMiB * 16), 3);
      patches.push({
        name: 'wasm-initial-heap',
        offset: WASM_MEMORY_SECTION_OFFSET,
        expect: hexBytes('05 08 01 01 80 80 02 80 fe 03'),
        replace: hexBytes('05 08 01 01 ' + bytesToHex(targetLEB) + ' 80 fe 03'),
        detail: 'initial heap ' + (WASM_INITIAL_PAGES / 16) + ' → ' + heapMiB + ' MiB (maximum ' + (WASM_MAXIMUM_PAGES / 16) + ' MiB untouched)',
        // A mirror that was already patched to some heap keeps its value:
        // recognise the same section shape and say what was found.
        alreadyDetail: function (window) {
          if (window[0] !== 0x05 || window[1] !== 0x08 || window[2] !== 0x01 || window[3] !== 0x01) return null;
          var pages = (window[4] & 0x7f) | ((window[5] & 0x7f) << 7) | ((window[6] & 0x7f) << 14);
          var max = (window[7] & 0x7f) | ((window[8] & 0x7f) << 7) | ((window[9] & 0x7f) << 14);
          if (max !== WASM_MAXIMUM_PAGES) return null;
          return 'the served module already declares a ' + (pages / 16) + ' MiB initial heap — left as served';
        },
      });
    }
    if (options.unloadPatch !== false) {
      patches.push({
        name: 'unload-assets-always',
        offset: UNLOAD_PATCH_OFFSET,
        expect: hexBytes(UNLOAD_EXPECT),
        replace: hexBytes(UNLOAD_REPLACE),
        detail: 'IsUnloadAssetsRequired-style gate returns true (room transitions unload unused assets)',
      });
    }
    return patches;
  }

  /**
   * A TransformStream that rewrites verified byte windows at absolute
   * file offsets while the module streams past — nothing is buffered
   * beyond the chunk straddling the next patch window, so an 82 MiB
   * module is patched with a few hundred KB of workspace. Each patch
   * is decided independently: expected bytes → replaced; replacement
   * already there (or `alreadyDetail` recognises the window) →
   * reported as already applied; anything else → passed through
   * untouched and reported as skipped with the bytes that were found.
   * The report is delivered to `options.onReport` when the stream ends
   * (which is before compileStreaming settles).
   */
  function createWasmPatchStream(patches, options) {
    options = options || {};
    var list = (patches || []).slice().sort(function (a, b) { return a.offset - b.offset; });
    list.forEach(function (patch, i) {
      if (!(patch.expect instanceof Uint8Array) || !(patch.replace instanceof Uint8Array) || patch.expect.length !== patch.replace.length) {
        throw new Error('wasm patch ' + patch.name + ': expect/replace must be same-length Uint8Arrays');
      }
      if (i && patch.offset < list[i - 1].offset + list[i - 1].expect.length) throw new Error('wasm patches overlap: ' + patch.name);
    });
    var report = { totalBytes: 0, patches: list.map(function (p) { return { name: p.name, offset: p.offset, status: 'pending', detail: p.detail || '' }; }) };
    var pending = new Uint8Array(0);
    var pendingStart = 0;
    var next = 0;
    function windowAt(patch) { return pending.subarray(patch.offset - pendingStart, patch.offset - pendingStart + patch.expect.length); }
    function same(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
    function decide(patch, entry) {
      var found = windowAt(patch);
      if (same(found, patch.expect)) {
        // Patch a private copy of the pending window: `found` may view
        // a chunk that was partially enqueued already, and bytes the
        // consumer already holds must never change under it.
        var copy = new Uint8Array(pending);
        copy.set(patch.replace, patch.offset - pendingStart);
        pending = copy;
        entry.status = 'applied';
      } else if (same(found, patch.replace)) {
        entry.status = 'already';
      } else {
        var already = typeof patch.alreadyDetail === 'function' ? patch.alreadyDetail(found) : null;
        if (already) { entry.status = 'already'; entry.detail = already; }
        else { entry.status = 'skipped'; entry.detail = 'found ' + bytesToHex(found) + ' at ' + patch.offset + ' instead of the pinned bytes — left untouched'; }
      }
    }
    function drain(controller, flushAll) {
      while (next < list.length) {
        var patch = list[next];
        if (pendingStart + pending.length < patch.offset + patch.expect.length) break;
        decide(patch, report.patches[next]);
        next++;
      }
      var emitEnd = (flushAll || next >= list.length) ? pendingStart + pending.length : Math.min(pendingStart + pending.length, list[next].offset);
      if (emitEnd > pendingStart) {
        controller.enqueue(pending.subarray(0, emitEnd - pendingStart));
        pending = pending.subarray(emitEnd - pendingStart);
        pendingStart = emitEnd;
      }
    }
    return new TransformStream({
      transform: function (chunk, controller) {
        if (!(chunk instanceof Uint8Array)) chunk = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
        report.totalBytes += chunk.length;
        if (!list.length) { controller.enqueue(chunk); return; }
        if (pending.length) {
          var merged = new Uint8Array(pending.length + chunk.length);
          merged.set(pending, 0);
          merged.set(chunk, pending.length);
          pending = merged;
        } else pending = chunk;
        drain(controller, false);
      },
      flush: function (controller) {
        drain(controller, true);
        while (next < list.length) {
          report.patches[next].status = 'skipped';
          report.patches[next].detail = 'the module ended (' + report.totalBytes + ' bytes) before this patch window at ' + list[next].offset;
          next++;
        }
        if (typeof options.onReport === 'function') {
          try { options.onReport(report); } catch (e) {}
        }
      },
    });
  }

  async function wasmResponse(response, options) {
    options = options || {};
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
    // Patch after decompression, before the compiler sees a byte.
    if (options.patches && options.patches.length && typeof TransformStream === 'function') {
      body = body.pipeThrough(createWasmPatchStream(options.patches, options));
    } else if (options.patches && options.patches.length && typeof options.onReport === 'function') {
      options.onReport({ totalBytes: 0, patches: options.patches.map(function (p) { return { name: p.name, offset: p.offset, status: 'skipped', detail: 'TransformStream is unavailable in this browser' }; }) });
    }
    return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
  }
  function preconnect(url, doc) {
    if (!doc) return;
    var origin = new URL(url, doc.baseURI).origin;
    if (Array.from(doc.querySelectorAll('link[rel="preconnect"]')).some(function (link) { return link.href === origin + '/' || link.href === origin; })) return;
    var link = doc.createElement('link'); link.rel = 'preconnect'; link.href = origin; link.crossOrigin = 'anonymous'; doc.head.appendChild(link);
  }
  async function digestHex(bytes) {
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  /** Inflate one small gzip buffer (the 104 KB framework) without a worker. */
  async function gunzipBytes(bytes) {
    var source = typeof Blob === 'function' && typeof Blob.prototype.stream === 'function'
      ? new Blob([bytes]).stream()
      : new ReadableStream({ start: function (controller) { controller.enqueue(bytes); controller.close(); } });
    return new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  /**
   * Fetch the framework, prove it is the pinned one, and patch it.
   * Resolves to the patched text; rejects (leaving the stock URL in
   * place) on any mismatch. The loader fetches whatever
   * `config.frameworkUrl` says, and its UnityCache layer only engages
   * for http(s) URLs, so handing it a blob URL of verified, already-
   * inflated text takes the plain fetch path — and the digest-pinned
   * loader patch above stops it being inflated a second time.
   */
  async function prepareFramework(url, fetchImpl, signal) {
    var res = await fetchImpl(url, { cache: 'force-cache', signal: signal });
    if (!res.ok) throw new Error('framework HTTP ' + res.status);
    var bytes = new Uint8Array(await res.arrayBuffer());
    var plain;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (await digestHex(bytes) !== FRAMEWORK_SHA256_GZIP) throw new Error('framework digest changed; leaving it unmodified');
      if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream is unavailable; leaving the framework unmodified');
      plain = await gunzipBytes(bytes);
      if (await digestHex(plain) !== FRAMEWORK_SHA256_PLAIN) throw new Error('framework inflated digest changed; leaving it unmodified');
    } else {
      if (await digestHex(bytes) !== FRAMEWORK_SHA256_PLAIN) throw new Error('framework digest changed; leaving it unmodified');
      plain = bytes;
    }
    return patchFramework(new TextDecoder().decode(plain));
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
    var wasmPatches = [];
    if (options.wasmPatches !== false) {
      try { wasmPatches = buildWasmPatches(options); }
      catch (error) { log('wasm patches disabled: ' + error.message); wasmPatches = []; }
    }
    var patchReport = null;
    var compiled, objectUrl, frameworkUrl;
    var controller = new AbortController();
    var cancel = function () { controller.abort(); };
    if (options.signal && options.signal.aborted) cancel();
    if (options.signal) options.signal.addEventListener('abort', cancel, { once: true });
    var timeout = setTimeout(cancel, options.timeoutMs || 90000);
    try {
      var start = Date.now();
      // A framework that will not patch must never cost the loader/wasm
      // patches: it degrades on its own to the stock framework URL.
      var frameworkReady = options.frameworkPatch === false ? Promise.resolve(null)
        : prepareFramework(urls.framework, fetchImpl, controller.signal).then(function (text) {
            log('verified framework: audio disconnect releases each room\'s decoder (digest-pinned patch)');
            return text;
          }, function (error) {
            log('framework left unpatched: ' + ((error && error.message) || error));
            return null;
          });
      var result = await Promise.all([
        fetchImpl(urls.loader, { cache: 'force-cache', signal: controller.signal }).then(async function (res) {
          if (!res.ok) throw new Error('loader HTTP ' + res.status);
          var bytes = await res.arrayBuffer();
          var hex = await digestHex(bytes);
          if (hex !== LOADER_SHA256) throw new Error('loader digest changed; leaving it unmodified');
          return patchLoader(new TextDecoder().decode(bytes), wantStreaming);
        }),
        wantStreaming ? fetchImpl(urls.wasm, { cache: 'force-cache', signal: controller.signal }).then(function (res) {
          return wasmResponse(res, { patches: wasmPatches, onReport: function (report) { patchReport = report; } });
        }).then(function (res) { return WebAssembly.compileStreaming(res); }) : Promise.resolve(null),
        frameworkReady,
      ]);
      compiled = result[1];
      objectUrl = URL.createObjectURL(new Blob([result[0]], { type: 'text/javascript' }));
      if (result[2]) frameworkUrl = URL.createObjectURL(new Blob([result[2]], { type: 'text/javascript' }));
      var fail;
      runtime.failed = new Promise(function (_, reject) { fail = reject; });
      runtime.failed.catch(function () {});
      var configure = runtime.configure;
      runtime.configure = function (config) {
        configure(config);
        if (frameworkUrl) config.frameworkUrl = frameworkUrl;
        if (compiled) config.instantiateWasm = function (imports, receive) {
          WebAssembly.instantiate(compiled, imports).then(function (instance) { receive(instance, compiled); compiled = null; }).catch(fail);
          return {};
        };
      };
      runtime.loaderUrl = objectUrl;
      runtime.wasmPatchReport = patchReport;
      runtime.dispose = function () {
        compiled = null;
        URL.revokeObjectURL(objectUrl);
        if (frameworkUrl) URL.revokeObjectURL(frameworkUrl);
      };
      if (patchReport) patchReport.patches.forEach(function (p) {
        log('wasm patch ' + p.name + ': ' + p.status + (p.detail ? ' — ' + p.detail : ''));
      });
      if (!wantStreaming && wasmPatches.length) {
        log('wasm patches NOT applied: native streaming compilation is unavailable in this browser, so the stock loader path will fetch the wasm itself with its compiled-in 2048 MiB initial heap. Serve an offline-patched mirror (tools/patch-community-wasm.mjs) via ?communityBase= on such a browser.');
      }
      log(wantStreaming
        ? 'Wasm compiled with native streaming in ' + (Date.now() - start) + ' ms (overlapped with asset setup); verified loader forces WebGL 2 (WebGPU probe removed)'
        : 'verified loader: WebGL 2 forced (WebGPU probe removed), native HTTP decoding guard enabled; stock Wasm path');
    } catch (error) {
      controller.abort();
      compiled = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (frameworkUrl) URL.revokeObjectURL(frameworkUrl);
      log('native streaming unavailable — using the unchanged Unity loader: ' + error.message +
        ' (the page preRun guard still forces WebGL 2 at startup)');
    }
    clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener('abort', cancel);
    return runtime;
  }
  return {
    prepare: prepare,
    wasmResponse: wasmResponse,
    patchLoader: patchLoader,
    patchFramework: patchFramework,
    buildWasmPatches: buildWasmPatches,
    createWasmPatchStream: createWasmPatchStream,
    encodeLEB128Fixed: encodeLEB128Fixed,
    preconnect: preconnect,
    LOADER_SHA256: LOADER_SHA256,
    FRAMEWORK_SHA256_GZIP: FRAMEWORK_SHA256_GZIP,
    FRAMEWORK_SHA256_PLAIN: FRAMEWORK_SHA256_PLAIN,
    WASM_MEMORY_SECTION_OFFSET: WASM_MEMORY_SECTION_OFFSET,
    WASM_INITIAL_PAGES: WASM_INITIAL_PAGES,
    WASM_MAXIMUM_PAGES: WASM_MAXIMUM_PAGES,
    WASM_DEFAULT_HEAP_MIB: WASM_DEFAULT_HEAP_MIB,
    UNLOAD_PATCH_OFFSET: UNLOAD_PATCH_OFFSET,
    UNLOAD_EXPECT: UNLOAD_EXPECT,
    UNLOAD_REPLACE: UNLOAD_REPLACE,
    FRAMEWORK_MEDIA_BLOCK: FRAMEWORK_MEDIA_BLOCK,
    FRAMEWORK_MEDIA_PATCHED: FRAMEWORK_MEDIA_PATCHED,
  };
});
