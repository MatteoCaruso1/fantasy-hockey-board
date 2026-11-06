// One command to rebuild the weekly board:
//   node refresh.mjs [--week YYYY-MM-DD]
// 1. NHL stats + schedule, shift-chart lines, DailyFaceoff lines/PP units, ESPN intel (injuries, Rotowire notes, odds)   2. Yahoo league snapshot (if the Yahoo login exists)
// 3. analysis               4. page -> out/board.html (then publish it as the artifact)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const run = (...args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
const extra = process.argv.slice(2);

run('nhl/fetch-nhl.mjs');
run('nhl/fetch-lines.mjs');
try { run('nhl/fetch-dfo.mjs'); } catch { console.warn('!! DailyFaceoff fetch failed; using the last saved lines.'); }
try { run('nhl/fetch-espn.mjs'); } catch { console.warn('!! ESPN intel fetch failed; using the last saved injuries, notes and odds.'); }
if (fs.existsSync(path.join(ROOT, 'secrets', 'yahoo-token.json'))) {
  try { run('yahoo/snapshot.mjs'); }
  catch { console.warn('!! Yahoo snapshot failed; using the last saved league data.'); }
  try { run('yahoo/snapshot.mjs', '--league', '22222'); }
  catch { console.warn('!! Yahoo snapshot of the Categories League failed; using its last Chrome read.'); }
} else {
  console.warn('!! No Yahoo login yet (run node yahoo/auth.mjs); using the last saved league data.');
}
run('engine/analyze.mjs', ...extra);
// Categories League (categories) tab: reads yahoo/data/chrome-raw-22222.json and the player model analyze just wrote
try { run('engine/cats.mjs'); } catch { console.warn('!! Categories board failed; the Categories League tab keeps its last data.'); }
try { run('engine/outlook.mjs'); } catch { console.warn('!! Outlook history failed; the team table shows no movement this run.'); }
run('page/build.mjs');
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'yahoo', 'data', 'league-11111.json'), 'utf8'));
console.log(`Done. Yahoo data from ${snap.fetchedAt} (${snap.source}). Publish out/board.html.`);
