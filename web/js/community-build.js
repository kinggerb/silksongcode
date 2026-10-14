/* ============================================================================
 * community-build.js — stream and mount the permitted community WebGL build
 * ----------------------------------------------------------------------------
 * The upstream build stores its Addressables in a 2.08 GB ZIP split into
 * 100 files. Keep that archive on OPFS and read individual bundles from it
 * with zip.js; do not concatenate the pieces in RAM or unpack the whole archive.
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKCommunityBuild = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fail(message) {
    var error = new Error(message);
    error.name = 'CommunityBuildError';
    return error;
  }

  function validate(config) {
    if (!config || typeof config !== 'object') throw fail('community build configuration is not an object');
    if (config.schema !== 1) throw fail('unsupported community build configuration schema');
    if (!config.buildId || !config.source || !config.base) throw fail('community build configuration is missing its source or build id');
    if (!config.unity || !config.unity.loader || !config.unity.framework || !config.unity.data || !config.unity.wasm || !config.unity.streamingAssets) {
      throw fail('community build configuration is missing Unity entry points');
    }
    if (!config.fileBytes || ['loader', 'framework', 'data', 'wasm'].some(function (key) {
      return !Number.isSafeInteger(config.fileBytes[key]) || config.fileBytes[key] <= 0;
    })) throw fail('community build configuration has invalid Unity file sizes');
    var archive = config.assetArchive;
    if (!archive || !archive.cacheKey || !Array.isArray(archive.parts) || !archive.parts.length) {
      throw fail('community build configuration is missing the StreamingAssets archive parts');
    }

    var total = 0;
    var names = Object.create(null);
    archive.parts.forEach(function (part, index) {
      if (!part || typeof part.path !== 'string' || !part.path || !Number.isSafeInteger(part.bytes) || part.bytes <= 0) {
        throw fail('invalid asset archive part ' + (index + 1));
      }
      if (names[part.path]) throw fail('duplicate asset archive part: ' + part.path);
      names[part.path] = true;
      total += part.bytes;
      if (!Number.isSafeInteger(total)) throw fail('asset archive size is too large');
    });
    if (archive.total !== total) throw fail('asset archive total does not match the part sizes');
    return config;
  }

  function join(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  function parts(config, base) {
    validate(config);
    var root = base || config.base;
    return config.assetArchive.parts.map(function (part) {
      return { url: join(root, part.path), bytes: part.bytes };
    });
  }

  async function ensureArchive(config, options) {
    options = options || {};
    validate(config);
    var stream = options.stream || (typeof SKStream !== 'undefined' ? SKStream : null);
    if (!stream || typeof stream.ensureDataset !== 'function') throw fail('the low-memory storage loader did not load');
    var base = options.base || config.base;
    var archive = config.assetArchive;
    return stream.ensureDataset({
      parts: parts(config, base),
      expectedSize: archive.total,
      cacheKey: archive.cacheKey,
      buildId: config.buildId,
      mime: archive.mime || 'application/zip',
      verify: 'size',
      workerUrl: options.workerUrl || 'js/writer.js',
      preferDisk: true,
      allowMemoryFallback: false,
      onProgress: options.onProgress,
      onStatus: options.onStatus,
      onLog: options.onLog,
      signal: options.signal,
    });
  }

  function basename(path) {
    var clean = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return clean.slice(clean.lastIndexOf('/') + 1);
  }

  function decodePath(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  async function openArchive(file, zipLib) {
    if (!file || typeof file.slice !== 'function') throw fail('the cached asset archive is not readable');
    zipLib = zipLib || (typeof zip !== 'undefined' ? zip : null);
    if (!zipLib || !zipLib.ZipReader || !zipLib.BlobReader || !zipLib.BlobWriter) {
      throw fail('the ZIP reader did not load');
    }
    if (typeof zipLib.configure === 'function') {
      // Safari has native compression streams on supported iPadOS versions;
      // avoid starting a separate codec worker for every requested bundle.
      zipLib.configure({ useWebWorkers: false, useCompressionStream: true });
    }

    // BlobReader uses slices of the file, so only the ZIP directory and the
    // requested bundle are read. The multi-gigabyte archive is never converted
    // into one ArrayBuffer.
    var reader = new zipLib.ZipReader(new zipLib.BlobReader(file), { useWebWorkers: false });
    var entries;
    try {
      entries = await reader.getEntries();
    } catch (error) {
      try { await reader.close(); } catch (e) {}
      throw fail('could not read the cached StreamingAssets ZIP: ' + ((error && error.message) || error));
    }

    var byPath = Object.create(null);
    var byName = Object.create(null);
    entries.forEach(function (entry) {
      if (entry.directory) return;
      var path = decodePath(String(entry.filename || '')).replace(/^\/+/, '').replace(/\\/g, '/');
      var lowerPath = path.toLowerCase();
      var name = basename(path).toLowerCase();
      if (!name) return;
      if (!byPath[lowerPath]) byPath[lowerPath] = entry;
      // The upstream player resolves cached Addressables by basename. Keep the
      // same fallback while preferring a full path match when one is available.
      if (!byName[name]) byName[name] = entry;
    });

    var inFlight = Object.create(null);

    function entryFor(url) {
      var parsed;
      try { parsed = new URL(String(url), (typeof location !== 'undefined' && location.href) || 'https://silksong.invalid/'); }
      catch (e) { return null; }
      var pathname = decodePath(parsed.pathname).replace(/\\/g, '/');
      var marker = pathname.toLowerCase().lastIndexOf('/streamingassets/');
      if (marker < 0) return null;
      var relative = pathname.slice(marker + '/streamingassets/'.length).replace(/^\/+/, '').toLowerCase();
      var fullMatch = byPath[relative];
      if (fullMatch) return fullMatch;
      // The source archive can contain only the Addressables file name, while
      // Unity requests it under StreamingAssets/aa/WebGL/.
      var stripped = relative.replace(/^aa\//, '');
      if (byPath[stripped]) return byPath[stripped];
      return byName[basename(relative).toLowerCase()] || null;
    }

    async function blobFor(entry) {
      var key = String(entry.filename || '');
      if (inFlight[key]) return inFlight[key];
      var promise = entry.getData(new zipLib.BlobWriter('application/octet-stream'), { useWebWorkers: false });
      inFlight[key] = promise;
      try {
        return await promise;
      } finally {
        delete inFlight[key];
      }
    }

    return {
      entryFor: entryFor,
      blobFor: blobFor,
      entryCount: entries.length,
      close: function () { return reader.close(); },
    };
  }

  function rangeResponse(blob, rangeHeader) {
    var headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    });
    var range = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || ''));
    if (!range) {
      headers.set('Content-Length', String(blob.size));
      return new Response(blob, { status: 200, headers: headers });
    }
    var start, end;
    if (!range[1] && range[2]) {
      var suffixBytes = Number(range[2]);
      start = Number.isSafeInteger(suffixBytes) && suffixBytes > 0 ? Math.max(0, blob.size - suffixBytes) : blob.size;
      end = blob.size - 1;
    } else {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Number(range[2]) : blob.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= blob.size) {
      headers.set('Content-Range', 'bytes */' + blob.size);
      return new Response(null, { status: 416, headers: headers });
    }
    end = Math.min(end, blob.size - 1);
    headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + blob.size);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(blob.slice(start, end + 1), { status: 206, headers: headers });
  }

  function installFetchMount(target, archive, options) {
    options = options || {};
    if (!target || typeof target.fetch !== 'function') throw fail('fetch is not available for the asset mount');
    var previous = target.fetch.bind(target);
    var onAsset = options.onAsset || function () {};

    target.fetch = function (input, init) {
      var rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      if (!rawUrl) return previous(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var entry = archive.entryFor(rawUrl);
      if (!entry || (method !== 'GET' && method !== 'HEAD')) return previous(input, init);
      if (method === 'HEAD') {
        var entrySize = Number(entry.uncompressedSize || 0);
        return Promise.resolve(new Response(null, {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(entrySize),
            'Accept-Ranges': 'bytes',
          }),
        }));
      }

      var rangeHeader = null;
      try {
        var requestHeaders = new Headers((init && init.headers) || (input && input.headers) || undefined);
        rangeHeader = requestHeaders.get('range');
      } catch (e) {}

      onAsset(entry.filename);
      return archive.blobFor(entry).then(function (blob) {
        return rangeResponse(blob, rangeHeader);
      });
    };

    return function restore() { target.fetch = previous; };
  }

  return {
    validate: validate,
    parts: parts,
    ensureArchive: ensureArchive,
    openArchive: openArchive,
    installFetchMount: installFetchMount,
  };
});
