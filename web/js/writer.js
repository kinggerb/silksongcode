/* ============================================================================
 * writer.js — OPFS ("Origin Private File System") writer worker
 * ----------------------------------------------------------------------------
 * Why this file exists:
 *   A Silksong WebGL build is a few hundred MB of `Build/*.partN` chunks that a
 *   naive page glues together *in RAM* (parts -> Blob -> ArrayBuffer -> Unity's
 *   own copy), which needs ~3-4x the file size in memory at once and gets the
 *   Safari tab jetsam-killed on an iPad right at the end of the progress bar.
 *
 *   Instead this worker streams every part straight onto disk (OPFS) and the
 *   page only ever hands Unity one file-backed blob URL. Peak RAM during the
 *   download drops from gigabytes to a few MB.
 *
 *   Real disk writes use FileSystemSyncAccessHandle, which is ONLY allowed
 *   inside a worker (Safari 15.2+, Chrome 102+). Writing off the main thread
 *   also keeps the page responsive while hundreds of MB land on disk.
 *
 * Protocol (request/response, every message carries an `id`):
 *   {id, type:'open',    dir, name, expected, resume}   -> {ready, size, canResume}
 *   {id, type:'write',   data:ArrayBuffer, at, flush}   -> {written, size}
 *   {id, type:'finish'}                                 -> {size}
 *   {id, type:'stat',    dir, name}                     -> {size}   (-1 = missing)
 *   {id, type:'putText', dir, name, text}               -> {ok:true}
 *   {id, type:'getText', dir, name}                     -> {text|null}
 *   {id, type:'remove',  dir, name}                     -> {ok:true}
 *   {id, type:'quit'}                                   -> {ok:true}
 *   any failure                                         -> {id, error:{name,message,op}}
 * ==========================================================================*/

'use strict';

var syncHandle = null; // FileSystemSyncAccessHandle of the file currently open
var fileHandle = null; // FileSystemFileHandle of the same file
var currentDir = null; // name of the OPFS directory holding `fileHandle`

function reply(id, payload) {
  var msg = payload || {};
  msg.id = id;
  self.postMessage(msg);
}

function fail(id, err, op) {
  self.postMessage({
    id: id,
    error: {
      name: (err && err.name) || 'Error',
      message: (err && err.message) || String(err),
      op: op || null,
    },
  });
}

async function getDir(name) {
  var root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function openFile(dirName, fileName, expected, resume) {
  var dir = await getDir(dirName);
  fileHandle = await dir.getFileHandle(fileName, { create: true });
  currentDir = dirName;

  // createSyncAccessHandle() takes an EXCLUSIVE lock on the file, so it is
  // refused while anything else holds one — and the two engines disagree about
  // how to say it: Chromium throws NoModificationAllowedError, WebKit throws
  // InvalidStateError ("The object is in an invalid state."). Browsers also
  // release the lock asynchronously after the holder dies, so a reload can land
  // inside that window; stream.js retries the open for a few seconds rather
  // than treating either refusal as a broken cache. It is not implemented
  // outside workers.
  syncHandle = await fileHandle.createSyncAccessHandle();

  var size = 0;
  try {
    size = syncHandle.getSize();
  } catch (e) {
    size = 0;
  }

  // Keep what is on disk when resuming; anything oversized (or a fresh start)
  // is truncated so the file can never contain a mix of two downloads.
  var start = 0;
  if (resume && size > 0 && (expected <= 0 || size <= expected)) {
    start = size;
  } else if (size !== 0) {
    syncHandle.truncate(0);
    start = 0;
  }

  return start;
}

async function closeHandle() {
  if (!syncHandle) return;
  try {
    syncHandle.flush();
  } catch (e) {
    /* flush is best effort */
  }
  try {
    syncHandle.close();
  } catch (e) {
    /* ignore */
  }
  syncHandle = null;
  fileHandle = null;
  currentDir = null;
}

self.onmessage = async function (event) {
  var msg = event.data || {};
  var id = msg.id;

  try {
    switch (msg.type) {
      case 'open': {
        var start = await openFile(msg.dir, msg.name, msg.expected, msg.resume);
        reply(id, { ready: true, size: start, canResume: start > 0 });
        break;
      }

      case 'write': {
        if (!syncHandle) throw new Error('write before open');
        var bytes = new Uint8Array(msg.data);
        var written = syncHandle.write(bytes, { at: msg.at });
        // A short write would silently corrupt the file: refuse it instead.
        if (written !== bytes.byteLength) {
          throw new Error('short write: ' + written + '/' + bytes.byteLength + ' bytes at ' + msg.at);
        }
        if (msg.flush) syncHandle.flush();
        reply(id, { written: written });
        break;
      }

      case 'flush': {
        if (!syncHandle) throw new Error('flush before open');
        syncHandle.flush();
        reply(id, { ok: true });
        break;
      }

      case 'finish': {
        if (!syncHandle) throw new Error('finish before open');
        syncHandle.flush();
        var size = syncHandle.getSize();
        await closeHandle();
        reply(id, { size: size });
        break;
      }

      case 'stat': {
        var dirStat = await getDir(msg.dir);
        try {
          var fh = await dirStat.getFileHandle(msg.name, { create: false });
          var f = await fh.getFile();
          reply(id, { size: f.size });
        } catch (e) {
          reply(id, { size: -1 });
        }
        break;
      }

      case 'putText': {
        var d = await getDir(msg.dir);
        var th = await d.getFileHandle(msg.name, { create: true });
        var wh = await th.createSyncAccessHandle();
        try {
          wh.truncate(0);
          wh.write(new TextEncoder().encode(msg.text), { at: 0 });
          wh.flush();
        } finally {
          wh.close();
        }
        reply(id, { ok: true });
        break;
      }

      case 'getText': {
        var d2 = await getDir(msg.dir);
        try {
          var rh = await d2.getFileHandle(msg.name, { create: false });
          var rf = await rh.getFile();
          reply(id, { text: await rf.text() });
        } catch (e) {
          reply(id, { text: null });
        }
        break;
      }

      case 'remove': {
        var d3 = await getDir(msg.dir);
        try {
          await d3.removeEntry(msg.name);
        } catch (e) {
          /* already gone */
        }
        reply(id, { ok: true });
        break;
      }

      case 'quit': {
        await closeHandle();
        reply(id, { ok: true });
        self.close();
        break;
      }

      default:
        throw new Error('unknown message type: ' + msg.type);
    }
  } catch (err) {
    // Make sure a half-open handle cannot block a retry.
    if (syncHandle && (msg.type === 'open' || msg.type === 'finish')) {
      await closeHandle();
    }
    fail(id, err, msg.type);
  }
};
