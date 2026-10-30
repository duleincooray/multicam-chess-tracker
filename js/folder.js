// folder.js — save PGN files straight into a folder the user picks (Chrome/Edge
// File System Access API). The folder handle is kept in IndexedDB so the choice
// survives reloads; the browser asks for permission again after a restart.

const DB = 'chesscam', STORE = 'handles', KEY = 'gamesDir';
let handle = null;

export const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Load the remembered folder, if any. */
export async function load() {
  if (!supported) return null;
  try { handle = (await idb('readonly', (s) => s.get(KEY))) || null; } catch { handle = null; }
  return handle;
}

/** Ask the user to pick a folder. Must be called from a click. */
export async function choose() {
  handle = await window.showDirectoryPicker({ id: 'chess-games', mode: 'readwrite' });
  try { await idb('readwrite', (s) => s.put(handle, KEY)); } catch { /* remembered for this session only */ }
  return handle;
}

export async function forget() {
  handle = null;
  try { await idb('readwrite', (s) => s.delete(KEY)); } catch { /* nothing stored */ }
}

export const folderName = () => handle?.name ?? null;

/** True if we may write; asks for permission if needed (needs a click on first use after a restart). */
export async function ensurePermission(ask = true) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** Folder handle for "a/b" inside the chosen folder, creating folders as needed. */
async function dirFor(parts, create) {
  let dir = handle;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

/**
 * Write (or overwrite) a file in the chosen folder. `path` may contain sub-folders
 * ("2026-10-30_121536/cam-A/ply-001.jpg"); `data` is text or a Blob. Returns true on success.
 */
export async function writeFile(path, data) {
  if (!(await ensurePermission())) return false;
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await dirFor(parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
  return true;
}

export async function removeFile(path) {
  if (!path || !(await ensurePermission(false))) return;
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  try { await (await dirFor(parts, false)).removeEntry(name); } catch { /* already gone */ }
}
