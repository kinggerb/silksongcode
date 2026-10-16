/* Disk-backed lazy ZIP parts and bounded, CRC-verified extracted bundle cache.
 * Whole immutable parts are the network/cache unit: works even on hosts that
 * ignore Range, without re-downloading a part for every small ZIP read. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SKAssetCache = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function noop() {}
  function limitQueue(max) {
    var active = 0, waiting = [];
    function next() {
      while (active < max && waiting.length) {
        var job = waiting.shift(); active++;
        Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(function () { active--; next(); });
      }
    }
    return function (task) { return new Promise(function (resolve, reject) { waiting.push({ task: task, resolve: resolve, reject: reject }); next(); }); };
  }
  function createPartReader(parts, options) {
    var stream = options.stream;
    var run = limitQueue(Math.max(1, Math.min(Number(options.concurrency) || 6, 8)));
    var offsets = [], size = 0, pending = new Map(), downloaded = new Set();
    var stats = { networkBytes: 0, cacheBytes: 0, requestedParts: 0, totalParts: parts.length };
    parts.forEach(function (part) { offsets.push(size); size += part.bytes; });
    function partAt(offset) {
      for (var i = offsets.length - 1; i >= 0; i--) if (offset >= offsets[i]) return i;
      throw new Error('ZIP offset out of bounds');
    }
    function getPart(index) {
      if (pending.has(index)) return pending.get(index);
      var part = parts[index];
      var key = options.cacheKey + '.part-' + (index + 1);
      var task = function () { return stream.ensureDataset({
        parts: [{ url: part.url, bytes: part.bytes }], expectedSize: part.bytes,
        cacheKey: key, buildId: options.buildId, mime: 'application/octet-stream',
        workerUrl: options.workerUrl || 'js/writer.js', writerFactory: options.writerFactory,
        allowMemoryFallback: false, preferDisk: true, concurrency: 1,
        manifest: part.sha256 ? { total: part.bytes, sha256: part.sha256 } : null,
        verify: part.sha256 ? 'full' : 'size',
        fetchImpl: options.fetchImpl, signal: options.signal, retryAfter: options.retryAfter,
        stallTimeoutMs: options.stallTimeoutMs, retryAttempts: options.retryAttempts,
        onLog: options.onLog, onStatus: options.onStatus,
      }); };
      var promise = run(async function () {
        var result;
        // ensureDataset serializes same-origin writers with Web Locks and
        // rechecks the read-only cache after acquiring the lock.
        result = await task();
        if (!result || !result.file || result.file.size !== part.bytes) throw new Error('cached ZIP part has the wrong size: ' + (index + 1));
        var file = result.file;
        result.dispose(); // closes workers/revokes unused URLs, retains disk File
        if (!downloaded.has(index)) {
          downloaded.add(index); stats.requestedParts++;
          if (result.kind === 'opfs-cached') stats.cacheBytes += file.size;
          else stats.networkBytes += file.size;
          if (options.onProgress) options.onProgress(Object.assign({}, stats));
        }
        return file;
      });
      pending.set(index, promise);
      promise.catch(function () { if (pending.get(index) === promise) pending.delete(index); });
      return promise;
    }
    var reader = {
      initialized: true, size: size, stats: stats,
      async init() {},
      async readUint8Array(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) throw new Error('ZIP read out of bounds');
        var out = new Uint8Array(length), cursor = 0;
        while (cursor < length) {
          var index = partAt(offset + cursor), local = offset + cursor - offsets[index];
          var count = Math.min(length - cursor, parts[index].bytes - local);
          var file = await getPart(index);
          var bytes = new Uint8Array(await file.slice(local, local + count).arrayBuffer());
          if (bytes.length !== count) throw new Error('short cached ZIP read');
          out.set(bytes, cursor); cursor += count;
        }
        return out;
      },
      // Fetch only parts touched by this requested bundle, in parallel. No
      // speculative whole-game prefetch competes with the startup working set.
      async prefetchEntry(entry) {
        var header = await reader.readUint8Array(entry.offset, 30);
        var view = new DataView(header.buffer);
        if (view.getUint32(0, true) !== 0x04034b50) throw new Error('invalid ZIP local header');
        var end = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true) + entry.compressedSize;
        if (end > size) throw new Error('ZIP entry exceeds archive');
        var first = partAt(entry.offset), last = partAt(Math.max(entry.offset, end - 1));
        await Promise.all(Array.from({ length: last - first + 1 }, function (_, i) { return getPart(first + i); }));
      },
    };
    return reader;
  }

  // Cache only what fits the budget. Files handed to Unity are pinned for this
  // session and never evicted underneath an in-flight Response/File read.
  function createBundleCache(options) {
    var budget = options.budgetBytes === undefined ? 512 * 1024 * 1024 : options.budgetBytes;
    var pinned = new Set(), releases = new Map(), pinning = new Map(), reserved = 0, queue = Promise.resolve();
    var stream = options.stream;
    function unpin(key) {
      if (releases.has(key)) { releases.get(key)(); releases.delete(key); }
      pinning.delete(key); pinned.delete(key);
    }
    async function pin(key) {
      if (pinned.has(key)) return;
      if (!navigator.locks) { pinned.add(key); return; }
      if (!pinning.has(key)) pinning.set(key, new Promise(function (resolve, reject) {
        navigator.locks.request('silksong-unpacked-pin:' + key, { mode: 'shared' }, function () {
          return new Promise(function (release) { releases.set(key, release); pinned.add(key); resolve(); });
        }).catch(reject);
      }));
      await pinning.get(key);
    }
    async function directory() {
      var root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(options.dirName || stream.DEFAULT_DIR, { create: true });
    }
    async function keyFor(entry) {
      var identity = options.buildId + ':' + entry.filename + ':' + entry.signature + ':' + entry.uncompressedSize;
      var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      return 'unpacked-' + Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    async function get(entry) {
      if (!(budget > 0)) return null;
      try {
        var key = await keyFor(entry);
        await pin(key);
        var cached = await stream.getCachedDataset({ cacheKey: key, buildId: options.buildId,
          expectedSize: entry.uncompressedSize, dirName: options.dirName, mime: 'application/octet-stream' });
        if (!cached) { unpin(key); return null; }
        var file = cached.file; cached.dispose();
        if (options.onLog) options.onLog('extracted bundle cache hit: ' + entry.filename);
        return file;
      } catch (e) { if (key) unpin(key); return null; }
    }
    async function reserve(key, bytes) {
      var allowed = false;
      queue = queue.catch(noop).then(async function () {
        var dir = await directory(), files = [], used = reserved;
        for await (var pair of dir.entries()) {
          if (!/^unpacked-[a-f0-9]{64}$/.test(pair[0])) continue;
          var file = await pair[1].getFile();
          used += file.size; files.push({ name: pair[0], size: file.size, at: file.lastModified });
        }
        files.sort(function (a, b) { return a.at - b.at; });
        for (var i = 0; used + bytes > budget && i < files.length; i++) {
          if (pinned.has(files[i].name)) continue;
          // Atomic, cross-tab pin check: never delete a File another page
          // is still handing to Unity, even after that page's writer finished.
          await navigator.locks.request('silksong-unpacked-pin:' + files[i].name, { ifAvailable: true }, async function (lock) {
            if (!lock) return;
            await dir.removeEntry(files[i].name);
            try { await dir.removeEntry(files[i].name + '.ok'); } catch (e) {}
            used -= files[i].size;
          });
        }
        if (used + bytes > budget) return;
        if (navigator.storage.estimate) {
          var estimate = await navigator.storage.estimate();
          if (estimate.quota && estimate.quota - estimate.usage < bytes + 128 * 1024 * 1024) return;
        }
        await pin(key); reserved += bytes; allowed = true;
      });
      await queue; return allowed;
    }
    return {
      get: get,
      dispose: function () { Array.from(pinned).forEach(unpin); },
      async extract(entry, zipLib) {
        // Never truncate a file another tab just published/handed to Unity.
        // Old browsers without Web Locks can still read existing cache entries
        // and use BlobWriter; optional persistent extraction is disabled there.
        if (!(budget > 0) || typeof navigator === 'undefined' || !navigator.locks) return null;
        var key;
        try { key = await keyFor(entry); } catch (e) { return null; }
        return navigator.locks.request('silksong-unpacked:' + key, function () {
          // Serialize disk extraction/reservation across tabs. This keeps the
          // quota budget real, rather than each tab reserving the same bytes.
          return navigator.locks.request('silksong-extraction-budget', function () { return extractUnlocked(entry, zipLib); });
        });
      },
    };
    async function extractUnlocked(entry, zipLib) {
        var cached = await get(entry); if (cached) return cached;
        var bytes = entry.uncompressedSize, key, sink, allocated = false;
        if (!(bytes > 0 && bytes <= budget)) return null;
        try {
          key = await keyFor(entry);
          allocated = await reserve(key, bytes); if (!allocated) return null;
          sink = await stream.createDiskSink({ cacheKey: key, expectedSize: bytes,
            dirName: options.dirName, workerUrl: options.workerUrl || 'js/writer.js' });
          await sink.remove(key + '.ok');
          await sink.open(false);
        } catch (error) {
          if (allocated) { reserved -= bytes; unpin(key); }
          if (sink) { await sink.abort(); sink.destroy(); }
          if (options.onLog) options.onLog('extracted cache unavailable: ' + error.message);
          return null; // use normal BlobWriter; optional disk cache must not break boot
        }
        var at = 0;
        var writer = new zipLib.Writer();
        writer.writeUint8Array = async function (chunk) {
          var length = chunk.byteLength; // transfer to worker detaches chunk.buffer
          if (at + length > bytes) throw new Error('ZIP entry exceeds declared size');
          await sink.write(chunk, at, false); at += length;
        };
        writer.getData = function () { return null; };
        try {
          // Publish the marker only AFTER CRC and final byte-count validation.
          await entry.getData(writer, { useWebWorkers: false, checkSignature: true });
          if (at !== bytes) throw new Error('short extracted bundle');
          await sink.finish();
          var file = await sink.getFile();
          if (!file || file.size !== bytes) throw new Error('cannot read extracted bundle');
          await sink.putText(key + '.ok', options.buildId + ' ' + new Date().toISOString());
          return file;
        } catch (error) {
          await sink.abort();
          await sink.remove(key).catch(noop);
          unpin(key);
          if (/quota|space|storage/i.test(String(error.name) + ' ' + error.message)) {
            if (options.onLog) options.onLog('optional extracted cache ran out of storage; using Blob extraction');
            return null;
          }
          throw error; // CRC/corruption is not silently accepted
        } finally { reserved -= bytes; sink.destroy(); }
    }
  }
  return { createPartReader: createPartReader, createBundleCache: createBundleCache, limitQueue: limitQueue };
});
