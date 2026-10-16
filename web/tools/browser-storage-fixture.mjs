// Execute the production writer in a Worker/OPFS model, including exclusive
// handles. Unlike writerFactory-only tests this covers probe and IPC setup.
import fs from 'node:fs';
import vm from 'node:vm';
const writerSource = fs.readFileSync(new URL('../js/writer.js', import.meta.url), 'utf8');
export function browserStorage(seed = {}) {
  const files = new Map(Object.entries(seed).map(([name, value]) => [name, Buffer.from(value)]));
  const locks = new Set(), messages = [], workers = new Set();
  const saved = ['navigator', 'Worker', 'isSecureContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const dir = {
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) { if (!opts.create) throw new Error('not found'); files.set(name, Buffer.alloc(0)); }
      return {
        kind: 'file', name,
        async getFile() { const file = new Blob([files.get(name)]); file.lastModified = 0; return file; },
        async createSyncAccessHandle() {
          if (locks.has(name)) { const error = new Error('file is locked'); error.name = 'NoModificationAllowedError'; throw error; }
          locks.add(name);
          return {
            getSize() { return files.get(name).length; },
            truncate(length) { const next = Buffer.alloc(length); files.get(name).copy(next); files.set(name, next); },
            write(bytes, { at = 0 } = {}) {
              const next = Buffer.alloc(Math.max(files.get(name).length, at + bytes.length));
              files.get(name).copy(next); Buffer.from(bytes).copy(next, at); files.set(name, next); return bytes.length;
            },
            flush() {}, close() { locks.delete(name); },
          };
        },
      };
    },
    async removeEntry(name) {
      if (locks.has(name)) throw new Error('cannot delete locked file');
      files.delete(name);
    },
    async *entries() { for (const name of files.keys()) yield [name, await dir.getFileHandle(name)]; },
  };
  const states = new Map();
  const navigator = { locks: {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      const mode = options.mode || 'exclusive';
      if (!states.has(name)) states.set(name, { exclusive: false, shared: 0, queue: [] });
      const state = states.get(name);
      const available = () => !state.exclusive && (mode === 'shared' || state.shared === 0);
      if (options.ifAvailable && !available()) return Promise.resolve().then(() => callback(null));
      return new Promise((resolve, reject) => {
        function grant() {
          if (mode === 'shared') state.shared++; else state.exclusive = true;
          Promise.resolve().then(() => callback({ name, mode })).then(resolve, reject).finally(() => {
            if (mode === 'shared') state.shared--; else state.exclusive = false;
            for (let i = 0; i < state.queue.length;) {
              if (state.queue[i].available()) state.queue.splice(i, 1)[0].grant(); else i++;
            }
          });
        }
        if (available()) grant(); else state.queue.push({ available, grant });
      });
    },
  }, storage: {
    async getDirectory() { return dir; },
    async estimate() { return { quota: 8 * 2 ** 30, usage: [...files.values()].reduce((sum, b) => sum + b.length, 0) }; },
  } };
  class Worker {
    constructor() {
      workers.add(this); this.closed = false;
      this.self = { postMessage: msg => queueMicrotask(() => this.onmessage?.({ data: msg })), close: () => { this.closed = true; workers.delete(this); } };
      this.context = vm.createContext({ self: this.self, navigator, Uint8Array, TextEncoder });
      vm.runInContext(writerSource, this.context);
    }
    postMessage(msg) {
      messages.push({ ...msg, data: undefined });
      queueMicrotask(() => { if (!this.closed) this.self.onmessage({ data: msg }); });
    }
    terminate() { this.closed = true; workers.delete(this); }
  }
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  Object.defineProperty(globalThis, 'Worker', { value: Worker, configurable: true });
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  return {
    files, messages, locks, workers, dir,
    restore() { workers.forEach(worker => worker.terminate()); saved.forEach(([name, desc]) => { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name]; }); },
  };
}
