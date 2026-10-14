#!/usr/bin/env node
/* ============================================================================
 * verify-build.mjs — "is the game data actually there, and is it the right one?"
 * ----------------------------------------------------------------------------
 *   node web/tools/verify-build.mjs [--out web] [--quick] [--json]
 *
 * Checks, in order:
 *
 *   1. the manifest parses and its arithmetic adds up (parts → totals);
 *   2. every chunk file exists and is exactly the size the manifest claims;
 *   3. every chunk hashes to the sha256 in the manifest        (--quick skips);
 *   4. the *assembled* data really is a UnityWebData1.0 archive: the header and
 *      the whole file table are read back across the chunk boundaries and every
 *      entry is checked to point inside the archive;
 *   5. the assembled wasm really is a wasm module (magic + parses);
 *   6. the loader/framework/StreamingAssets are present, and whether the
 *      room-audio patch is in the framework;
 *   7. the page's own assets (play.html, js/*) are all present.
 *
 * Exit code 0 = everything checks out, 1 = something is wrong (details printed).
 * ==========================================================================*/

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseHeader, MAGIC_BYTES } from './unity-webdata.mjs';
import { validate as validateWasm } from './wasm-module.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

const USAGE = `Usage: node web/tools/verify-build.mjs [--out <web dir>] [--quick] [--json]

  --out <dir>   folder holding Build/build-manifest.json (default: web/)
  --quick       skip the per-chunk sha256 (sizes and headers are still checked)
  --json        print the report as JSON
`;

function parseArgs(argv) {
  const args = { out: WEB_ROOT, quick: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out': args.out = path.resolve(argv[++i]); break;
      case '--quick': args.quick = true; break;
      case '--json': args.json = true; break;
      case '-h': case '--help': args.help = true; break;
      default: throw new Error('unknown option ' + argv[i] + '\n' + USAGE);
    }
  }
  return args;
}

/**
 * Read a byte range out of the assembled file, transparently crossing chunk
 * boundaries. `parts` is `[{ file, bytes }]` in order.
 */
export async function readAssembled(parts, offset, length) {
  const out = Buffer.alloc(length);
  let written = 0;
  let at = offset;
  for (const part of parts) {
    if (written >= length) break;
    if (at >= part.bytes) {
      at -= part.bytes;
      continue;
    }
    const skip = at;
    const want = Math.min(length - written, part.bytes - skip);
    const fh = await fsp.open(part.file, 'r');
    try {
      const buf = Buffer.alloc(want);
      const read = await fh.read(buf, 0, want, skip);
      buf.copy(out, written, 0, read.bytesRead);
      written += read.bytesRead;
    } finally {
      await fh.close();
    }
    at = 0;
  }
  return out.subarray(0, written);
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024);
    let at = 0;
    const stat = await fh.stat();
    while (at < stat.size) {
      const read = await fh.read(buf, 0, Math.min(buf.length, stat.size - at), at);
      if (read.bytesRead === 0) break;
      hash.update(buf.subarray(0, read.bytesRead));
      at += read.bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

export async function verifyBuild(outDir, opts = {}) {
  const report = { ok: true, outDir, manifest: null, datasets: {}, unity: {}, page: {}, problems: [], notes: [] };
  const fail = (msg) => {
    report.ok = false;
    report.problems.push(msg);
  };

  const manifestFile = path.join(outDir, 'Build', 'build-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  } catch (e) {
    fail('no readable Build/build-manifest.json in ' + outDir + ' — run prepare-build.mjs first');
    return report;
  }
  report.manifest = { buildId: manifest.buildId, name: manifest.name, partBytes: manifest.partBytes, generatedAt: manifest.generatedAt };

  if (manifest.schema !== 2) fail('unknown manifest schema ' + manifest.schema + ' (this tool writes schema 2)');

  for (const [key, set] of Object.entries(manifest.datasets || {})) {
    const info = { total: set.total, parts: [], ok: true };
    let sum = 0;
    for (const part of set.parts || []) {
      const file = path.join(outDir, ...part.path.split('/'));
      const entry = { file: part.path, expected: part.bytes };
      try {
        const stat = await fsp.stat(file);
        entry.actual = stat.size;
        if (stat.size !== part.bytes) {
          entry.ok = false;
          info.ok = false;
          fail(part.path + ' is ' + stat.size + ' bytes, the manifest says ' + part.bytes);
        } else if (!opts.quick && part.sha256) {
          const digest = await hashFile(file);
          entry.sha256 = digest === part.sha256 ? 'ok' : 'MISMATCH';
          if (digest !== part.sha256) {
            entry.ok = false;
            info.ok = false;
            fail(part.path + ' does not hash to the manifest value (re-run prepare-build.mjs)');
          }
        }
        sum += stat.size;
      } catch (e) {
        entry.ok = false;
        info.ok = false;
        fail('missing chunk ' + part.path);
      }
      info.parts.push(entry);
    }
    if (sum !== set.total) {
      info.ok = false;
      fail(key + ': parts add up to ' + sum + ' but the manifest says ' + set.total);
    }
    info.bytes = sum;
    report.datasets[key] = info;
  }

  /* ---- the assembled data must still be a Unity archive ---- */
  const dataSet = manifest.datasets && manifest.datasets.data;
  if (dataSet) {
    const parts = (dataSet.parts || []).map((p) => ({ file: path.join(outDir, ...p.path.split('/')), bytes: p.bytes }));
    try {
      const magic = await readAssembled(parts, 0, MAGIC_BYTES.length + 8);
      if (!magic.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
        fail('the data chunks do not start with UnityWebData1.0');
      } else {
        const headerSize = magic.readUInt32LE(MAGIC_BYTES.length);
        const fileCount = magic.readUInt32LE(MAGIC_BYTES.length + 4);
        const tableLength = Math.min(headerSize, 8 * 1024 * 1024);
        const table = await readAssembled(parts, 0, tableLength);
        const header = parseHeader((o, l) => table.subarray(o, o + l), dataSet.total);
        report.datasets.data.archive = { headerSize: header.headerSize, entries: header.fileCount };
        report.notes.push('data: ' + header.fileCount + ' archive entries, header ' + headerSize + ' bytes');
        if (header.fileCount !== fileCount) fail('the archive file count changed while reading it back');
        const biggest = header.entries.reduce((a, e) => (e.size > a.size ? e : a), { size: 0, path: '' });
        report.notes.push('data: largest entry ' + biggest.path + ' (' + (biggest.size / 1048576).toFixed(1) + ' MB)');
        const videos = (manifest.report && manifest.report.videos) || null;
        if (videos) {
          report.notes.push('data: ' + videos.replaced + ' videos replaced, ' + videos.truncated + ' truncated (' + (videos.savedBytes / 1048576).toFixed(1) + ' MB saved)');
        }
      }
    } catch (err) {
      fail('could not read the assembled data: ' + ((err && err.message) || err));
    }
  }

  /* ---- the assembled wasm must parse ---- */
  const wasmSet = manifest.datasets && manifest.datasets.wasm;
  if (wasmSet) {
    const parts = (wasmSet.parts || []).map((p) => ({ file: path.join(outDir, ...p.path.split('/')), bytes: p.bytes }));
    if (wasmSet.total <= 128 * 1024 * 1024) {
      try {
        const whole = await readAssembled(parts, 0, wasmSet.total);
        const check = validateWasm(whole);
        report.datasets.wasm.module = check.summary ? { functions: check.summary.functionCount, version: check.summary.version } : null;
        if (!check.ok) fail('the assembled wasm does not parse: ' + check.detail);
      } catch (err) {
        fail('could not read the assembled wasm: ' + ((err && err.message) || err));
      }
    } else {
      const head = await readAssembled(parts, 0, 8);
      if (head.readUInt32LE(0) !== 0x6d736100) fail('the wasm chunks do not start with the wasm magic');
    }
  }

  /* ---- entry points ---- */
  for (const [key, rel] of Object.entries({
    loader: manifest.unity && manifest.unity.loader,
    framework: manifest.unity && manifest.unity.framework,
  })) {
    if (!rel) {
      fail('the manifest does not name the ' + key);
      continue;
    }
    try {
      const text = await fsp.readFile(path.join(outDir, ...rel.split('/')), 'utf8');
      report.unity[key] = { bytes: text.length, present: true };
      if (key === 'loader' && !text.includes('createUnityInstance')) fail('the loader has no createUnityInstance');
      if (key === 'framework') {
        const patched = text.includes('mediaElement.src=""');
        report.unity.framework.audioPatch = patched;
        report.notes.push('framework: room-audio release patch ' + (patched ? 'applied' : 'NOT applied (see BUILD.md §4)'));
      }
    } catch (e) {
      fail('missing ' + rel);
    }
  }
  try {
    const entries = await fsp.readdir(path.join(outDir, 'StreamingAssets'));
    report.unity.streamingAssets = { files: entries.length };
  } catch (e) {
    fail('missing StreamingAssets/');
  }

  /* ---- the page itself (lives next to this tool, not in the build output) ---- */
  const pageDir = opts.pageDir || WEB_ROOT;
  for (const rel of ['play.html', 'index.html', 'js/stream.js', 'js/writer.js', 'js/manifest.js', 'js/save-codec.js', 'js/boss-scenes.js']) {
    try {
      const stat = await fsp.stat(path.join(pageDir, ...rel.split('/')));
      report.page[rel] = stat.size;
    } catch (e) {
      fail('the page is incomplete: ' + rel + ' is missing');
    }
  }

  const dataMb = report.datasets.data ? report.datasets.data.bytes / 1048576 : 0;
  const wasmMb = report.datasets.wasm ? report.datasets.wasm.bytes / 1048576 : 0;
  report.totals = { mb: Math.round((dataMb + wasmMb) * 10) / 10, chunks: Object.values(report.datasets).reduce((a, d) => a + d.parts.length, 0) };
  report.notes.push('total to stream: ' + report.totals.mb + ' MB in ' + report.totals.chunks + ' chunks');
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const report = await verifyBuild(args.out, { quick: args.quick });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('verifying ' + args.out);
    report.notes.forEach((n) => console.log('  · ' + n));
    Object.entries(report.datasets).forEach(([key, info]) => {
      console.log('  ' + key + ': ' + info.parts.length + ' chunks, ' + (info.bytes / 1048576).toFixed(1) + ' MB — ' + (info.ok ? 'ok' : 'PROBLEMS'));
    });
    report.problems.forEach((p) => console.log('  ! ' + p));
    console.log(report.ok ? '\n✓ the build is complete and matches the manifest' : '\n✗ ' + report.problems.length + ' problem(s) — see above');
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('verify-build failed: ' + ((err && err.stack) || err));
    process.exitCode = 1;
  });
}

export { USAGE };
