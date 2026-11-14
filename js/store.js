// Browser storage. Settings + API key in localStorage; bets, snapshots and caches in IndexedDB.
const DB_NAME = 'line-board';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('bets', { keyPath: 'id' });
      const s = d.createObjectStore('snaps', { autoIncrement: true });
      s.createIndex('eventId', 'eventId');
      s.createIndex('t', 't');
      d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const st = t.objectStore(store);
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
};
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const getAll = (store) => tx(store, 'readonly', (s) => reqP(s.getAll()));
export const put = (store, v) => tx(store, 'readwrite', (s) => { s.put(v); });
export const putMany = (store, vs) => tx(store, 'readwrite', (s) => { vs.forEach((v) => s.put(v)); });
export const del = (store, k) => tx(store, 'readwrite', (s) => { s.delete(k); });
export const clear = (store) => tx(store, 'readwrite', (s) => { s.clear(); });
export const kvGet = async (k) => (await tx('kv', 'readonly', (s) => reqP(s.get(k))))?.v;
export const kvSet = (k, v) => put('kv', { k, v });

export async function pruneSnaps(beforeMs) {
  const d = await db();
  return new Promise((res) => {
    const t = d.transaction('snaps', 'readwrite');
    const idx = t.objectStore('snaps').index('t');
    idx.openCursor(IDBKeyRange.upperBound(beforeMs)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };
    t.oncomplete = res;
  });
}

export function lsGet(k, def) {
  try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }

export async function askPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
