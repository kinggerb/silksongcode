/* ============================================================================
 * unity-webdata.mjs — read, rewrite and prune a Unity WebGL `.data` archive
 * ----------------------------------------------------------------------------
 * A Unity WebGL build packs every game resource into one `UnityWebData1.0`
 * archive. The layout is:
 *
 *   "UnityWebData1.0\0"           16 bytes, magic + NUL
 *   u32 headerSize                byte offset of the file table (LE)
 *   u32 fileCount
 *   repeat fileCount times:
 *     u32 offset                  relative to headerSize
 *     u32 size                    byte length of the payload
 *     u32 pathLength              byte length of the path (no NUL)
 *     path                        UTF-8, e.g. "sharedassets229.resource"
 *   <padding> then the payloads, each at headerSize + offset
 *
 * Why this file exists in this repo: Silksong's cutscenes are the single
 * biggest thing in the archive that a tablet never needs. Each video entry is
 * replaced with a tiny placeholder (`shorten cutscene videos to short black
 * videos`), the index is rewritten with the new sizes and offsets, and the
 * archive is rebuilt — the game still finds every file it asks for; the videos
 * play as black frames and the download shrinks by hundreds of MB.
 *
 * Everything here is byte-level and streams to disk: a 1 GB archive is never
 * held in memory twice.
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAGIC = 'UnityWebData1.0';
export const MAGIC_BYTES = Buffer.from(MAGIC + '\0', 'latin1'); // 16 bytes

/* ---------------------------------------------------------------- *
 * Placeholder videos
 * ---------------------------------------------------------------- */

/**
 * Build a tiny, structurally valid, codec-empty video container.
 *
 * `mp4` — ISO BMFF with a single zero-sample 2×2 video track (`mp4v`, 30 fps,
 *         1 s). No decoder is needed to parse it, so it costs ~500 bytes and a
 *         VideoPlayer that opens it immediately reaches the end: the cutscene
 *         renders as black.
 * `webm` — EBML header + Segment(Info, Tracks with a 2×2 V_VP8 track) and no
 *         clusters: the same idea for builds whose videos are WebM.
 *
 * Both are *containers only*. If a build's player refuses them, use
 * `--video-strategy truncate`, which keeps the real container header and cuts
 * the payload short instead (see prepare-build.mjs).
 */
export function makePlaceholderVideo(kind = 'mp4', opts = {}) {
  const width = opts.width || 2;
  const height = opts.height || 2;
  if (kind === 'webm') return makeWebmPlaceholder(width, height);
  return makeMp4Placeholder(width, height, opts.timescale || 30, opts.duration || 1);
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}
function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff, 0);
  return b;
}

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);
}

function fullBox(version, flags, ...parts) {
  const head = Buffer.concat([Buffer.from([version]), Buffer.from([(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff])]);
  return Buffer.concat([head, ...parts]);
}

/** A minimal but structurally complete MP4 with a video track that has no samples. */
export function makeMp4Placeholder(width = 2, height = 2, timescale = 30, duration = 1) {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isomiso2mp41', 'latin1'));
  const mvhd = box(
    'mvhd',
    fullBox(
      0,
      0,
      u32(0), // creation time
      u32(0), // modification time
      u32(timescale),
      u32(duration * timescale),
      u32(0x00010000), // rate 1.0
      u16(0x0100), // volume 1.0
      u16(0), // reserved
      u32(0), u32(0), // reserved
      u32(0x00010000), u32(0), u32(0), // matrix
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
      u32(2) // next track id
    )
  );

  const tkhd = box(
    'tkhd',
    fullBox(
      0,
      7, // enabled | in movie | in preview
      u32(0),
      u32(0),
      u32(1), // track id
      u32(0),
      u32(duration * timescale),
      u32(0), u32(0),
      u16(0), // layer
      u16(0), // alternate group
      u16(0), // volume (0 for video)
      u16(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(width << 16),
      u32(height << 16)
    )
  );

  const mdhd = box('mdhd', fullBox(0, 0, u32(0), u32(0), u32(timescale), u32(duration * timescale), u16(0x55c4), u16(0)));
  const hdlr = box('hdlr', fullBox(0, 0, u32(0), Buffer.from('vide', 'latin1'), u32(0), u32(0), u32(0), Buffer.from('VideoHandler\0', 'latin1')));

  const esds = box(
    'esds',
    fullBox(
      0,
      0,
      Buffer.from([0x03, 0x19, 0x00, 0x01, 0x00]), // ES_Descriptor, ES_ID 1
      Buffer.from([0x04, 0x11, 0x40, 0x15]), // DecoderConfigDescriptor: MPEG-4 Visual, streamType 5
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x05, 0x02, 0x12, 0x10]), // DecoderSpecificInfo (visual object type)
      Buffer.from([0x06, 0x01, 0x02]) // SLConfigDescriptor
    )
  );
  const mp4v = box(
    'mp4v',
    Buffer.alloc(6), // reserved
    u16(1), // data reference index
    u16(0), u16(0), u16(0), // pre_defined / reserved
    u32(0), u32(0), u32(0), // pre_defined
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    u32(0), u16(1), // reserved, frame count
    Buffer.alloc(32), // compressor name
    u16(0x0018), // depth
    u16(0xffff), // pre_defined = -1
    esds
  );
  const stsd = box('stsd', fullBox(0, 0, u32(1), mp4v));
  const stbl = box('stbl', stsd, box('stts', fullBox(0, 0, u32(0))), box('stsc', fullBox(0, 0, u32(0))), box('stsz', fullBox(0, 0, u32(0), u32(0))), box('stco', fullBox(0, 0, u32(0))));
  const vmhd = box('vmhd', fullBox(0, 1, u16(0), u16(0), u16(0), u16(0)));
  const dref = box('dref', fullBox(0, 0, u32(1), box('url ', fullBox(0, 1))));
  const dinf = box('dinf', dref);
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const moov = box('moov', mvhd, trak);
  const mdat = box('mdat');
  return Buffer.concat([ftyp, moov, mdat]);
}

/** EBML/WebM: header + Segment(Info, Tracks) with a 2×2 V_VP8 track, no clusters. */
export function makeWebmPlaceholder(width = 2, height = 2) {
  const vint = (value, length) => {
    const out = Buffer.alloc(length);
    for (let i = length - 1; i >= 0; i--) {
      out[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    out[0] |= 1 << (8 - length);
    return out;
  };
  const ebmlId = (id) => {
    const bytes = [];
    let v = id;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
    return Buffer.from(bytes);
  };
  const el = (id, payload) => Buffer.concat([ebmlId(id), vint(payload.length, 4), payload]);
  const uintEl = (id, value) => {
    const bytes = [];
    let v = value;
    do {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    return el(id, Buffer.from(bytes));
  };
  const floatEl = (id, value) => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(value, 0);
    return el(id, b);
  };
  const stringEl = (id, text) => el(id, Buffer.from(text, 'latin1'));

  const ebml = el(0x1a45dfa3, Buffer.concat([uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), stringEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2)]));
  const info = el(0x1549a966, Buffer.concat([uintEl(0x2ad7b1, 1000000), floatEl(0x4489, 0.0), stringEl(0x7ba9, 'silksong-placeholder')]));
  const video = el(0xe0, Buffer.concat([uintEl(0xb0, width), uintEl(0xba, height)]));
  const trackEntry = el(
    0xae,
    Buffer.concat([
      uintEl(0xd7, 1), // TrackNumber
      uintEl(0x73c5, 1), // TrackUID
      uintEl(0x83, 1), // TrackType: video
      stringEl(0x86, 'V_VP8'), // CodecID
      uintEl(0x23e383, 1000000000), // DefaultDuration (1 ns)
      video,
    ])
  );
  const tracks = el(0x1654ae6b, trackEntry);
  const segment = el(0x18538067, Buffer.concat([info, tracks]));
  return Buffer.concat([ebml, segment]);
}

/* ---------------------------------------------------------------- *
 * Archive parsing
 * ---------------------------------------------------------------- */

export function isGzipOrZip(buf) {
  return (buf[0] === 0x1f && buf[1] === 0x8b) || (buf[0] === 0x50 && buf[1] === 0x4b);
}

/**
 * Parse only the header/directory of a `UnityWebData1.0` file.
 * `readAt(offset, length)` must return a Buffer (so this works for files,
 * streams and test fixtures alike).
 */
export function parseHeader(readAt, size) {
  const magic = readAt(0, MAGIC_BYTES.length);
  if (!magic.equals(MAGIC_BYTES)) {
    const hint = isGzipOrZip(magic)
      ? 'the file looks compressed (gzip/zip) — prepare-build.mjs needs the decompressed .data'
      : 'not a UnityWebData1.0 archive (magic is ' + JSON.stringify(magic.toString('latin1').slice(0, 16)) + ')';
    throw new Error(hint);
  }
  const headerSize = readAt(MAGIC_BYTES.length, 4).readUInt32LE(0);
  const fileCount = readAt(MAGIC_BYTES.length + 4, 4).readUInt32LE(0);
  if (headerSize < MAGIC_BYTES.length + 8 || headerSize > size) {
    throw new Error('bad header size ' + headerSize + ' for a file of ' + size + ' bytes');
  }
  if (fileCount > 2_000_000) throw new Error('unreasonable file count ' + fileCount);

  const tableBytes = readAt(MAGIC_BYTES.length + 8, Math.min(fileCount * 12 + 4 * 1024 * 1024, headerSize - MAGIC_BYTES.length - 8));
  const entries = [];
  let p = 0;
  for (let i = 0; i < fileCount; i++) {
    if (p + 12 > tableBytes.length) throw new Error('truncated file table at entry ' + i);
    const offset = tableBytes.readUInt32LE(p);
    const entrySize = tableBytes.readUInt32LE(p + 4);
    const pathLength = tableBytes.readUInt32LE(p + 8);
    p += 12;
    if (p + pathLength > tableBytes.length) throw new Error('truncated path at entry ' + i);
    const name = tableBytes.subarray(p, p + pathLength).toString('utf8');
    p += pathLength;
    if (offset + entrySize > size - headerSize) {
      throw new Error('entry "' + name + '" points past the end of the archive');
    }
    entries.push({ index: i, offset, size: entrySize, path: name });
  }
  return { headerSize, fileCount, entries, tableEnd: MAGIC_BYTES.length + 8 + p };
}

/** Open an archive from disk and read its directory. */
export async function openArchive(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    // The directory is at the front of the file: a few hundred KB at most, so
    // one read is enough and the payloads never have to be touched here.
    const headLength = Math.min(stat.size, 16 * 1024 * 1024);
    const head = Buffer.alloc(headLength);
    const read = await handle.read(head, 0, headLength, 0);
    const header = parseHeader((o, l) => head.subarray(o, o + l), stat.size);
    return { file, size: stat.size, header, handle };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** Read a single entry's payload. */
export async function readEntry(handle, headerSize, entry) {
  const buf = Buffer.alloc(entry.size);
  await handle.read(buf, 0, entry.size, headerSize + entry.offset);
  return buf;
}

/**
 * Rebuild an archive from a list of `{ path, data }` payloads.
 *
 * `align` keeps the payload alignment of the source archive (Unity pads the
 * directory with zeroes and some builds expect 16-byte alignment).
 * The directory is written first, then the payloads are streamed in order.
 */
export async function writeArchive(outFile, entries, opts = {}) {
  const align = opts.align || 4;
  const headerSize = alignUp(
    MAGIC_BYTES.length + 8 + entries.reduce((sum, e) => sum + 12 + Buffer.byteLength(e.path, 'utf8'), 0),
    align
  );

  const table = Buffer.alloc(headerSize - MAGIC_BYTES.length - 8);
  let p = 0;
  let offset = 0;
  const positions = [];
  for (const entry of entries) {
    const size = entry.data.length;
    const nameBytes = Buffer.from(entry.path, 'utf8');
    table.writeUInt32LE(offset, p);
    table.writeUInt32LE(size, p + 4);
    table.writeUInt32LE(nameBytes.length, p + 8);
    nameBytes.copy(table, p + 12);
    p += 12 + nameBytes.length;
    positions.push({ entry, offset });
    offset += size;
    const pad = alignUp(offset, align) - offset;
    offset += pad; // payloads keep the archive's alignment
  }

  const header = Buffer.alloc(MAGIC_BYTES.length + 8);
  MAGIC_BYTES.copy(header, 0);
  header.writeUInt32LE(headerSize, MAGIC_BYTES.length);
  header.writeUInt32LE(entries.length, MAGIC_BYTES.length + 4);

  const finalSize = headerSize + offset; // `offset` accumulated padding as well
  const out = await fsp.open(outFile, 'w');
  try {
    await out.write(header, 0, header.length, 0);
    await out.write(table, 0, table.length, header.length);
    for (const { entry, offset: at } of positions) {
      await out.write(entry.data, 0, entry.data.length, headerSize + at);
      const end = headerSize + at + entry.data.length;
      const paddedEnd = headerSize + alignUp(at + entry.data.length, align);
      if (paddedEnd > end) await out.write(Buffer.alloc(paddedEnd - end), 0, paddedEnd - end, end);
    }
    await out.truncate(finalSize);
  } finally {
    await out.close();
  }
  return { headerSize, size: finalSize };
}

function alignUp(value, align) {
  return Math.ceil(value / align) * align;
}

/**
 * Streaming rebuild: write a new archive where each entry's payload either
 * comes from the source archive (copied byte range) or is replacement data.
 *
 *   entries = [{ path, size, source?: { offset }, data?: Buffer, skip?: number }]
 *     • `source.offset` is relative to the *source* header size
 *     • `skip` drops the first N bytes of the source payload (truncation)
 *     • `data` are literal replacement bytes
 *
 * Peak memory stays at one copy buffer, so this works on a 1 GB archive.
 */
export async function rebuildArchive(opts) {
  const { fromFile, toFile, entries, align = 4, bufferBytes = 8 * 1024 * 1024, log = () => {} } = opts;
  const src = await fsp.open(fromFile, 'r');
  const stat = await src.stat();

  // Read the directory (it is always at the front of the file).
  const headLength = Math.min(stat.size, 16 * 1024 * 1024);
  const head = Buffer.alloc(headLength);
  await src.read(head, 0, headLength, 0);
  const parsed = parseHeader((o, l) => head.subarray(o, o + l), stat.size);
  const sourceHeaderSize = parsed.headerSize;

  const headerSize = alignUp(
    MAGIC_BYTES.length + 8 + entries.reduce((sum, e) => sum + 12 + Buffer.byteLength(e.path, 'utf8'), 0),
    align
  );

  const table = Buffer.alloc(headerSize - MAGIC_BYTES.length - 8);
  let p = 0;
  let offset = 0;
  const plan = [];
  for (const entry of entries) {
    const size = entry.size;
    const nameBytes = Buffer.from(entry.path, 'utf8');
    table.writeUInt32LE(offset, p);
    table.writeUInt32LE(size, p + 4);
    table.writeUInt32LE(nameBytes.length, p + 8);
    nameBytes.copy(table, p + 12);
    p += 12 + nameBytes.length;
    plan.push({ entry, at: offset });
    offset += alignUp(size, align);
  }
  const finalSize = headerSize + offset;

  const headerBytes = Buffer.alloc(MAGIC_BYTES.length + 8);
  MAGIC_BYTES.copy(headerBytes, 0);
  headerBytes.writeUInt32LE(headerSize, MAGIC_BYTES.length);
  headerBytes.writeUInt32LE(entries.length, MAGIC_BYTES.length + 4);

  const dst = await fsp.open(toFile, 'w');
  const copy = Buffer.alloc(bufferBytes);
  try {
    await dst.write(headerBytes, 0, headerBytes.length, 0);
    await dst.write(table, 0, table.length, headerBytes.length);

    let index = 0;
    for (const { entry, at } of plan) {
      const target = headerSize + at;
      if (entry.data) {
        await dst.write(entry.data, 0, entry.data.length, target);
      } else if (entry.source) {
        let remaining = entry.size;
        let position = sourceHeaderSize + entry.source.offset + (entry.skip || 0);
        let written = 0;
        while (remaining > 0) {
          const want = Math.min(copy.length, remaining);
          const read = await src.read(copy, 0, want, position);
          if (read.bytesRead === 0) throw new Error('source ended while copying "' + entry.path + '"');
          await dst.write(copy, 0, read.bytesRead, target + written);
          written += read.bytesRead;
          position += read.bytesRead;
          remaining -= read.bytesRead;
        }
      } else {
        await dst.write(Buffer.alloc(entry.size), 0, entry.size, target);
      }
      // pad to the alignment so the next payload starts where the table says
      const pad = alignUp(entry.size, align) - entry.size;
      if (pad > 0) await dst.write(Buffer.alloc(pad), 0, pad, target + entry.size);
      index++;
      if (index % 200 === 0) log('  rebuilt ' + index + '/' + entries.length + ' entries');
    }
    await dst.truncate(finalSize);
  } finally {
    await dst.close();
    await src.close();
  }
  return { headerSize, size: finalSize, entries: entries.length };
}

/** Heuristic: is this archive entry a video file? */
export function looksLikeVideo(name, head) {
  const lower = String(name).toLowerCase();
  if (/\.(mp4|webm|mov|m4v|avi|ogv|mpg|mpeg)$/.test(lower)) return true;
  if (/^(movie|cinematic|cutscene|video)[_/]/i.test(name)) return true;
  if (!head || head.length < 12) return false;
  // MP4: ....ftyp   /  WebM: 1a 45 df a3
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  return false;
}

/** What kind of video container is this? */
export function videoKind(head) {
  if (head && head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (head && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  return 'unknown';
}

export function human(bytes) {
  if (Math.abs(bytes) >= 1024 * 1024 * 1024) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (Math.abs(bytes) >= 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
  if (Math.abs(bytes) >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

export { path };
