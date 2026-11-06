// Categories League (Yahoo 22222): head-to-head categories board data.
//   node engine/cats.mjs
// Reads out/players.json (the points engine's usage-adjusted rates, injuries, goalie start chances and
// intel), projections/cats-2026-27.json (your CATS sheet), nhl/out/nhl-data.json (hits, goalie stats)
// and yahoo/data/chrome-raw-22222.json (the league read). Writes out/cats.json; the page runs
// engine/cats-core.js on it so changing category priorities re-ranks players and re-plans moves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatcher, round, teamGoalieForm, tradeRules } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const CatsCore = new Function(fs.readFileSync(path.join(ROOT, 'engine/cats-core.js'), 'utf8') + '\nreturn CatsCore;')();

const P = read('out/players.json');
const CJ = read('projections/cats-2026-27.json');
const nhl = read('nhl/out/nhl-data.json');
// the newest Categories League read: the Yahoo API (league-22222.json) or the Chrome read
const Y = [ 'yahoo/data/league-22222.json', 'yahoo/data/chrome-raw-22222.json' ]
  .filter((f) => fs.existsSync(path.join(ROOT, f))).map(read).sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)))[0];
const PREV = '20252026', CUR = '20262027';
const LEAGUE = {
  id: 22222, name: 'Categories League', teams: 12, maxAdds: 5, minG: 3, faab: true,
  slots: ['C', 'C', 'LW', 'LW', 'RW', 'RW', 'D', 'D', 'D', 'Util', 'Util', 'G', 'G'], bench: 4, playoffEnd: '2027-03-28',
};
const SKATER_SLOTS = LEAGUE.slots.filter((s) => s !== 'G').length;
const iso = (d) => d.toISOString().slice(0, 10);
const days = P.week.days;

// ---- match the league read to NHL ids ---------------------------------------------------------
const pool = P.players.map((p) => ({ ...p, playerId: p.id, onRoster: !p.inactive }));
const byId = new Map(pool.map((p) => [p.id, p]));
const mS = buildMatcher(pool.filter((p) => p.kind === 'S')), mG = buildMatcher(pool.filter((p) => p.kind === 'G')), mAny = buildMatcher(pool);
const find = (name, team, g) => (g ? mG : mS)(name, team) || mAny(name, team);
const unmatched = [];
const mine = new Map(); // id -> { slot, status }
for (const r of Y.myTeam.roster) {
  const p = find(r.name, r.team, r.pos.includes('G'));
  if (!p) { unmatched.push(r.name); continue; }
  mine.set(p.id, { slot: r.slot, status: r.status || '', ypos: r.pos });
}
const rosteredBy = new Map();
for (const e of Y.otherRostered.split(';').filter(Boolean)) {
  const m = e.match(/^(\d+):(.*)$/), ft = m ? Number(m[1]) : 0;
  const [name, team, g] = (m ? m[2] : e).split('/');
  const p = find(name, team, g === 'G');
  if (!p) { unmatched.push(name); continue; }
  rosteredBy.set(p.id, ft);
}
// Yahoo Pre-Season / Current rank in this league: the trade market's view of a player
const yRank = new Map();
for (const e of (Y.ranks || '').split(';').filter(Boolean)) {
  const [name, team, pre, cur, g] = e.split('/');
  const p = find(name, team, g === 'G');
  if (p) yRank.set(p.id, { pre: Number(pre) || null, cur: Number(cur) || null });
}
const waiverDay = new Map();
for (const e of (Y.waivers || '').split(';').filter(Boolean)) {
  const [name, team, date] = e.split('/');
  const p = find(name, team);
  const d = new Date(`${date} ${P.today.slice(0, 4)} 12:00`);
  if (!p || isNaN(d)) continue;
  const i = days.findIndex((x) => x >= iso(d));
  waiverDay.set(p.id, i === -1 ? days.length : i);
}
const oppId = Y.myTeam.opponent?.teamId;

// ---- skater category rates on your sheet's scale ---------------------------------------------
const nhlById = new Map([...nhl.skaters, ...nhl.goalies].map((p) => [p.playerId, p]));
const catsByName = buildMatcher(CJ.skaters.map((s) => ({ ...s, playerId: s.name + '|' + s.team, onRoster: true })));
const sheetFor = (p) => { const hit = catsByName(p.name, p.team); return hit ? CJ.skaters.find((s) => s.name + '|' + s.team === hit.playerId) : null; };
const PROJ_GAMES = 50; // your projection = 50 games of sample; every game played adds one (same rule as the points engine)
function skaterRates(p) {
  const n = nhlById.get(p.id), prev = n?.seasons?.[PREV], cur = n?.seasons?.[CUR];
  const s = sheetFor(p);
  const isD = p.pos.includes('D');
  const baseHit = isD ? 1.1 : 0.9;
  const prior = s && s.GP ? s.HIT / s.GP : prev?.GP ? ((prev.totals.HIT || 0) + baseHit * 20) / (prev.GP + 20) : baseHit;
  const gp = cur?.GP || 0;
  const hit = ((prior * PROJ_GAMES + (cur?.totals?.HIT || 0)) / (PROJ_GAMES + gp)) * Math.sqrt(p.evAdj || 1);
  return { ...p.rates, HIT: hit, sheet: !!s };
}

// ---- goalie per-start rates ----------------------------------------------------------------------
const gPrevPool = nhl.goalies.map((g) => g.seasons?.[PREV]).filter((x) => x && x.totals.GS >= 20);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const LG = {
  SVP: sum(gPrevPool, (x) => x.totals.SV) / sum(gPrevPool, (x) => x.totals.SA),
  SA: sum(gPrevPool, (x) => x.totals.SA) / sum(gPrevPool, (x) => x.totals.GS),
  SO: sum(gPrevPool, (x) => x.totals.SO) / sum(gPrevPool, (x) => x.totals.GS),
};
// how the team in front of him is playing this season vs last (lib.mjs)
const TEAM_FORM = teamGoalieForm(nhl.goalies, PREV, CUR);
const tierOf = buildMatcher(CJ.goalies.map((g) => ({ ...g, playerId: g.name + '|' + g.team, onRoster: true })));
function goalieRates(p) {
  const n = nhlById.get(p.id), prev = n?.seasons?.[PREV], cur = n?.seasons?.[CUR];
  const same = prev && (prev.teamAbbrevs || '').split(',').pop() === p.team;
  const wp = prev ? (same ? 1 : 0.5) : 0;
  const pg = (prev?.totals?.GS || 0) * wp, cg = cur?.totals?.GS || 0;
  const t = tierOf(p.name, p.team);
  const tier = t ? CJ.goalies.find((g) => g.name + '|' + g.team === t.playerId)?.tier : null;
  const bump = tier ? (3.5 - tier) / 2.5 : -0.4; // tier 1 = +1, tier 6 = -1
  // the projection: last season regressed to league average, nudged by your tier; it counts as
  // PROJ_GAMES starts and this season's starts add to it
  const ct = cur?.totals || {};
  const W0 = ((prev?.totals?.W || 0) * wp + 0.5 * 20) / (pg + 20) + 0.04 * bump;
  const svp0 = ((prev?.totals?.SV || 0) * wp + LG.SVP * 700) / ((prev?.totals?.SA || 0) * wp + 700) + 0.003 * bump;
  const SA0 = ((prev?.totals?.SA || 0) * wp + LG.SA * 12) / (pg + 12);
  const SO0 = (((prev?.totals?.SO || 0) * wp + LG.SO * 25) / (pg + 25)) * (1 + 0.25 * bump);
  const W = clamp01((W0 * PROJ_GAMES + (ct.W || 0)) / (PROJ_GAMES + cg));
  const svp = (svp0 * SA0 * PROJ_GAMES + (ct.SV || 0)) / (SA0 * PROJ_GAMES + (ct.SA || 0));
  const SA = (SA0 * PROJ_GAMES + (ct.SA || 0)) / (PROJ_GAMES + cg);
  const SO = (SO0 * PROJ_GAMES + (ct.SO || 0)) / (PROJ_GAMES + cg);
  // team form: fewer wins, more shots and goals against than last season move every goalie on the team
  const f = TEAM_FORM[p.team] || { winDelta: 0, gaF: 1, saF: 1 };
  const W1 = clamp01(W + f.winDelta), SA1 = SA * f.saF, GA1 = SA * (1 - svp) * f.gaF, svp1 = 1 - GA1 / SA1;
  return { W: W1, SA: SA1, SV: SA1 - GA1, GA: GA1, SO: Math.max(0, SO / f.gaF), SVP: svp1, tier, teamForm: f.starts ? { wins: f.wins, starts: f.starts, winDelta: f.winDelta, gaF: f.gaF } : null };
}
function clamp01(x) { return Math.max(0.05, Math.min(0.95, x)); }

// rough pre-sort of the wire by projected production, to keep the page light
function sumRates(p) { const r = p.rates || {}; return 7.93 * (r.G || 0) + 5.82 * (r.A || 0) + 8 * (r.PPP || 0) + 1.56 * (r.SOG || 0) + 1.91 * (r.BLK || 0); }
// ---- everyone the board needs: your roster, the opponent, all rostered players (for starter level), the wire
const wireSk = new Set(pool.filter((p) => p.kind === 'S' && !mine.has(p.id) && !rosteredBy.has(p.id) && !p.inactive).sort((a, b) => sumRates(b) - sumRates(a)).slice(0, 200).map((p) => p.id));
const relevant = pool.filter((p) => mine.has(p.id) || rosteredBy.has(p.id) || (!p.inactive && (p.kind === 'G' ? p.share >= 0.12 || p.priorShare >= 0.3 : wireSk.has(p.id))));
const players = relevant.map((p) => {
  const m = mine.get(p.id);
  const isG = p.kind === 'G';
  const rate = isG ? goalieRates(p) : skaterRates(p);
  const pos = isG ? ['G'] : [...new Set([...(m?.ypos?.length ? m.ypos : p.pos), 'Util'])];
  // back during the week: he plays from his return date (goalies at their usual share)
  const backIdx = p.back ? days.findIndex((d) => d >= p.back) : -1;
  const healthyFrom = !p.injured ? 0 : backIdx >= 0 ? backIdx : 99;
  let startProb = p.startProb;
  if (isG && p.injured && backIdx >= 0) startProb = p.gameDays.map((g, t) => (t >= backIdx && g ? Math.max(0.3, p.priorShare || 0.4) : 0));
  return {
    id: p.id, name: p.name, team: p.team, pos, kind: p.kind, age: p.age,
    mine: !!m, ir: !!m && /^IR/.test(m.slot), slot: m?.slot || null, status: m?.status || null,
    rosteredBy: rosteredBy.get(p.id) ?? null, opp: rosteredBy.get(p.id) === oppId,
    avail: !m && !rosteredBy.has(p.id), waiverDay: waiverDay.get(p.id) ?? null,
    injured: p.injured, back: p.back, healthyFrom, gameDays: p.gameDays, opps: p.opps, startProb, share: p.share ?? null,
    // long-term share: an injured starter keeps his usual share, a fill-in goes back to his
    shareLong: isG ? (p.injured || p.fillInFor ? p.priorShare ?? p.share : p.share) ?? null : null,
    pPlay: p.pPlay ?? 1, pPlayLong: p.longFactor ?? 1, rate, isStarter: p.isStarter, fillInFor: p.fillInFor,
    // how other managers see him: Yahoo's Pre-Season and Current rank here, and games played this season
    pre: yRank.get(p.id)?.pre ?? null, cur: yRank.get(p.id)?.cur ?? null, gp: p.gp ?? 0,
  };
});

// ---- standardize: each category in units of the spread of weekly team totals ------------------------
// pass 1 sizes each team's week with rough spreads, pass 2 measures the real spread across the 12 teams
const SK = ['G', 'A', 'PPP', 'SOG', 'HIT', 'BLK'];
const sheetScale = CJ.scale;
const teamsRoster = {};
for (const p of players) { const t = p.mine ? 12 : p.rosteredBy; if (t) (teamsRoster[t] ||= []).push(p); }
const avgStarts = 3.5;
function setContrib(sd) {
  for (const p of players) {
    p.contrib = {};
    if (p.kind === 'S') for (const k of SK) p.contrib[k] = (p.rate[k] || 0) / sd[k];
    else {
      p.contrib.W = p.rate.W / sd.W; p.contrib.SV = p.rate.SV / sd.SV; p.contrib.SO = p.rate.SO / sd.SO;
      p.contrib.GAA = (sd.muGA - p.rate.GA) / (avgStarts * sd.GAA);
      p.contrib.SVP = ((p.rate.SVP - sd.muSVP) * p.rate.SA) / (sd.muSA * avgStarts * sd.SVP);
    }
  }
}
let sd = { G: 4, A: 6, PPP: 3.5, SOG: 15, HIT: 18, BLK: 12, W: 1.2, SV: 25, SO: 0.5, GAA: 0.8, SVP: 0.02, muGA: LG.SA * (1 - LG.SVP), muSVP: LG.SVP, muSA: LG.SA };
setContrib(sd);
const D0 = { days, slots: LEAGUE.slots, minG: LEAGUE.minG, players };
const eq = CatsCore.weights({});
const totals = Object.values(teamsRoster).map((r) => CatsCore.matchup(D0, days.map(() => r.filter((p) => !p.ir)), [], eq).mine);
const spread = (k) => { const v = totals.map((t) => t[k]).filter((x) => x != null); const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }; };
const wk = {};
for (const k of SK) { const s = spread(k); wk[k] = Math.sqrt(s.sd ** 2 + s.m * 1.2); }
{ const s = spread('W'); wk.W = Math.sqrt(s.sd ** 2 + s.m * 0.25); }
{ const s = spread('SV'); wk.SV = Math.sqrt(s.sd ** 2 + s.m * 1.5); }
{ const s = spread('SO'); wk.SO = Math.sqrt(s.sd ** 2 + s.m); }
{ const s = spread('GAA'); wk.GAA = Math.sqrt(s.sd ** 2 + 1.5 ** 2 / avgStarts); }
{ const s = spread('SVP'); wk.SVP = Math.sqrt(s.sd ** 2 + 0.045 ** 2 / avgStarts); }
const muStarts = spread('starts').m, muGA = spread('GA').m / Math.max(muStarts, 1), muSA = spread('SA').m / Math.max(muStarts, 1);
sd = { ...wk, muGA, muSVP: LG.SVP, muSA };
setContrib(sd);

// ---- z-scores for display: skaters on your sheet's scale, goalies against the starting goalie pool -----
for (const p of players) {
  p.z = {};
  if (p.kind === 'S') for (const k of SK) p.z[k] = round(sheetScale[k].a + sheetScale[k].b * (p.rate[k] || 0), 2);
}
{
  const gp = players.filter((p) => p.kind === 'G' && (p.share || 0) >= 0.3);
  const season = (p) => { const st = Math.max(p.share || 0, 0.1) * 82; return { W: p.rate.W * st, SV: p.rate.SV * st, SO: p.rate.SO * st, GAA: (muGA - p.rate.GA) * st, SVP: (p.rate.SVP - LG.SVP) * p.rate.SA * st }; };
  const pz = {};
  for (const k of ['W', 'SV', 'SO', 'GAA', 'SVP']) { const v = gp.map((p) => season(p)[k]); const m = v.reduce((a, b) => a + b, 0) / v.length; pz[k] = { m, s: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1 }; }
  for (const p of players.filter((x) => x.kind === 'G')) { const s = season(p); for (const k of Object.keys(pz)) p.z[k] = round((s[k] - pz[k].m) / pz[k].s, 2); }
}

// ---- display details for the players you'll see -------------------------------------------------
const display = {};
const pickWire = players.filter((p) => p.avail).sort((a, b) => CatsCore.perWeek(b, eq) - CatsCore.perWeek(a, eq));
const shown = new Set([...players.filter((p) => p.mine || p.opp).map((p) => p.id), ...pickWire.slice(0, 120).map((p) => p.id)]);
for (const p of players) {
  if (!shown.has(p.id)) continue;
  const src = byId.get(p.id);
  display[p.id] = { notes: src.notes || [], intel: src.intel || null, toi: src.toi || null, owned: src.owned, gp: src.gp, line: src.line ?? null, pp: src.pp ?? null, depth: src.depth ?? null, sheet: p.rate.sheet ?? null, tier: p.rate.tier ?? null };
}
// slim the per-player payload to what the page and the core need
const r3 = (v) => (v == null ? v : Math.round(v * 1000) / 1000);
const slim = players.map((p) => ({
  ...p, rate: Object.fromEntries(Object.entries(p.rate).filter(([k]) => k !== 'sheet' && k !== 'tier').map(([k, v]) => [k, r3(v)])),
  contrib: Object.fromEntries(Object.entries(p.contrib).map(([k, v]) => [k, r3(v)])),
  startProb: p.startProb || null, opps: shown.has(p.id) ? p.opps : undefined,
}));

const weekEnd = new Date(LEAGUE.playoffEnd + 'T12:00:00Z');
const weeksLeft = Math.max(1, Math.round((weekEnd - new Date(P.week.end + 'T12:00:00Z')) / (7 * 86400000)));
// Yahoo's count is this week's only if the read was taken on or after the week's Monday (a Sunday read shows last week's)
const addsUsed = new Date(Y.fetchedAt).toLocaleDateString('en-CA') >= P.week.start ? Y.myTeam.addsUsedThisWeek || 0 : 0;
const out = {
  generatedAt: new Date().toISOString(), today: P.today, league: LEAGUE,
  team: { id: Y.myTeam.id, name: Y.myTeam.name, opponent: Y.myTeam.opponent, addsUsed: Y.myTeam.addsUsedThisWeek }, teamNames: Y.teamNames || {},
  yahooRead: Y.fetchedAt,
  week: { ...P.week, labels: P.week.nightly.map((n) => n.day) },
  core: { days, slots: LEAGUE.slots, minG: LEAGUE.minG, teams: LEAGUE.teams, skaterSlots: SKATER_SLOTS, firstDay: P.week.firstDay, addsLeft: Math.max(0, LEAGUE.maxAdds - addsUsed), weeksLeft, players: slim },
  spread: Object.fromEntries(Object.entries(sd).map(([k, v]) => [k, r3(v)])), sheetScale,
  display, keyInjuries: P.keyInjuries, unmatched,
  tradeRules: tradeRules(ROOT, 'cats'), rosterSize: LEAGUE.slots.length + (LEAGUE.bench || 0),
  // standings (category wins-losses-ties) from the API read, for every team's projected finish
  ...(() => { const api = fs.existsSync(path.join(ROOT, 'yahoo/data/league-22222.json')) ? read('yahoo/data/league-22222.json') : {}; return { standings: api.standings || null, regularWeeks: (api.league?.playoffStartWeek || 23) - 1 }; })(),
};
fs.writeFileSync(path.join(ROOT, 'out', 'cats.json'), JSON.stringify(out));

// default view, for the log
const plan = CatsCore.plan(out.core, eq);
const byIdOut = new Map(slim.map((p) => [p.id, p]));
const mu = CatsCore.matchup(out.core, plan.rosterByDay, slim.filter((p) => p.opp && !/^IR/.test('')), eq);
console.log(`Categories board: ${slim.length} players (${[...mine.keys()].length} yours, ${slim.filter((p) => p.avail).length} available), unmatched: ${unmatched.join(', ') || 'none'}`);
console.log('Weekly spreads:', Object.entries(sd).map(([k, v]) => `${k} ${round(v, 3)}`).join(', '));
console.log(`Plan (${out.core.addsLeft} adds left): ${plan.moves.map((m) => `${days[m.day]} +${byIdOut.get(m.addId).name} -${byIdOut.get(m.dropId).name} (${round(m.weekGain, 2)} wk, ${round(m.longGain, 2)} long)`).join(' | ') || 'none'}`);
console.log(`Matchup vs ${Y.myTeam.opponent?.name}: ${mu.rows.map((r) => `${r.short} ${r.mine == null ? '-' : round(r.mine, r.k === 'SVP' ? 3 : 1)}-${r.opp == null ? '-' : round(r.opp, r.k === 'SVP' ? 3 : 1)} (${Math.round(r.pWin * 100)}%)`).join(', ')} | expected cats ${round(mu.expCats, 1)}`);
