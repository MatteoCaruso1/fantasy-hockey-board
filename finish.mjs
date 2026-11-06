// Second half of the weekly run, after the Chrome reads (run it even when they were skipped):
//   node finish.mjs
// 1. imports the points-league Chrome read if it is newer than the saved league data
// 2. reruns both analyses and the page (out/board.html, for the claude.ai artifact)
// 3. deploys the shared board, so the link and its Refresh button use these rosters
// 4. reads the link back and fails if it does not show this run's rosters and opponents
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const run = (...args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const chrome = path.join(ROOT, 'yahoo', 'data', 'chrome-raw.json');
if (fs.existsSync(chrome) && new Date(read('yahoo/data/chrome-raw.json').fetchedAt) > new Date(read('yahoo/data/league-11111.json').fetchedAt)) {
  run('yahoo/import-chrome.mjs');
}
run('engine/analyze.mjs');
run('engine/cats.mjs');
run('engine/outlook.mjs');
run('page/build.mjs');
run('web/deploy.mjs');

// what the link now serves must be this run
const board = read('out/board.json'), cats = read('out/cats.json');
const { api } = read('web/config.json');
const live = await (await fetch(`${api}/latest?v=${Date.now()}`, { cache: 'no-store' })).json();
const checks = [
  ['points rosters', live.board?.dataNotes?.yahooSnapshot, board.dataNotes?.yahooSnapshot],
  ['points opponent', live.board?.opponent?.name, board.opponent?.name],
  ['Categories League rosters', live.cats?.yahooRead, cats.yahooRead],
  ['Categories League opponent', live.cats?.team?.opponent?.name, cats.team?.opponent?.name],
  ['week', live.board?.week?.start ?? JSON.stringify(live.board?.week), board.week?.start ?? JSON.stringify(board.week)],
];
const bad = checks.filter(([, got, want]) => got !== want);
if (bad.length) {
  console.error(`!! The shared board does NOT match this run: ${bad.map(([k, got, want]) => `${k} is ${got}, expected ${want}`).join('; ')}`);
  process.exit(1);
}
const days = (t) => Math.round((Date.now() - new Date(t)) / 864e5 * 10) / 10;
console.log(`Link verified: points vs ${board.opponent?.name} (rosters ${days(board.dataNotes.yahooSnapshot)} days old), Categories League vs ${cats.team?.opponent?.name} (rosters ${days(cats.yahooRead)} days old).`);
console.log('Publish out/board.html to the artifact.');
