// node:crypto for the browser build: the NHL fetchers only hash URLs into cache file names, so
// any stable hash works (FNV-1a, 4 x 32-bit lanes -> 32 hex chars).
export function createHash() {
  let s = '';
  const h = {
    update(x) { s += String(x); return h; },
    digest() {
      let out = '';
      for (let lane = 0; lane < 4; lane++) {
        let v = (0x811c9dc5 ^ (lane * 0x9e3779b1)) >>> 0;
        for (let i = 0; i < s.length; i++) { v ^= s.charCodeAt(i); v = Math.imul(v, 0x01000193) >>> 0; }
        out += v.toString(16).padStart(8, '0');
      }
      return out;
    },
  };
  return h;
}
export default { createHash };
