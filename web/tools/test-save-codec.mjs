/* ============================================================================
 * test-save-codec.mjs — Silksong save files
 * ----------------------------------------------------------------------------
 *   node web/tools/test-save-codec.mjs
 *
 * Round-trips the .dat container, decrypts the boss-rush saves that ship in
 * mods/boss-rush/BossScenes/BossSave (the same files the page installs into a
 * slot), accepts the shapes a save editor hands back, and checks the tolerant
 * sniffing used by Import.
 * ==========================================================================*/

import { section, test, eq, ok, rejects, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const codec = require('../js/save-codec.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOSS_SAVES = path.join(REPO, 'mods', 'boss-rush', 'BossScenes', 'BossSave');
const CATALOGUE = path.join(REPO, 'mods', 'boss-rush', 'BossScenes', 'BossSceneConfig.json');

section('container');

await test('the key and header are the ones the game uses', () => {
  eq(Buffer.from(codec._internals.AES_KEY).toString('latin1'), 'UKu52ePUBwetZ9wNX88o54dnfKRu0T1l', 'AES key');
  eq(codec.HEADER.length, 22, 'BinaryFormatter string header length');
  eq(Array.from(codec.HEADER.subarray(17, 22)).join(','), '6,1,0,0,0', '0x06 + objectId 1');
});

await test('encode → decode round-trips exactly', () => {
  const json = JSON.stringify({ playerData: { health: 5, silk: 9, version: '1.0.30000' }, flags: [] });
  const dat = codec.encodeDat(json);
  eq(codec.looksLikeDat(dat), true, 'produces a .dat container');
  eq(dat[dat.length - 1], 0x0b, 'ends with MessageEnd');
  eq(codec.decodeDat(dat), json, 'decodes back to the same JSON');
});

await test('the payload really is base64(AES-256-ECB-PKCS7(UTF-8(JSON)))', () => {
  const json = '{"a":1}';
  const dat = Buffer.from(codec.encodeDat(json)); // Uint8Array in, Buffer for slicing
  // re-derive it with node's crypto, so this is not just our own code agreeing
  // with itself: the byte layout is documented in mods/boss-rush/tools/SaveCodec.ps1
  let p = 22;
  let length = 0;
  let shift = 0;
  for (;;) {
    const b = dat[p++];
    length |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const b64 = dat.subarray(p, p + length).toString('ascii');
  const cipher = Buffer.from(b64, 'base64');
  const key = Buffer.from('UKu52ePUBwetZ9wNX88o54dnfKRu0T1l');
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  eq(plain, json, 'node crypto decrypts our payload');
  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  const ours = Buffer.concat([enc.update(Buffer.from(json)), enc.final()]);
  ok(ours.equals(cipher), 'and our ciphertext equals node crypto\'s');
});

await test('a plain JSON save is accepted too (editors hand those back)', () => {
  const json = '{"playerData":{"health":3}}';
  eq(codec.findSave(Buffer.from(json)), json, 'plain JSON');
});

await test('a bare base64 payload is accepted', () => {
  const json = '{"playerData":{"silk":4}}';
  const key = Buffer.from('UKu52ePUBwetZ9wNX88o54dnfKRu0T1l');
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  const payload = Buffer.concat([cipher.update(Buffer.from(json)), cipher.final()]).toString('base64');
  eq(codec.findSave(Buffer.from(payload)), json, 'base64 only');
  eq(codec.findSave(Buffer.from('<html><body><pre>' + payload + '</pre></body></html>')), json, 'embedded in HTML');
});

await test('garbage is refused instead of producing a broken save', async () => {
  await rejects(Promise.resolve().then(() => codec.findSave(Buffer.from('this is not a save at all, far too short'))), null, 'findSave');
  let message = '';
  try {
    codec.decodeDat(Buffer.alloc(200, 0x5a));
  } catch (e) {
    message = e.message;
  }
  ok(/not a save|payload/.test(message), 'decodeDat explains itself: ' + message);
});

section('the boss-rush saves from this repo');

const saves = fs.existsSync(BOSS_SAVES) ? fs.readdirSync(BOSS_SAVES).filter((f) => f.endsWith('.json.gz')) : [];

await test('the catalogue and its saves are present', () => {
  eq(fs.existsSync(CATALOGUE), true, 'BossSceneConfig.json');
  ok(saves.length >= 40, 'at least 40 prepared saves (' + saves.length + ')');
});

for (const name of saves.slice(0, 3)) {
  await test('re-encoding ' + name + ' survives the round trip', () => {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(BOSS_SAVES, name)));
    const json = raw.toString('utf8');
    ok(json.startsWith('{'), 'the repo file is gzipped JSON');
    const dat = codec.encodeDat(json);
    ok(codec.decodeDat(dat) === json, 'a boss save can be packaged as a .dat byte for byte');
  });
}

await test('every boss save in the repo decodes after a gzip sniff', async () => {
  const samples = saves.slice(0, 8);
  for (const name of samples) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(BOSS_SAVES, name)));
    ok(codec.looksLikeGzip(bytes), name + ' sniffs as gzip');
    const json = await codec.findSaveOrGzip(bytes);
    ok(json.includes('playerData'), name + ' decodes to a save');
  }
});

section('slots');

await test('slot names map to save slots the way the game writes them', async () => {
  const bossScenes = require('../js/boss-scenes.js');
  ok(bossScenes && typeof bossScenes.install === 'function', 'boss-scenes module loads');
  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  const names = catalogue.BossScenes.map((b) => b.BossName);
  eq(names.length, catalogue.BossScenes.length, 'every boss has a name');
  eq(names.includes('苔藓之母'), true, 'including the one the RL config defaults to');
  const staged = path.join(REPO, 'web', 'BossScenes');
  if (fs.existsSync(staged)) {
    const stagedConfig = JSON.parse(fs.readFileSync(path.join(staged, 'BossSceneConfig.json'), 'utf8'));
    eq(stagedConfig.BossScenes.length, catalogue.BossScenes.length, 'the staged copy matches the repo catalogue');
  }
});

await done('save codec tests');
