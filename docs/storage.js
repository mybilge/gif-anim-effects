const encoder = new TextEncoder();
const root = new URL('.', document.baseURI).pathname;
const namespace = `gif-anim:${root}`;
let files, database;
const pendingBlobs = new Set();

function commit(next) {
  localStorage.setItem(namespace, JSON.stringify(next));
  files = next;
}

function assertPath(path) {
  if (!/^\/(app|tmp)(\/|$)/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) {
    throw new Error(`Invalid app storage path: ${path}`);
  }
}

function entry(path) {
  const value = files[path];
  if (!value) throw new Error(`Missing app file: ${path}`);
  return value;
}

function transaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('blobs', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error);
    action(tx.objectStore('blobs'), (value) => { result = value; });
  });
}

export const storage = {
  async cleanup() {
    const used = new Set([...Object.values(files).map((file) => file.blob), ...pendingBlobs]);
    await transaction('readwrite', (store) => {
      const cursor = store.openKeyCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        if (!used.has(current.key)) store.delete(current.key);
        current.continue();
      };
    });
  },
  call(method, path, argument) {
    assertPath(path);
    const arg = JSON.parse(argument);
    const next = { ...files };
    let result = null;
    switch (method) {
      case 'exists': result = Object.hasOwn(files, path); break;
      case 'text':
        if (typeof entry(path).text !== 'string') throw new Error(`Not a text file: ${path}`);
        result = entry(path).text; break;
      case 'size': result = entry(path).size; break;
      case 'writeText':
        if (!entry(path.slice(0, path.lastIndexOf('/'))).directory) throw new Error(`Parent is not a folder: ${path}`);
        next[path] = { text: arg, size: encoder.encode(arg).length }; commit(next); break;
      case 'mkdir': {
        const parts = path.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          const folder = `/${parts.slice(0, i).join('/')}`;
          if (next[folder] && !next[folder].directory) throw new Error(`Not a folder: ${folder}`);
          if (i < parts.length && !arg && !next[folder]) throw new Error(`Missing parent: ${folder}`);
          next[folder] = { directory: true };
        }
        commit(next); break;
      }
      case 'list':
        if (!entry(path).directory) throw new Error(`Not a folder: ${path}`);
        result = Object.entries(files).filter(([p]) => p.startsWith(`${path}/`) && (arg || !p.slice(path.length + 1).includes('/')))
          .map(([p, value]) => ({ path: p, directory: !!value.directory })); break;
      case 'rename':
      case 'copy': {
        assertPath(arg); entry(path);
        if (!entry(arg.slice(0, arg.lastIndexOf('/'))).directory) throw new Error(`Missing target parent: ${arg}`);
        if (files[path].directory && files[arg]) throw new Error(`Folder already exists: ${arg}`);
        for (const [p, value] of Object.entries(files)) {
          if (p !== path && !p.startsWith(`${path}/`)) continue;
          next[arg + p.slice(path.length)] = value;
          if (method === 'rename') delete next[p];
        }
        commit(next); break;
      }
      case 'delete': {
        entry(path);
        const children = Object.keys(files).filter((p) => p.startsWith(`${path}/`));
        if (!arg && children.length) throw new Error(`Folder is not empty: ${path}`);
        for (const p of [path, ...children]) delete next[p];
        commit(next); break;
      }
      default: throw new Error(`Unknown storage operation: ${method}`);
    }
    return JSON.stringify(result);
  },
  async read(path) {
    assertPath(path);
    const value = entry(path);
    if (typeof value.text === 'string') return encoder.encode(value.text);
    const bytes = await transaction('readonly', (store, done) => {
      const request = store.get(value.blob);
      request.onsuccess = () => done(request.result);
    });
    if (!bytes) throw new Error(`Missing IndexedDB blob: ${path}`);
    return new Uint8Array(bytes);
  },
  async write(path, bytes) {
    assertPath(path);
    entry(path.slice(0, path.lastIndexOf('/')));
    const blob = crypto.randomUUID();
    pendingBlobs.add(blob);
    try {
      await transaction('readwrite', (store) => store.put(bytes, blob));
      // Blobs are immutable: a failed metadata write leaves the previous file intact.
      commit({ ...files, [path]: { blob, size: bytes.length } });
    } finally { pendingBlobs.delete(blob); }
    await storage.cleanup();
  },
};

window.gifStorage = storage;
window.gifStorageReady = (async () => {
  let acquired;
  const lockReady = new Promise((resolve, reject) => { acquired = { resolve, reject }; });
  navigator.locks.request(namespace, { ifAvailable: true }, async (lock) => {
    if (!lock) { acquired.reject(new Error('GIF Anim is already open in another tab')); return; }
    acquired.resolve();
    await new Promise(() => {});
  }).catch(acquired.reject);
  await lockReady;
  const saved = localStorage.getItem(namespace);
  files = saved === null ? { '/app': { directory: true }, '/tmp': { directory: true } } : JSON.parse(saved);
  for (const [path, value] of Object.entries(files)) {
    assertPath(path);
    if (!value || (!value.directory && !('text' in value) && typeof value.blob !== 'string')) throw new Error(`Invalid storage index: ${path}`);
  }
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(namespace, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('blobs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  await storage.cleanup();
})().then(() => null, (error) => String(error));
