// In-memory file system for running the board's Node scripts in a browser (the shared board's
// Refresh). Files live in globalThis.__VFS, seeded from seed.json and shared by every step, so one
// script's output is the next one's input exactly as on disk. Paths are POSIX under /app.
const V = (globalThis.__VFS ||= { files: new Map(), mtime: new Map() });

function norm(p) {
  if (p && typeof p === 'object' && 'pathname' in p) p = p.pathname;
  p = String(p).replace(/\\/g, '/');
  if (p.startsWith('file://')) p = new URL(p).pathname;
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(decodeURIComponent(seg));
  }
  return '/' + out.join('/');
}
const isDir = (k) => { const pre = k.endsWith('/') ? k : k + '/'; for (const f of V.files.keys()) if (f.startsWith(pre)) return true; return false; };
const enoent = (k) => Object.assign(new Error(`ENOENT: no such file or directory, '${k}'`), { code: 'ENOENT' });
const text = (d) => (typeof d === 'string' ? d : d instanceof Uint8Array ? new TextDecoder().decode(d) : String(d));

export function existsSync(p) { const k = norm(p); return V.files.has(k) || isDir(k); }
export function readFileSync(p) { const k = norm(p); if (!V.files.has(k)) throw enoent(k); return V.files.get(k); }
export function writeFileSync(p, d) { const k = norm(p); V.files.set(k, text(d)); V.mtime.set(k, Date.now()); }
export function mkdirSync() {}
export function readdirSync(p) {
  const pre = norm(p).replace(/\/?$/, '/'), names = new Set();
  for (const f of V.files.keys()) if (f.startsWith(pre)) names.add(f.slice(pre.length).split('/')[0]);
  return [...names];
}
export function statSync(p) {
  const k = norm(p);
  if (!V.files.has(k) && !isDir(k)) throw enoent(k);
  const m = V.mtime.get(k) ?? 0;
  return { mtimeMs: m, mtime: new Date(m), size: (V.files.get(k) || '').length, isFile: () => V.files.has(k), isDirectory: () => !V.files.has(k) };
}
export function copyFileSync(a, b) { writeFileSync(b, readFileSync(a)); }
export function renameSync(a, b) { writeFileSync(b, readFileSync(a)); V.files.delete(norm(a)); }
export function unlinkSync(p) { V.files.delete(norm(p)); }

export const promises = {
  readFile: async (p) => readFileSync(p),
  writeFile: async (p, d) => writeFileSync(p, d),
  mkdir: async () => {},
  stat: async (p) => statSync(p),
  readdir: async (p) => readdirSync(p),
};
export const readFile = promises.readFile, writeFile = promises.writeFile, mkdir = promises.mkdir, stat = promises.stat, readdir = promises.readdir;
export default { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync, unlinkSync, promises };
