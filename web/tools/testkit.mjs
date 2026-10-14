/* ============================================================================
 * testkit.mjs — a three-function test harness (no dependencies)
 * ----------------------------------------------------------------------------
 * The suites in this folder run with plain `node tools/test-*.mjs`. They use
 * this file so a failure prints what was expected and what happened, and so the
 * exit code is right for CI.
 * ==========================================================================*/

const state = { passed: 0, failed: 0, failures: [], current: '?' };

export function section(name) {
  state.current = name;
  console.log('\n▸ ' + name);
}

export function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => pass(name),
        (err) => fail(name, err)
      );
    }
    pass(name);
    return Promise.resolve();
  } catch (err) {
    fail(name, err);
    return Promise.resolve();
  }
}

function pass(name) {
  state.passed++;
  console.log('  ✓ ' + name);
}

function fail(name, err) {
  state.failed++;
  const message = (err && err.message) || String(err);
  state.failures.push(state.current + ' → ' + name + ': ' + message);
  console.log('  ✗ ' + name + '\n      ' + message);
}

export function eq(actual, expected, what = 'value') {
  if (actual !== expected) {
    throw new Error(what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

export function ok(value, what = 'value') {
  if (!value) throw new Error(what + ' should be truthy, got ' + JSON.stringify(value));
}

export function close(actual, expected, tolerance, what = 'number') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(what + ': expected ≈' + expected + ' (±' + tolerance + '), got ' + actual);
  }
}

export async function rejects(promise, pattern, what = 'call') {
  try {
    await promise;
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (pattern && !pattern.test(message)) {
      throw new Error(what + ' failed with the wrong message: ' + message);
    }
    return message;
  }
  throw new Error(what + ' should have failed but resolved');
}

export async function done(name = 'suite') {
  console.log('\n' + name + ': ' + state.passed + ' passed, ' + state.failed + ' failed');
  if (state.failed) {
    console.log('\nfailures:');
    state.failures.forEach((f) => console.log('  · ' + f));
  }
  // Test servers keep keep-alive sockets open (undici reuses them), which would
  // hold the event loop open long after the last assertion: leave deterministically.
  process.exit(state.failed ? 1 : 0);
}

/** Run a local static server (tools/serve.mjs style) for tests that need HTTP. */
export async function serveDir(dir, port = 0) {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.join(dir, decodeURIComponent(url.pathname));
    try {
      const stat = await fsp.stat(file);
      const range = req.headers.range;
      const headers = { 'content-length': String(stat.size), 'accept-ranges': 'bytes' };
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : stat.size - 1;
        headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
        headers['content-length'] = String(end - start + 1);
        res.writeHead(206, headers);
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const stop = () => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (e) {
      /* older node */
    }
    try {
      server.close();
    } catch (e) {
      /* already closed */
    }
  };
  return { server, port: server.address().port, url, stop };
}

export function tmpDir(name) {
  return path_join(process.env.TMPDIR || '/tmp', 'silksong-web-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
}
function path_join(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}
