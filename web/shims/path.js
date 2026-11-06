// POSIX path helpers for the browser build (the scripts only use join/resolve/dirname/basename).
const clean = (p) => {
  const abs = p.startsWith('/'), out = [];
  for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
};
export const sep = '/';
export const join = (...a) => clean(a.filter((x) => x !== '').join('/'));
export const resolve = (...a) => { let p = ''; for (const x of a) p = x.startsWith('/') ? x : p + '/' + x; return clean(p.startsWith('/') ? p : '/app/' + p); };
export const dirname = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i <= 0 ? '/' : c.slice(0, i); };
export const basename = (p, ext) => { const b = clean(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export const relative = (a, b) => clean(b).replace(clean(a) + '/', '');
export const posix = { sep, join, resolve, dirname, basename, extname, relative };
export default { sep, join, resolve, dirname, basename, extname, relative, posix };
