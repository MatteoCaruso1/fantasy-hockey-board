// Inline out/board.json (points league) and out/cats.json (Categories League) into
// page/template.html -> out/board.html (the published artifact)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const board = fs.readFileSync(path.join(ROOT, 'out', 'board.json'), 'utf8');
const tpl = fs.readFileSync(path.join(ROOT, 'page', 'template.html'), 'utf8');
const safe = JSON.stringify(JSON.parse(board)).replace(/</g, '\\u003c');
// the Categories League tab: its data, the shared categories core and the tab's UI
const catsPath = path.join(ROOT, 'out', 'cats.json');
let ui = '';
if (fs.existsSync(catsPath)) {
  const cats = JSON.stringify(JSON.parse(fs.readFileSync(catsPath, 'utf8'))).replace(/</g, '\\u003c');
  const core = fs.readFileSync(path.join(ROOT, 'engine', 'cats-core.js'), 'utf8');
  ui = fs.readFileSync(path.join(ROOT, 'page', 'cats-ui.js'), 'utf8').replace('/*__CATS__*/null', () => cats).replace('/*__CATSCORE__*/', () => core);
}
// the shared board's worker (web/config.json, written by web/deploy.mjs): Refresh and the live link
const cfgPath = path.join(ROOT, 'web', 'config.json');
const web = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8').trim() : 'null';
const trades = fs.readFileSync(path.join(ROOT, 'engine', 'trades-core.js'), 'utf8');
export const html = tpl.replace('/*__TRADESCORE__*/', () => trades).replace('/*__BOARD__*/null', () => safe).replace('/*__CATSUI__*/', () => ui).replace('/*__WEB__*/null', () => web);
fs.writeFileSync(path.join(ROOT, 'out', 'board.html'), html);
console.log('Wrote out/board.html');
