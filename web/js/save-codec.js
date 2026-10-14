/* ============================================================================
 * save-codec.js — Silksong save-file codec (user1.dat … user8.dat)
 * ----------------------------------------------------------------------------
 * The game stores a save as a `BinaryFormatter`-serialised single string, and
 * that string is `Base64(AES-256-ECB-PKCS7(UTF-8(JSON)))`. Writing one string
 * with BinaryFormatter produces a fixed byte layout, so the format can be read
 * and written without BinaryFormatter:
 *
 *   00                  SerializationHeaderRecord
 *   01 00 00 00         rootId = 1
 *   ff ff ff ff         headerId = -1
 *   01 00 00 00         majorVersion = 1
 *   00 00 00 00         minorVersion = 0
 *   06                  BinaryObjectString
 *   01 00 00 00         objectId = 1
 *   <7-bit varint>      byte length of the base64 text
 *   <base64 bytes>
 *   0b                  MessageEnd
 *
 * The AES key is the hard-coded one both Team Cherry games use:
 * `UKu52ePUBwetZ9wNX88o54dnfKRu0T1l` (see mods/boss-rush/tools/SaveCodec.ps1,
 * which this file mirrors byte for byte).
 *
 * Exposed as `window.SKSaveCodec` (or `require('./save-codec.js')` in Node):
 *   decodeDat(bytes)  -> save JSON string      (throws if it is not a save)
 *   encodeDat(json)   -> Uint8Array            (.dat container bytes)
 *   findSave(bytes)   -> save JSON string|null (tolerant sniffing)
 *   gunzip(bytes)     -> Uint8Array            (for the repo's *.json.gz)
 * ==========================================================================*/

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * AES-256-ECB
   * ------------------------------------------------------------------ */

  // 'UKu52ePUBwetZ9wNX88o54dnfKRu0T1l'
  var AES_KEY = new Uint8Array([
    85, 75, 117, 53, 50, 101, 80, 85, 66, 119, 101, 116, 90, 57, 119, 78,
    88, 56, 56, 111, 53, 52, 100, 110, 102, 75, 82, 117, 48, 84, 49, 108,
  ]);

  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);
  var RCON = new Uint32Array(15);
  var MUL2 = new Uint8Array(256);
  var MUL3 = new Uint8Array(256);
  var MUL9 = new Uint8Array(256);
  var MUL11 = new Uint8Array(256);
  var MUL13 = new Uint8Array(256);
  var MUL14 = new Uint8Array(256);

  function xtime(x) {
    return ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
  }
  function rot8(b, n) {
    return ((b << n) | (b >>> (8 - n))) & 0xff;
  }

  (function buildTables() {
    var log = new Uint8Array(256);
    var exp = new Uint8Array(256);
    var x = 1;
    var i;
    for (i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      x = (x ^ xtime(x)) & 0xff; // generator 3
    }
    exp[255] = exp[0];
    SBOX[0] = 0x63;
    for (i = 1; i < 256; i++) {
      var b = exp[255 - log[i]]; // multiplicative inverse
      b = (b ^ rot8(b, 1) ^ rot8(b, 2) ^ rot8(b, 3) ^ rot8(b, 4) ^ 0x63) & 0xff;
      SBOX[i] = b;
      INV_SBOX[b] = i;
    }
    for (i = 1; i < 15; i++) RCON[i] = RCON[i - 1] ? xtime(RCON[i - 1]) : 1;
    for (i = 0; i < 256; i++) {
      MUL2[i] = xtime(i);
      MUL3[i] = xtime(i) ^ i;
    }
    for (i = 0; i < 256; i++) {
      var m8 = MUL2[MUL2[MUL2[i]]];
      var m4 = MUL2[MUL2[i]];
      MUL9[i] = m8 ^ i;
      MUL11[i] = m8 ^ MUL2[i] ^ i;
      MUL13[i] = m8 ^ m4 ^ i;
      MUL14[i] = m8 ^ m4 ^ MUL2[i];
    }
  })();

  function subWord(x) {
    return (
      (SBOX[(x >>> 24) & 0xff] << 24) |
      (SBOX[(x >>> 16) & 0xff] << 16) |
      (SBOX[(x >>> 8) & 0xff] << 8) |
      SBOX[x & 0xff]
    ) | 0;
  }

  function expandKey(keyBytes) {
    var w = new Uint32Array(60);
    var i;
    for (i = 0; i < 8; i++) {
      w[i] = ((keyBytes[4 * i] << 24) | (keyBytes[4 * i + 1] << 16) | (keyBytes[4 * i + 2] << 8) | keyBytes[4 * i + 3]) | 0;
    }
    for (i = 8; i < 60; i++) {
      var t = w[i - 1];
      if (i % 8 === 0) t = (subWord(((t << 8) | (t >>> 24)) | 0) ^ (RCON[i / 8] << 24)) | 0;
      else if (i % 8 === 4) t = subWord(t);
      w[i] = (w[i - 8] ^ t) | 0;
    }
    return w;
  }

  var ROUND_KEYS = expandKey(AES_KEY); // the key never changes: expand once

  function keyByte(round, i) {
    return (ROUND_KEYS[round * 4 + (i >> 2)] >>> ((3 - (i & 3)) * 8)) & 0xff;
  }

  function shiftRowsSub(s, box, inverse) {
    var t = new Uint8Array(16);
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        t[4 * c + r] = box[s[4 * ((c + (inverse ? 4 - r : r)) & 3) + r]];
      }
    }
    s.set(t);
  }

  function mixColumns(s) {
    for (var c = 0; c < 4; c++) {
      var i = 4 * c;
      var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = MUL2[a0] ^ MUL3[a1] ^ a2 ^ a3;
      s[i + 1] = a0 ^ MUL2[a1] ^ MUL3[a2] ^ a3;
      s[i + 2] = a0 ^ a1 ^ MUL2[a2] ^ MUL3[a3];
      s[i + 3] = MUL3[a0] ^ a1 ^ a2 ^ MUL2[a3];
    }
  }

  function invMixColumns(s) {
    for (var c = 0; c < 4; c++) {
      var i = 4 * c;
      var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = MUL14[a0] ^ MUL11[a1] ^ MUL13[a2] ^ MUL9[a3];
      s[i + 1] = MUL9[a0] ^ MUL14[a1] ^ MUL11[a2] ^ MUL13[a3];
      s[i + 2] = MUL13[a0] ^ MUL9[a1] ^ MUL14[a2] ^ MUL11[a3];
      s[i + 3] = MUL11[a0] ^ MUL13[a1] ^ MUL9[a2] ^ MUL14[a3];
    }
  }

  function addRoundKey(s, round) {
    for (var i = 0; i < 16; i++) s[i] ^= keyByte(round, i);
  }

  function encryptBlock(input, output, offset) {
    var s = new Uint8Array(16);
    for (var i = 0; i < 16; i++) s[i] = input[offset + i];
    addRoundKey(s, 0);
    for (var r = 1; r < 14; r++) {
      shiftRowsSub(s, SBOX, false);
      mixColumns(s);
      addRoundKey(s, r);
    }
    shiftRowsSub(s, SBOX, false);
    addRoundKey(s, 14);
    output.set(s, offset);
  }

  function decryptBlock(input, output, offset) {
    var s = new Uint8Array(16);
    for (var i = 0; i < 16; i++) s[i] = input[offset + i];
    addRoundKey(s, 14);
    for (var r = 13; r >= 1; r--) {
      shiftRowsSub(s, INV_SBOX, true);
      addRoundKey(s, r);
      invMixColumns(s);
    }
    shiftRowsSub(s, INV_SBOX, true);
    addRoundKey(s, 0);
    output.set(s, offset);
  }

  function ecbEncrypt(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var off = 0; off < bytes.length; off += 16) encryptBlock(bytes, out, off);
    return out;
  }

  function ecbDecrypt(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var off = 0; off < bytes.length; off += 16) decryptBlock(bytes, out, off);
    return out;
  }

  function pkcs7Pad(bytes) {
    var pad = 16 - (bytes.length % 16);
    var out = new Uint8Array(bytes.length + pad);
    out.set(bytes);
    for (var i = bytes.length; i < out.length; i++) out[i] = pad;
    return out;
  }

  function pkcs7Unpad(bytes) {
    var pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || bytes.length < pad) throw new Error('bad pkcs7 padding');
    return bytes.subarray(0, bytes.length - pad);
  }

  /* ------------------------------------------------------------------ *
   * base64 / UTF-8 helpers
   * ------------------------------------------------------------------ */

  function b64ToBytes(text) {
    text = String(text).replace(/[\s\r\n]+/g, '');
    var bin = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  }

  function utf8Encode(text) {
    return new TextEncoder().encode(text);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  /* ------------------------------------------------------------------ *
   * .dat container
   * ------------------------------------------------------------------ */

  // 00 | rootId 1 | headerId -1 | major 1 | minor 0 | 0x06 | objectId 1
  var HEADER = new Uint8Array([0, 1, 0, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 0, 0, 0, 0, 6, 1, 0, 0, 0]);
  var PAYLOAD_OFFSET = HEADER.length; // 7-bit varint length starts here
  var GZIP_MAGIC = [0x1f, 0x8b];

  function looksLikeDat(bytes) {
    if (!bytes || bytes.length < HEADER.length + 20) return false;
    for (var i = 0; i < HEADER.length; i++) {
      if (bytes[i] !== HEADER[i]) return false;
    }
    return true;
  }

  function looksLikeGzip(bytes) {
    return !!bytes && bytes.length > 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
  }

  /* Parse the container, AES-decrypt and JSON-validate. Throws on anything that
   * is not a Silksong save. */
  function decodeDat(bytes) {
    if (!bytes || bytes.length < 64) throw new Error('save file is too short');
    var p = PAYLOAD_OFFSET;
    var len = 0;
    var shift = 0;
    var count = 0;
    while (p < bytes.length - 1) {
      var b = bytes[p++];
      count++;
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (count > 5) throw new Error('bad length-prefixed string');
    }
    if (p + len > bytes.length) throw new Error('truncated base64 payload');
    var b64 = '';
    for (var q = p; q < p + len; q += 0x8000) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(q, Math.min(q + 0x8000, p + len)));
    }
    var cipher = b64ToBytes(b64);
    if (!cipher.length || (cipher.length & 15) !== 0) throw new Error('payload is not AES-sized');
    var plain = ecbDecrypt(cipher);
    var json;
    try {
      json = utf8Decode(pkcs7Unpad(plain));
    } catch (e) {
      json = utf8Decode(plain); // be forgiving about padding from other tools
    }
    try {
      JSON.parse(json);
      return json;
    } catch (e) {
      /* fall through: maybe there is a trailing byte */
    }
    var end = json.lastIndexOf('}');
    if (end > 0) {
      var trimmed = json.slice(0, end + 1);
      JSON.parse(trimmed);
      return trimmed;
    }
    throw new Error('decrypted payload is not a save');
  }

  function varint(n) {
    var out = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>= 7;
    }
    out.push(n);
    return out;
  }

  function encodeDat(json) {
    if (typeof json !== 'string') json = JSON.stringify(json);
    JSON.parse(json); // fail early on malformed saves
    var cipher = ecbEncrypt(pkcs7Pad(utf8Encode(json)));
    var b64 = bytesToB64(cipher);
    var lps = varint(b64.length);
    var out = new Uint8Array(HEADER.length + lps.length + b64.length + 1);
    var p = 0;
    var i;
    for (i = 0; i < HEADER.length; i++) out[p++] = HEADER[i];
    for (i = 0; i < lps.length; i++) out[p++] = lps[i];
    for (i = 0; i < b64.length; i++) out[p++] = b64.charCodeAt(i);
    out[p] = 0x0b;
    return out;
  }

  /** Decrypt a bare base64 payload (no container). */
  function decodePayloadB64(b64) {
    var cipher = b64ToBytes(b64);
    if (!cipher.length || (cipher.length & 15) !== 0) throw new Error('payload is not AES-sized');
    var json = utf8Decode(pkcs7Unpad(ecbDecrypt(cipher)));
    JSON.parse(json);
    return json;
  }

  /**
   * Tolerant sniffing: find the save JSON inside .dat bytes, plain JSON, bare
   * base64, an HTML page wrapping any of those, or a gzip stream (the shape
   * mods/boss-rush stores its prepared saves in).
   */
  function findSave(bytes) {
    if (!bytes || !bytes.length) throw new Error('empty file');
    var err = null;
    try {
      return decodeDat(bytes); // 1) the normal container
    } catch (e) {
      err = e;
    }

    var text = utf8Decode(bytes);
    var trimmed = text.replace(/^[\ufeff\s]+/, '');
    if (trimmed.charAt(0) === '{') {
      JSON.parse(trimmed); // 2) a plain, unencrypted save
      return trimmed;
    }
    try {
      return decodePayloadB64(trimmed); // 3) bare base64 ciphertext
    } catch (e) {
      /* keep scanning */
    }

    // 4) inside HTML/text (a save editor download is often wrapped in a page,
    //    and Safari renames it to userN.dat.html). 32 characters of base64 is
    //    the shortest ciphertext worth trying: a save is far bigger, but a
    //    hand-made test save is not, and the decrypt below is the real check.
    var runs = text.match(/[A-Za-z0-9+/]{32,}={0,2}/g) || [];
    for (var i = 0; i < runs.length && i < 25; i++) {
      try {
        return decodePayloadB64(runs[i]);
      } catch (e) {
        /* next candidate */
      }
    }
    throw err || new Error('not a Silksong save file');
  }

  /** Same as findSave, but unwraps a `.json.gz` first when gzip is available. */
  async function findSaveOrGzip(bytes) {
    if (looksLikeGzip(bytes)) {
      var plain = await gunzip(bytes);
      return findSave(plain);
    }
    return findSave(bytes);
  }

  /**
   * gzip decompression without a dependency: DecompressionStream is in Safari
   * 16.4+, Chrome 80+, Firefox 113+; Node has it since 18.
   */
  async function gunzip(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser cannot unpack .json.gz (Safari 16.4+ needed) — use a .dat save');
    }
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  var codec = {
    VERSION: '1.0.0',
    HEADER: HEADER,
    looksLikeDat: looksLikeDat,
    looksLikeGzip: looksLikeGzip,
    decodeDat: decodeDat,
    encodeDat: encodeDat,
    findSave: findSave,
    findSaveOrGzip: findSaveOrGzip,
    gunzip: gunzip,
    _internals: {
      ecbEncrypt: ecbEncrypt,
      ecbDecrypt: ecbDecrypt,
      pkcs7Pad: pkcs7Pad,
      pkcs7Unpad: pkcs7Unpad,
      expandKey: expandKey,
      SBOX: SBOX,
      INV_SBOX: INV_SBOX,
      AES_KEY: AES_KEY,
      roundKeys: ROUND_KEYS,
    },
  };

  global.SKSaveCodec = codec;
  if (typeof module === 'object' && module.exports) module.exports = codec;
})(typeof window !== 'undefined' ? window : globalThis);
