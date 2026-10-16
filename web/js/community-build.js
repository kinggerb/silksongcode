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
    // The archive may live somewhere else than the rest of the build (the
    // slimmer re-published archive does), so it can name its own root.
    if (archive.base !== undefined && (typeof archive.base !== 'string' || !archive.base)) {
      throw fail('community build configuration has an invalid asset archive base');
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

  /** A human readable size, in megabytes. */
  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Where a part of the archive is. An archive that names its own root wins
   * over the build's, because the slimmer archive is published on its own.
   */
  function archiveBase(config, base) {
    return base || (config.assetArchive && config.assetArchive.base) || config.base;
  }

  function parts(config, base) {
    validate(config);
    var root = archiveBase(config, base);
    return config.assetArchive.parts.map(function (part) {
      return { url: join(root, part.path), bytes: part.bytes };
    });
  }

  /* ---------------------------------------------------------------- *
   * A smaller archive
   *
   * The upstream archive is one 1.94 GiB ZIP, and a good part of it is
   * the high-definition cutscenes — the very files the page answers with
   * a placeholder instead of the real bytes. Downloading them is a waste
   * of an hour on a phone and a gigabyte of storage nobody can use.
   *
   * So before the download starts, the archive is asked for its index:
   * two small range requests read the ZIP's central directory, which
   * says where every file lives inside the archive. With that in hand
   * the download can skip the files nobody is ever going to read, and
   * the archive is written out again in a smaller, perfectly ordinary
   * ZIP (the entries are copied byte for byte — nothing is recompressed).
   *
   * If the server does not honour byte ranges, or the archive is not
   * shaped the way we expect, the whole archive is downloaded as before.
   * ---------------------------------------------------------------- */

  // Below this there is no point: the plan costs a couple of requests.
  var MIN_SAVING = 1024 * 1024;

  /* ---------------------------------------------------------------- *
   * Remembering the cutscenes
   *
   * Telling a game bundle from a cutscene by looking at its bytes
   * takes a few hundred small requests, and the answer is the same for
   * every launch of the same build. So it is looked at once and the
   * names are remembered in local storage — the next launch only has to
   * read the archive's own index.
   * ---------------------------------------------------------------- */

  function sniffKey(options) {
    return 'silksong.archive.cutscenes.' + (options.key || 'default');
  }

  function storageFor(options) {
    if (options.storage) return options.storage;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* no storage (private mode, or a sandboxed frame) */ }
    return null;
  }

  function loadRemembered(options) {
    try {
      var store = storageFor(options);
      if (!store) return null;
      var text = store.getItem(sniffKey(options));
      if (!text) return null;
      var names = JSON.parse(text);
      return Array.isArray(names) ? names : null;
    } catch (e) {
      return null;
    }
  }

  function remember(options, names) {
    try {
      var store = storageFor(options);
      if (!store) return;
      store.setItem(sniffKey(options), JSON.stringify(names || []));
    } catch (e) { /* no room, or no storage */ }
  }

  function zipLibrary(options) {
    if (options && options.zip) return options.zip;
    if (typeof SKZipPlan !== 'undefined') return SKZipPlan;
    // Node (the test suite) has no globals: the module sits next to this one.
    try {
      if (typeof require === 'function') return require('./zip-plan.js');
    } catch (e) { /* not a CommonJS host */ }
    return null;
  }

  /**
   * Read the archive's index and work out what can be left out.
   *
   * Returns null when the archive cannot be pruned — the caller then
   * downloads it whole, exactly as before.
   */
  async function planArchive(partList, options) {
    options = options || {};
    var zip = zipLibrary(options);
    if (!zip || typeof zip.readIndex !== 'function') return null;

    var reader = zip.createReader(partList, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    var index = await zip.readIndex(reader);
    if (!index) return null;
    // A server that ignores the Range header sends whole files, and then
    // there is nothing to save.
    if (!reader.ranges) return null;

    var plan = zip.planEntries(index, {
      skip: options.skip || function (name) {
        // The very same rule the mount uses to answer a cutscene with a
        // placeholder: a file that is left out of the archive has to be one
        // the page never asks the archive for.
        if (isVideoPath('/StreamingAssets/' + String(name).replace(/^\/+/, ''))) return 'video';
        if (zip.isOtherPlatformEntry(name)) return 'other';
        return '';
      },
    });

    // A name is only a hint: the big entries are looked at as well, because
    // a cutscene that is called "packed-something.bundle" is still a
    // cutscene, and leaving it out is the whole point. The answer is the
    // same for every launch, so it is remembered.
    var remembered = loadRemembered(options);
    if (remembered) {
      if (typeof zip.applySniffed === 'function') plan = zip.applySniffed(plan, index, remembered);
    } else if (typeof zip.planEntriesAsync === 'function') {
      plan = await zip.planEntriesAsync(index, reader, {
        skip: options.skip,
        minBytes: options.minSniffBytes,
        maxSniffs: options.maxSniffs,
      });
      remember(options, plan.sniffedNames);
    }

    if (!plan.skipped.length || plan.skippedBytes < MIN_SAVING) return null;

    var layout = zip.buildLayout(plan, index);
    if (!layout) return null;

    var segments = zip.buildSegments(layout, partList);
    var videoNames = plan.skipped
      .filter(function (entry) { return entry.skipReason === 'video'; })
      .map(function (entry) { return basename(entry.name).toLowerCase(); })
      .filter(function (name, at, all) { return name && all.indexOf(name) === at; });
    return {
      segments: segments,
      // What the file on the device will be.
      outputSize: layout.outputSize,
      // What the network has to send.
      downloadBytes: layout.downloadBytes,
      keptBytes: plan.keptBytes,
      skippedBytes: plan.skippedBytes,
      skippedCount: plan.skipped.length,
      skippedNames: plan.skipped.map(function (entry) { return entry.name; }),
      // The cutscenes that are left out, so the mount can answer a request
      // for one of them with a placeholder instead of a missing file.
      videoNames: videoNames,
      entryCount: index.entries.length,
      sniffed: plan.sniffed || 0,
    };
  }

  async function ensureArchive(config, options) {
    options = options || {};
    validate(config);
    var stream = options.stream || (typeof SKStream !== 'undefined' ? SKStream : null);
    if (!stream || typeof stream.ensureDataset !== 'function') throw fail('the low-memory storage loader did not load');
    var base = archiveBase(config, options.base);
    var archive = config.assetArchive;
    var partList = parts(config, base);

    // Work out whether the archive can be made smaller before a single
    // byte of it is downloaded. An archive that says it is already slim has
    // nothing to leave out, and the plan costs a couple of hundred range
    // requests, so it is skipped.
    var plan = null;
    if (options.prune !== false && !archive.slim) {
      try {
        plan = await planArchive(partList, Object.assign({}, options, {
          key: config.buildId + ':' + archive.total,
        }));
      } catch (error) {
        if (options.onLog) {
          options.onLog('could not plan a smaller archive (' + ((error && error.message) || error) + ') — downloading the whole thing');
        }
        plan = null;
      }
    }

    if (plan) {
      if (options.onLog) {
        options.onLog(
          'leaving out ' + plan.skippedCount + ' of ' + plan.entryCount + ' archive files (' +
            mb(plan.skippedBytes) + ' of cutscenes and other platforms) — ' +
            mb(plan.downloadBytes) + ' instead of ' + mb(archive.total)
        );
      }
      if (options.onPlan) options.onPlan(plan);
      var pruned = await stream.ensureDataset({
        segments: plan.segments,
        expectedSize: plan.outputSize,
        // The same cache file as the whole archive: the pruned one replaces
        // it, so the device is not left with both. The build id says which
        // of the two it is, so a half-downloaded one is never continued as
        // the other.
        cacheKey: archive.cacheKey,
        buildId: 'pruned-' + config.buildId,
        mime: archive.mime || 'application/zip',
        verify: 'size',
        workerUrl: options.workerUrl || 'js/writer.js',
        writerFactory: options.writerFactory,
        preferDisk: true,
        allowMemoryFallback: false,
        concurrency: options.concurrency || 6,
        fetchImpl: options.fetchImpl,
        onProgress: options.onProgress,
        onStatus: options.onStatus,
        onLog: options.onLog,
        signal: options.signal,
      });
      pruned.plan = plan;
      return pruned;
    }

    return stream.ensureDataset({
      parts: partList,
      expectedSize: archive.total,
      // The same cache file as the pruned one, but a build id of its own: the
      // loader has to be able to tell the two apart, or a half-downloaded
      // archive would be continued as the other one.
      cacheKey: archive.cacheKey,
      buildId: config.buildId,
      mime: archive.mime || 'application/zip',
      verify: 'size',
      workerUrl: options.workerUrl || 'js/writer.js',
      writerFactory: options.writerFactory,
      preferDisk: true,
      allowMemoryFallback: false,
      // The archive is 100 parts: one at a time is minutes of round trips.
      concurrency: options.concurrency || 6,
      fetchImpl: options.fetchImpl,
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

  /* ---------------------------------------------------------------- *
   * Cutscenes: a placeholder instead of the real thing
   *
   * The community archive is the upstream one, so it still contains the
   * high-definition cutscenes — some of them hundreds of megabytes. When
   * Unity asks for one, the ZIP reader has to inflate it into a Blob
   * first, and *that* is what empties a phone's memory: a single video
   * can be bigger than the whole tab is allowed to be.
   *
   * So the mount never hands the real bytes over. A cutscene request is
   * answered with a tiny, structurally valid container (an MP4 with a
   * 2×2 track and no samples, or a WebM with a header and no clusters),
   * which costs a few hundred bytes and plays as a black frame. The
   * bytes are the same ones `makePlaceholderVideo()` in
   * tools/unity-webdata.mjs builds for the prepared build — the two are
   * compared byte for byte by the test suite.
   * ---------------------------------------------------------------- */

  function u32(value) {
    var b = new Uint8Array(4);
    b[0] = (value >>> 24) & 0xff;
    b[1] = (value >>> 16) & 0xff;
    b[2] = (value >>> 8) & 0xff;
    b[3] = value & 0xff;
    return b;
  }

  function u16(value) {
    var b = new Uint8Array(2);
    b[0] = (value >>> 8) & 0xff;
    b[1] = value & 0xff;
    return b;
  }

  function asciiBytes(text) {
    var b = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    return b;
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  function box(type, parts) {
    var payload = concatBytes(parts);
    return concatBytes([u32(payload.length + 8), asciiBytes(type), payload]);
  }

  function fullBox(version, flags, parts) {
    var head = new Uint8Array([
      version & 0xff,
      (flags >>> 16) & 0xff,
      (flags >>> 8) & 0xff,
      flags & 0xff,
    ]);
    return concatBytes([head].concat(parts || []));
  }

  /** A minimal but structurally complete MP4 with a video track that has no samples. */
  function makeMp4Placeholder(width, height, timescale, duration) {
    width = width || 2;
    height = height || 2;
    timescale = timescale || 30;
    duration = duration || 1;

    var ftyp = box('ftyp', [asciiBytes('isom'), u32(0x200), asciiBytes('isomiso2mp41')]);
    var mvhd = box('mvhd', [fullBox(0, 0, [
      u32(0), u32(0),
      u32(timescale), u32(duration * timescale),
      u32(0x00010000), u16(0x0100), u16(0),
      u32(0), u32(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
      u32(2),
    ])]);
    var tkhd = box('tkhd', [fullBox(0, 7, [
      u32(0), u32(0), u32(1), u32(0),
      u32(duration * timescale),
      u32(0), u32(0),
      u16(0), u16(0), u16(0), u16(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(width << 16), u32(height << 16),
    ])]);
    var mdhd = box('mdhd', [fullBox(0, 0, [
      u32(0), u32(0), u32(timescale), u32(duration * timescale), u16(0x55c4), u16(0),
    ])]);
    var hdlr = box('hdlr', [fullBox(0, 0, [
      u32(0), asciiBytes('vide'), u32(0), u32(0), u32(0), asciiBytes('VideoHandler\0'),
    ])]);
    var esds = box('esds', [fullBox(0, 0, [
      new Uint8Array([0x03, 0x19, 0x00, 0x01, 0x00]),
      new Uint8Array([0x04, 0x11, 0x40, 0x15]),
      new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      new Uint8Array([0x05, 0x02, 0x12, 0x10]),
      new Uint8Array([0x06, 0x01, 0x02]),
    ])]);
    var mp4v = box('mp4v', [
      new Uint8Array(6),
      u16(1),
      u16(0), u16(0), u16(0),
      u32(0), u32(0), u32(0),
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000),
      u32(0), u16(1),
      new Uint8Array(32),
      u16(0x0018),
      u16(0xffff),
      esds,
    ]);
    var stsd = box('stsd', [fullBox(0, 0, [u32(1), mp4v])]);
    var stbl = box('stbl', [
      stsd,
      box('stts', [fullBox(0, 0, [u32(0)])]),
      box('stsc', [fullBox(0, 0, [u32(0)])]),
      box('stsz', [fullBox(0, 0, [u32(0), u32(0)])]),
      box('stco', [fullBox(0, 0, [u32(0)])]),
    ]);
    var vmhd = box('vmhd', [fullBox(0, 1, [u16(0), u16(0), u16(0), u16(0)])]);
    var dref = box('dref', [fullBox(0, 0, [u32(1), box('url ', [fullBox(0, 1)])])]);
    var dinf = box('dinf', [dref]);
    var minf = box('minf', [vmhd, dinf, stbl]);
    var mdia = box('mdia', [mdhd, hdlr, minf]);
    var trak = box('trak', [tkhd, mdia]);
    var moov = box('moov', [mvhd, trak]);
    var mdat = box('mdat', []);
    return concatBytes([ftyp, moov, mdat]);
  }

  /** EBML/WebM: header + Segment(Info, Tracks) with a 2×2 V_VP8 track, no clusters. */
  function makeWebmPlaceholder(width, height) {
    width = width || 2;
    height = height || 2;

    function vint(value, length) {
      var out = new Uint8Array(length);
      for (var i = length - 1; i >= 0; i--) {
        out[i] = value & 0xff;
        value = Math.floor(value / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
    function ebmlId(id) {
      var bytes = [];
      var v = id;
      while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      }
      return new Uint8Array(bytes);
    }
    function el(id, payload) {
      return concatBytes([ebmlId(id), vint(payload.length, 4), payload]);
    }
    function uintEl(id, value) {
      var bytes = [];
      var v = value;
      do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      } while (v > 0);
      return el(id, new Uint8Array(bytes));
    }
    function floatEl(id, value) {
      var b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, value, false);
      return el(id, b);
    }
    function stringEl(id, text) {
      return el(id, asciiBytes(text));
    }

    var ebml = el(0x1a45dfa3, concatBytes([
      uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8),
      stringEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2),
    ]));
    var info = el(0x1549a966, concatBytes([
      uintEl(0x2ad7b1, 1000000), floatEl(0x4489, 0.0), stringEl(0x7ba9, 'silksong-placeholder'),
    ]));
    var video = el(0xe0, concatBytes([uintEl(0xb0, width), uintEl(0xba, height)]));
    var trackEntry = el(0xae, concatBytes([
      uintEl(0xd7, 1),
      uintEl(0x73c5, 1),
      uintEl(0x83, 1),
      stringEl(0x86, 'V_VP8'),
      uintEl(0x23e383, 1000000000),
      video,
    ]));
    var tracks = el(0x1654ae6b, trackEntry);
    var segment = el(0x18538067, concatBytes([info, tracks]));
    return concatBytes([ebml, segment]);
  }

  var placeholderCache = {};

  /** The placeholder container for a kind of video, built once and kept. */
  function placeholderVideoBytes(kind) {
    var key = kind === 'webm' ? 'webm' : 'mp4';
    if (!placeholderCache[key]) {
      placeholderCache[key] = key === 'webm' ? makeWebmPlaceholder() : makeMp4Placeholder();
    }
    return placeholderCache[key];
  }

  // The same extensions and names the build pipeline uses to spot a video
  // inside the data archive (tools/unity-webdata.mjs → looksLikeVideo).
  var VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|avi|ogv|mpg|mpeg)$/;
  var VIDEO_NAME = /^(movie|cinematic|cutscene|video|intro)[_/-]/i;
  var VIDEO_SEGMENTS = [
    'video', 'videos', 'cutscene', 'cutscenes', 'intro', 'intros',
    'cinematic', 'cinematics', 'movie', 'movies',
  ];
  // …but never a Unity asset bundle that happens to be called "video_*".
  // A false positive here is not a black cutscene, it is a missing game
  // asset, so the name rule below only fires for a file that has no
  // extension at all.
  var NOT_VIDEO_EXTENSIONS = [
    '.bundle', '.bin', '.resource', '.assets', '.dat', '.json', '.bytes',
    '.hash', '.xml', '.txt', '.config', '.manifest', '.unity3d', '.resS',
    '.scene', '.prefab', '.shader', '.png', '.jpg', '.jpeg', '.wav', '.ogg',
  ];

  function extensionOf(name) {
    var at = String(name || '').lastIndexOf('.');
    return at < 0 ? '' : String(name).slice(at).toLowerCase();
  }

  /** Is this URL path a cutscene rather than an ordinary asset? */
  function isVideoPath(pathname) {
    var lower = decodePath(String(pathname || '')).toLowerCase();
    var segments = lower.split('/');
    var last = segments.length - 1;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (!segment) continue;
      if (i === last) {
        if (VIDEO_EXTENSIONS.test(segment)) return true;
        var extension = extensionOf(segment);
        if (extension) continue;                 // a named asset is not a video
        if (VIDEO_NAME.test(segment)) return true;
      } else if (VIDEO_SEGMENTS.indexOf(segment) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** The kind of container to answer a video request with. */
  function videoKindFor(pathname) {
    var lower = decodePath(String(pathname || '')).toLowerCase();
    if (/\.(webm|ogv|ogg)$/.test(lower)) return 'webm';
    if (/\.(mp4|mov|m4v|avi|mpg|mpeg)$/.test(lower)) return 'mp4';
    return 'mp4';
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

  function rangeResponse(blob, rangeHeader, contentType) {
    var headers = new Headers({
      'Content-Type': contentType || 'application/octet-stream',
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
    var onVideo = options.onVideo || function () {};
    // Optional: hand the placeholder bytes to the page so it can stage them
    // in Unity's own heap (see play.html → stageInWasmHeap).
    var stageBytes = typeof options.stageBytes === 'function' ? options.stageBytes : null;
    var bypassVideos = options.bypassVideos !== false;
    // The cutscenes that were left out of the archive. A video that is
    // called something else than a video is only known by its name here.
    var videoNames = Object.create(null);
    (options.videoNames || []).forEach(function (name) {
      if (name) videoNames[String(name).toLowerCase()] = true;
    });

    target.fetch = function (input, init) {
      var rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      if (!rawUrl) return previous(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var pathname = rawUrl;
      try {
        pathname = new URL(rawUrl, (typeof location !== 'undefined' && location.href) || 'https://silksong.invalid/').pathname;
      } catch (e) {
        pathname = String(rawUrl).split('?')[0].split('#')[0];
      }

      // Cutscenes never reach the network and never reach the ZIP: the
      // placeholder container is answered straight away, so a phone never
      // has to hold a high-definition video in memory.
      var isCutscene = isVideoPath(pathname) || videoNames[basename(decodePath(pathname)).toLowerCase()];
      if (bypassVideos && (method === 'GET' || method === 'HEAD') && isCutscene) {
        var kind = videoKindFor(pathname);
        var bytes = placeholderVideoBytes(kind);
        var contentType = kind === 'webm' ? 'video/webm' : 'video/mp4';
        onVideo(pathname, bytes.length);
        if (method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 200,
            headers: new Headers({
              'Content-Type': contentType,
              'Content-Length': String(bytes.length),
              'Accept-Ranges': 'bytes',
            }),
          }));
        }
        var videoRange = null;
        try {
          var videoHeaders = new Headers((init && init.headers) || (input && input.headers) || undefined);
          videoRange = videoHeaders.get('range');
        } catch (e) {}
        var body = bytes;
        if (stageBytes) {
          var staged = stageBytes(bytes);
          if (staged && staged.length === bytes.length) body = staged;
        }
        return Promise.resolve(rangeResponse(new Blob([body], { type: contentType }), videoRange, contentType));
      }

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
    planArchive: planArchive,
    openArchive: openArchive,
    installFetchMount: installFetchMount,
    // Exported for the test suite and for anything that wants to build the
    // same placeholder container the build pipeline writes.
    makePlaceholderVideo: function (kind) {
      return kind === 'webm' ? makeWebmPlaceholder() : makeMp4Placeholder();
    },
    isVideoPath: isVideoPath,
    videoKindFor: videoKindFor,
  };
});
