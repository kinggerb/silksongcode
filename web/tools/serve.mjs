/* ============================================================================
 * serve.mjs — static server for the Silksong web port
 * ----------------------------------------------------------------------------
 *   node web/tools/serve.mjs              # serves web/ on 0.0.0.0:8080
 *   node web/tools/serve.mjs 3000         # ... another port
 *   node web/tools/serve.mjs 3000 /path   # ... another folder
 *
 * Why not `python -m http.server`:
 *   • iOS Safari and Unity both use HTTP Range requests; that server ignores
 *     them, which breaks the chunked loader's size probes and any resumable
 *     fetch;
 *   • `.wasm` must be served as application/wasm or Unity cannot stream-compile
 *     it;
 *   • a 700 MB file must be streamed, never buffered into the server's RAM.
 *
 * Open http://<this machine's ip>:8080/play.html on the iPad.
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const root = path.resolve(process.argv[3] || repo);
const host = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
  '.data': 'application/octet-stream',
  '.part': 'application/octet-stream',
  '.resource': 'application/octet-stream',
};

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (/\.(data|wasm)\.part\d+$/.test(file)) return MIME['.' + /\.(data|wasm)\./.exec(file)[1]];
  return 'application/octet-stream';
}

function human(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';

    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      console.log('404 ' + rel);
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(302, { location: rel.replace(/\/?$/, '/') + 'index.html' }).end();
      return;
    }

    const headers = {
      'content-type': contentType(file),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    };

    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        if (m[1] === '' && m[2] !== '') {
          start = Math.max(0, stat.size - Number(m[2]));
        } else {
          start = Number(m[1] || 0);
          end = m[2] === '' ? stat.size - 1 : Number(m[2]);
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
          res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
          return;
        }
        headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
        res.writeHead(206, headers);
      } else {
        headers['content-length'] = String(stat.size);
        res.writeHead(200, headers);
      }
    } else {
      headers['content-length'] = String(stat.size);
      res.writeHead(200, headers);
    }

    const length = end - start + 1;
    if (req.method === 'HEAD') {
      res.end();
    } else {
      await new Promise((resolve) => {
        const stream = fs.createReadStream(file, { start, end, highWaterMark: 1 << 19 });
        stream.on('error', () => res.destroy());
        stream.on('end', resolve);
        stream.pipe(res);
      });
    }
    if (stat.size > 4 * 1048576) {
      console.log((range ? '206 ' : '200 ') + rel + '  ' + human(length) + '  (' + (Date.now() - started) + 'ms)');
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('server error: ' + err.message);
    console.log('500 ' + req.url + ' ' + err.message);
  }
});

server.listen(port, host, () => {
  console.log('Silksong web port served from ' + root);
  console.log('  local:   http://127.0.0.1:' + port + '/play.html');
  console.log('  network: http://<this machine ip>:' + port + '/play.html   ← open this on the iPad');
});
