// Publish the shared board: build web/dist, deploy the Cloudflare worker, and save this run's board as
// the latest (so the link opens on it). Run after refresh.mjs / the Chrome reads:
//   node web/deploy.mjs
// The first deploy learns the worker's address and writes web/config.json, which the page embeds.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB, '..');
const CFG = path.join(WEB, 'config.json');
const wrangler = (...args) => execFileSync(process.execPath, [path.join(WEB, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args], { cwd: WEB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const build = () => execFileSync(process.execPath, [path.join(WEB, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
const key = fs.readFileSync(path.join(WEB, 'wrangler.toml'), 'utf8').match(/WRITE_KEY\s*=\s*"([^"]+)"/)[1];

function deploy() {
  const out = wrangler('deploy');
  const url = out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  if (!url) throw new Error('Deployed, but no workers.dev address in the output:\n' + out.slice(-800));
  return url;
}

const cfg = fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')) : null;
build();
let url = deploy();
if (!cfg || cfg.base !== url) {
  fs.writeFileSync(CFG, JSON.stringify({ base: url, api: url + '/api', key, live: url }));
  build();
  url = deploy();
}
// rebuild the claude.ai copy too, so its button links to the live board
execFileSync(process.execPath, [path.join(ROOT, 'page', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });

// this run's data becomes what the link opens on
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'board.json'), 'utf8'));
board.refresh = { at: new Date().toISOString(), warnings: [], via: 'weekly run' };
const catsFile = path.join(ROOT, 'out', 'cats.json');
const latest = path.join(WEB, 'latest.json');
fs.writeFileSync(latest, JSON.stringify({ board, cats: fs.existsSync(catsFile) ? JSON.parse(fs.readFileSync(catsFile, 'utf8')) : null }));
wrangler('kv', 'key', 'put', 'latest', '--path', latest, '--binding', 'BOARD', '--remote');
fs.rmSync(latest);
console.log(`Shared board live at ${url}`);
