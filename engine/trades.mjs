// Trade market from the command line (the board's "Trade market" sections run the same engine/trades-core.js):
//   node engine/trades.mjs points|cats                      every team's holes and surplus, your trade chips
//   node engine/trades.mjs cats --give "Jackson LaCombe" [--add "Seth Jones,Noah Dobson"] [--for F|G|C|LW|RW|D]
// --give: your player(s) to trade away (comma-separated): 1-for-1 returns from every team, ranked by potential,
//         with what the trade does to THEIR lineup (trades they'd never take are left out).
// --add:  wire pickups made first; your weakest healthy players are dropped for them.
// --for:  only returns at these positions (F = any forward).
//   node engine/trades.mjs points|cats --consolidate [--for F|G|D] [--limit 12] [--min 10 (lowest % likely shown)]
//         2-for-1s: every pair of your players (never the keep / never-drop list) for one better player,
//         printed as a table (likely, your lineup, who you'd cut when the injured come back, why they'd talk)
//   node engine/trades.mjs points|cats --team "kopi"    one team as its manager sees it (Yahoo ranks, depth per position)
// Teams that won't trade with you, and players never offered: engine/trade-rules.json (read fresh each run).
// Values are over the wire at each position: points league = projected fantasy points per game;
// Categories League = value per week at equal category weights (x10, as on the board).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tradeRules } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const load = (rel, name) => new Function(fs.readFileSync(path.join(ROOT, rel), 'utf8') + `;return ${name}`)();
const TradesCore = load('engine/trades-core.js', 'TradesCore');
const LEAGUE = process.argv[2];
if (!['points', 'cats'].includes(LEAGUE)) { console.error('Usage: node engine/trades.mjs points|cats [--give "A,B"] [--add "X,Y"] [--for F|G|C|LW|RW|D]'); process.exit(1); }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const list = (k) => (arg(k) || '').split(',').map((s) => s.trim()).filter(Boolean);

let M, fmt, wire;
if (LEAGUE === 'points') {
  const B = read('out/board.json');
  M = { ...B.tradeData, repl: B.model.replacement, goalieTradeDiscount: 0.7, rosterSize: B.model.ROSTER_MAX, rules: tradeRules(ROOT, 'points') }; // as on the board: acquired goalies at 70% (volatile)
  fmt = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} pts/gm`;
  wire = (B.bestOnWire || []).slice(0, 5).map((p) => `${p.name} (${p.team} ${p.pos.join('/')}) ${fmt(p.vor)}`);
} else {
  const C = load('engine/cats-core.js', 'CatsCore');
  const CATS = read('out/cats.json'), D = CATS.core, w = C.weights({});
  const me = read('yahoo/data/chrome-raw-22222.json');
  const repl = C.replacement(D, w); // forwards share one level (Util slots), as on the board
  const weekly = (p) => (p.kind === 'G' ? 3.5 * (p.shareLong ?? p.share ?? 0) : 3.5 * (p.pPlayLong ?? 1));
  M = {
    me: me.myTeam.id, slots: CATS.league.slots, teamNames: me.teamNames, repl, rules: tradeRules(ROOT, 'cats'), rosterSize: CATS.league.slots.length + (CATS.league.bench || 0),
    players: D.players.map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos.filter((x) => x !== 'Util'), owner: p.mine ? me.myTeam.id : p.rosteredBy || null, value: C.perWeek(p, w), age: p.age ?? null, pre: p.pre, cur: p.cur, gp: p.gp, injured: !!(p.injured || p.ir), back: p.back || null, src: p })),
    catsOf: (p) => Object.fromEntries(C.CATS.map((c) => [c.short, (p.src.contrib[c.k] || 0) * weekly(p.src)])),
  };
  fmt = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 10).toFixed(1)}/wk`;
  const T0 = TradesCore.build(M);
  wire = M.players.filter((p) => !p.owner && p.src.healthyFrom < 7).sort((a, b) => T0.vor(b) - T0.vor(a)).slice(0, 5).map((p) => `${p.name} (${p.team} ${p.pos.join('/')}) ${fmt(T0.vor(p))}`);
}
const T = TradesCore.build(M);
const find = (n) => M.players.find((p) => p.name.toLowerCase() === n.toLowerCase()) || (() => { throw new Error(`No player "${n}" in this league`); })();
const pl = (p) => `${p.name} (${p.team} ${p.pos.join('/')}${p.injured ? ', out' + (p.back ? ' to ' + p.back.slice(5) : '') : ''}) ${fmt(T.vor(p))}`;
const plM = (p) => `${pl(p)}${Math.abs(T.hype(p)) >= 0.05 ? ` (market ${fmt(T.mvor(p))})` : ''}`;
const describe = (pr) => [pr.holes.map((l) => l.text).join(', '), pr.strengths.map((l) => l.text).join(', '),
  pr.bench.length ? `bench surplus: ${pr.bench.map((p) => `${p.name} ${p.pos.join('/')}`).join(', ')}` : '',
  pr.catsWeak.join(', '), pr.catsStrong.join(', ')].filter(Boolean).join('; ');

console.log(`${LEAGUE === 'points' ? 'Points League (points)' : 'Categories League (categories)'}: values are over the wire at each position`);
console.log(`\nYou (${T.name(T.me)}): ${describe(T.profile(T.me))}`);
const LU = T.lineup(T.rosters[T.me]);
for (const p of [...T.rosters[T.me]].sort((a, b) => T.vor(b) - T.vor(a))) console.log(`  ${LU.starters.has(p) ? 'start' : p.injured ? 'out  ' : 'bench'} ${pl(p)}`);
console.log(`Best on the wire: ${wire.join(' | ')}`);
console.log(`Trade chips: ${T.chips().map((c) => `${pl(c.p)} (${c.why})`).join(' | ') || 'none'}`);

if (arg('--team')) {
  // one team the way its manager sees it: every player with Yahoo ranks, then depth per position
  const q = arg('--team').toLowerCase(), t = T.ids.find((x) => T.name(x).toLowerCase().includes(q));
  if (!t) { console.error(`No team matching "${arg('--team')}"`); process.exit(1); }
  console.log(`
${T.name(t)}${T.blocked(t) ? " (won't trade with you)" : ''}${M.rules.notes?.[T.name(t)] ? ` | note: ${M.rules.notes[T.name(t)]}` : ''}`);
  for (const p of [...T.rosters[t]].sort((a, b) => T.nameVal(b) - T.nameVal(a))) console.log(`  ${p.name} (${p.team} ${p.pos.join('/')}${p.injured ? ', out' + (p.back ? ' to ' + p.back.slice(5) : '') : ''}) Yahoo pre ${p.pre ?? '–'} / now ${p.cur ?? '–'} | yours ${fmt(T.vor(p))}, name value ${fmt(T.nameVal(p))}`);
  console.log(`  Depth (healthy players in Yahoo's top ${T.cut}): ${['C', 'LW', 'RW', 'D', 'G'].map((x) => `${x} ${T.depth(T.rosters[t], x).toFixed(1)} ${T.level(T.rosters[t], x)}`).join(' | ')}`);
  process.exit(0);
}
if (process.argv.includes('--consolidate')) {
  const rows = T.consolidate({ for: list('--for'), limit: Number(arg('--limit')) || 14, minLikely: arg('--min') ? Number(arg('--min')) / 100 : undefined });
  const last = (p) => p.name.split(' ').slice(1).join(' ') || p.name;
  const cut = (ps) => (ps.length ? ps.map(last).join(', ') : 'nobody');
  console.log(`
2-for-1 consolidation (blocked: ${M.rules.blocked.join(', ') || 'none'}; never offered: ${M.rules.keep.map((n) => n.split(' ').pop()).join(', ') || 'none'})`);
  if (rows.length) console.log(`When everyone hurt is back you'd cut today: ${cut(rows[0].cutBefore)}`);
  console.log("\n| # | You send | You get | From | Likely | Your lineup | Then you cut | Their side |");
  console.log('|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.give.map((p) => `${p.name} (${p.pos.join('/')})`).join(' + ')} | **${r.player.name}** (${r.player.team} ${r.player.pos.join('/')}${r.player.injured ? ', out' : ''}) | ${r.teamName} | ${Math.round(r.likely * 100)}% | ${fmt(r.you)} now, ${fmt(r.youFull)} all back | ${cut(r.cutAfter)} | ${r.reasons.join('; ')} |`));
  if (!rows.length) console.log('| – | none: no 2-for-1 a willing team would take improves your lineup | | | | | | |');
  const notes = Object.entries(M.rules.notes || {});
  if (notes.length) console.log(`
Notes on managers: ${notes.map(([t, x]) => `${t}: ${x}`).join(' | ')}`);
  process.exit(0);
}
const give = list('--give').map(find);
if (!give.length) {
  console.log('\nOther teams:');
  for (const t of T.ids.filter((x) => x !== T.me)) console.log(`  ${T.name(t)}: ${describe(T.profile(t))}`);
  process.exit(0);
}
const rows = T.shop(give.map((p) => p.id), { addIds: list('--add').map((n) => find(n).id), for: list('--for') });
console.log(`\nTrading ${give.map(plM).join(' + ')}${list('--add').length ? ` after picking up ${list('--add').join(', ')}` : ''}. Returns ranked by potential (how likely they deal + how much you win):`);
rows.slice(0, 12).forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.flag ? '!! ' + r.flag.text + ': ' : ''}${plM(r.player)} from ${r.teamName} [likely ${Math.round(r.likely * 100)}%, score ${r.score.toFixed(2)}]: player value ${fmt(r.gain)}, your lineup ${fmt(r.you)}, their view ${fmt(r.them)}`);
  const f = r.forYou;
  console.log(`     for you: ${[...f.stepIn.map((x) => `${x} takes his lineup spot`), f.pv >= 0.005 ? `better player (${fmt(f.pv)})` : '', ...f.fills, f.starts ? '' : "won't start for you yet"].filter(Boolean).join('; ') || '-'} | they'd talk: ${r.reasons.join(', ')}`);
});
if (rows[0]?.forYou.giveWhy.length) console.log(`  Giving him up: ${rows[0].forYou.giveWhy.join('; ')}`);
if (!rows.length) console.log('  none: no return improves your lineup in a trade the other side would see as fair.');
