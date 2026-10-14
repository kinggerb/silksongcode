/* ============================================================================
 * test-pipeline.mjs — the whole prepare → verify → serve path, end to end
 * ----------------------------------------------------------------------------
 *   node web/tools/test-pipeline.mjs
 *
 * Builds a synthetic Unity build, runs the real CLI tools over it, and checks
 * what lands in the output folder: the manifest's arithmetic, every chunk's
 * size and digest, the pruned junk, the patched framework, the replaced
 * cutscenes, the alignment of the rebuilt archive, and the sizes the page will
 * actually download. Then it breaks things on purpose and checks that
 * verify-build.mjs notices.
 * ==========================================================================*/

import { section, test, eq, ok, done, tmpDir } from './testkit.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openArchive, parseHeader, MAGIC_BYTES } from './unity-webdata.mjs';
import { makeFixtureBuild } from './make-fixture-build.mjs';
import { verifyBuild } from './verify-build.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const TMP = tmpDir('pipeline');

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { encoding: 'utf8' });
  return result;
}

await fsp.mkdir(TMP, { recursive: true });

section('fixture → prepare-build');

const fixture = path.join(TMP, 'unity-build');
const out = path.join(TMP, 'web-out');
let prepareOut = '';

await test('the fixture looks like a Unity WebGL build', async () => {
  await makeFixtureBuild(fixture, { filler: 3 * 1024 * 1024 });
  for (const name of ['silksong.loader.js', 'silksong.framework.js', 'silksong.wasm', 'silksong.data']) {
    ok(fs.existsSync(path.join(fixture, name)), name + ' exists');
  }
});

await test('prepare-build writes a manifest and chunks', () => {
  prepareOut = run('prepare-build.mjs', ['--build', fixture, '--out', out, '--part-bytes', '1MB']).stdout;
  ok(fs.existsSync(path.join(out, 'Build', 'build-manifest.json')), 'manifest written');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  eq(manifest.schema, 2, 'schema');
  eq(manifest.datasets.data.parts.length > 1, true, 'data was chunked');
  eq(manifest.unity.loader, 'Build/silksong.loader.js', 'loader path');
  ok(/silksong-webgl/.test(manifest.buildId), 'build id looks like ours: ' + manifest.buildId);
});

await test('build junk is left out of the output', () => {
  for (const junk of ['silksong.symbols', 'silksong.data.gz', 'TemplateData', '.DS_Store']) {
    eq(fs.existsSync(path.join(out, 'Build', junk)), false, junk + ' was skipped');
  }
  ok(/silksong\.symbols/.test(prepareOut), 'and the report names it');
});

await test('cutscenes were replaced with tiny black placeholders', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  const videos = manifest.report.videos;
  eq(videos.replaced, 3, 'three video entries replaced');
  ok(videos.savedBytes > 900000, 'and roughly a megabyte saved (' + videos.savedBytes + ')');
  ok(manifest.report.savings.dataAfter < manifest.report.savings.dataBefore, 'the archive got smaller');
});

await test('the framework got the room-audio fix', () => {
  const text = fs.readFileSync(path.join(out, 'Build', 'silksong.framework.js'), 'utf8');
  ok(text.includes('mediaElement.src=""'), 'audio sources are released on disconnect');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  ok(manifest.integrity.patches.length >= 1, 'the manifest records which patches were applied');
});

section('what the page will download');

await test('every chunk is a real file with the size the manifest claims', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  let total = 0;
  for (const set of Object.values(manifest.datasets)) {
    for (const part of set.parts) {
      const stat = await fsp.stat(path.join(out, ...part.path.split('/')));
      eq(stat.size, part.bytes, part.path + ' size');
      total += stat.size;
    }
    eq(
      set.parts.reduce((a, p) => a + p.bytes, 0),
      set.total,
      'the chunk sizes add up to the dataset total'
    );
  }
  ok(total > 0, 'there is something to download');
});

await test('the assembled data is still a valid Unity archive with every entry inside it', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  const parts = manifest.datasets.data.parts;
  // stitch the chunks in a temp file (small fixture, so this is cheap) and parse it
  const stitched = path.join(TMP, 'stitched.data');
  const outFd = fs.openSync(stitched, 'w');
  let at = 0;
  for (const part of parts) {
    const buf = await fsp.readFile(path.join(out, ...part.path.split('/')));
    fs.writeSync(outFd, buf, 0, buf.length, at);
    at += buf.length;
  }
  fs.closeSync(outFd);
  eq(at, manifest.datasets.data.total, 'stitched size matches the manifest total');
  const archive = await openArchive(stitched);
  eq(archive.header.fileCount, manifest.datasets.data.entries, 'entry count matches the manifest');
  ok(archive.header.entries.every((e) => e.offset + e.size <= manifest.datasets.data.total - archive.header.headerSize), 'no entry points past the end');
  const magic = Buffer.alloc(16);
  const fh = await fsp.open(stitched, 'r');
  await fh.read(magic, 0, 16, 0);
  await fh.close();
  ok(magic.equals(MAGIC_BYTES), 'starts with the UnityWebData magic');
  await archive.handle.close();
});

section('verify-build');

await test('verify-build is happy with a complete build', async () => {
  const report = await verifyBuild(out);
  eq(report.ok, true, 'no problems: ' + report.problems.join('; '));
  eq(report.datasets.data.parts.every((p) => p.sha256 === 'ok' || p.sha256 === undefined), true, 'digests match');
  ok(report.datasets.data.archive.entries > 0, 'the archive directory was read back');
});

await test('verify-build notices a chunk whose bytes changed', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  const victim = path.join(out, ...manifest.datasets.data.parts[0].path.split('/'));
  const original = await fsp.readFile(victim);
  const damaged = Buffer.from(original);
  damaged[damaged.length - 1] ^= 0xff;
  await fsp.writeFile(victim, damaged);
  const report = await verifyBuild(out);
  eq(report.ok, false, 'the corruption is reported');
  ok(report.problems.some((p) => /does not hash/.test(p)), 'and named: ' + report.problems.join('; '));
  await fsp.writeFile(victim, original); // put it back
  eq((await verifyBuild(out)).ok, true, 'and it passes again once restored');
});

await test('verify-build notices a missing chunk', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(out, 'Build', 'build-manifest.json'), 'utf8'));
  const victim = path.join(out, ...manifest.datasets.wasm.parts[0].path.split('/'));
  const original = await fsp.readFile(victim);
  await fsp.rm(victim);
  const report = await verifyBuild(out);
  eq(report.ok, false, 'reported');
  ok(report.problems.some((p) => /missing chunk/.test(p)), 'as a missing chunk');
  await fsp.writeFile(victim, original);
});

await test('the CLI exits non-zero when the build is broken', async () => {
  const broken = path.join(TMP, 'broken-out');
  await fsp.mkdir(path.join(broken, 'Build'), { recursive: true });
  await fsp.copyFile(path.join(out, 'Build', 'build-manifest.json'), path.join(broken, 'Build', 'build-manifest.json'));
  const result = run('verify-build.mjs', ['--out', broken]);
  eq(result.status, 1, 'exit code 1');
  ok(/missing chunk/.test(result.stdout), 'and it explains why');
});

section('the video strategies');

await test('truncate keeps the container head instead of a placeholder', () => {
  const truncOut = path.join(TMP, 'trunc-out');
  const fixture2 = path.join(TMP, 'unity-build-2');
  const result = spawnSync(process.execPath, [path.join(TOOLS, 'make-fixture-build.mjs'), '--out', fixture2, '--filler', '1MB'], { encoding: 'utf8' });
  ok(result.status === 0, 'second fixture built');
  const prepared = run('prepare-build.mjs', ['--build', fixture2, '--out', truncOut, '--part-bytes', '1MB', '--video-strategy', 'truncate', '--video-keep-bytes', '4096']);
  eq(prepared.status, 0, 'prepare-build ran: ' + prepared.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(truncOut, 'Build', 'build-manifest.json'), 'utf8'));
  eq(manifest.report.videos.truncated, 3, 'all three videos truncated');
  eq(manifest.report.videos.replaced, 0, 'none replaced');
  ok(/truncate/.test(prepared.stdout), 'the report says which strategy ran');
});

await test('--keep protects a file the prune list would have removed', () => {
  const keepOut = path.join(TMP, 'keep-out');
  const prepared = run('prepare-build.mjs', ['--build', fixture, '--out', keepOut, '--part-bytes', '2MB', '--keep', 'silksong.data.gz']);
  eq(prepared.status, 0, 'prepare-build ran');
  ok(!/silksong\.data\.gz/.test(prepared.stdout.match(/− .*/g)?.join(' ') || ''), 'the kept file is not in the removal list');
});

await test('--scan shortlists candidate functions in a build', () => {
  const scanned = run('prepare-build.mjs', ['--scan', path.join(fixture, 'silksong.wasm')]);
  eq(scanned.status, 0, 'scan ran');
  ok(/func #0/.test(scanned.stdout), 'it lists the function: ' + scanned.stdout.split('\n').slice(0, 3).join(' | '));
  ok(/confirm before patching/.test(scanned.stdout), 'and says the list needs confirmation');
});

await test('--list-videos reports the cutscenes without touching them', () => {
  const listed = run('prepare-build.mjs', ['--build', fixture, '--list-videos']);
  eq(listed.status, 0, 'list ran');
  ok(/video entries: 3/.test(listed.stdout), 'found the three videos: ' + listed.stdout.split('\n')[1]);
});

await fsp.rm(TMP, { recursive: true, force: true });
await done('pipeline tests');
