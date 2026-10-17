#!/usr/bin/env node
/* ============================================================================
 * prepare-build.mjs — turn a Unity WebGL build into what the iPad page wants
 * ----------------------------------------------------------------------------
 *   node web/tools/prepare-build.mjs --build "path/to/Build" [--out web]
 *
 * What it does, in order (each step is skippable and reported):
 *
 *   1. CHECK      the input is really a Unity WebGL build: the loader exports
 *                 `createUnityInstance`, the framework is Unity's, the wasm
 *                 starts with `\0asm` and parses, the data file is a
 *                 `UnityWebData1.0` archive whose directory is readable.
 *   2. PRUNE      build junk that a browser never loads (`.symbols`, `.debug.wasm`,
 *                 `.map`, pre-compressed `.gz`/`.br` twins, `.unityweb`, old
 *                 `.bak` files, `TemplateData/` extras) is left out of `web/`.
 *   3. VIDEOS     every cutscene inside the data archive is replaced with a tiny
 *                 black placeholder (`blank`, ~600 bytes) or truncated to its
 *                 container header (`truncate`). This is the single biggest win
 *                 on an iPad — see the report it prints.
 *   4. PATCH      any documented wasm byte patch in `web/patches/*.json` is
 *                 applied *after verifying the original bytes* (see BUILD.md).
 *                 Typically: force `IsUnloadAssetsRequired` to true so room
 *                 transitions run `Resources.UnloadUnusedAssets`.
 *   5. CHUNK      the data and wasm are split into ~20 MB parts so the page can
 *                 stream them into OPFS one at a time (a few MB of RAM) instead
 *                 of building a multi-hundred-MB blob in memory.
 *   6. MANIFEST   `web/Build/build-manifest.json` records every part, its exact
 *                 size and digests (whole file, first/last 4 MB and per part),
 *                 which is what the page checks before and after loading.
 *
 * Nothing is ever modified in place: the source build is only read.
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openArchive, rebuildArchive, makePlaceholderVideo, videoKind, looksLikeVideo, human, MAGIC } from './unity-webdata.mjs';
import { validate as validateWasm, applyPatch, scanBooleanReturns, parseMemoryLimits } from './wasm-module.mjs';
import { PATCHES, patchFramework, WASM_PATCH_LIBRARY } from './patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

/* ---------------------------------------------------------------- *
 * Arguments
 * ---------------------------------------------------------------- */

const USAGE = `Usage: node web/tools/prepare-build.mjs --build <unity Build dir> [options]

  --build <dir>        Unity WebGL output folder (holds *.loader.js, *.framework.js,
                       *.wasm, *.data). Required unless --list-videos/--scan.
  --out <dir>          where the web build goes (default: web/)
  --name <name>        base name for the chunk files (default: silksong)
  --part-bytes <n>     chunk size for data + wasm (default: 20 MiB; accepts 20MB)
  --video-strategy <s> blank (default) | truncate | keep
  --video-keep-bytes   bytes kept per video with --video-strategy truncate (default 65536)
  --video-min-bytes    only touch video entries at least this big (default 65536)
  --prune <glob>       extra file glob to leave out of the output (repeatable)
  --keep <glob>        exception to the prune list (repeatable)
  --no-prune           keep everything
  --patch <file>       wasm patch file (default: web/patches/*.json when present)
  --no-patch           do not patch the wasm
  --align <n>          archive payload alignment (default: keep the source's)
  --no-full-hash       skip the whole-file sha256 (faster, weaker check)
  --list-videos        only list video entries in the data archive and exit
  --scan [wasm file]   list wasm functions that look like the unload/GC checks and exit
  --dry-run            do everything except writing to --out
  --json               print the report as JSON
`;

function parseArgs(argv) {
  const args = { prune: [], keep: [], partBytes: 20 * 1024 * 1024, videoStrategy: 'blank', videoKeepBytes: 65536, videoMinBytes: 65536, name: 'silksong', out: WEB_ROOT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--build': args.build = next(); break;
      case '--out': args.out = path.resolve(next()); break;
      case '--name': args.name = next(); break;
      case '--part-bytes': args.partBytes = parseSize(next()); break;
      case '--video-strategy': args.videoStrategy = next(); break;
      case '--video-keep-bytes': args.videoKeepBytes = parseSize(next()); break;
      case '--video-min-bytes': args.videoMinBytes = parseSize(next()); break;
      case '--prune': args.prune.push(next()); break;
      case '--keep': args.keep.push(next()); break;
      case '--no-prune': args.noPrune = true; break;
      case '--patch': args.patch = next(); break;
      case '--no-patch': args.noPatch = true; break;
      case '--align': args.align = Number(next()); break;
      case '--no-full-hash': args.noFullHash = true; break;
      case '--list-videos': args.listVideos = true; break;
      case '--scan': args.scan = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error('unknown option ' + a + '\n\n' + USAGE);
    }
  }
  return args;
}

export function parseSize(text) {
  const m = /^([\d.]+)\s*(k|kb|kib|m|mb|mib|g|gb|gib|b)?$/i.exec(String(text).trim());
  if (!m) throw new Error('cannot read a size from "' + text + '"');
  const value = parseFloat(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const factor = unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1048576 : unit.startsWith('g') ? 1073741824 : 1;
  return Math.round(value * factor);
}

/* ---------------------------------------------------------------- *
 * Step 1 — discovery + integrity check
 * ---------------------------------------------------------------- */

const JUNK = [
  '*.symbols', '*.wasm.map', '*.map', '*.debug.wasm', '*.debug.framework.js', '*.unityweb',
  '*.data.gz', '*.wasm.gz', '*.framework.js.gz', '*.loader.js.gz', '*.data.br', '*.wasm.br',
  '*.framework.js.br', '*.loader.js.br', '*.jsbr', '*.wasmbr', '*.sym', '*.pdb', '*.mdb',
  '*.bak', '*.orig', '*.rej', '*.log', '*~', '.DS_Store', 'Thumbs.db',
];

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function matchesAny(name, globs) {
  return globs.some((g) => globToRegExp(g).test(name));
}

export async function discover(buildDir) {
  const all = await fsp.readdir(buildDir, { withFileTypes: true });
  const files = all.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = all.filter((e) => e.isDirectory()).map((e) => e.name);

  const pick = (re) => files.filter((f) => re.test(f)).sort();
  const loader = pick(/\.loader\.js$/)[0] || pick(/^.*\.js$/).find((f) => /loader/i.test(f));
  const framework = pick(/\.framework\.js$/)[0];
  const wasm = pick(/\.wasm$/)[0] || pick(/\.wasm\.uncompressed$/)[0];
  const data = pick(/\.data$/)[0] || pick(/\.data\.uncompressed$/)[0];

  for (const [what, file] of [['loader', loader], ['framework', framework], ['wasm', wasm], ['data', data]]) {
    if (!file) {
      throw new Error(
        'no ' + what + ' file in ' + buildDir + ' (found: ' + files.join(', ') + ')\n' +
          'Point --build at the folder that Unity wrote to (the one with the .data file).'
      );
    }
  }
  return { buildDir, files, dirs, loader, framework, wasm, data };
}

export async function checkInput(found) {
  const report = { ok: true, problems: [], notes: [], files: {} };
  const read = (name, bytes = 4096) => {
    const fd = fs.openSync(path.join(found.buildDir, name), 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  };

  const loaderHead = read(found.loader, 512 * 1024);
  report.files.loader = { name: found.loader, hasCreateUnityInstance: loaderHead.includes('createUnityInstance') };
  if (!report.files.loader.hasCreateUnityInstance) {
    report.problems.push('the loader does not call createUnityInstance — is this a Unity WebGL build?');
  }

  const frameworkHead = read(found.framework, 256 * 1024);
  report.files.framework = { name: found.framework, looksUnity: /Unity|unityFramework|Module\./.test(frameworkHead.toString('latin1')) };
  if (!report.files.framework.looksUnity) report.problems.push('the framework js does not look like Unity output');

  const wasmBuf = await fsp.readFile(path.join(found.buildDir, found.wasm));
  const wasmCheck = validateWasm(wasmBuf);
  report.files.wasm = { name: found.wasm, size: wasmBuf.length, ...wasmCheck.summary, detail: wasmCheck.detail };
  if (!wasmCheck.ok) report.problems.push('the wasm module does not parse: ' + wasmCheck.detail);
  else report.notes.push('wasm: ' + wasmBuf.length + ' bytes, version ' + wasmCheck.summary.version + ', ' + wasmCheck.summary.functionCount + ' functions');

  const dataStat = await fsp.stat(path.join(found.buildDir, found.data));
  report.files.data = { name: found.data, size: dataStat.size };
  try {
    const archive = await openArchive(path.join(found.buildDir, found.data));
    report.files.data.entries = archive.header.fileCount;
    report.files.data.headerSize = archive.header.headerSize;
    report.notes.push('data: ' + human(dataStat.size) + ' archive with ' + archive.header.fileCount + ' entries');
    await archive.handle.close();
  } catch (err) {
    report.problems.push('the data file is not readable: ' + ((err && err.message) || err));
  }

  report.ok = report.problems.length === 0;
  return report;
}

/* ---------------------------------------------------------------- *
 * Step 3 — videos in the data archive
 * ---------------------------------------------------------------- */

async function surveyVideos(dataFile, opts = {}) {
  const archive = await openArchive(dataFile);
  const entries = archive.header.entries;
  const videos = [];
  const probe = Buffer.alloc(16);
  for (const entry of entries) {
    if (entry.size === 0) continue;
    await archive.handle.read(probe, 0, Math.min(16, entry.size), archive.header.headerSize + entry.offset);
    const head = probe.subarray(0, Math.min(16, entry.size));
    if (looksLikeVideo(entry.path, head) || (entry.size > (opts.minBytes || 0) && (videoKind(head) !== 'unknown'))) {
      videos.push({ ...entry, kind: videoKind(head), video: looksLikeVideo(entry.path, head) });
    }
  }
  // Videos can also be *inside* a bundle: report those without touching them.
  const bundles = entries.filter((e) => e.size > 64 * 1024 && !looksLikeVideo(e.path, null)).length;
  await archive.handle.close();
  return { archive: archive.header, videos, bundles };
}

function planVideoEntries(entries, videos, opts) {
  const byIndex = new Map(videos.map((v) => [v.index, v]));
  const out = [];
  const report = { replaced: 0, truncated: 0, kept: 0, savedBytes: 0, byKind: {}, examples: [] };
  for (const entry of entries) {
    const video = byIndex.get(entry.index);
    if (!video || opts.strategy === 'keep' || entry.size < opts.minBytes) {
      out.push({ path: entry.path, size: entry.size, source: { offset: entry.offset } });
      if (video) report.kept++;
      continue;
    }
    const kind = video.kind === 'unknown' ? 'mp4' : video.kind;
    report.byKind[kind] = (report.byKind[kind] || 0) + 1;
    if (opts.strategy === 'truncate') {
      const keep = Math.min(opts.keepBytes, entry.size);
      out.push({ path: entry.path, size: keep, source: { offset: entry.offset } });
      report.truncated++;
      report.savedBytes += entry.size - keep;
    } else {
      const placeholder = makePlaceholderVideo(kind);
      out.push({ path: entry.path, size: placeholder.length, data: placeholder });
      report.replaced++;
      report.savedBytes += entry.size - placeholder.length;
    }
    if (report.examples.length < 5) {
      report.examples.push(entry.path + ' (' + human(entry.size) + ' → ' + human(out[out.length - 1].size) + ')');
    }
  }
  return { entries: out, report };
}

/* ---------------------------------------------------------------- *
 * Step 5 — chunking
 * ---------------------------------------------------------------- */

export async function chunkFile(file, outDir, baseName, partBytes, log = () => {}) {
  const stat = await fsp.stat(file);
  const parts = [];
  const fh = await fsp.open(file, 'r');
  const buffer = Buffer.alloc(Math.min(partBytes, 8 * 1024 * 1024));
  try {
    let written = 0;
    let index = 0;
    while (written < stat.size) {
      index++;
      const target = Math.min(partBytes, stat.size - written);
      const partName = baseName + '.part' + index;
      const partPath = path.join(outDir, partName);
      const out = await fsp.open(partPath, 'w');
      const hash = crypto.createHash('sha256');
      try {
        let produced = 0;
        while (produced < target) {
          const want = Math.min(buffer.length, target - produced);
          const read = await fh.read(buffer, 0, want, written + produced);
          if (read.bytesRead === 0) throw new Error('source ended early at ' + (written + produced));
          await out.write(buffer, 0, read.bytesRead, produced);
          hash.update(buffer.subarray(0, read.bytesRead));
          produced += read.bytesRead;
        }
      } finally {
        await out.close();
      }
      parts.push({ path: 'Build/' + partName, bytes: target, sha256: hash.digest('hex') });
      written += target;
      log('  ' + partName + '  ' + human(target));
    }
    return { parts, total: stat.size };
  } finally {
    await fh.close();
  }
}

export async function digestFile(file, opts = {}) {
  const stat = await fsp.stat(file);
  const probe = opts.probeBytes || 4 * 1024 * 1024;
  const out = { size: stat.size, headSha256: null, tailSha256: null, sha256: null };
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(probe, stat.size));
    await fh.read(head, 0, head.length, 0);
    out.headSha256 = crypto.createHash('sha256').update(head).digest('hex');
    const tail = Buffer.alloc(Math.min(probe, stat.size));
    await fh.read(tail, 0, tail.length, Math.max(0, stat.size - tail.length));
    out.tailSha256 = crypto.createHash('sha256').update(tail).digest('hex');

    if (!opts.skipFull) {
      const hash = crypto.createHash('sha256');
      const buf = Buffer.alloc(8 * 1024 * 1024);
      let at = 0;
      while (at < stat.size) {
        const read = await fh.read(buf, 0, Math.min(buf.length, stat.size - at), at);
        if (read.bytesRead === 0) break;
        hash.update(buf.subarray(0, read.bytesRead));
        at += read.bytesRead;
        if (opts.onProgress) opts.onProgress(at, stat.size);
      }
      out.sha256 = hash.digest('hex');
    }
  } finally {
    await fh.close();
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Main
 * ---------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (...a) => console.log(...a);
  if (args.help || (!args.build && !args.listVideos && !args.scan)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const found = args.build ? await discover(args.build) : null;

  if (args.scan) {
    if (args.scan === true && !found) throw new Error('--scan needs a .wasm file, or --build <dir>' + USAGE);
    const wasmFile = args.scan !== true ? path.resolve(args.scan) : path.join(found.buildDir, found.wasm);
    const buf = await fsp.readFile(wasmFile);
    const summary = validateWasm(buf);
    log('module: ' + (summary.ok ? summary.summary.functionCount + ' functions, ' + human(buf.length) : 'INVALID — ' + summary.detail));
    for (const mem of parseMemoryLimits(buf)) {
      log(
        'memory: initial ' + mem.initialPages + ' pages (' + ((mem.initialPages * 65536) / 1048576) + ' MiB) at offset ' + mem.initialOffset +
        (mem.maximumPages === null ? ', no declared maximum' : ', maximum ' + mem.maximumPages + ' pages (' + ((mem.maximumPages * 65536) / 1048576) + ' MiB)') +
        ' — the initial amount is backed at instantiation, before any asset loads'
      );
    }
    const candidates = scanBooleanReturns(buf);
    log('candidates that look like "is X required?" checks (confirm before patching):');
    candidates.slice(0, 20).forEach((c) => {
      log(
        '  func #' + c.index + '  ' + c.bytes + ' bytes  f64=' + c.f64Constants + ' cmp=' + c.floatCompares +
          ' calls=' + c.calls + '  tail@' + c.tailOffset + ' (' + c.tailBytes + ')'
      );
    });
    return;
  }

  if (args.listVideos) {
    const survey = await surveyVideos(path.join(found.buildDir, found.data), { minBytes: args.videoMinBytes });
    log('archive: ' + survey.archive.fileCount + ' entries, header ' + survey.archive.headerSize + ' bytes');
    log('video entries: ' + survey.videos.length);
    survey.videos.slice(0, 40).forEach((v) => log('  ' + v.path + ' — ' + human(v.size) + ' (' + v.kind + ')'));
    if (survey.videos.length > 40) log('  … ' + (survey.videos.length - 40) + ' more');
    log('note: ' + survey.bundles + ' entries are large bundles; videos embedded in a bundle are not touched here.');
    return;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    buildDir: path.resolve(found.buildDir),
    outDir: args.out,
    name: args.name,
    partBytes: args.partBytes,
    check: null,
    prune: { removed: [], bytes: 0 },
    videos: null,
    patches: [],
    datasets: {},
    savings: {},
  };

  log('▸ checking the build');
  report.check = await checkInput(found);
  report.check.notes.forEach((n) => log('  · ' + n));
  report.check.problems.forEach((p) => log('  ! ' + p));
  if (!report.check.ok) {
    log('\nThe input does not look like a usable Unity WebGL build; fix that first.');
    process.exitCode = 2;
    return;
  }

  const outBuildDir = path.join(args.out, 'Build');
  if (!args.dryRun) await fsp.mkdir(outBuildDir, { recursive: true });
  const tmpDir = path.join(args.out, '.prepare-tmp');
  if (!args.dryRun) await fsp.mkdir(tmpDir, { recursive: true });

  /* ---- prune -------------------------------------------------------- */
  log('▸ leaving build junk out of the output');
  const pruneGlobs = [...JUNK, ...args.prune];
  const keepGlobs = args.keep;
  const junk = args.noPrune
    ? []
    : found.files.filter((f) => matchesAny(f, pruneGlobs) && !matchesAny(f, keepGlobs) && !/\.(data|wasm)$/.test(f));
  for (const name of junk) {
    const size = (await fsp.stat(path.join(found.buildDir, name))).size;
    report.prune.removed.push({ name, bytes: size });
    report.prune.bytes += size;
    log('  − ' + name + '  ' + human(size));
  }
  if (!junk.length) log('  (nothing to leave out)');

  /* ---- small files -------------------------------------------------- */
  log('▸ copying the entry points');
  const copySmall = async (name, targetName) => {
    const src = path.join(found.buildDir, name);
    const dst = path.join(outBuildDir, targetName);
    if (!args.dryRun) await fsp.copyFile(src, dst);
    const size = (await fsp.stat(src)).size;
    log('  ' + targetName + '  ' + human(size));
    return { name: targetName, bytes: size };
  };
  const loaderInfo = await copySmall(found.loader, args.name + '.loader.js');

  // The framework js is small but holds the room-audio cleanup that keeps
  // WebKit from holding on to every room's music decoder. Patches are exact
  // matches or they are skipped — see tools/patches.mjs.
  const frameworkSource = await fsp.readFile(path.join(found.buildDir, found.framework));
  const frameworkOut = patchFramework(frameworkSource);
  frameworkOut.report.forEach((p) => {
    report.patches.push({ name: p.name, file: found.framework, applied: p.applied, already: p.already, detail: p.detail });
    log(
      '  ' + (p.applied ? (p.already ? '=' : '✓') : '·') + ' framework: ' + p.name +
        (p.detail ? ' — ' + p.detail : '')
    );
  });
  if (!args.dryRun) await fsp.writeFile(path.join(outBuildDir, args.name + '.framework.js'), frameworkOut.bytes);
  log('  ' + args.name + '.framework.js  ' + human(frameworkOut.bytes.length) + (frameworkOut.changed ? ' (patched)' : ''));

  const streamingAssets = path.join(found.buildDir, 'StreamingAssets');
  const streamingOut = path.join(args.out, 'StreamingAssets');
  let streamingBytes = 0;
  try {
    const entries = await fsp.readdir(streamingAssets, { withFileTypes: true });
    if (!args.dryRun) await fsp.mkdir(streamingOut, { recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const size = (await fsp.stat(path.join(streamingAssets, entry.name))).size;
      streamingBytes += size;
      if (!args.dryRun) await fsp.copyFile(path.join(streamingAssets, entry.name), path.join(streamingOut, entry.name));
    }
    log('  StreamingAssets/  ' + entries.length + ' files  ' + human(streamingBytes));
  } catch (e) {
    // Unity writes a StreamingAssets folder even when it is empty; make sure
    // the page still finds the URL it asks for.
    if (!args.dryRun) {
      await fsp.mkdir(streamingOut, { recursive: true });
      await fsp.writeFile(
        path.join(streamingOut, 'StreamingAssets.txt'),
        'Intentionally useless file. Required for version control.\n'
      );
    }
    log('  StreamingAssets/  (created a placeholder — the build had none)');
  }

  /* ---- data archive: videos + prune entries ------------------------- */
  log('▸ rewriting the data archive (' + args.videoStrategy + ' videos)');
  const srcData = path.join(found.buildDir, found.data);
  const survey = await surveyVideos(srcData, { minBytes: args.videoMinBytes });
  const planned = planVideoEntries(survey.archive.entries, survey.videos, {
    strategy: args.videoStrategy,
    minBytes: args.videoMinBytes,
    keepBytes: args.videoKeepBytes,
  });
  report.videos = {
    entries: survey.videos.length,
    replaced: planned.report.replaced,
    truncated: planned.report.truncated,
    kept: planned.report.kept,
    byKind: planned.report.byKind,
    savedBytes: planned.report.savedBytes,
    examples: planned.report.examples,
    strategy: args.videoStrategy,
  };
  log('  video entries found: ' + survey.videos.length + ' (' + JSON.stringify(planned.report.byKind) + ')');
  planned.report.examples.forEach((e) => log('    ' + e));
  log('  saved: ' + human(planned.report.savedBytes));

  const processedData = path.join(tmpDir, args.name + '.data');
  if (!args.dryRun) {
    const result = await rebuildArchive({
      fromFile: srcData,
      toFile: processedData,
      entries: planned.entries.map((e) => ({
        path: e.path,
        size: e.size,
        data: e.data,
        source: e.source,
      })),
      align: args.align || 4,
      log: (line) => log(line),
    });
    log('  new archive: ' + human(result.size) + ' with ' + result.entries + ' entries');
  }

  /* ---- wasm patches ------------------------------------------------- */
  log('▸ patching the wasm (if a patch file applies)');
  const wasmSource = path.join(found.buildDir, found.wasm);
  let wasmBytes = await fsp.readFile(wasmSource);
  const patchFiles = args.noPatch ? [] : await collectPatchFiles(args);
  if (!patchFiles.length) log('  (no patches configured — see web/BUILD.md §4)');
  for (const patchFile of patchFiles) {
    const patches = JSON.parse(await fsp.readFile(patchFile, 'utf8'));
    // A patch file pinned to a specific externally-hosted binary (the
    // community build) must never be auto-applied to a prepared build that
    // merely happens to be lying next to it. An explicit --patch still can.
    if (patches.communityOnly && !args.patch) {
      log('  · ' + path.basename(patchFile) + ' is pinned to a specific binary (communityOnly) — skipped for a prepared build');
      continue;
    }
    for (const patch of patches.patches || []) {
      if (!patch.expect || !patch.replace) {
        report.patches.push({ name: patch.name || '(unnamed)', file: path.basename(patchFile), applied: false, reason: 'structural patch — not a byte patch prepare-build can apply' });
        log('  · ' + (patch.name || '(unnamed)') + ' is structural, not a byte patch — skipped');
        continue;
      }
      try {
        const result = applyPatch(wasmBytes, patch);
        report.patches.push({ name: patch.name, file: path.basename(patchFile), ...result });
        log('  ✓ ' + patch.name + ' @' + result.offset);
      } catch (err) {
        report.patches.push({ name: patch.name, file: path.basename(patchFile), applied: false, reason: String(err.message || err) });
        log('  · ' + patch.name + ' does not apply to this build: ' + ((err && err.message) || err));
      }
    }
  }
  const wasmProcessed = path.join(tmpDir, args.name + '.wasm');
  if (!args.dryRun) await fsp.writeFile(wasmProcessed, wasmBytes);

  /* ---- chunk + digest ---------------------------------------------- */
  log('▸ chunking for the streaming loader (' + human(args.partBytes) + ' parts)');
  const dataFile = args.dryRun ? srcData : processedData;
  const wasmFile = args.dryRun ? wasmSource : wasmProcessed;

  const dataDigestStart = Date.now();
  const dataDigest = await digestFile(dataFile, { skipFull: args.noFullHash });
  const dataChunks = args.dryRun
    ? { parts: [], total: (await fsp.stat(dataFile)).size }
    : await chunkFile(dataFile, outBuildDir, args.name + '.data', args.partBytes, log);
  log('  data: ' + human(dataChunks.total) + ' in ' + dataChunks.parts.length + ' parts (' + ((Date.now() - dataDigestStart) / 1000).toFixed(1) + 's)');

  const wasmDigest = await digestFile(wasmFile, { skipFull: args.noFullHash });
  const wasmChunks = args.dryRun
    ? { parts: [], total: (await fsp.stat(wasmFile)).size }
    : await chunkFile(wasmFile, outBuildDir, args.name + '.wasm', args.partBytes, log);
  log('  wasm: ' + human(wasmChunks.total) + ' in ' + wasmChunks.parts.length + ' parts');

  const sourceDataSize = (await fsp.stat(srcData)).size;
  const sourceWasmSize = (await fsp.stat(wasmSource)).size;
  report.savings = {
    dataBefore: sourceDataSize,
    dataAfter: dataChunks.total,
    wasmBefore: sourceWasmSize,
    wasmAfter: wasmChunks.total,
    streamedBefore: sourceDataSize + sourceWasmSize,
    streamedAfter: dataChunks.total + wasmChunks.total,
    junkSkipped: report.prune.bytes,
  };

  /* ---- manifest ---------------------------------------------------- */
  const patchSummary = report.patches.filter((p) => p.applied).map((p) => p.name);
  const manifest = {
    schema: 2,
    name: args.name,
    buildId: args.name + '-webgl-' + new Date().toISOString().slice(0, 10) + '-' + dataChunks.total.toString(36) + '-' + (patchSummary.length ? 'p' : 'n'),
    generatedAt: report.generatedAt,
    partBytes: args.partBytes,
    unity: {
      loader: 'Build/' + args.name + '.loader.js',
      framework: 'Build/' + args.name + '.framework.js',
      streamingAssets: 'StreamingAssets/',
      // Optional IL2CPP entry points for the periodic memory cleanup; a wrong
      // index would call an unrelated function, so they are only listed when a
      // patch file/site config supplies them on purpose.
      api: {},
    },
    datasets: {
      data: {
        cacheKey: args.name + '.data',
        mime: 'application/octet-stream',
        total: dataChunks.total,
        entries: report.check.files.data.entries,
        parts: dataChunks.parts,
      },
      wasm: {
        cacheKey: args.name + '.wasm',
        mime: 'application/wasm',
        total: wasmChunks.total,
        parts: wasmChunks.parts,
      },
    },
    integrity: {
      data: dataDigest,
      wasm: wasmDigest,
      api: {},
      patches: patchSummary,
    },
    report: {
      videos: report.videos,
      prune: report.prune,
      check: report.check,
      savings: report.savings,
    },
  };

  if (!args.dryRun) {
    await fsp.writeFile(path.join(outBuildDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  if (args.json) {
    console.log(JSON.stringify({ manifest, report }, null, 2));
    return;
  }

  log('\n▸ summary');
  log('  game data   ' + human(report.savings.dataBefore) + ' → ' + human(report.savings.dataAfter) +
      '  (' + human(report.savings.dataBefore - report.savings.dataAfter) + ' less to download)');
  log('  wasm        ' + human(report.savings.wasmBefore) + ' → ' + human(report.savings.wasmAfter));
  log('  build junk  ' + human(report.prune.bytes) + ' left out of the output');
  log('  chunks      ' + (dataChunks.parts.length + wasmChunks.parts.length) + ' files of ≤ ' + human(args.partBytes));
  log('  manifest    ' + path.join(outBuildDir, 'build-manifest.json'));
  log('\nNext: node web/tools/verify-build.mjs  — then serve web/ and open play.html.');
}

async function collectPatchFiles(args) {
  if (args.patch) return [path.resolve(args.patch)];
  const dir = path.join(WEB_ROOT, 'patches');
  try {
    const names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    return names.map((n) => path.join(dir, n));
  } catch (e) {
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('prepare-build failed: ' + ((err && err.stack) || err));
    process.exitCode = 1;
  });
}

export { main, surveyVideos, planVideoEntries, USAGE, PATCHES };
