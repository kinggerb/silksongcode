#!/usr/bin/env node
/* ============================================================================
 * make-fixture-build.mjs — synthesise a fake Unity WebGL build
 * ----------------------------------------------------------------------------
 * The real Silksong build cannot live in this repository (it is hundreds of MB
 * and it is Team Cherry's), but everything in `web/tools/` and the whole iPad
 * page still have to be testable. This writes a small build with exactly the
 * same *shape* as a Unity one:
 *
 *   silksong.loader.js        exports createUnityInstance (a stub that boots
 *                             nothing, so the page can complete its flow)
 *   silksong.framework.js     contains Unity's unpatched audio block, so the
 *                             framework patch has something real to patch
 *   silksong.wasm             a valid wasm module, including a function shaped
 *                             like `IsUnloadAssetsRequired` for --scan
 *   silksong.data             a real UnityWebData1.0 archive with video entries,
 *                             a bundle entry and small resources
 *   StreamingAssets/…         the usual folder
 *   junk (.symbols, .gz twins, TemplateData) so --prune has work to do
 *
 *   node web/tools/make-fixture-build.mjs --out /tmp/fake-webgl --filler 8MB
 * ==========================================================================*/

import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeArchive, makePlaceholderVideo } from './unity-webdata.mjs';
import { parseSize } from './prepare-build.mjs';

const USAGE = `Usage: node web/tools/make-fixture-build.mjs [--out <dir>] [--filler <size>]

  --out <dir>      where to write the fake build (default: web/.fixture-build)
  --filler <size>  extra payload to add so chunking is exercised (default: 6MB)
  --name <name>    build name (default: silksong)
`;

function parseArgs(argv) {
  const args = { out: null, filler: 6 * 1024 * 1024, name: 'silksong' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out': args.out = path.resolve(argv[++i]); break;
      case '--filler': args.filler = parseSize(argv[++i]); break;
      case '--name': args.name = argv[++i]; break;
      case '-h': case '--help': args.help = true; break;
      default: throw new Error('unknown option ' + argv[i] + '\n' + USAGE);
    }
  }
  return args;
}

/* ---- a wasm module with a scan-friendly function ------------------------ */

function leb(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
function section(id, payload) {
  return Buffer.concat([Buffer.from([id]), leb(payload.length), payload]);
}
function body(bytes) {
  const packed = Buffer.concat([leb(bytes.length), bytes]);
  return packed;
}
function f64(value) {
  const b = Buffer.alloc(9);
  b[0] = 0x44;
  b.writeDoubleLE(value, 1);
  return b;
}

/**
 * `bool IsUnloadAssetsRequired()` shaped like Unity's memory-limit check: it
 * compares measured memory against a couple of constants and returns a bool.
 * Real ones are a few hundred bytes; this one is ~90 so `--scan`, whose default
 * shortlist threshold is 64 bytes, picks it up.
 */
function unloadCheckBody() {
  return Buffer.concat([
    Buffer.from([0x00]), // no locals
    f64(0), Buffer.from([0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5e, 0x40, 0x62, 0x1a]), // if f64 > 125.0
    f64(1024), Buffer.from([0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x63, 0x1a]), // if f64 >= 2.5e9
    f64(0), Buffer.from([0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x64, 0x1a]), // if f64 <= 2.05e9
    f64(0), Buffer.from([0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x8f, 0x40, 0x61, 0x1a]), // if f64 < 1000.0
    Buffer.from([0x20, 0x01, 0x0b]), // local.get 1; end
  ]);
}

function buildWasm() {
  const typeSec = section(1, Buffer.concat([Buffer.from([1]), Buffer.from([0x60, 0x00, 0x01, 0x7f])]));
  const funcSec = section(3, Buffer.concat([Buffer.from([1]), Buffer.from([0])]));
  const codeSec = section(10, Buffer.concat([Buffer.from([1]), body(unloadCheckBody())]));
  const exportSec = section(7, Buffer.concat([Buffer.from([1]), leb(4), Buffer.from('main'), Buffer.from([0x00]), leb(0)]));
  return Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), typeSec, funcSec, exportSec, codeSec]);
}

/* ---- the stub loader / framework --------------------------------------- */

const LOADER = `/* fixture loader: same entry point as a Unity WebGL build */
(function(){'use strict';
window.createUnityInstance = function(canvas, config, onProgress){
  var report = function(p){ if(onProgress) onProgress(p); };
  return new Promise(function(resolve){
    var pct = 0;
    var timer = setInterval(function(){
      pct += 0.2;
      report(Math.min(1, pct));
      if(pct >= 1){
        clearInterval(timer);
        var ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if(ctx){ ctx.clearColor(0.02,0.02,0.05,1); ctx.clear(ctx.COLOR_BUFFER_BIT); }
        window.__fixtureBooted = true;
        resolve({
          Module: { HEAPU8: new Uint8Array(${32 * 1024 * 1024}), setCanvasSize: function(w,h){ canvas.width=w; canvas.height=h; } },
          SendMessage: function(){}, Quit: function(){}
        });
      }
    }, 50);
  });
};
})();
`;

const PRISTINE_AUDIO_BLOCK =
  'if(this.source.mediaElement){this.source._pauseMediaElement();' +
  'if(this.source.playTimeout){clearTimeout(this.source.playTimeout);this.source.playTimeout=null}}';

const FRAMEWORK = `/* fixture framework: the parts of Unity's WebGL framework this pipeline looks at */
var WEBAudio = { audioContext: null, audioInstances: [], pendingAudioSources: {}, audioWebEnabled: 0 };
function jsAudioCreateChannel(callback,userData){
  var channel={callback:callback,userData:userData,source:null,threeD:false,loop:false,pitch:1};
  channel.release=function(){this.disconnectSource()};
  channel.disconnectSource=function(){if(!this.source||this.source.isPausedMockNode){return}${PRISTINE_AUDIO_BLOCK}this.source.onended=null;this.source.disconnect();delete this.source};
  channel.playSoundClip=function(soundClip,startTime,startOffset){
    try{ var self=this; this.source=soundClip.createSourceNode(); }
    catch(e){console.error("playSoundClip error. Exception: "+error)}
  };
  return channel;
}
function _JS_Sound_Play(bufferInstance,channelInstance,offset,delay){
  if(WEBAudio.audioWebEnabled==0)return;
  var channel=WEBAudio.audioInstances[channelInstance];
  channel.playSoundClip(null,0,offset);
}
function _JS_Sound_ReleaseInstance(instance){ var object=WEBAudio.audioInstances[instance]; if(object){object.release()} }
`;

/* ---- the data archive -------------------------------------------------- */

async function buildArchive(file, fillerBytes) {
  const entries = [];
  entries.push({ path: 'Resources/unity default resources', data: Buffer.alloc(4096, 7) });
  entries.push({ path: 'Resources/unity_builtin_extra', data: Buffer.alloc(2048, 3) });
  // Cutscene videos, exactly the thing the iPad pipeline replaces: one MP4 and
  // one WebM, both large enough to matter.
  entries.push({ path: 'sharedassets200.resource', data: fakeVideoPayload('mp4', 512 * 1024) });
  entries.push({ path: 'sharedassets201.resource', data: fakeVideoPayload('webm', 384 * 1024) });
  entries.push({ path: 'cine_ending.webm', data: fakeVideoPayload('webm', 256 * 1024) });
  // A bundle and a few small assets that must survive untouched.
  entries.push({ path: 'sharedassets9', data: Buffer.alloc(fillerBytes, 0xab) });
  for (let i = 0; i < 6; i++) entries.push({ path: 'sharedassets' + (400 + i), data: Buffer.alloc(20 * 1024 + i * 1024, i) });
  await writeArchive(file, entries, { align: 4 });
  return { entries: entries.length, bytes: entries.reduce((a, e) => a + e.data.length, 0) };
}

function fakeVideoPayload(kind, bytes) {
  const head = makePlaceholderVideo(kind);
  const rest = Buffer.alloc(Math.max(0, bytes - head.length), 0x11);
  return Buffer.concat([head, rest]);
}

export async function makeFixtureBuild(outDir, opts = {}) {
  await fsp.mkdir(outDir, { recursive: true });
  const name = opts.name || 'silksong';
  await fsp.writeFile(path.join(outDir, name + '.loader.js'), LOADER);
  await fsp.writeFile(path.join(outDir, name + '.framework.js'), FRAMEWORK);
  await fsp.writeFile(path.join(outDir, name + '.wasm'), buildWasm());
  const archive = await buildArchive(path.join(outDir, name + '.data'), opts.filler || 6 * 1024 * 1024);
  await fsp.mkdir(path.join(outDir, 'StreamingAssets'), { recursive: true });
  await fsp.writeFile(path.join(outDir, 'StreamingAssets', 'StreamingAssets.txt'), 'Intentionally useless file. Required for version control.\n');
  // Junk that --prune is expected to leave out of the web output.
  await fsp.writeFile(path.join(outDir, name + '.symbols'), Buffer.alloc(64 * 1024, 0x7a));
  await fsp.writeFile(path.join(outDir, name + '.data.gz'), Buffer.alloc(1024, 1));
  await fsp.mkdir(path.join(outDir, 'TemplateData'), { recursive: true });
  await fsp.writeFile(path.join(outDir, 'TemplateData', 'style.css'), '/* unused at runtime */\n');
  await fsp.writeFile(path.join(outDir, '.DS_Store'), Buffer.alloc(24));
  return { outDir, name, archive };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const out = args.out || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.fixture-build');
  const result = await makeFixtureBuild(out, { filler: args.filler, name: args.name });
  console.log('fixture build written to ' + result.outDir);
  console.log('  ' + result.archive.entries + ' archive entries, ' + (result.archive.bytes / 1048576).toFixed(2) + ' MB of payload');
  console.log('  next: node web/tools/prepare-build.mjs --build ' + result.outDir + ' --out /tmp/web-out');
}

if (process.argv[1] && process.argv[1].endsWith('make-fixture-build.mjs')) {
  main().catch((err) => {
    console.error('make-fixture-build failed: ' + ((err && err.stack) || err));
    process.exitCode = 1;
  });
}

export { buildWasm, USAGE };
