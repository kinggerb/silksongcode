#!/usr/bin/env node
/* ============================================================================
 * stage-boss-scenes.mjs — copy the boss roster into web/BossScenes/
 * ----------------------------------------------------------------------------
 *   node web/tools/stage-boss-scenes.mjs [--clean]
 *
 * `mods/boss-rush` already holds the catalogue and one prepared save per boss.
 * The web port can use exactly those files, but they are 1.7 MB of game data
 * that belongs in the mod folder — so they are *staged* into web/BossScenes/
 * (git-ignored) instead of being committed twice. The page works without them
 * and simply hides the Boss saves section when they are absent.
 *
 * The saved games are gzipped JSON; js/save-codec.js turns them into the .dat
 * container in the browser when you install one into a slot.
 * ==========================================================================*/

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');
const SRC = path.join(REPO_ROOT, 'mods', 'boss-rush', 'BossScenes');

const USAGE = `Usage: node web/tools/stage-boss-scenes.mjs [--clean] [--out <dir>]

  --clean      remove web/BossScenes/ instead of staging it
  --out <dir>  stage somewhere else
`;

async function main() {
  const argv = process.argv.slice(2);
  const clean = argv.includes('--clean');
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : path.join(WEB_ROOT, 'BossScenes');

  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  if (clean) {
    await fsp.rm(out, { recursive: true, force: true });
    console.log('removed ' + out);
    return;
  }

  const config = path.join(SRC, 'BossSceneConfig.json');
  let catalogue;
  try {
    catalogue = JSON.parse(await fsp.readFile(config, 'utf8'));
  } catch (e) {
    console.error('cannot read ' + config + ' — is mods/boss-rush present?');
    process.exitCode = 1;
    return;
  }

  const bosses = catalogue.BossScenes || [];
  await fsp.mkdir(path.join(out, 'BossSave'), { recursive: true });
  await fsp.copyFile(config, path.join(out, 'BossSceneConfig.json'));

  let copied = 0;
  let bytes = 0;
  const missing = [];
  for (const boss of bosses) {
    const from = path.join(SRC, 'BossSave', boss.BossName + '.json.gz');
    const to = path.join(out, 'BossSave', boss.BossName + '.json.gz');
    try {
      await fsp.copyFile(from, to);
      bytes += (await fsp.stat(to)).size;
      copied++;
    } catch (e) {
      missing.push(boss.BossName);
    }
  }

  console.log('staged ' + copied + '/' + bosses.length + ' boss saves into ' + out + ' (' + (bytes / 1048576).toFixed(2) + ' MB)');
  if (missing.length) console.log('missing saves: ' + missing.join(', '));
  console.log('open the page and use Menu ▸ Boss saves to install one into a save slot');
}

if (process.argv[1] && process.argv[1].endsWith('stage-boss-scenes.mjs')) {
  main().catch((err) => {
    console.error('stage-boss-scenes failed: ' + ((err && err.stack) || err));
    process.exitCode = 1;
  });
}
