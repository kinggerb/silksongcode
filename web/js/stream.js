/* ============================================================================
 * stream.js — low-memory chunked asset loader (iPad/Safari first)
 * ----------------------------------------------------------------------------
 * The problem
 *   A Unity WebGL build ships as a handful of big files — `<name>.data`,
 *   `<name>.wasm`, plus `loaders/framework` JS. For Silksong the data file is
 *   hundreds of MB, which is far past what a Safari tab on iPad can hold *while
 *   also* making copies of it.
 *
 *   The naive page glues the chunks together in RAM:
 *       N x new Blob(chunks)        ~ size
 *       fetch(blobUrl).blob()       ~ size, again
 *       new Blob([...blobs])        ~ size, again
 *       Unity's dataUrl fetch       ~ size, again   ==> ~3-4x the file size
 *   That lands exactly when the progress bar reaches ~100 %, and iPadOS
 *   jetsam-kills the WebContent process: the tab simply disappears.
 *
 * What this module does instead
 *   1. streams every part straight to disk (OPFS) through a worker, so the
 *      download phase only ever uses a few MB of RAM;
 *   2. keeps the merged file between sessions, so a reload (or a retry after a
 *      crash) skips the download completely; an interrupted download resumes
 *      from the byte it reached instead of starting over;
 *   3. hands Unity ONE file-backed blob URL, so its own copy of the data is the
 *      only big allocation left in the tab;
 *   4. checks the assembled file against the manifest (exact size always,
 *      sampled SHA-256 digests on request) so a truncated download is detected
 *      before Unity is handed a broken file.
 *
 * Network + storage are injectable so this file is unit tested in Node
 * (see tools/test-stream.mjs).
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKStream = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.3';
  var DEFAULT_DIR = 'silksong-webgl-cache';
  var FLUSH_EVERY = 32 * 1024 * 1024; // flush OPFS about every 32 MB
  var MAX_RETRIES = 4; // per part (positional sinks only)
  var SEQ_RETRIES = 3; // whole-pass retries for non-positional sinks
  var MAX_WRITES_IN_FLIGHT = 8;
  // How many parts may be on the wire at the same time. One part at a time
  // is slow for a reason that has nothing to do with the bandwidth: every
  // part is its own HTTP request, so the round-trip latency of 100 requests
  // adds up to minutes on a phone. Four at a time keeps the connection busy
  // while the previous parts are still being written to the disk, and the
  // RAM cost stays at a few chunks because the parts are written to the
  // sink as they arrive instead of being buffered.
  var DEFAULT_CONCURRENCY = 4;
  var MAX_CONCURRENCY = 4;
  var WRITE_TIMEOUT = 180000; // ms per worker write
  var OPEN_TIMEOUT = 60000; // ms for open/stat/marker calls
  var PROGRESS_THROTTLE = 120; // ms
  var DEFAULT_PART_BYTES = 20 * 1024 * 1024; // ~20 MB chunks, matches prepare-build.mjs

  function noop() {}
  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
  function defaultFetch(url, opts) {
    return fetch(url, opts);
  }
  function mb(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function makeLogger(log) {
    return function () {
      if (!log) return;
      try {
        log.apply(null, arguments);
      } catch (e) {
        /* logging must never break the loader */
      }
    };
  }
  function abortError() {
    var e = new Error('aborted');
    e.name = 'AbortError';
    return e;
  }
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var timer = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /* ------------------------------------------------------------------ *
   * Capability detection
   * ------------------------------------------------------------------ */

  var capabilityPromise = null;

  function detect() {
    if (capabilityPromise) return capabilityPromise;
    capabilityPromise = (async function () {
      var caps = {
        opfs: false,
        opfsError: null,
        quota: 0,
        usage: 0,
        available: 0,
        persistent: null,
        secure: false,
        workers: typeof Worker !== 'undefined',
        sab: typeof SharedArrayBuffer === 'function',
        deviceMemoryGb: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0,
      };
      try {
        caps.secure =
          typeof isSecureContext === 'undefined'
            ? typeof location !== 'undefined' && location.protocol === 'https:'
            : isSecureContext;
      } catch (e) {
        caps.secure = false;
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
          caps.opfs = !!(await navigator.storage.getDirectory());
        }
      } catch (e) {
        caps.opfs = false;
        caps.opfsError = String((e && e.message) || e);
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
          var est = (await navigator.storage.estimate()) || null;
          caps.quota = (est && est.quota) || 0;
          caps.usage = (est && est.usage) || 0;
          caps.available = caps.quota ? Math.max(0, caps.quota - caps.usage) : 0;
        }
      } catch (e) {
        /* estimate() is only a hint */
      }
      return caps;
    })();
    return capabilityPromise;
  }

  function requestPersistence() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
        return Promise.resolve(navigator.storage.persist()).catch(function () {
          return false;
        });
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.resolve(false);
  }

  /* ------------------------------------------------------------------ *
   * Sinks
   *   sink.open(resume)          -> {size, canResume}
   *   sink.write(u8, at, flush)  -> void       (positional if !sequentialOnly)
   *   sink.finish()              -> {size, url?}
   *   sink.abort()               -> void
   *   sink.stat/putText/getText/remove  (cache bookkeeping)
   * ------------------------------------------------------------------ */

  /* ---- OPFS through a worker using FileSystemSyncAccessHandle -------- */

  function WorkerSink(opts) {
    this.dir = opts.dirName || DEFAULT_DIR;
    this.name = opts.name;
    this.expected = opts.expectedSize || 0;
    this.workerUrl = opts.workerUrl;
    this.log = makeLogger(opts.log);
    this.seq = 0;
    this.pending = new Map();
    this.worker = null;
    this.sequentialOnly = false; // sync access handles support random access
  }

  WorkerSink.prototype.connect = function () {
    var self = this;
    if (this.worker) return Promise.resolve(this);
    return new Promise(function (resolve, reject) {
      var worker;
      try {
        worker = new Worker(self.workerUrl);
      } catch (e) {
        return reject(e);
      }
      self.worker = worker;
      worker.onmessage = function (ev) {
        var msg = ev.data || {};
        var entry = self.pending.get(msg.id);
        if (!entry) return;
        self.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          var err = new Error(msg.error.message || 'writer worker error');
          err.name = msg.error.name || 'WorkerError';
          err.op = msg.error.op;
          entry.reject(err);
        } else {
          entry.resolve(msg);
        }
      };
      worker.onerror = function (ev) {
        self.failAll(new Error('writer worker failed: ' + ((ev && ev.message) || 'unknown error')));
      };
      worker.onmessageerror = function () {
        self.failAll(new Error('writer worker could not decode a message'));
      };
      resolve(self);
    });
  };

  WorkerSink.prototype.failAll = function (err) {
    this.pending.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.reject(err);
    });
    this.pending.clear();
  };

  WorkerSink.prototype.call = function (msg, timeout, transfer) {
    var self = this;
    if (!this.worker) return Promise.reject(new Error('writer worker is not connected'));
    return new Promise(function (resolve, reject) {
      var id = ++self.seq;
      var timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new Error('writer worker timed out on "' + msg.type + '"'));
      }, timeout || WRITE_TIMEOUT);
      self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      msg.id = id;
      try {
        self.worker.postMessage(msg, transfer || []);
      } catch (e) {
        clearTimeout(timer);
        self.pending.delete(id);
        reject(e);
      }
    });
  };

  WorkerSink.prototype.open = async function (resume) {
    await this.connect();
    var res = await this.call(
      { type: 'open', dir: this.dir, name: this.name, expected: this.expected, resume: !!resume },
      OPEN_TIMEOUT
    );
    this.size = res.size || 0;
    return { size: this.size, canResume: !!res.canResume };
  };

  WorkerSink.prototype.write = async function (u8, at, flush) {
    // Transfer the buffer so the chunk is moved (not copied) to the worker.
    var buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
    await this.call({ type: 'write', data: buf.buffer, at: at, flush: !!flush }, WRITE_TIMEOUT, [buf.buffer]);
  };

  WorkerSink.prototype.finish = async function () {
    var res = await this.call({ type: 'finish' }, OPEN_TIMEOUT);
    return { size: res.size };
  };

  WorkerSink.prototype.abort = async function () {
    try {
      if (this.worker) await this.call({ type: 'quit' }, 5000);
    } catch (e) {
      /* ignore */
    }
    this.destroy();
  };

  WorkerSink.prototype.destroy = function () {
    this.failAll(new Error('writer worker closed'));
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        /* ignore */
      }
      this.worker = null;
    }
  };

  WorkerSink.prototype.stat = async function (name) {
    await this.connect();
    var res = await this.call({ type: 'stat', dir: this.dir, name: name }, OPEN_TIMEOUT);
    return typeof res.size === 'number' ? res.size : -1;
  };
  WorkerSink.prototype.putText = async function (name, text) {
    await this.connect();
    return this.call({ type: 'putText', dir: this.dir, name: name, text: text }, OPEN_TIMEOUT);
  };
  WorkerSink.prototype.getText = async function (name) {
    await this.connect();
    var res = await this.call({ type: 'getText', dir: this.dir, name: name }, OPEN_TIMEOUT);
    return res.text === undefined ? null : res.text;
  };
  WorkerSink.prototype.remove = async function (name) {
    await this.connect();
    return this.call({ type: 'remove', dir: this.dir, name: name }, OPEN_TIMEOUT);
  };
  WorkerSink.prototype.getFile = function () {
    return getFileFromOpfs(this.dir, this.name);
  };

  /* ---- OPFS on the main thread via createWritable (Safari 26+) ------- */

  function DirectOpfsSink(opts) {
    this.dirName = opts.dirName || DEFAULT_DIR;
    this.name = opts.name;
    this.handle = null;
    this.writable = null;
    this.sequentialOnly = true; // no seeking: writes must arrive in order
  }

  DirectOpfsSink.prototype.open = async function () {
    var root = await navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(this.dirName, { create: true });
    this.handle = await dir.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable(); // truncates to zero
    return { size: 0, canResume: false };
  };

  DirectOpfsSink.prototype.write = async function (u8) {
    await this.writable.write(u8);
  };

  DirectOpfsSink.prototype.finish = async function () {
    await this.writable.close();
    this.writable = null;
    var f = await this.handle.getFile();
    return { size: f.size };
  };

  DirectOpfsSink.prototype.abort = async function () {
    try {
      if (this.writable) await this.writable.abort();
    } catch (e) {
      /* ignore */
    }
    this.writable = null;
  };

  DirectOpfsSink.prototype.stat = async function (name) {
    try {
      var root = await navigator.storage.getDirectory();
      var dir = await root.getDirectoryHandle(this.dirName, { create: true });
      var fh = await dir.getFileHandle(name, { create: false });
      return (await fh.getFile()).size;
    } catch (e) {
      return -1;
    }
  };
  DirectOpfsSink.prototype.putText = async function (name, text) {
    var root = await navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(this.dirName, { create: true });
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text));
    await w.close();
    return { ok: true };
  };
  DirectOpfsSink.prototype.getText = async function (name) {
    try {
      var root = await navigator.storage.getDirectory();
      var dir = await root.getDirectoryHandle(this.dirName, { create: true });
      var fh = await dir.getFileHandle(name, { create: false });
      return await (await fh.getFile()).text();
    } catch (e) {
      return null;
    }
  };
  DirectOpfsSink.prototype.remove = async function (name) {
    try {
      var root = await navigator.storage.getDirectory();
      var dir = await root.getDirectoryHandle(this.dirName, { create: true });
      await dir.removeEntry(name);
    } catch (e) {
      /* already gone */
    }
    return { ok: true };
  };
  DirectOpfsSink.prototype.getFile = function () {
    return getFileFromOpfs(this.dirName, this.name);
  };

  /* ---- Plain RAM (last resort) -------------------------------------- */

  function MemorySink(opts) {
    this.expected = opts.expectedSize || 0;
    this.mime = opts.mime || 'application/octet-stream';
    this.buffer = null;
    this.url = null;
    this.sequentialOnly = true;
  }

  MemorySink.prototype.open = function () {
    if (!this.buffer && this.expected > 0) this.buffer = new Uint8Array(this.expected);
    return Promise.resolve({ size: 0, canResume: false });
  };

  MemorySink.prototype.write = function (u8, at) {
    if (!this.buffer) this.buffer = new Uint8Array(at + u8.byteLength);
    if (at + u8.byteLength > this.buffer.length) {
      var bigger = new Uint8Array(at + u8.byteLength);
      bigger.set(this.buffer.subarray(0, Math.min(at, this.buffer.length)));
      this.buffer = bigger;
    }
    this.buffer.set(u8, at);
    return Promise.resolve();
  };

  MemorySink.prototype.finish = function () {
    var blob = new Blob([this.buffer], { type: this.mime });
    this.url = URL.createObjectURL(blob);
    return Promise.resolve({ size: this.buffer.byteLength, url: this.url });
  };

  MemorySink.prototype.abort = function () {
    if (this.url) {
      try {
        URL.revokeObjectURL(this.url);
      } catch (e) {
        /* ignore */
      }
      this.url = null;
    }
    this.buffer = null;
    return Promise.resolve();
  };

  /* ------------------------------------------------------------------ *
   * Download driver
   * ------------------------------------------------------------------ */

  /**
   * Can this response's Content-Length be compared with the manifest as-is?
   *
   * Only when nothing can have transformed the body between the file on the
   * server and the bytes res.body hands us. A content coding (gzip, br, …)
   * makes Content-Length the size of the *coded* body, and that lands on either
   * side of the file size: compressible data shrinks, but an incompressible
   * part — every ZIP part of the community build — only gains the coding's
   * framing. jsDelivr does exactly that: part 1 of the community build is
   * 20866662 bytes and is announced as 20866707.
   *
   * So a readable Content-Encoding other than `identity` means no. Not seeing
   * one only proves something when every header is visible: in Node (the
   * tests — there is no `location`) and for a same-origin URL. Cross-origin,
   * CORS hides Content-Encoding (it is not CORS-safelisted) but still exposes
   * Content-Length, so a coded response looks exactly like a plain one; a URL
   * that cannot be resolved is not trusted either.
   */
  function contentLengthIsTruthful(url, res) {
    var encoding = null;
    try {
      encoding = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-encoding') : null;
    } catch (e) {
      encoding = null;
    }
    if (encoding && String(encoding).trim().toLowerCase() !== 'identity') return false;
    if (typeof location === 'undefined') return true; // Node: nothing is hidden from us
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false; // cannot tell where it came from, so cannot rule a transform out
    }
  }

  /**
   * One attempt at streaming a part into the sink.
   * p = {url, bytes, index, sink, partOffset, skip, signal, fetchImpl,
   *      progress, onAdvance, log, expectDigest}
   */
  async function fetchPartOnce(p) {
    var res = await p.fetchImpl(p.url, { cache: 'default', signal: p.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + p.url);
    if (!res.body) throw new Error('no readable body for ' + p.url);

    // "Checking game data": a part that is not the size the manifest measured
    // has to be caught here instead of inside Unity, where it shows up as a
    // black screen. The Content-Length header alone cannot decide that, though.
    //
    // A cross-origin CDN (jsDelivr for the community build) may put a content
    // coding on the response, and then Content-Length describes the *coded*
    // body while res.body hands us *decoded* bytes. Content-Encoding is not a
    // CORS-safelisted header, so a page like this one cannot even read it to
    // tell the two cases apart. Comparing the two sizes up front therefore
    // turned a perfectly good download into a bogus "rebuild or re-run
    // prepare-build.mjs", which is also flagged as non-retryable — the load
    // died on a part that was fine.
    //
    // 1.0.1 still refused a declared size *above* the manifest, on the theory
    // that compression only ever shrinks the wire size. It does not: an
    // incompressible part only gains the coding's framing, and jsDelivr
    // announces the community build's 20866662-byte part 1 as 20866707 bytes.
    // So the header may only fail a part when it cannot have been transformed
    // (contentLengthIsTruthful above). Any other disagreement, in either
    // direction, is logged and settled by counting the bytes that actually
    // arrive below, which rejects a short part and an oversized one just as
    // firmly.
    var log = makeLogger(p.log);
    if (p.bytes > 0 && res.headers && typeof res.headers.get === 'function') {
      var declared = Number(res.headers.get('content-length') || 0) || 0;
      if (declared && declared !== p.bytes) {
        var truthful = contentLengthIsTruthful(p.url, res);
        if (declared > p.bytes && truthful) {
          throw new Error(
            'part ' + p.index + ' is ' + declared + ' bytes on the server but only ' + p.bytes +
              ' in the manifest — rebuild or re-run prepare-build.mjs'
          );
        }
        if (!truthful) {
          log(
            'part ' + p.index + ': the server announced ' + declared + ' bytes for a ' + p.bytes +
              ' byte part (a compressed transfer does that) — checking the bytes as they arrive'
          );
        }
      }
    }

    var reader = res.body.getReader();
    var received = 0; // bytes pulled off the wire for this part (incl. skipped prefix)
    var written = 0; // bytes this attempt produced for the file
    // Where the next byte of this part goes *in the file*. On a resumed part the
    // first `skip` bytes are already on disk, so the write cursor starts at
    // partOffset + skip rather than partOffset — getting this wrong silently
    // shifts the whole tail of the file (the Hollow Knight page's copy of this
    // loop had that bug: a resume that stopped mid-chunk corrupted the archive).
    var place = p.partOffset + p.skip;
    var inFlight = [];
    var lastFlushAt = 0;
    var failed = null;

    p.progress.written = 0;
    p.onAdvance();

    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        var value = chunk.value;
        if (!value || !value.byteLength) continue;

        var start = received; // offset of this chunk inside the part
        received += value.byteLength;

        // The real size check, on the bytes that actually arrived: more than the
        // manifest measured means the deployed part is not the one that was
        // chunked, and writing the extra would shift every later part in the
        // file. Failing here rather than after the download keeps the message
        // accurate — and unlike a short read, this will not fix itself on a
        // retry, so fetchPartTo treats it as permanent.
        if (p.bytes > 0 && received > p.bytes) {
          throw new Error(
            'part ' + p.index + ' is bigger than the manifest: ' + received + ' bytes received, ' +
              p.bytes + ' expected — rebuild or re-run prepare-build.mjs'
          );
        }

        if (received <= p.skip) {
          p.onAdvance();
          continue;
        }

        var usable = start >= p.skip ? value : value.subarray(p.skip - start);
        var at = place;
        place += usable.byteLength;
        written += usable.byteLength;
        var flush = written - lastFlushAt >= FLUSH_EVERY;
        if (flush) lastFlushAt = written;

        p.progress.written = written;
        p.onAdvance();

        inFlight.push(p.sink.write(usable, at, flush));
        if (inFlight.length >= (p.maxWritesInFlight || MAX_WRITES_IN_FLIGHT)) {
          await Promise.all(inFlight);
          inFlight = [];
        }
      }
      await Promise.all(inFlight);
    } catch (err) {
      failed = err;
    } finally {
      if (reader.cancel) {
        try {
          await reader.cancel();
        } catch (e) {
          /* ignore */
        }
      }
    }

    if (failed) {
      // Roll the progress back so a retry does not double count.
      p.progress.written = 0;
      p.onAdvance();
      throw failed;
    }

    var want = p.bytes - p.skip;
    if (written !== want) {
      p.progress.written = 0;
      p.onAdvance();
      throw new Error('part ' + p.index + ' ended early: ' + written + '/' + want + ' bytes');
    }
    p.progress.written = 0;
    p.onAdvance();
  }

  async function fetchPartTo(p) {
    var log = makeLogger(p.log);
    var attempts = p.sink.sequentialOnly ? 0 : MAX_RETRIES;

    for (var attempt = 0; ; attempt++) {
      if (p.signal && p.signal.aborted) throw abortError();
      try {
        await fetchPartOnce(p);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        // A manifest mismatch will not fix itself by retrying.
        if (/manifest|rebuild or re-run/i.test(String((err && err.message) || err))) throw err;
        if (attempt >= attempts) throw err;
        var wait = Math.min(8000, 400 * Math.pow(2, attempt));
        log(
          'part ' +
            p.index +
            ' failed (' +
            ((err && err.message) || err) +
            '), retrying in ' +
            wait +
            'ms (attempt ' +
            (attempt + 2) +
            '/' +
            (attempts + 1) +
            ')'
        );
        await sleep(wait, p.signal);
      }
    }
  }

  /**
   * Stream every part into `sink`; `startOffset` is what is already on disk.
   *
   * Several parts are on the wire at the same time (see DEFAULT_CONCURRENCY):
   * one part at a time spends most of the download waiting for the next
   * round trip, and the community build is 100 parts. The parts are *not*
   * buffered — each one is written to the sink at its own offset as its
   * chunks arrive, so only the chunks that happen to be in flight are ever
   * in memory.
   */
  async function streamAll(opts) {
    var parts = opts.parts;
    var sink = opts.sink;
    var fetchImpl = opts.fetchImpl || defaultFetch;
    var log = makeLogger(opts.log);

    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) {
      parts[i].bytes = parts[i].bytes || 0;
      parts[i].offset = total;
      total += parts[i].bytes;
    }

    // A sink that can only be written to in order (the createWritable
    // fallback and the RAM sink) cannot take parts out of order, so those
    // keep the old one-at-a-time behaviour.
    var wanted = Number(opts.concurrency);
    if (!isFinite(wanted) || wanted < 1) wanted = DEFAULT_CONCURRENCY;
    var concurrency = sink.sequentialOnly ? 1 : Math.max(1, Math.min(wanted, MAX_CONCURRENCY, parts.length));
    // Every part keeps a few writes in flight; with several parts running
    // that adds up, so the budget is shared.
    var writesPerPart = Math.max(2, Math.floor(MAX_WRITES_IN_FLIGHT / concurrency));

    var passes = sink.sequentialOnly ? SEQ_RETRIES : 1;
    var lastErr = null;

    for (var pass = 0; pass < passes; pass++) {
      var startOffset = pass === 0 ? opts.startOffset || 0 : 0;
      try {
        if (pass > 0) {
          log('restarting the download from the beginning (attempt ' + (pass + 1) + '/' + passes + ')');
          var reopened = await sink.open(false);
          startOffset = reopened.canResume ? reopened.size : 0;
        }

        var lastReport = 0;
        var currentPart = 0;
        var began = now();
        // Bytes accounted for per part: the parts that are already on disk
        // count as complete, the ones being downloaded count what they have
        // written so far.
        var written = new Array(parts.length);
        var todo = [];

        for (i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part.offset + part.bytes <= startOffset) {
            written[i] = part.bytes;
            continue;
          }
          written[i] = 0;
          todo.push(i);
        }

        function accounted() {
          var sum = 0;
          for (var k = 0; k < written.length; k++) sum += written[k];
          return sum;
        }

        function report(force) {
          if (!opts.onProgress) return;
          var t = now();
          if (!force && t - lastReport < PROGRESS_THROTTLE) return;
          lastReport = t;
          var done = accounted();
          var elapsed = (t - began) / 1000;
          var rate = elapsed > 0.5 ? done / elapsed : 0;
          opts.onProgress({
            loaded: Math.min(done, total),
            total: total,
            part: currentPart,
            parts: parts.length,
            pass: pass + 1,
            bytesPerSecond: rate,
            etaSeconds: rate > 0 ? Math.max(0, (total - done) / rate) : 0,
          });
        }

        function makeAdvance(index, prog, skip) {
          return function () {
            // `prog.written` counts the bytes this attempt wrote; the
            // skipped prefix of a resumed part is already on disk. The
            // count only ever grows: the streamer resets it to zero when a
            // part is done, and the progress bar must not fall back.
            var value = skip + prog.written;
            if (value > written[index]) written[index] = value;
            report(false);
          };
        }

        var failed = null;
        var next = 0;

        async function runPart(index) {
          var p = parts[index];
          var skip = Math.max(0, startOffset - p.offset);
          var progress = { written: 0 };
          var onAdvance = makeAdvance(index, progress, skip);

          await fetchPartTo({
            url: p.url,
            bytes: p.bytes,
            index: index + 1,
            sink: sink,
            partOffset: p.offset,
            skip: skip,
            signal: opts.signal,
            fetchImpl: fetchImpl,
            log: opts.log,
            progress: progress,
            onAdvance: onAdvance,
            maxWritesInFlight: writesPerPart,
          });

          written[index] = p.bytes;
          report(true);
        }

        // The queue: `concurrency` parts are fetched at the same time, and
        // each of them is written to the sink at its own offset.
        var workers = [];
        for (var w = 0; w < concurrency; w++) {
          workers.push(
            (async function () {
              for (;;) {
                if (failed) return;
                if (next >= todo.length) return;
                var index = todo[next++];
                if (index + 1 > currentPart) currentPart = index + 1;
                try {
                  await runPart(index);
                } catch (err) {
                  failed = err;
                  return;
                }
              }
            })()
          );
        }
        await Promise.all(workers);
        if (failed) throw failed;

        report(true);
        return { total: total };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastErr = err;
        if (pass + 1 >= passes) break;
        await sleep(1000, opts.signal);
      }
    }

    throw lastErr || new Error('download failed');
  }

  /* ------------------------------------------------------------------ *
   * Integrity checks ("checking game data")
   * ------------------------------------------------------------------ */

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  async function sha256Hex(blobLike) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    var buf = await blobLike.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', buf);
    return toHex(digest);
  }

  /**
   * Verify an assembled file against the manifest.
   *
   *   mode 'size'  — exact byte length only (instant, always done)
   *   mode 'sample'— first/last part digests (a few MB of hashing)
   *   mode 'full'  — whole-file SHA-256 (slow on iPad; opt-in)
   *
   * Returns {ok, checked, mode, detail}.
   */
  async function verifyFile(file, manifest, mode) {
    var want = (manifest && (manifest.total || manifest.size)) || 0;
    if (want && file.size !== want) {
      return { ok: false, mode: mode || 'size', detail: 'size ' + file.size + ' != ' + want, checked: 0 };
    }
    mode = mode || 'sample';
    if (mode === 'size' || !manifest) return { ok: true, mode: 'size', checked: 0 };
    // Nothing to compare against (an old manifest, or a build that shipped no
    // digests): say so instead of pretending a full check happened.
    if (!manifest.sha256 && !manifest.headSha256 && !manifest.tailSha256) {
      return { ok: true, mode: 'skipped', checked: 0, detail: 'the manifest has no digests' };
    }

    try {
      if (mode === 'full' && manifest.sha256) {
        var full = await sha256Hex(file);
        if (!full) return { ok: true, mode: 'skipped', checked: 0 };
        return {
          ok: full === manifest.sha256,
          mode: 'full',
          checked: file.size,
          detail: full === manifest.sha256 ? '' : 'sha256 ' + full.slice(0, 12) + '… != ' + String(manifest.sha256).slice(0, 12) + '…',
        };
      }

      // Sampled: the first and the last chunk of the file. Cheap on iPad and
      // enough to catch a truncated or cross-build file.
      var probe = manifest.probeBytes || 4 * 1024 * 1024;
      var head = await sha256Hex(file.slice(0, probe));
      var tail = await sha256Hex(file.slice(Math.max(0, file.size - probe)));
      var ok = (!manifest.headSha256 || head === manifest.headSha256) &&
               (!manifest.tailSha256 || tail === manifest.tailSha256);
      return {
        ok: ok,
        mode: 'sample',
        checked: Math.min(file.size, probe * 2),
        detail: ok ? '' : 'first/last ' + mb(probe) + ' do not match the manifest',
      };
    } catch (e) {
      return { ok: true, mode: 'skipped', checked: 0, detail: String((e && e.message) || e) };
    }
  }

  /* ------------------------------------------------------------------ *
   * High level: make sure a merged, disk-backed dataset exists
   * ------------------------------------------------------------------ */

  function wrapBlob(file, name, mime) {
    // Re-wrapping keeps the disk-backed reference (no copy) and gives the blob
    // a content type: Unity needs application/wasm to *stream* compile it.
    try {
      return new File([file], name, { type: mime });
    } catch (e) {
      return new Blob([file], { type: mime });
    }
  }

  async function safeCall(fn) {
    try {
      return await fn();
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * The exclusive OPFS lock, and why opening has to be retried
   * ------------------------------------------------------------------ *
   * A FileSystemSyncAccessHandle (and a FileSystemWritableFileStream) takes an
   * EXCLUSIVE lock on its file: while one is open, the next open of the same
   * file is refused. Browsers release that lock asynchronously when the holder
   * goes away, so there is a window where the file is still locked although
   * nothing is using it any more:
   *
   *   - this page's own "Try again" button does a location.reload(); the new
   *     page asks for the cache file while WebKit is still letting go of the
   *     previous page's worker;
   *   - a tab that iPadOS jetsam-killed mid-download never ran close();
   *   - a second Safari tab on the same site holds the lock for as long as it
   *     is open.
   *
   * Safari reports the refusal as "InvalidStateError: The object is in an
   * invalid state." and Chromium as NoModificationAllowedError. Neither means
   * the cache is corrupt, and neither is worth showing a player as a dead end,
   * so the open is retried for a few seconds before it is called a failure.
   */

  // Mutable (and exposed on _internals) so the tests can exercise both the
  // retry and the give-up path without waiting out the real backoff.
  var OPEN_LOCK = { attempts: 6, delay: 500 }; // delay is multiplied by the attempt number

  /** Is this failure "somebody else is still holding the file"? */
  function isLockRefusal(err) {
    var name = String((err && err.name) || '');
    var message = String((err && err.message) || err);
    return (
      name === 'InvalidStateError' ||
      name === 'NoModificationAllowedError' ||
      /another open access handle|already open|invalid state|writable stream associated/i.test(message)
    );
  }

  /**
   * `sink.open()`, retried while the file is still locked by a previous holder.
   * Every sink type benefits: the writer worker and the main-thread
   * createWritable() path both hit the same exclusive lock.
   */
  async function openSinkWithRetry(sink, resume, opts, log) {
    var attempts = Math.max(1, OPEN_LOCK.attempts | 0);
    var last = null;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      try {
        return await sink.open(resume);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!isLockRefusal(err) || attempt >= attempts) throw err;
        last = err;
        var wait = Math.max(0, OPEN_LOCK.delay | 0) * attempt;
        log(
          'the cache file is still locked (' + ((err && err.name) || 'Error') + ': ' +
            ((err && err.message) || err) + ') — waiting ' + wait + 'ms for the previous holder to let go' +
            ' (attempt ' + attempt + '/' + attempts + ')'
        );
        if (opts.onStatus) opts.onStatus('waiting for the cached file to be released…');
        if (wait > 0) await sleep(wait, opts.signal);
      }
    }
    throw last || new Error('could not open the cache file');
  }

  /** Turn an open failure into something a player can act on. */
  function describeOpenFailure(err, cacheKey) {
    var name = err && err.name && err.name !== 'Error' ? err.name + ': ' : '';
    var detail = (err && err.message) || String(err);
    if (isLockRefusal(err)) {
      return (
        'the cached game file is still locked by another Safari tab, or by the page you just left (' +
        name + detail + '). Close every other tab of this site and reload; a tab that iOS killed ' +
        'mid-download can hold the file for a few seconds. If it still will not open, ' +
        'Menu ▸ Clear cached game data starts the download over.'
      );
    }
    // Keep the DOMException name in the message: "the object is in an invalid
    // state" on its own says nothing about which call failed or why.
    return 'could not open the cache file ' + cacheKey + ' (' + name + detail + ')';
  }

  /** Release a sink without ever letting the cleanup itself fail the load. */
  async function quietAbort(sink) {
    try {
      if (sink && typeof sink.abort === 'function') await sink.abort();
    } catch (e) {
      /* the load already failed; a failed cleanup must not replace that error */
    }
  }

  /**
   * Read the assembled file back so it can be verified and handed to Unity.
   * The sink is asked first (an injected sink may hold the data itself); OPFS
   * is the fallback because that is where the real ones wrote it.
   */
  async function resultFile(sink, dirName, name) {
    if (sink && typeof sink.getFile === 'function') {
      try {
        var file = await sink.getFile();
        if (file) return file;
      } catch (e) {
        /* fall through to OPFS */
      }
    }
    return getFileFromOpfs(dirName, name);
  }

  async function getFileFromOpfs(dirName, name) {
    try {
      var root = await navigator.storage.getDirectory();
      var dir = await root.getDirectoryHandle(dirName, { create: true });
      var fh = await dir.getFileHandle(name, { create: false });
      return await fh.getFile();
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {object} opts
   *   parts, expectedSize, cacheKey, buildId, dirName, mime, verify,
   *   onProgress, onStatus, onLog, signal, fetchImpl, workerUrl,
   *   writerFactory (tests), allowMemoryFallback (default true),
   *   concurrency (how many parts are fetched at once, default 4)
   * @returns {Promise<{url,size,kind,file,sink,dispose,verify}>}
   */
  async function ensureDataset(opts) {
    var log = makeLogger(opts.onLog);
    var dirName = opts.dirName || DEFAULT_DIR;
    var expectedSize = opts.expectedSize || 0;
    var caps = opts.caps || (await detect());
    var sink = null;

    // An injected writerFactory is an explicit request to use disk (the test
    // suite and the desktop fallback both use it), so it wins over the
    // capability probe: without that, a caller that already knows OPFS works
    // would silently end up holding hundreds of MB in RAM.
    var wantDisk = opts.preferDisk !== false && (opts.writerFactory ? true : caps.opfs);

    if (wantDisk) {
      try {
        sink = opts.writerFactory
          ? await opts.writerFactory({ dirName: dirName, name: opts.cacheKey, expectedSize: expectedSize })
          : await openOpfsSink(opts, caps, dirName, expectedSize);
      } catch (err) {
        log('could not open OPFS writer: ' + ((err && err.message) || err));
        sink = null;
      }
    }

    if (sink) {
      try {
        return await runDiskSession(opts, sink, dirName, expectedSize, log);
      } catch (err) {
        // Whatever went wrong, let go of the sink FIRST. An OPFS sync access
        // handle (and a createWritable stream) is an exclusive lock on the cache
        // file, and abandoning it is what turns one failed download into
        // "the object is in an invalid state" on the next attempt: the page's
        // "Try again" button reloads, and the new page asks for the file while
        // WebKit is still releasing the old holder. WorkerSink.abort() sends
        // 'quit', which flushes and close()s the handle properly instead of
        // leaving the browser to reap it after terminate().
        await quietAbort(sink);
        if (err && err.name === 'AbortError') throw err;
        // Setup problems (no sync handle / blocked OPFS) can fall back to RAM;
        // a failed download must not silently retry in RAM.
        if (err && err.setupFailure && opts.allowMemoryFallback !== false) {
          log('disk cache unavailable: ' + err.message + ' — falling back to memory');
          if (opts.onStatus) opts.onStatus('disk cache unavailable, loading into memory');
        } else {
          throw err;
        }
      }
    } else if (opts.allowMemoryFallback === false) {
      throw new Error('no writable storage available for the game data');
    }

    /* ---- RAM fallback ------------------------------------------------ */
    var memSink = new MemorySink({
      expectedSize: expectedSize,
      mime: opts.mime,
    });
    await memSink.open();
    if (opts.onStatus) opts.onStatus('loading into memory (no disk cache)');
    await streamAll({
      parts: opts.parts,
      sink: memSink,
      startOffset: 0,
      concurrency: opts.concurrency,
      onProgress: opts.onProgress,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      log: opts.onLog,
    });
    var memDone = await memSink.finish();
    if (expectedSize && memDone.size !== expectedSize) {
      throw new Error('assembled size mismatch: ' + memDone.size + ' != ' + expectedSize);
    }
    return finish({
      kind: 'memory',
      url: memDone.url,
      size: memDone.size,
      file: null,
      sink: memSink,
    });
  }

  async function openOpfsSink(opts, caps, dirName, expectedSize) {
    var base = {
      dirName: dirName,
      name: opts.cacheKey,
      expectedSize: expectedSize,
      log: opts.onLog,
    };
    if (caps.workers && typeof Worker !== 'undefined' && opts.workerUrl) {
      // Probe with a throw-away file so a partially downloaded cache is never
      // touched, and so we know OPFS + sync access handles really work here.
      var probeName = opts.cacheKey + '.probe';
      var probe = new WorkerSink(
        Object.assign({ workerUrl: opts.workerUrl, name: probeName, expectedSize: 0 }, base)
      );
      try {
        await probe.open(false);
        await probe.remove(probeName);
        await probe.abort();
        return new WorkerSink(Object.assign({ workerUrl: opts.workerUrl }, base));
      } catch (e) {
        probe.destroy();
        opts.onLog && opts.onLog('writer worker unavailable: ' + ((e && e.message) || e));
      }
    }
    var root = await navigator.storage.getDirectory();
    var dir = await root.getDirectoryHandle(dirName, { create: true });
    var handle = await dir.getFileHandle(opts.cacheKey, { create: true });
    if (typeof handle.createWritable !== 'function') {
      throw new Error('cannot write to the origin private file system on this browser');
    }
    return new DirectOpfsSink(base);
  }

  async function runDiskSession(opts, sink, dirName, expectedSize, log) {
    function setup(msg) {
      var e = new Error(msg);
      e.setupFailure = true;
      return e;
    }

    if (opts.onStatus) opts.onStatus('checking local cache');
    var known = await safeCall(function () {
      return sink.stat(opts.cacheKey);
    });
    if (typeof known !== 'number') known = -1;

    // `.ok`       = written after the whole file was verified  (complete)
    // `.building` = written before the first byte of a download (partial)
    var done = await safeCall(function () {
      return sink.getText(opts.cacheKey + '.ok');
    });
    var building = await safeCall(function () {
      return sink.getText(opts.cacheKey + '.building');
    });

    var doneMatchesBuild = typeof done === 'string' && done.indexOf(opts.buildId) === 0;
    var partialMatchesBuild = typeof building === 'string' && building.indexOf(opts.buildId) === 0;

    var cacheValid = expectedSize > 0 && known === expectedSize && doneMatchesBuild;

    // A file of exactly the expected size can only exist if every byte was
    // written (writes are issued strictly in order), so it is usable even when
    // the tab died between the final write and the completion marker — but
    // only if no *other* build left a marker behind.
    var completeButUnmarked = expectedSize > 0 && known === expectedSize && done === null && !cacheValid;
    var staleBuild = done !== null && !doneMatchesBuild;

    if (cacheValid || completeButUnmarked) {
      var cachedFile = await resultFile(sink, dirName, opts.cacheKey);
      if (cachedFile && cachedFile.size === expectedSize) {
        var check = await verifyFile(cachedFile, opts.manifest, opts.verify || 'size');
        if (!check.ok) {
          log('cached file failed the ' + check.mode + ' check (' + check.detail + ') — downloading again');
          await safeCall(function () {
            return sink.remove(opts.cacheKey + '.ok');
          });
          await safeCall(function () {
            return sink.remove(opts.cacheKey + '.building');
          });
          await safeCall(function () {
            return sink.remove(opts.cacheKey);
          });
        } else {
          if (completeButUnmarked) {
            log('found a complete file without a completion marker — repairing it');
            await safeCall(function () {
              return sink.putText(opts.cacheKey + '.ok', opts.buildId + ' ' + new Date().toISOString());
            });
          }
          log(
            'cache hit: ' + opts.cacheKey + ' (' + mb(expectedSize) + ' already on disk' +
              (check.mode === 'sample' || check.mode === 'full' ? ', verified ' + check.mode : '') + ')'
          );
          return finish({
            kind: 'opfs-cached',
            url: URL.createObjectURL(wrapBlob(cachedFile, opts.cacheKey, opts.mime)),
            size: cachedFile.size,
            file: cachedFile,
            sink: sink,
            verify: check,
          });
        }
      } else {
        log('cache looked complete but the file could not be read back, rebuilding');
      }
    }

    if (staleBuild) log('cached data belongs to another build id — starting over');

    var resumeAt = 0;
    if (expectedSize > 0 && known > 0 && known < expectedSize && partialMatchesBuild && !staleBuild) {
      resumeAt = known; // same build, partially written
    }

    if (!resumeAt) {
      // Remember which build this partial file belongs to, so a killed session
      // can be resumed instead of re-downloaded.
      await safeCall(function () {
        return sink.putText(opts.cacheKey + '.building', opts.buildId);
      });
      if (staleBuild) {
        await safeCall(function () {
          return sink.remove(opts.cacheKey + '.ok');
        });
      }
    }

    var opened;
    try {
      opened = await openSinkWithRetry(sink, resumeAt > 0, opts, log);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw setup(describeOpenFailure(err, opts.cacheKey));
    }

    var startOffset = opened.canResume ? opened.size : 0;
    if (startOffset > 0) {
      log('resuming download at ' + mb(startOffset));
      if (opts.onStatus) opts.onStatus('resuming download — ' + mb(startOffset) + ' already saved');
    } else {
      if (opts.onStatus) opts.onStatus('downloading game data');
    }

    await streamAll({
      parts: opts.parts,
      sink: sink,
      startOffset: startOffset,
      concurrency: opts.concurrency,
      onProgress: opts.onProgress,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      log: opts.onLog,
    });

    var finished = await sink.finish();
    if (expectedSize && finished.size !== expectedSize) {
      // Something is wrong with the file on disk: throw it away so the next
      // attempt starts from zero instead of failing the same way.
      await safeCall(function () {
        return sink.remove(opts.cacheKey + '.ok');
      });
      await safeCall(function () {
        return sink.remove(opts.cacheKey + '.building');
      });
      if (resumeAt) {
        // Only delete the data file when we did not simply resume into it.
        await safeCall(function () {
          return sink.remove(opts.cacheKey);
        });
      }
      throw new Error(
        'saved file is ' + finished.size + ' bytes, expected ' + expectedSize + ' — the cache was cleared, try again'
      );
    }

    var built = await resultFile(sink, dirName, opts.cacheKey);
    var builtCheck = built
      ? await verifyFile(built, opts.manifest, opts.verify || 'size')
      : { ok: true, mode: 'size', detail: 'the file could not be read back for deeper checks' };
    if (built && !builtCheck.ok) {
      await safeCall(function () {
        return sink.remove(opts.cacheKey);
      });
      await safeCall(function () {
        return sink.remove(opts.cacheKey + '.building');
      });
      throw new Error('the downloaded file failed verification (' + (builtCheck.detail || 'unreadable') + ') — try again');
    }

    try {
      var stamp = opts.buildId;
      if (builtCheck.mode === 'sample' || builtCheck.mode === 'full') stamp += ' verified=' + builtCheck.mode;
      await sink.putText(opts.cacheKey + '.ok', stamp + ' ' + new Date().toISOString());
    } catch (e) {
      log('could not write the cache marker: ' + ((e && e.message) || e));
    }

    log('saved ' + mb(finished.size) + ' to OPFS as ' + opts.cacheKey);
    if (!built && opts.onStatus) opts.onStatus('saved to disk (the file could not be read back here)');
    return finish({
      kind: 'opfs',
      url: built ? URL.createObjectURL(wrapBlob(built, opts.cacheKey, opts.mime)) : null,
      size: built ? built.size : finished.size,
      file: built,
      sink: sink,
      verify: builtCheck,
    });
  }

  function finish(dataset) {
    dataset.dispose = function () {
      if (dataset.url) {
        try {
          URL.revokeObjectURL(dataset.url);
        } catch (e) {
          /* ignore */
        }
      }
      if (dataset.sink && dataset.sink.destroy) dataset.sink.destroy();
    };
    return dataset;
  }

  async function clearCache(dirName) {
    try {
      var root = await navigator.storage.getDirectory();
      await root.removeEntry(dirName || DEFAULT_DIR, { recursive: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function cacheInfo(dirName) {
    var out = { entries: [], bytes: 0 };
    try {
      var root = await navigator.storage.getDirectory();
      var dir = await root.getDirectoryHandle(dirName || DEFAULT_DIR, { create: false });
      if (dir.entries) {
        for await (var pair of dir.entries()) {
          var size = 0;
          if (pair[1].kind === 'file') {
            try {
              size = (await pair[1].getFile()).size;
            } catch (e) {
              size = 0;
            }
          }
          out.entries.push({ name: pair[0], size: size });
          out.bytes += size;
        }
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  /**
   * Turn a manifest's chunk list into the `parts` array streamAll wants.
   * `manifest` = { base, chunks: {data: [{path, bytes, sha256}], wasm: [...] } }
   */
  function partsFromManifest(chunks, base) {
    var prefix = base || '';
    return (chunks || []).map(function (chunk) {
      return {
        url: prefix + chunk.path,
        bytes: chunk.bytes,
        sha256: chunk.sha256 || null,
      };
    });
  }

  return {
    VERSION: VERSION,
    DEFAULT_DIR: DEFAULT_DIR,
    DEFAULT_PART_BYTES: DEFAULT_PART_BYTES,
    detect: detect,
    requestPersistence: requestPersistence,
    ensureDataset: ensureDataset,
    verifyFile: verifyFile,
    sha256Hex: sha256Hex,
    partsFromManifest: partsFromManifest,
    clearCache: clearCache,
    cacheInfo: cacheInfo,
    mb: mb,
    _internals: {
      WorkerSink: WorkerSink,
      DirectOpfsSink: DirectOpfsSink,
      MemorySink: MemorySink,
      streamAll: streamAll,
      fetchPartOnce: fetchPartOnce,
      contentLengthIsTruthful: contentLengthIsTruthful,
      fetchPartTo: fetchPartTo,
      sleep: sleep,
      noop: noop,
      OPEN_LOCK: OPEN_LOCK,
      isLockRefusal: isLockRefusal,
      describeOpenFailure: describeOpenFailure,
      quietAbort: quietAbort,
    },
  };
});
