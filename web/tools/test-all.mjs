/* ============================================================================
 * test-all.mjs — run every suite
 * ----------------------------------------------------------------------------
 *   node web/tools/test-all.mjs            # everything
 *   node web/tools/test-all.mjs --no-dom   # skip the jsdom suite (no npm install)
 * ==========================================================================*/

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const skipDom = process.argv.includes('--no-dom');

const suites = [
  ['stream loader', 'test-stream.mjs'],
  ['build manifest', 'test-manifest.mjs'],
  ['community build adapter', 'test-community-build.mjs'],
  ['unity archive + patches', 'test-webdata.mjs'],
  ['save codec', 'test-save-codec.mjs'],
  ['prepare → verify pipeline', 'test-pipeline.mjs'],
  ['page (jsdom)', 'test-page.mjs'],
];

let failed = 0;
const started = Date.now();

for (const [name, file] of suites) {
  if (skipDom && file === 'test-page.mjs') {
    console.log('\n▸ ' + name + ' — skipped (--no-dom)');
    continue;
  }
  console.log('\n════ ' + name + ' ════');
  const result = spawnSync(process.execPath, [path.join(TOOLS, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(
  '\n' +
    (failed ? '✗ ' + failed + ' suite(s) failed' : '✓ all suites passed') +
    ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's'
);
process.exit(failed ? 1 : 0);
