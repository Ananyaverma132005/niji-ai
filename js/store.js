// Keeps documents and their vectors in IndexedDB, on this device only.

const DB_NAME = 'niji-ai';
const STORE = 'documents';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDocs() {
  try { return (await run('readonly', (s) => s.getAll())) || []; } catch { return []; }
}
export async function saveDoc(doc) {
  try { await run('readwrite', (s) => s.put(doc)); } catch { /* storage unavailable: keep in memory */ }
}
export async function deleteDoc(id) {
  try { await run('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
}
export async function clearDocs() {
  try { await run('readwrite', (s) => s.clear()); } catch { /* ignore */ }
}
