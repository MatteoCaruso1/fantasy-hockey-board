// Every team's projected finish, saved each refresh so the "What the model thinks" table can say who is rising
// or sliding (engine/trades-core.js verdicts). Runs after analyze and cats, before the page:
//   node engine/outlook.mjs
// 1. builds both leagues' trade market the way the page does and reads each team's projected finish
// 2. saves today's finishes in yahoo/data/outlook-history.json (one entry per day, the last 60 kept)
// 3. writes the latest earlier day's finishes (prevFinish) and a per-refresh seed (rotates the quips) into
//    out/board.json (tradeData) and out/cats.json, which the page reads
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const write = (rel, x) => fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(x));
const load = (rel, name) => new Function(fs.readFileSync(path.join(ROOT, rel), 'utf8') + `;return ${name}`)();
const TradesCore = load('engine/trades-core.js', 'TradesCore');
const CatsCore = load('engine/cats-core.js', 'CatsCore');

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const seed = Math.floor(Date.now() / 864e5);
const HIST = 'yahoo/data/outlook-history.json';
const hist = fs.existsSync(path.join(ROOT, HIST)) ? read(HIST) : {};
const finishes = (T) => Object.fromEntries(T.ids.map((t) => [t, T.profile(t).outlook?.finish]).filter(([, f]) => f));
const prevOf = (key) => [...(hist[key] || [])].reverse().find((e) => e.date < today) || null;
const save = (key, finish) => {
  const list = (hist[key] || []).filter((e) => e.date !== today);
  list.push({ date: today, finish });
  hist[key] = list.slice(-60);
};

// Points League (points): as page/template.html builds it
const B = read('out/board.json');
if (B.tradeData?.standings) {
  const prev = prevOf('points');
  B.tradeData.prevFinish = prev?.finish || null;
  B.tradeData.prevDate = prev?.date || null;
  B.tradeData.seed = seed;
  const T = TradesCore.build({ ...B.tradeData, repl: B.model.replacement, goalieTradeDiscount: 0.7 });
  save('points', finishes(T));
  write('out/board.json', B);
  console.log(`Outlook (points): ${Object.keys(hist.points.at(-1).finish).length} teams${prev ? `, compared with ${prev.date}` : ', first entry'}`);
}

// Categories League (categories): as page/cats-ui.js builds it, at default category weights
const CATS = read('out/cats.json');
if (CATS.standings) {
  const prev = prevOf('cats');
  CATS.prevFinish = prev?.finish || null;
  CATS.prevDate = prev?.date || null;
  CATS.seed = seed + 3; // a different rotation from the points league, so the two tables don't share lines
  const D = CATS.core, w = CatsCore.weights({}), repl = CatsCore.replacement(D, w);
  const T = TradesCore.build({
    me: CATS.team.id, slots: CATS.league.slots, teamNames: CATS.teamNames, repl, rules: CATS.tradeRules, rosterSize: CATS.rosterSize,
    rankNeeds: true, standings: CATS.standings, regularWeeks: CATS.regularWeeks, catsPerWeek: CatsCore.CATS.length,
    players: D.players.filter((p) => p.mine || p.rosteredBy).map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos.filter((x) => x !== 'Util'), owner: p.mine ? CATS.team.id : p.rosteredBy, value: CatsCore.perWeek(p, w), age: p.age ?? null, pre: p.pre, cur: p.cur, gp: p.gp, injured: !!(p.injured || p.ir), back: p.back || null, src: p })),
  });
  save('cats', finishes(T));
  write('out/cats.json', CATS);
  console.log(`Outlook (Categories League): ${Object.keys(hist.cats.at(-1).finish).length} teams${prev ? `, compared with ${prev.date}` : ', first entry'}`);
}
fs.writeFileSync(path.join(ROOT, HIST), JSON.stringify(hist, null, 1));
