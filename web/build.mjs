// Builds the shared board for Cloudflare (web/dist):
//   index.html      the board page (same as out/board.html), wired to the worker
//   pipeline/*.js   the board's own scripts bundled for the browser (Refresh runs them)
//   runner.js       the Refresh orchestrator
//   moves.html      auto moves (queued Yahoo add/drops the worker's cron makes)
//   seed.json       this week's inputs the browser can't fetch itself (projections, league reads,
//                   shift-chart lines, last saved DailyFaceoff/ESPN pulls, last season's NHL stats)
//   node web/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB, '..');
const DIST = path.join(WEB, 'dist');
// clear the contents (not the folder: a running `wrangler dev` keeps it open)
if (fs.existsSync(DIST)) for (const f of fs.readdirSync(DIST)) fs.rmSync(path.join(DIST, f), { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'pipeline'), { recursive: true });

// ---- pipeline bundles ---------------------------------------------------------------------------
const ENTRIES = {
  'fetch-nhl': 'nhl/fetch-nhl.mjs', 'fetch-dfo': 'nhl/fetch-dfo.mjs', 'fetch-espn': 'nhl/fetch-espn.mjs',
  'yahoo-snapshot': 'yahoo/snapshot.mjs', analyze: 'engine/analyze.mjs', cats: 'engine/cats.mjs',
};
const SHIM = { 'node:fs': 'fs.js', 'node:fs/promises': 'fs.js', 'node:path': 'path.js', 'node:url': 'url.js', 'node:crypto': 'crypto.js' };
const nodeShims = {
  name: 'node-shims',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => {
      if (!SHIM[a.path]) return { errors: [{ text: `no browser shim for ${a.path}` }] };
      return { path: path.join(WEB, 'shims', SHIM[a.path]) };
    });
    // each script finds its folder from import.meta.url: pin it to its place under /app
    b.onLoad({ filter: /\.mjs$/ }, (a) => {
      const rel = path.relative(ROOT, a.path).replace(/\\/g, '/');
      const src = fs.readFileSync(a.path, 'utf8').replaceAll('import.meta.url', JSON.stringify('file:///app/' + rel));
      return { contents: src, loader: 'js' };
    });
  },
};
for (const [name, entry] of Object.entries(ENTRIES)) {
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    outfile: path.join(DIST, 'pipeline', name + '.js'), plugins: [nodeShims], inject: [path.join(WEB, 'shims', 'process.js')],
    logLevel: 'warning', legalComments: 'none',
  });
}
fs.copyFileSync(path.join(WEB, 'runner.js'), path.join(DIST, 'runner.js'));
// the owner's auto moves page (its API needs the private key, see worker.js)
fs.copyFileSync(path.join(WEB, 'moves.html'), path.join(DIST, 'moves.html'));

// ---- seed: inputs for a browser refresh -------------------------------------------------------------
const files = {}, mtime = {};
const add = (rel) => {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return;
  files['/app/' + rel] = fs.readFileSync(f, 'utf8');
  mtime['/app/' + rel] = fs.statSync(f).mtimeMs;
};
['engine/cats-core.js', 'projections/ag-2026-27.json', 'projections/cats-2026-27.json',
  'yahoo/data/league-11111.json', 'yahoo/data/league-22222.json', 'yahoo/data/chrome-raw-22222.json',
  'nhl/out/lines.json', 'nhl/out/dfo.json', 'nhl/out/espn.json'].forEach(add);
for (const dir of ['nhl/out/dfo-history', 'nhl/out/espn-history']) {
  const d = path.join(ROOT, dir);
  if (fs.existsSync(d)) fs.readdirSync(d).sort().slice(-12).forEach((f) => add(`${dir}/${f}`));
}
// last season's NHL stats never change: seed them so a refresh only downloads this season
for (const f of fs.readdirSync(path.join(ROOT, 'nhl/cache'))) if (/seasonId_3D2025/.test(f)) add(`nhl/cache/${f}`);
fs.writeFileSync(path.join(DIST, 'seed.json'), JSON.stringify({ builtAt: new Date().toISOString(), files, mtime }));

// ---- the page ------------------------------------------------------------------------------------------
const { html } = await import('../page/build.mjs?' + Date.now());
fs.writeFileSync(path.join(DIST, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"></head><body>${html}</body></html>`);
// a file opened from a co-manager's computer loads the pipeline from here: allow it
fs.writeFileSync(path.join(DIST, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: no-cache\n');
const size = (f) => (fs.statSync(path.join(DIST, f)).size / 1024).toFixed(0) + ' KB';
console.log(`web/dist: index.html ${size('index.html')}, seed.json ${size('seed.json')}, pipeline ${Object.keys(ENTRIES).map((n) => `${n} ${size('pipeline/' + n + '.js')}`).join(', ')}`);
