/* ============================================================================
 * zip-plan.js — read a remote ZIP's index and plan a smaller copy of it
 * ----------------------------------------------------------------------------
 * The problem
 *   The community build ships its Addressables as one 1.94 GiB ZIP, split
 *   into 100 files. Downloading all of it is 1986.6 MB on the wire and the
 *   same again on the device, and a good part of it is the high-definition
 *   cutscenes — the one thing in the archive a phone can never hold.
 *
 * What this module does
 *   A ZIP is a sequence of *local records* (a header plus the compressed
 *   data) followed by a *central directory* that says where every entry
 *   lives. The central directory sits at the end of the file, so it can be
 *   read with two small range requests before a single byte of the archive
 *   is downloaded:
 *
 *     1. read the last 64 KB      → the end-of-central-directory record
 *     2. read the directory       → every entry: name, sizes, offset
 *
 *   From that index we know exactly which bytes belong to which file, so we
 *   can download only the entries that are worth having and write a *new*,
 *   smaller ZIP: the local records we kept, copied verbatim, followed by a
 *   fresh central directory (with the offsets moved) and a fresh end record.
 *
 *   The bytes of a kept entry are copied as they are — the compressed data
 *   is not touched, so nothing is re-compressed and nothing can go wrong
 *   with the payload. Only the directory is rewritten.
 *
 *   The parts of the archive that are skipped are the cutscenes (served to
 *   Unity as a blank placeholder instead) and any bundle that belongs to
 *   another platform (a WebGL build never loads one).
 *
 * Everything here is pure: the index is parsed from byte ranges, the plan
 * is a list of numbers, and the layout is a list of segments. The bytes
 * themselves are moved by js/stream.js, which knows how to resume.
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKZipPlan = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var SIG_EOCD64 = 0x06064b50;
  var SIG_LOCATOR64 = 0x07064b50;
  var ZIP64_EXTRA = 0x0001;
  var U32_MAX = 0xffffffff;
  var U16_MAX = 0xffff;
  // The biggest central directory worth reading (8 MB).
  var MAX_DIRECTORY = 8 * 1024 * 1024;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }
  function w16(v) {
    var b = new Uint8Array(2);
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
    return b;
  }
  function w32(v) {
    var b = new Uint8Array(4);
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
    b[2] = (v >>> 16) & 0xff;
    b[3] = (v >>> 24) & 0xff;
    return b;
  }
  function w64(v) {
    var b = new Uint8Array(8);
    var lo = v >>> 0;
    var hi = Math.floor(v / 4294967296);
    b[0] = lo & 0xff; b[1] = (lo >>> 8) & 0xff; b[2] = (lo >>> 16) & 0xff; b[3] = (lo >>> 24) & 0xff;
    b[4] = hi & 0xff; b[5] = (hi >>> 8) & 0xff; b[6] = (hi >>> 16) & 0xff; b[7] = (hi >>> 24) & 0xff;
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

  var utf8 = null;
  function decodeName(bytes, utf8Flag) {
    try {
      if (!utf8) utf8 = new TextDecoder('utf-8', { fatal: false });
      return utf8.decode(bytes);
    } catch (e) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  /* ---------------------------------------------------------------- *
   * The end-of-central-directory record
   * ---------------------------------------------------------------- */

  /** Find the EOCD record in the tail of a ZIP. */
  function findEocd(bytes) {
    for (var i = bytes.length - 22; i >= 0; i--) {
      if (u32(bytes, i) !== SIG_EOCD) continue;
      var comment = u16(bytes, i + 20);
      if (i + 22 + comment === bytes.length) return i;
    }
    return -1;
  }

  function parseEocd(bytes, at) {
    return {
      disk: u16(bytes, at + 4),
      cdDisk: u16(bytes, at + 6),
      entriesOnDisk: u16(bytes, at + 8),
      entries: u16(bytes, at + 10),
      cdSize: u32(bytes, at + 12),
      cdOffset: u32(bytes, at + 16),
      commentLength: u16(bytes, at + 20),
      zip64: false,
    };
  }

  /* ---------------------------------------------------------------- *
   * The central directory
   * ---------------------------------------------------------------- */

  /**
   * Parse the central directory into a list of entries.
   *
   * Every entry keeps the bytes of its own directory record, because that
   * record is copied into the new archive verbatim — only the "relative
   * offset of the local header" field is rewritten.
   */
  function parseCentralDirectory(bytes, baseOffset) {
    var entries = [];
    var at = 0;
    while (at + 46 <= bytes.length) {
      if (u32(bytes, at) !== SIG_CENTRAL) break;
      var entry = {
        flags: u16(bytes, at + 8),
        method: u16(bytes, at + 10),
        crc: u32(bytes, at + 16),
        compSize: u32(bytes, at + 20),
        uncompSize: u32(bytes, at + 24),
        nameLength: u16(bytes, at + 28),
        extraLength: u16(bytes, at + 30),
        commentLength: u16(bytes, at + 32),
        diskStart: u16(bytes, at + 34),
        localOffset: u32(bytes, at + 42),
        recordAt: baseOffset + at,
        recordLength: 46 + u16(bytes, at + 28) + u16(bytes, at + 30) + u16(bytes, at + 32),
        name: '',
        // Where the 8-byte local offset lives inside the Zip64 extra field,
        // when the entry uses one.
        zip64OffsetAt: -1,
        zip64ExtraAt: -1,
        zip64ExtraSize: 0,
      };
      var nameStart = at + 46;
      var extraStart = nameStart + entry.nameLength;
      entry.name = decodeName(bytes.subarray(nameStart, extraStart), !!(entry.flags & 0x800));
      applyZip64(bytes, extraStart, entry.extraLength, entry);
      entries.push(entry);
      at = extraStart + entry.extraLength + entry.commentLength;
    }
    return entries;
  }

  /**
   * The Zip64 extra field holds the values that did not fit into 32 bits,
   * in a fixed order, and only for the fields that overflowed.
   */
  function applyZip64(bytes, extraStart, extraLength, entry) {
    var at = 0;
    var end = extraStart + extraLength;
    while (at + 4 <= extraLength) {
      var id = u16(bytes, extraStart + at);
      var size = u16(bytes, extraStart + at + 2);
      if (at + 4 + size > extraLength) break;
      if (id === ZIP64_EXTRA) {
        var p = extraStart + at + 4;
        if (entry.uncompSize === U32_MAX) { entry.uncompSize = u64(bytes, p); p += 8; }
        if (entry.compSize === U32_MAX) { entry.compSize = u64(bytes, p); p += 8; }
        if (entry.localOffset === U32_MAX) {
          entry.localOffset = u64(bytes, p);
          entry.zip64OffsetAt = p - (extraStart + at + 4);   // inside the Zip64 body
          entry.zip64ExtraAt = at;                            // inside the extra field
          entry.zip64ExtraSize = size;
          p += 8;
        }
        if (entry.diskStart === U16_MAX) { entry.diskStart = u16(bytes, p); p += 4; }
      }
      at += 4 + size;
    }
  }

  /* ---------------------------------------------------------------- *
   * Reading the index of a remote ZIP
   * ---------------------------------------------------------------- */

  /**
   * Read the central directory of a ZIP through a range reader.
   *
   * `reader` is anything with `read(offset, length) -> Promise<Uint8Array>`
   * and a `total` size. Returns null when the archive is not something we
   * understand — the caller then falls back to downloading it whole.
   */
  async function readIndex(reader) {
    var total = reader.total;
    if (!total || total < 22) return null;

    var tailLength = Math.min(total, 66000);
    var tail = await reader.read(total - tailLength, tailLength);
    var eocdAt = findEocd(tail);
    if (eocdAt < 0) return null;
    var eocd = parseEocd(tail, eocdAt);
    var eocdOffset = total - tailLength + eocdAt;

    // A 64-bit archive keeps the real numbers in a Zip64 record that sits
    // just before the end-of-central-directory one.
    if (eocd.cdOffset === U32_MAX || eocd.cdSize === U32_MAX || eocd.entries === U16_MAX) {
      if (eocdOffset < 20) return null;
      var locator = await reader.read(eocdOffset - 20, 20);
      if (u32(locator, 0) !== SIG_LOCATOR64) return null;
      var zip64Offset = u64(locator, 8);
      if (zip64Offset + 56 > total) return null;
      var zip64 = await reader.read(zip64Offset, 56);
      if (u32(zip64, 0) !== SIG_EOCD64) return null;
      eocd.entries = u64(zip64, 32);
      eocd.entriesOnDisk = u64(zip64, 24);
      eocd.cdSize = u64(zip64, 40);
      eocd.cdOffset = u64(zip64, 48);
      eocd.zip64 = true;
    }

    if (eocd.disk !== 0 || eocd.cdDisk !== 0) return null;   // a split archive: no
    if (!eocd.cdSize || !eocd.cdOffset) return null;
    if (eocd.cdOffset + eocd.cdSize > total) return null;
    // The directory is read on every launch, so it has to stay small. An
    // archive with a huge directory is rare, and downloading it whole is
    // better than reading a hundred megabytes of index first.
    if (eocd.cdSize > MAX_DIRECTORY) return null;

    var directory = await reader.read(eocd.cdOffset, eocd.cdSize);
    var entries = parseCentralDirectory(directory, eocd.cdOffset);
    if (!entries.length) return null;

    var index = {
      total: total,
      entries: entries,
      cdOffset: eocd.cdOffset,
      cdSize: eocd.cdSize,
      cdBytes: directory,
      eocd: eocd,
      eocdOffset: eocdOffset,
      // The bytes between the last entry and the directory: padding, but
      // it belongs to nobody.
      directoryEnd: eocd.cdOffset + eocd.cdSize,
    };
    assignRecordEnds(index);
    return index;
  }

  /**
   * Work out where each entry's local record ends.
   *
   * The local records are written one after another, so the record of an
   * entry reaches up to the entry that follows it — and the last one
   * reaches up to the central directory.
   */
  function assignRecordEnds(index) {
    var byOffset = index.entries.slice().sort(function (a, b) { return a.localOffset - b.localOffset; });
    for (var i = 0; i < byOffset.length; i++) {
      byOffset[i].recordEnd = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : index.directoryEnd;
    }
    return index;
  }

  /* ---------------------------------------------------------------- *
   * What to keep and what to drop
   * ---------------------------------------------------------------- */

  // The cutscenes. A high-definition video is the one thing in the
  // archive that a phone can never hold, and the page serves a blank
  // container in its place (see community-build.js → installFetchMount).
  var VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|avi|ogv|mpg|mpeg)$/i;
  var VIDEO_PREFIX = /^(movie|cinematic|cutscene|video|intro)[_/-]/i;
  var VIDEO_FOLDERS = [
    'video', 'videos', 'cutscene', 'cutscenes', 'intro', 'intros',
    'cinematic', 'cinematics', 'movie', 'movies',
  ];

  /** Is this archive entry a cutscene? */
  function isVideoEntry(name) {
    var lower = String(name || '').toLowerCase();
    if (VIDEO_EXTENSION.test(lower)) return true;
    var parts = lower.split('/');
    for (var i = 0; i < parts.length - 1; i++) {
      if (VIDEO_FOLDERS.indexOf(parts[i]) >= 0) return true;
    }
    var last = parts[parts.length - 1];
    if (last && last.indexOf('.') < 0 && VIDEO_PREFIX.test(last)) return true;
    return false;
  }

  /**
   * Is this archive entry a bundle for another platform?
   *
   * A WebGL build only ever loads its own `aa/WebGL/…` bundles, so the
   * others are dead weight. The rule is deliberately narrow: it only fires
   * for an `aa/<platform>/…` path whose platform is not WebGL.
   */
  function isOtherPlatformEntry(name) {
    var match = /^aa\/([^/]+)\//i.exec(String(name || ''));
    return !!match && match[1].toLowerCase() !== 'webgl';
  }

  /**
   * Decide what to keep.
   *
   * `opts.skip(name, entry)` decides and says why: it returns a short
   * reason ('video', 'other') for an entry that goes, and nothing for one
   * that stays. By default the cutscenes and the other platforms' bundles
   * go.
   */
  function planEntries(index, opts) {
    opts = opts || {};
    var skip = opts.skip || function (name) {
      if (isVideoEntry(name)) return 'video';
      if (isOtherPlatformEntry(name)) return 'other';
      return '';
    };
    assignRecordEnds(index);
    var kept = [];
    var skipped = [];
    var keptBytes = 0;
    var skippedBytes = 0;
    index.entries.forEach(function (entry) {
      var reason = skip(entry.name, entry);
      if (reason) {
        entry.skipReason = reason;
        skipped.push(entry);
      } else {
        kept.push(entry);
      }
    });
    kept.forEach(function (entry) { keptBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    skipped.forEach(function (entry) { skippedBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    return {
      kept: kept,
      skipped: skipped,
      keptBytes: keptBytes,
      skippedBytes: skippedBytes,
    };
  }

  /* ---------------------------------------------------------------- *
   * What a name cannot say
   *
   * A name is a hint. The bytes are the proof: a Unity asset bundle
   * starts with "UnityFS" and a video with "ftyp" (MP4) or the WebM
   * magic. So the entries that are big enough to be a cutscene are
   * looked at — a few bytes at the start of their data — and the ones
   * that really are a video are left out, whatever they are called.
   * ---------------------------------------------------------------- */

  // The smallest entry worth looking at (a cutscene is never small).
  var MIN_SNIFF_BYTES = 1024 * 1024;
  // How many entries to look at at most: the ones that are left are the
  // smaller ones, and a cutscene that small is not worth the trouble.
  var MAX_SNIFFS = 300;

  /**
   * Read the first bytes of an entry's data and say whether it is a video.
   *
   * The data starts after the local header, whose length is only known
   * once the header has been read — so the header is read first.
   *
   * The bytes may be compressed (a bundle is deflated, a video usually is
   * not), so a deflated entry is inflated for a moment before it is
   * looked at.
   */
  async function isVideoBytes(entry, reader) {
    var head;
    try {
      head = await reader.read(entry.localOffset, Math.min(256, reader.total - entry.localOffset));
    } catch (error) {
      return false;
    }
    if (head.length < 30 || u32(head, 0) !== SIG_LOCAL) return false;
    var nameLength = u16(head, 26);
    var extraLength = u16(head, 28);
    var dataAt = 30 + nameLength + extraLength;
    if (dataAt + 12 > head.length) {
      try {
        head = await reader.read(entry.localOffset, dataAt + 16);
      } catch (error) {
        return false;
      }
    }
    if (head.length < dataAt + 12) return false;
    var bytes = head.subarray(dataAt, dataAt + 16);
    var method = u16(head, 8);
    if (method === 8) {
      // Deflated: the magic is only there once the data is unpacked.
      var plain = await inflateHead(head.subarray(dataAt, Math.min(head.length, dataAt + 512)));
      if (!plain) return false;
      bytes = plain;
    } else if (method !== 0) {
      return false;   // some other compression: do not guess
    }
    if (bytes.length < 12) return false;
    // MP4: "....ftyp"
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
    // WebM / Matroska: the EBML magic
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    return false;
  }

  /**
   * Unpack the beginning of a deflate stream.
   *
   * The stream is cut short on purpose: all that is wanted is the first
   * few bytes, and the rest of a two hundred megabyte video is of no
   * interest here.
   */
  async function inflateHead(bytes) {
    if (typeof DecompressionStream === 'undefined' || !bytes.length) return null;
    var out = null;
    try {
      var stream = new DecompressionStream('deflate-raw');
      var writer = stream.writable.getWriter();
      var reader = stream.readable.getReader();
      var reading = (async function () {
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          if (!out) out = new Uint8Array(0);
          out = concatBytes([out, chunk.value]);
          if (out.length >= 32) break;
        }
        return out;
      })();
      writer.write(bytes).catch(function () {});
      writer.close().catch(function () {});
      var result = await reading;
      return result && result.length ? result : null;
    } catch (error) {
      return out && out.length ? out : null;
    }
  }

  /**
   * Plan what to keep, looking at the bytes of the big entries as well.
   *
   * `opts.minBytes`  — how big an entry has to be to be looked at
   * `opts.maxSniffs` — how many entries are looked at at most
   */
  async function planEntriesAsync(index, reader, opts) {
    opts = opts || {};
    var plan = planEntries(index, opts);
    var minBytes = opts.minBytes === undefined ? MIN_SNIFF_BYTES : opts.minBytes;
    var maxSniffs = opts.maxSniffs === undefined ? MAX_SNIFFS : opts.maxSniffs;

    // The entries that are big enough to be a cutscene, largest first.
    var candidates = plan.kept
      .filter(function (entry) { return Math.max(entry.compSize, entry.uncompSize) >= minBytes; })
      .sort(function (a, b) { return b.compSize - a.compSize; })
      .slice(0, maxSniffs);

    var found = [];
    var index2 = 0;
    async function worker() {
      for (;;) {
        var at = index2++;
        if (at >= candidates.length) return;
        var entry = candidates[at];
        if (await isVideoBytes(entry, reader)) found.push(entry);
      }
    }
    var workers = [];
    var wanted = Math.min(8, candidates.length);
    for (var w = 0; w < wanted; w++) workers.push(worker());
    await Promise.all(workers);

    if (!found.length) {
      plan.sniffedNames = [];
      return plan;
    }

    // Move the entries that turned out to be videos over to the skipped
    // side and count the bytes again.
    plan.kept = plan.kept.filter(function (entry) { return found.indexOf(entry) < 0; });
    found.forEach(function (entry) { entry.skipReason = 'video'; });
    plan.skipped = plan.skipped.concat(found);
    plan.keptBytes = 0;
    plan.skippedBytes = 0;
    plan.kept.forEach(function (entry) { plan.keptBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    plan.skipped.forEach(function (entry) { plan.skippedBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    plan.sniffed = candidates.length;
    plan.sniffedNames = found.map(function (entry) { return entry.name; });
    return plan;
  }

  /**
   * Apply a remembered list of cutscenes to a plan.
   *
   * Looking at the bytes of every big file in the archive takes a few
   * hundred requests, and the answer never changes for a given build — so
   * it is looked at once and then remembered.
   */
  function applySniffed(plan, index, names) {
    if (!names || !names.length) return plan;
    var known = Object.create(null);
    names.forEach(function (name) { known[name] = true; });
    var found = plan.kept.filter(function (entry) { return known[entry.name]; });
    if (!found.length) return plan;
    plan.kept = plan.kept.filter(function (entry) { return found.indexOf(entry) < 0; });
    found.forEach(function (entry) { entry.skipReason = 'video'; });
    plan.skipped = plan.skipped.concat(found);
    plan.keptBytes = 0;
    plan.skippedBytes = 0;
    plan.kept.forEach(function (entry) { plan.keptBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    plan.skipped.forEach(function (entry) { plan.skippedBytes += Math.max(0, entry.recordEnd - entry.localOffset); });
    return plan;
  }

  /* ---------------------------------------------------------------- *
   * The new archive
   * ---------------------------------------------------------------- */

  /**
   * Build the layout of the smaller archive.
   *
   * The new file is: the local records we kept (copied verbatim, in the
   * order they had in the source), then a fresh central directory, then a
   * fresh end-of-central-directory record. The directory records are the
   * originals with one field changed: where their local record now lives.
   */
  function buildLayout(plan, index) {
    var kept = plan.kept.slice().sort(function (a, b) { return a.localOffset - b.localOffset; });
    if (!kept.length) return null;

    // The local records, back to back, and the offset each one lands at.
    var records = [];
    var outOffset = 0;
    for (var i = 0; i < kept.length; i++) {
      var entry = kept[i];
      var start = entry.localOffset;
      var end = entry.recordEnd;
      if (!(end > start)) return null;
      records.push({ entry: entry, sourceStart: start, sourceEnd: end, outStart: outOffset, length: end - start });
      outOffset += end - start;
    }

    // The new central directory: the original records, with the local
    // header offset rewritten.
    var directory = [];
    for (i = 0; i < kept.length; i++) {
      var record = index.cdBytes.subarray(
        kept[i].recordAt - index.cdOffset,
        kept[i].recordAt - index.cdOffset + kept[i].recordLength
      );
      var copy = new Uint8Array(record);
      var at = kept[i].recordAt - index.cdOffset;
      if (copy.length >= 46 && u32(copy, 0) === SIG_CENTRAL) {
        if (kept[i].zip64OffsetAt >= 0) {
          // The offset lives in the Zip64 extra field.
          var extraStart = 46 + kept[i].nameLength;
          var bodyAt = extraStart + kept[i].zip64ExtraAt + 4 + kept[i].zip64OffsetAt;
          if (bodyAt + 8 <= copy.length) {
            var v = w64(records[i].outStart);
            copy.set(v, bodyAt);
          }
        } else {
          copy.set(w32(records[i].outStart), 42);
        }
      }
      directory.push(copy);
    }
    var cdBytes = concatBytes(directory);

    // The end-of-central-directory record.
    var eocd = buildEocd(kept.length, cdBytes.length, outOffset, index.eocd.zip64);
    var outputSize = outOffset + cdBytes.length + eocd.length;

    return {
      records: records,
      cdBytes: cdBytes,
      eocdBytes: eocd,
      outputSize: outputSize,
      downloadBytes: outOffset,
    };
  }

  function buildEocd(entries, cdSize, cdOffset, zip64) {
    var needsZip64 = entries > U16_MAX || cdSize > U32_MAX || cdOffset > U32_MAX;
    if (!needsZip64 && !zip64) {
      return concatBytes([
        w32(SIG_EOCD),
        w16(0), w16(0),
        w16(entries), w16(entries),
        w32(cdSize), w32(cdOffset),
        w16(0),
      ]);
    }
    // A Zip64 end record, its locator, and a stub end record that points
    // at it (the classic "0xffff / 0xffffffff" markers).
    var zip64 = concatBytes([
      w32(SIG_EOCD64),
      w64(44),                 // the size of the rest of this record
      w16(45), w16(45),        // version made by / needed
      w32(0), w32(0),          // disk numbers
      w64(entries), w64(entries),
      w64(cdSize), w64(cdOffset),
    ]);
    var locator = concatBytes([
      w32(SIG_LOCATOR64),
      w32(0),                  // the disk with the Zip64 end record
      w64(cdOffset + cdSize),  // where it is
      w32(1),                  // the number of disks
    ]);
    var eocd = concatBytes([
      w32(SIG_EOCD),
      w16(0), w16(0),
      w16(U16_MAX), w16(U16_MAX),
      w32(U32_MAX), w32(U32_MAX),
      w16(0),
    ]);
    return concatBytes([zip64, locator, eocd]);
  }

  /**
   * Turn the layout into the segments the downloader moves.
   *
   * A segment is either a range of one of the source files (`url`,
   * `rangeStart`, `rangeEnd`) or a block of bytes we already have (`data`).
   * `outOffset` is where the bytes land in the new file.
   *
   * The segments are merged as much as they can be: two pieces that follow
   * each other in the source *and* in the new file become one request, so
   * the download still takes about as many round trips as the archive has
   * parts — not one per file inside it.
   */
  function buildSegments(layout, parts) {
    var segments = [];
    var starts = [];
    var total = 0;
    parts.forEach(function (part) {
      starts.push(total);
      total += part.bytes || 0;
    });

    function partFor(offset) {
      for (var i = parts.length - 1; i >= 0; i--) {
        if (offset >= starts[i]) return i;
      }
      return -1;
    }

    function push(index, sourceStart, sourceEnd, outStart) {
      var last = segments[segments.length - 1];
      if (last && !last.data && last.part === index && last.sourceEnd === sourceStart && last.outEnd === outStart) {
        last.sourceEnd = sourceEnd;
        last.rangeEnd = sourceEnd - starts[index];
        last.bytes = last.rangeEnd - last.rangeStart;
        last.outEnd = outStart + (sourceEnd - sourceStart);
        return;
      }
      segments.push({
        url: parts[index].url,
        part: index,
        sourceStart: sourceStart,
        sourceEnd: sourceEnd,
        rangeStart: sourceStart - starts[index],
        rangeEnd: sourceEnd - starts[index],
        bytes: sourceEnd - sourceStart,
        outOffset: outStart,
        outEnd: outStart + (sourceEnd - sourceStart),
      });
    }

    layout.records.forEach(function (record) {
      var at = record.sourceStart;
      while (at < record.sourceEnd) {
        var index = partFor(at);
        if (index < 0) throw new Error('offset ' + at + ' is outside the archive');
        var end = Math.min(record.sourceEnd, starts[index] + parts[index].bytes);
        push(index, at, end, record.outStart + (at - record.sourceStart));
        at = end;
      }
    });

    // The new directory, which we already have in memory.
    var tail = concatBytes([layout.cdBytes, layout.eocdBytes]);
    segments.push({
      data: tail,
      bytes: tail.length,
      outOffset: layout.outputSize - tail.length,
    });

    return segments;
  }

  /* ---------------------------------------------------------------- *
   * A range reader over a ZIP that is split into files
   * ---------------------------------------------------------------- */

  /**
   * Read bytes out of an archive that is stored as a list of files.
   *
   * The reader asks for byte ranges; a server that honours `Range` sends
   * only those bytes, and one that does not sends the whole file, in which
   * case the reader takes the part it needs and says so (`ranges` becomes
   * false) — the caller can then decide that the saving is not worth it.
   */
  function createReader(parts, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetchImpl || function (url, o) { return fetch(url, o); };
    var starts = [];
    var total = 0;
    parts.forEach(function (part) {
      starts.push(total);
      total += part.bytes || 0;
    });
    var ranges = true;

    function partFor(offset) {
      for (var i = parts.length - 1; i >= 0; i--) {
        if (offset >= starts[i]) return i;
      }
      return -1;
    }

    async function readPiece(index, from, to) {
      var part = parts[index];
      var rangeStart = from - starts[index];
      var rangeEnd = to - starts[index];
      var want = rangeEnd - rangeStart;
      var headers = {};
      if (want > 0) headers.Range = 'bytes=' + rangeStart + '-' + (rangeEnd - 1);
      var res = await fetchImpl(part.url, { headers: headers, signal: opts.signal, cache: 'default' });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + part.url);
      var whole = res.status !== 206;
      if (whole) ranges = false;
      if (!res.body) {
        var buffer = new Uint8Array(await res.arrayBuffer());
        return whole ? buffer.subarray(rangeStart, rangeEnd) : buffer;
      }
      var reader = res.body.getReader();
      var out = new Uint8Array(want);
      var at = 0;
      var skip = whole ? rangeStart : 0;
      try {
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          var value = chunk.value;
          if (!value || !value.byteLength) continue;
          if (skip > 0) {
            if (value.byteLength <= skip) { skip -= value.byteLength; continue; }
            value = value.subarray(skip);
            skip = 0;
          }
          var take = Math.min(value.byteLength, want - at);
          if (take > 0) {
            out.set(value.subarray(0, take), at);
            at += take;
          }
          if (at >= want) break;
        }
      } finally {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
      }
      if (at < want) throw new Error('short read: ' + at + '/' + want + ' bytes');
      return out;
    }

    return {
      total: total,
      parts: parts,
      get ranges() { return ranges; },
      async read(offset, length) {
        if (!length) return new Uint8Array(0);
        var out = new Uint8Array(length);
        var at = 0;
        while (at < length) {
          var pos = offset + at;
          var index = partFor(pos);
          if (index < 0) throw new Error('offset ' + pos + ' is outside the archive');
          var end = Math.min(offset + length, starts[index] + parts[index].bytes);
          var piece = await readPiece(index, pos, end);
          out.set(piece, at);
          at += piece.length;
        }
        return out;
      },
    };
  }

  return {
    // The pieces, exported so the test suite can check them one by one.
    findEocd: findEocd,
    parseEocd: parseEocd,
    parseCentralDirectory: parseCentralDirectory,
    readIndex: readIndex,
    planEntries: planEntries,
    planEntriesAsync: planEntriesAsync,
    applySniffed: applySniffed,
    isVideoBytes: isVideoBytes,
    buildLayout: buildLayout,
    buildSegments: buildSegments,
    buildEocd: buildEocd,
    createReader: createReader,
    isVideoEntry: isVideoEntry,
    isOtherPlatformEntry: isOtherPlatformEntry,
    // A tiny helper for the tests: the number of entries a ZIP holds.
    countEntries: function (bytes) {
      var eocdAt = findEocd(bytes);
      if (eocdAt < 0) return -1;
      return parseEocd(bytes, eocdAt).entries;
    },
  };
});
