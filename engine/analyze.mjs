// Weekly board for the Yahoo points league: usage-driven projections, stud/keep
// alerts, optimal daily lineups, the add/drop plan, a roster usage ledger and
// long-term holds.
//   node engine/analyze.mjs [--week YYYY-MM-DD] [--today YYYY-MM-DD]
// Reads nhl/out/nhl-data.json, projections/ag-2026-27.json, yahoo/data/league-11111.json
// Writes out/board.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatcher, bestLineup, nhlTeam, round, clamp, fmtToi, teamGoalieForm, tradeRules } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const nhl = read('nhl/out/nhl-data.json');
const LINES = fs.existsSync(path.join(ROOT, 'nhl/out/lines.json')) ? read('nhl/out/lines.json') : null;
const DFO = fs.existsSync(path.join(ROOT, 'nhl/out/dfo.json')) ? read('nhl/out/dfo.json') : null;
const dfoP = (id) => DFO?.players?.[id] || null;
const DFO_GAMES = 1.5; // a DailyFaceoff unit CHANGE counts as 1.5 games of shift data (its lines come from the same recent games)
const DFO_PREV = (() => {
  const dir = path.join(ROOT, 'nhl/out/dfo-history');
  if (!DFO || !fs.existsSync(dir)) return null;
  const cut = new Date(new Date(DFO.fetchedAt) - 4 * 86400000).toISOString().slice(0, 10);
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x.slice(0, 10) <= cut).sort().pop();
  return f ? { date: f.slice(0, 10), players: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).players } : null;
})();
const dfoLastGame = (team) => /^last game/i.test(DFO?.teams?.[team]?.sourceName || '');
const dfoSource = (team) => { const n = DFO?.teams?.[team]?.sourceName || ''; return /^last game/i.test(n) ? `last game's deployment` : n ? `lines reported by ${n}` : 'DailyFaceoff'; };
const dfoOut = (d) => d && (d.injury === 'out' || d.injury === 'ir');
// ESPN intel (nhl/fetch-espn.mjs): injury list with return dates, Rotowire notes, recent TOI, ownership, odds
const ESPN = fs.existsSync(path.join(ROOT, 'nhl/out/espn.json')) ? read('nhl/out/espn.json') : null;
const espnP = (id) => ESPN?.players?.[id] || null;
// an ESPN injury counts until he plays a game after it was posted
const espnInj = (id) => { const e = espnP(id), i = e?.injury; return i && !(e.lastGame && i.date && e.lastGame > i.date) ? i : null; };
const espnDtd = (id) => /day-to-day/i.test(espnInj(id)?.status || '');
const espnOut = (id) => { const i = espnInj(id); return i && !/day-to-day/i.test(i.status) ? i : null; };
const NOTE_DAYS = 10; // a note's role and events count for this long
const freshNote = (id) => { const n = espnP(id)?.note; return n?.at && (Date.now() - new Date(n.at)) / 86400000 <= NOTE_DAYS ? n : null; };
const newsRole = (p) => { const n = freshNote(p.playerId); return n && Object.keys(n.role || {}).length ? { ...n.role, at: n.at } : null; };
const injuryWord = (p) => {
  const d = dfoP(p.playerId), e = espnInj(p.playerId);
  const word = d?.injury === 'dtd' || d?.gtd || (!dfoOut(d) && espnDtd(p.playerId)) ? 'day-to-day' : d?.injury === 'ir' || /reserve/i.test(e?.status || '') ? 'on IR' : /suspension/i.test(e?.status || '') ? 'suspended' : 'out';
  return e?.returnDate && word !== 'day-to-day' ? `${word}, back ~${e.returnDate.slice(5).replace('-', '/')}` : word;
};
const ag = read('projections/ag-2026-27.json');
const yl = read('yahoo/data/league-11111.json');
const L = yl.league;
const PREV = '20252026', CUR = '20262027';
const SEASON_GAMES = 84;

// ---- Model constants ----------------------------------------------------------
// Your projection counts as PROJ_GAMES games of sample and every game played adds one (the owner's rule,
// 2026-10-13): 5 games in, the projection is 50/55 = 91% of the rate. Same for every stat; role changes
// (ice time, PP unit, linemates) adjust the projection itself and aren't counted as results.
const PROJ_GAMES = 50;
const K = { G: PROJ_GAMES, SOG: PROJ_GAMES, BLK: PROJ_GAMES, A: PROJ_GAMES, PPP: PROJ_GAMES, SHP: PROJ_GAMES };
const EV_ELASTICITY = 0.8;      // points scale with even-strength ice time ^0.8
const GOALIE_PRIOR_STARTS = 25;  // last season regressed to league average over this many starts (the goalie projection)
const ROS_NOISE = 0.25;         // pts/game over the wire treated as noise when valuing a roster spot
const ROS_DISCOUNT = 0.5;       // injuries, projection error, future churn
const MIN_MOVE_GAIN = 5;        // ignore moves worth less than this (inside projection noise)
const CHURN_PENALTY = 4;
const FUTURE_WEEK_WEIGHT = 0.71; // average H2H weight of a future week's points (margins ~ normal): E[exp(-z²/2)] = 1/√2
const FILL_IN_GAMES = 15;       // a goalie starting only because the starter is out: value counted for ~15 games
// Goalie minimum: fewer than 3 goalie starts in a week and every goalie point that week is wiped.
const STUD_RANK = 42, STRONG_RANK = 84, STARTER_RANK = 140;     // skaters, by value over the wire
const G_STUD_RANK = 8, G_STRONG_RANK = 18, G_STARTER_RANK = 28; // goalies
const KEEP_VOR = 1;             // 1+ pt/game over the wire = "Keep"

// ---- Dates -----------------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const today = arg('--today') || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// the board's week: the coming week on Sunday (the weekly run), otherwise the week in progress
const boardMonday = (() => { const d = new Date(today + 'T12:00:00Z'); const dow = d.getUTCDay(); return addDays(today, dow === 0 ? 1 : 1 - dow); })();
const weekStart = arg('--week') || boardMonday;
const week = nhl.weeks.find((w) => w.start === weekStart);
if (!week) throw new Error(`No NHL week starting ${weekStart}`);
const week2 = nhl.weeks.find((w) => w.start === addDays(weekStart, 7));
const days = week.nightly.map((n) => n.date);
const days2 = week2 ? week2.nightly.map((n) => n.date) : [];
const dates14 = [...days, ...days2];
const plays = new Set(); // "TEAM|date"
for (const g of nhl.schedule.games) { plays.add(g.home + '|' + g.date); plays.add(g.away + '|' + g.date); }
const teamPlays = (team, date) => plays.has(team + '|' + date);
// ESPN's expected return date, as the number of his team's games he still misses (null = no date)
const returnDate = (p) => espnInj(p.playerId)?.returnDate || null;
const returnGames = (p) => {
  const r = returnDate(p);
  if (!r) return null;
  let n = 0;
  for (let d = today; d < r && n < 90; d = addDays(d, 1)) if (teamPlays(p.team, d)) n++;
  return Math.max(1, n);
};
// ESPN expects him back before the board's week starts: he is not out for this board
const backBeforeWeek = (p) => { const r = returnDate(p); return !!r && r <= weekStart; };
// back partway through the week: he counts from his return date on
const backBy = (p, date) => { const r = returnDate(p); return !!r && date >= r; };
const oppOn = {};
for (const g of nhl.schedule.games) { oppOn[g.home + '|' + g.date] = g.away; oppOn[g.away + '|' + g.date] = '@' + g.home; }
const lightNights = new Set([...week.nightly, ...(week2?.nightly || [])].filter((n) => n.offNight).map((n) => n.date));

// team games completed so far, from the stats feed (schedule finals can arrive before player stats)
const teamGP = {}, teamFinals = {};
for (const g of nhl.schedule.games) if (g.state === 'OFF' || g.state === 'FINAL') for (const t of [g.home, g.away]) teamFinals[t] = (teamFinals[t] || 0) + 1;
for (const p of [...nhl.skaters, ...nhl.goalies]) { const c = p.seasons?.['20262027']; if (c && p.onRoster) teamGP[p.team] = Math.max(teamGP[p.team] || 0, c.GP); }
const statsPending = Object.keys(teamFinals).filter((t) => teamFinals[t] > (teamGP[t] || 0));

// ---- Scoring -----------------------------------------------------------------
const S = L.scoring.skater, GW = L.scoring.goalie;
const skaterFP = (t) => (t.G || 0) * S.G + (t.A || 0) * S.A + (t.PPP || 0) * S.PPP + (t.SHP || 0) * S.SHP + (t.SOG || 0) * S.SOG + (t.BLK || 0) * S.BLK;
const goalieFP = (t) => (t.W || 0) * GW.W + (t.GA || 0) * GW.GA + (t.SV || 0) * GW.SV + (t.SO || 0) * GW.SO;
const season = (p, s) => { const x = p.seasons?.[s]; return x && x.GP ? x : null; };

// ---- Match projections and Yahoo names to NHL players -------------------------
// Injured players drop off the NHL "current roster" feed, so a player counts as
// NHL-active if he is on a roster, has played this season, or is projected.
const agById = new Map(), agGoalie = new Map();
{
  const mS = buildMatcher(nhl.skaters), mG = buildMatcher(nhl.goalies);
  for (const a of ag.skaters) { const p = mS(a.name, a.team); if (p) agById.set(p.playerId, a); }
  for (const a of ag.goalies) { const p = mG(a.name, a.team); if (p) agGoalie.set(p.playerId, a); }
}
const inNHL = (p) => p.onRoster || p.seasons?.[CUR] || agById.has(p.playerId) || agGoalie.has(p.playerId);
const skaters = nhl.skaters.filter(inNHL);
const goalies = nhl.goalies.filter(inNHL);
const all = [...skaters, ...goalies];
const byId = new Map(all.map((p) => [p.playerId, p]));
const match = buildMatcher(all);
const matchSk = buildMatcher(skaters), matchG = buildMatcher(goalies);

const unmatched = [];
const POSMAP = { C: ['C'], L: ['LW'], R: ['RW'], D: ['D'], G: ['G'] };
const multiPos = new Map(yl.multiPosition.split(';').map((s) => s.split('>').map((x) => x.trim())).filter((x) => x[1]).map(([n, ps]) => [n, ps.split(' ')]));

const rostered = new Map(); // playerId -> fantasy team id (1 = mine, 0 = unknown other)
const mine = [];
for (const r of yl.myTeam.roster) {
  const p = (r.pos.includes('G') ? matchG : matchSk)(r.name, r.team) || match(r.name, r.team);
  if (!p) { unmatched.push(r.name); continue; }
  rostered.set(p.playerId, 1);
  mine.push({ p, slot: r.slot, ypos: r.pos.filter(Boolean), status: r.status || '' });
}
const opponentRoster = [];
for (const e of yl.otherRostered.split(';').filter(Boolean)) {
  // "Name/TEAM[/G]" or, with team ids, "7:Name/TEAM[/G]"
  const m = e.match(/^(\d+):(.*)$/);
  const ft = m ? Number(m[1]) : 0;
  const [name, team, g] = (m ? m[2] : e).split('/');
  const p = (g === 'G' ? matchG : matchSk)(name, team) || match(name, team);
  if (!p) { unmatched.push(name); continue; }
  rostered.set(p.playerId, ft);
  if (ft && ft === yl.myTeam.opponent?.teamId) opponentRoster.push(p);
}
// Yahoo Pre-Season / Current rank of rostered players: the trade market's view (name value, pedigree,
// this season's production as managers see it)
const yRank = new Map();
for (const e of (yl.ranks || '').split(';').filter(Boolean)) {
  const [name, team, pre, cur, g] = e.split('/');
  const p = (g === 'G' ? matchG : matchSk)(name, team) || match(name, team);
  if (p) yRank.set(p.playerId, { pre: Number(pre) || null, cur: Number(cur) || null });
}
const waiverUntil = new Map();
for (const e of (yl.waivers || '').split(';').filter(Boolean)) {
  const [name, team, date] = e.split('/');
  const p = match(name, team);
  const d = new Date(`${date} ${today.slice(0, 4)} 12:00`);
  if (p && !isNaN(d)) waiverUntil.set(p.playerId, iso(d));
}

const posOf = (p) => {
  const m = mine.find((x) => x.p.playerId === p.playerId);
  if (m && m.ypos.length) return m.ypos;
  const sheet = agById.get(p.playerId)?.pos;
  const fromSheet = sheet ? String(sheet).split('/').map((x) => ({ L: 'LW', R: 'RW' }[x] || x)).filter((x) => ['C', 'LW', 'RW', 'D'].includes(x)) : null;
  return multiPos.get(p.name) || (fromSheet?.length ? fromSheet : null) || POSMAP[p.position] || ['C'];
};

// ---- Team usage context ---------------------------------------------------------
// team EV seconds per game (5 skaters on ice), per season, so a player's EV time can be read as a share
const teamEVpg = { [PREV]: {}, [CUR]: {} };
{
  const sum = { [PREV]: {}, [CUR]: {} };
  for (const p of nhl.skaters) for (const sn of [PREV, CUR]) {
    const x = p.seasons?.[sn];
    if (!x?.GP || !x.toi?.EVTOI_pg) continue;
    const team = sn === CUR ? p.team : (x.teamAbbrevs || '').split(',').pop();
    sum[sn][team] = (sum[sn][team] || 0) + x.toi.EVTOI_pg * x.GP;
  }
  for (const [t, v] of Object.entries(sum[PREV])) teamEVpg[PREV][t] = v / 5 / 82;
  for (const [t, v] of Object.entries(sum[CUR])) if (teamGP[t]) teamEVpg[CUR][t] = v / 5 / teamGP[t];
}
const LEAGUE_EVPG = Object.values(teamEVpg[PREV]).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(teamEVpg[PREV]).length);
const evShareOf = (x, sn, team) => (x?.toi?.EVTOI_pg && teamEVpg[sn][team] ? x.toi.EVTOI_pg / teamEVpg[sn][team] : null);
// even-strength TOI rank among a team's forwards / defensemen this season
const evRank = new Map();
{
  const groups = {};
  for (const p of skaters) {
    const c = season(p, CUR);
    if (!c || !p.onRoster) continue;
    const k = p.team + '|' + (p.position === 'D' ? 'D' : 'F');
    (groups[k] ||= []).push({ id: p.playerId, ev: p.position === 'D' ? c.toi?.TOI_pg || 0 : (c.toi?.EVTOI_pg || 0) + (c.toi?.PPTOI_pg || 0) });
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.ev - a.ev).forEach((x, i) => evRank.set(x.id, i + 1));
}

// each team's PP1/PP2 share of PP time, from DailyFaceoff units and shift charts (some teams split ~50/50)
const unitShares = {};
for (const p of skaters) {
  const d = dfoP(p.playerId), c = season(p, CUR);
  if (!d?.pp || c?.toi?.PPshare == null || !c.GP) continue;
  ((unitShares[p.team] ||= { 1: [], 2: [] })[d.pp] ||= []).push(c.toi.PPshare);
}
const UNIT_DEFAULT = { 1: 0.6, 2: 0.35 };
const teamPrevUnit = {};
{
  const by = {};
  for (const p of skaters) {
    const x = p.seasons?.[PREV];
    if (!(p.onRoster || dfoOut(dfoP(p.playerId))) || !x || x.GP < 20 || (x.teamAbbrevs || '').split(',').pop() !== p.team || x.toi?.PPshare == null) continue;
    (by[p.team] ||= []).push(x.toi.PPshare);
  }
  for (const [t, v] of Object.entries(by)) {
    v.sort((a, b) => b - a);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (v.length >= 8) teamPrevUnit[t] = { 1: avg(v.slice(0, 5)), 2: avg(v.slice(5, 10)) };
  }
}
const unitShare = (team, u) => {
  if (!u) return 0.08;
  const v = unitShares[team]?.[u];
  const prior = teamPrevUnit[team]?.[u] ?? UNIT_DEFAULT[u];
  if (!v || v.length < 3) return prior;
  const n = teamGP[team] || 0, w = n / (n + 6);
  return clamp(v.reduce((a, b) => a + b, 0) / v.length * w + prior * (1 - w), 0.2, 0.75);
};
const evenSplit = (team) => unitShare(team, 1) - unitShare(team, 2) < 0.15;
// team scoring/defence, last season regressed 40% to the mean, then blended with this season
const teamGF = {}, teamGA = {};
{
  const gf = {}, ga = {}, gfC = {}, gaC = {};
  for (const p of nhl.skaters) {
    const x = p.seasons?.[PREV]; if (x?.GP) { const t = (x.teamAbbrevs || '').split(',').pop(); gf[t] = (gf[t] || 0) + (x.totals.G || 0); }
    const c = p.seasons?.[CUR]; if (c?.GP && p.onRoster) gfC[p.team] = (gfC[p.team] || 0) + (c.totals.G || 0);
  }
  for (const p of nhl.goalies) {
    const x = p.seasons?.[PREV]; if (x?.GP) { const t = (x.teamAbbrevs || '').split(',').pop(); ga[t] = (ga[t] || 0) + (x.totals.GA || 0); }
    const c = p.seasons?.[CUR]; if (c?.GP && p.onRoster) gaC[p.team] = (gaC[p.team] || 0) + (c.totals.GA || 0);
  }
  const avgF = Object.values(gf).reduce((a, b) => a + b, 0) / Object.keys(gf).length / 82;
  const avgA = Object.values(ga).reduce((a, b) => a + b, 0) / Object.keys(ga).length / 82;
  for (const t of new Set([...Object.keys(gf), ...Object.keys(ga)])) {
    const n = teamGP[t] || 0, w = n / (n + 20);
    teamGF[t] = (avgF + 0.6 * ((gf[t] || avgF * 82) / 82 - avgF)) * (1 - w) + (n ? (gfC[t] || 0) / n : 0) * w;
    teamGA[t] = (avgA + 0.6 * ((ga[t] || avgA * 82) / 82 - avgA)) * (1 - w) + (n ? (gaC[t] || 0) / n : 0) * w;
  }
  teamGF._avg = avgF; teamGA._avg = avgA;
}

// ---- Skater projection --------------------------------------------------------
// 1) preseason per-game line (your sheet, else last season shrunk toward depth level)
// 2) usage adjustment: EV ice time scales the even-strength part, PP share scales the PP part
// 3) each stat blended with this season's actuals at its own stabilisation rate; goals = shots x regressed shooting %
const BASE = { F: { G: 0.13, A: 0.19, PPP: 0.05, SHP: 0.005, SOG: 1.7, BLK: 0.45 }, D: { G: 0.05, A: 0.2, PPP: 0.05, SHP: 0.003, SOG: 1.2, BLK: 1.25 } };
const ppShareFromUnit = (u) => (u == 1 ? 0.6 : u == 2 ? 0.35 : 0.08);
const fpRates = (r) => r.G * S.G + r.A * S.A + r.PPP * S.PPP + r.SHP * S.SHP + r.SOG * S.SOG + r.BLK * S.BLK;

function projectSkater(p, opts = {}) {
  const prev = season(p, PREV), cur = season(p, CUR);
  const a = agById.get(p.playerId);
  const grp = p.position === 'D' ? 'D' : 'F';
  const base = BASE[grp];
  let prior, src;
  if (a && a.GP) {
    const shp = prev ? (prev.totals.SHP || 0) / prev.GP : base.SHP;
    prior = { G: a.G / a.GP, A: a.A / a.GP, PPP: a.PPP / a.GP, SHP: shp, SOG: a.SOG / a.GP, BLK: a.BLK / a.GP };
    src = 'your projections';
  } else if (prev) {
    const k = 20, g = prev.GP;
    prior = Object.fromEntries(Object.keys(base).map((s) => [s, ((prev.totals[s] || 0) + base[s] * k) / (g + k)]));
    src = 'last season';
  } else {
    prior = { ...base };
    src = 'no history';
  }
  const priorFP = fpRates(prior);

  // usage baselines
  const sameTeam = prev && (prev.teamAbbrevs || '').split(',').pop() === p.team;
  const basePP = a?.ppUnit ? ppShareFromUnit(a.ppUnit) * 0.7 + (sameTeam && prev.GP >= 20 ? prev.toi.PPshare ?? ppShareFromUnit(a.ppUnit) : ppShareFromUnit(a.ppUnit)) * 0.3
    : prev && prev.GP >= 20 ? prev.toi.PPshare ?? 0.08 : 0.08;
  // baseline EV share: last season's share of his team's EV time, nudged by the sheet's TOI view
  const prevTeam = prev ? (prev.teamAbbrevs || '').split(',').pop() : null;
  let baseEV = prev && prev.GP >= 15 ? evShareOf(prev, PREV, prevTeam) : null;
  if (baseEV && a?.ATOI && prev.toi.TOI_pg) baseEV *= clamp((a.ATOI * 60) / prev.toi.TOI_pg, 0.75, 1.3);
  if (!baseEV && a?.ATOI) baseEV = (a.ATOI * 60 * (grp === 'D' ? 0.78 : 0.82)) / LEAGUE_EVPG;

  const gp = cur?.GP || 0;
  const curEV = opts.baselineUsage ? null : evShareOf(cur, CUR, p.team), shiftPP = opts.baselinePP || opts.baselineUsage ? null : cur?.toi?.PPshare ?? null;
  const dfo = dfoP(p.playerId);
  // the PP unit a recent Rotowire note reports stands in for DailyFaceoff when DFO has no current read on him
  const nr = newsRole(p), dfoAt = DFO?.teams?.[p.team]?.updatedAt;
  const ppFromNews = nr?.pp != null && !dfoOut(dfo) && (!dfo || dfoLastGame(p.team) || !dfoAt || new Date(nr.at) - new Date(dfoAt) > 2 * 86400000);
  const dfoUnit = ppFromNews ? nr.pp : dfo && !dfoOut(dfo) ? dfo.pp ?? 0 : null; // 0 = dressed but on neither PP unit
  const baseUnit = a?.ppUnit ? Number(a.ppUnit) : basePP >= 0.45 ? 1 : basePP >= 0.2 ? 2 : 0;
  const dfoShare = opts.baselinePP || opts.baselineUsage || dfoUnit == null || dfoUnit === baseUnit || (dfoLastGame(p.team) && !ppFromNews) ? null : unitShare(p.team, dfoUnit);
  const ppGames = (shiftPP != null ? gp : 0) + (dfoShare != null ? DFO_GAMES : 0);
  const curPP = ppGames ? ((shiftPP ?? 0) * (shiftPP != null ? gp : 0) + (dfoShare ?? 0) * (dfoShare != null ? DFO_GAMES : 0)) / ppGames : null;
  let evAdj = 1, ppAdj = 1;
  if (gp && curEV && baseEV) evAdj = 1 + (Math.pow(clamp(curEV / baseEV, 0.6, 1.5), EV_ELASTICITY) - 1) * (opts.fullUsage ? 1 : gp / (gp + 4));
  if (ppGames && curPP != null) {
    const ratio = basePP >= 0.15 ? clamp(curPP / basePP, 0.4, 2.5) : null;
    const rel = opts.fullUsage ? 1 : ppGames / (ppGames + 3);
    if (ratio != null) ppAdj = 1 + (ratio - 1) * rel;
    else if (curPP > 0.3) { // new PP role from nowhere
      const dPPP = (0.6 * curPP - prior.PPP) * rel;
      prior.PPP += dPPP; prior.A += 0.75 * dPPP; prior.G += 0.25 * dPPP;
    }
  }
  const tot = Math.max(prior.G + prior.A, 0.01);
  const ppFrac = clamp(prior.PPP / tot, 0, 0.8);
  const mix = (1 - ppFrac) * evAdj + ppFrac * ppAdj;
  const adj = {
    G: prior.G * mix, A: prior.A * mix, PPP: prior.PPP * ppAdj, SHP: prior.SHP,
    SOG: prior.SOG * (0.8 * evAdj + 0.2 * ppAdj), BLK: prior.BLK * evAdj,
  };
  const usageFP = fpRates(adj); // what the role alone implies, before this season's results

  // blend with results, stat by stat
  const t = cur?.totals || {};
  const blend = (s) => (adj[s] * K[s] + (t[s] || 0)) / (K[s] + gp);
  const post = { G: blend('G'), A: blend('A'), PPP: blend('PPP'), SHP: blend('SHP'), SOG: blend('SOG'), BLK: blend('BLK') };
  const shPrior = adj.SOG > 0 ? adj.G / adj.SOG : 0.1;
  const proj = fpRates(post);

  // luck ledger: this season's actual vs what usage + normal shooting would produce
  const curFP = cur ? skaterFP(t) / gp : null;
  const xG = (t.SOG || 0) * shPrior;
  const expFP = cur ? usageFP : null;

  const missed = Math.max(0, (teamGP[p.team] || 0) - gp);
  const injured = (!p.onRoster || dfoOut(dfo) || !!espnOut(p.playerId)) && !backBeforeWeek(p);
  const dtd = dfo?.injury === 'dtd' || dfo?.gtd || espnDtd(p.playerId);
  const pPlay = injured ? 0 : gp === 0 && missed ? (missed === 1 ? 0.6 : missed === 2 ? 0.35 : 0.15) * (dfo?.line || dfo?.pair ? 1.5 : 1) : dtd ? 0.8 : 1;
  const inactive = injured || pPlay < 0.3;
  return {
    kind: 'S', rates: post, pPlay, proj, prior: priorFP, dfo, dfoUnit, shiftPP, dtd, baseUnit, ppFrac, gaFP: post.G * S.G + post.A * S.A,
    ppFromNews, pp1: dfoUnit != null && (!dfoLastGame(p.team) || ppFromNews) ? dfoUnit === 1 && (!evenSplit(p.team) || (curPP ?? 0) >= 0.5) : (curPP ?? 0) >= Math.max(0.5, unitShare(p.team, 1) - 0.05) && !evenSplit(p.team), usageFP, src, prev, cur, a, gp, missed, injured, inactive,
    basePP, curPP, baseEV, curEV, evAdj, ppAdj, curEVsec: cur?.toi?.EVTOI_pg ?? null, prevEVsec: prev?.toi?.EVTOI_pg ?? null, shPrior, curFP, expFP, xG, goals: t.G || 0, sog: t.SOG || 0,
  };
}

// ---- Goalie projection -------------------------------------------------------------
const gPrevPool = goalies.map((p) => season(p, PREV)).filter((x) => x && x.GP >= 20);
const G_BASE = gPrevPool.reduce((s, x) => s + goalieFP(x.totals), 0) / gPrevPool.reduce((s, x) => s + x.GP, 0) - 0.5;
const TIER_BUMP = { 1: 1.0, 2: 0.6, 3: 0.2, 4: -0.2, 5: -0.5 };
// how the team in front of him is playing this season vs last (lib.mjs): fewer wins, more goals and shots
// against move every goalie on the team, in fantasy points per start
const TEAM_FORM = teamGoalieForm(nhl.goalies, PREV, CUR);
function teamFormAdj(team, prev) {
  const f = TEAM_FORM[team]; if (!f) return 0;
  const big = prev && prev.GP >= 10 && prev.totals.GS;
  const ga = big ? prev.totals.GA / prev.totals.GS : TEAM_FORM._avg.GA, sa = big ? (prev.totals.SA || 0) / prev.totals.GS || TEAM_FORM._avg.SA : TEAM_FORM._avg.SA;
  const dGA = ga * (f.gaF - 1), dSA = sa * (f.saF - 1);
  return GW.W * f.winDelta + GW.GA * dGA + GW.SV * (dSA - dGA);
}

function projectGoalie(p) {
  const prev = season(p, PREV), cur = season(p, CUR);
  const sameTeam = prev && (prev.teamAbbrevs || '').split(',').pop() === p.team;
  const tier = agGoalie.get(p.playerId)?.tier;
  const prevRate = prev ? goalieFP(prev.totals) / prev.GP : null;
  const w = prev ? prev.GP * (sameTeam ? 1 : 0.5) : 0; // a new team's defence changes a goalie's numbers
  let prior = prev ? (prevRate * w + G_BASE * GOALIE_PRIOR_STARTS) / (w + GOALIE_PRIOR_STARTS) : G_BASE;
  prior += TIER_BUMP[tier] ?? 0;
  const teamAdj = teamFormAdj(p.team, prev);
  const perStart = (cur ? (prior * PROJ_GAMES + goalieFP(cur.totals)) / (PROJ_GAMES + cur.GP) : prior) + teamAdj;
  const gs = cur?.totals.GS || 0;
  const priorShare = sameTeam && prev.GP >= 10 ? clamp((prev.totals.GS || 0) / 82, 0.08, 0.85) : tier ? (tier <= 3 ? 0.62 : tier <= 5 ? 0.5 : 0.35) : 0.3;
  const tg = teamGP[p.team] || 0;
  const rel = tg / (tg + 8);
  const dfo = dfoP(p.playerId);
  // a goalie missing from a team's posted depth chart is the third goalie, not a 30% default
  const offChart = !dfo?.goalie && DFO?.teams?.[p.team]?.lines?.g?.length >= 2;
  const dfoShare = offChart ? 0.02 : dfoLastGame(p.team) ? null : dfo?.goalie === 1 ? 0.62 : dfo?.goalie === 2 ? 0.38 : dfo?.goalie ? 0.05 : null;
  const prior2 = dfoShare != null && !dfoOut(dfo) ? (priorShare + dfoShare * 2) / 3 : priorShare;
  const share = tg ? prior2 * (1 - rel) + (gs / tg) * rel : prior2;
  return { kind: 'G', pid: p.playerId, dfoShare, dfo, depth: dfo?.goalie ?? null, priorShare, perStart, teamAdj, prior, share, prev, cur, agTier: tier, gs, gp: cur?.GP || 0, injured: (!p.onRoster || dfoOut(dfo) || !!espnOut(p.playerId)) && !backBeforeWeek(p), inactive: (!p.onRoster || dfoOut(dfo) || !!espnOut(p.playerId)) && !backBeforeWeek(p) };
}

const proj = new Map();
for (const p of skaters) proj.set(p.playerId, projectSkater(p));
{
  const hurtPP1 = {}, hurtAll = [];
  for (const p of skaters) { const x = proj.get(p.playerId); if (!x.injured) continue; hurtAll.push(p); if (Number(x.a?.ppUnit) === 1) (hurtPP1[p.team] ||= []).push(p); }
  const horizon = (q) => {
    const g = returnGames(q);
    if (g != null) return g;
    const m = mine.find((x) => x.p === q && /^IR/.test(x.slot));
    if (m) return Math.round(returnWeeks(m).weeks * 3.5);
    const w = injuryWord(q); return w === 'day-to-day' ? 3 : w.startsWith('on IR') ? 25 : 10;
  };
  for (const p of skaters) {
    const x = proj.get(p.playerId);
    if (x.injured) continue;
    const dfoPromo = x.dfo?.pp === 1 && x.baseUnit !== 1 && !dfoLastGame(p.team);
    const ppHurt = (x.curPP ?? 0) - x.basePP >= 0.1 || dfoPromo ? hurtPP1[p.team] || [] : [];
    const evHurt = x.curEV && x.baseEV && x.curEV - x.baseEV >= 0.04
      ? hurtAll.filter((q) => q.team === p.team && (q.position === 'D') === (p.position === 'D') && proj.get(q.playerId).prior >= x.prior * 0.75) : [];
    const hurt = [...new Set([...ppHurt, ...evHurt])];
    if (!hurt.length) continue;
    const alt = projectSkater(p, { baselineUsage: true });
    if (x.proj - alt.proj < (dfoPromo && ppHurt.length ? 0 : 0.1)) continue;
    x.fillIn = hurt.map((q) => `${q.name} (${injuryWord(q)})`); x.fillInIds = hurt.map((q) => q.playerId); x.projLong = alt.proj; x.fillInGames = Math.min(...hurt.map(horizon));
    x.fillInMine = hurt.filter((q) => yl.myTeam.roster.some((r) => r.name === q.name)).map((q) => q.name);
  }
}
for (const p of skaters) {
  const x = proj.get(p.playerId), toi = x.cur?.toi?.TOI_pg, sheetToi = x.a?.ATOI ? x.a.ATOI * 60 : null;
  const prevToi = x.prev && x.prev.GP >= 20 && (x.prev.teamAbbrevs || '').split(',').pop() === p.team ? x.prev.toi?.TOI_pg : null;
  const baseToi = prevToi && sheetToi ? Math.min(prevToi, sheetToi) : prevToi || sheetToi;
  if (!x.injured && x.gp && toi && baseToi && toi < baseToi * 0.85) {
    const ppPart = x.a ? clamp((x.a.PPP / x.a.GP) * (S.G * 0.3 + S.A * 0.7) / Math.max(x.proj, 1), 0, 0.5) : 0.1;
    const projIfRole = x.proj * ((1 - ppPart) * Math.pow(toi / baseToi, 0.9) + ppPart * (x.curPP != null && x.basePP > 0.05 ? clamp(x.curPP / x.basePP, 0, 1.5) : 1));
    x.roleCheck = { toi, sheetToi: baseToi, projIfRole, confirmed: !dfoLastGame(p.team) && (x.dfo?.pair === 3 || x.dfo?.line >= 3) };
  }
}
for (const p of goalies) proj.set(p.playerId, projectGoalie(p));
// linemates: (linemate projection / team top-6 average)^0.3 on the even-strength share of his points
if (LINES?.players) {
  const snap = new Map([...proj].map(([id, x]) => [id, x.proj])); // before any line adjustment
  const natural = new Map(), teamF = {};
  for (const p of skaters) if (p.position !== 'D' && (p.onRoster || dfoP(p.playerId))) (teamF[p.team] ||= []).push(p.playerId);
  for (const ids of Object.values(teamF)) {
    ids.sort((a, b) => snap.get(b) - snap.get(a));
    ids.slice(0, 12).forEach((id, i) => {
      const trio = ids.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3).filter((x) => x !== id);
      if (trio.length) natural.set(id, { line: Math.floor(i / 3) + 1, q: trio.reduce((a, x) => a + snap.get(x), 0) / trio.length });
    });
  }
  const top6 = {}, top9 = {}, rankOf = new Map();
  for (const [t, ids] of Object.entries(teamF)) {
    top6[t] = ids.slice(0, 6).reduce((a, id) => a + snap.get(id), 0) / Math.min(6, ids.length);
    top9[t] = ids.slice(0, 9).reduce((a, id) => a + snap.get(id), 0) / Math.min(9, ids.length);
    ids.forEach((id, i) => rankOf.set(id, i));
  }
  const bucket = (i) => Math.min(3, Math.floor(i / 3));
  const ratioSum = [0, 0, 0, 0], ratioN = [0, 0, 0, 0];
  for (const p of skaters) {
    const m = dfoP(p.playerId)?.mates, i = rankOf.get(p.playerId);
    if (p.position === 'D' || !m?.length || i == null || !top9[p.team]) continue;
    const q = m.map((id) => snap.get(id)).filter((v) => v != null);
    if (!q.length) continue;
    ratioSum[bucket(i)] += q.reduce((a, b) => a + b, 0) / q.length / top9[p.team]; ratioN[bucket(i)]++;
  }
  const lineRatio = ratioSum.map((v, k) => (ratioN[k] >= 10 ? v / ratioN[k] : [1.15, 1.0, 0.85, 0.7][k]));
  for (const [id, n] of natural) { const p = byId.get(id); n.q = lineRatio[bucket(rankOf.get(id))] * top9[p.team]; }
  console.log('Linemate ratio by team rank bucket:', lineRatio.map((v) => round(v, 2)).join(' / '));
  for (const p of skaters) {
    const x = proj.get(p.playerId), ln = LINES.players[p.playerId], dm = x.dfo?.mates;
    const mateIds = dm?.length ? dm : ln?.line?.map((m) => Number(m.id));
    const lineGames = x.gp + (dm?.length ? DFO_GAMES : 0);
    const nat = natural.get(p.playerId);
    if (p.position === 'D' || !mateIds?.length || !lineGames || !nat) continue;
    const mates = mateIds.map((id) => snap.get(id)).filter((v) => v != null);
    if (!mates.length) continue;
    const lq = mates.reduce((a, b) => a + b, 0) / mates.length;
    const m = 1 + (Math.pow(clamp(lq / nat.q, 0.6, 1.4), 0.3) - 1) * (lineGames / (lineGames + 4)) * (1 - x.ppFrac);
    const dFP = x.gaFP * (m - 1); // linemates move goals and assists, not shots or blocks
    x.lineQuality = lq; x.lineTop6 = top6[p.team]; x.lineExpected = nat.q; x.naturalLine = nat.line; x.lineAdj = m; x.lineFP = dFP; x.proj += dFP; x.usageFP += dFP;
    if (x.projLong != null) x.projLong += dFP;
    // injured top-6 teammates explain a shuffled line
    const hurt = (teamF[p.team] || []).slice(0, 6).map((id) => byId.get(id)).filter((q) => q && q.playerId !== p.playerId && (dfoP(q.playerId)?.injury || proj.get(q.playerId).injured));
    x.lineInjuries = hurt.map((q) => `${q.name} ${dfoP(q.playerId)?.injury === 'dtd' ? 'day-to-day' : 'out'}`);
  }
}
// ---- Crease model: each team's healthy goalies split 100% of starts ---------------------------
// The split is a role, so it's learned from this season fast (4 team games of prior), with the last
// 4 games for who has the net right now (an even window, so a strict rotation reads 50/50). Then the goalie outplaying his partner (saves above an
// average goalie, per start) takes starts from him, less so when the partner has a long leash:
// an elite starter, a young prospect, or an established starter the team pays to play. A non-elite
// goalie behind a healthy elite starter stays a backup.
const byTeamG = {};
for (const p of goalies) { const x = proj.get(p.playerId); if (x.injured) x.share = 0; else (byTeamG[p.team] ||= []).push(x); }
const gById = new Map(goalies.map((p) => [p.playerId, p]));
{
  const all = goalies.flatMap((p) => (p.gameLog || []).filter((e) => e.gs && e.sa));
  const LG_SV = all.length ? all.reduce((a, e) => a + e.sa - e.ga, 0) / all.reduce((a, e) => a + e.sa, 0) : 0.9;
  const teamDates = {};
  for (const p of goalies) for (const e of p.gameLog || []) if (e.gs) (teamDates[e.team] ||= new Set()).add(e.date);
  for (const [team, list] of Object.entries(byTeamG)) {
    const dates = [...(teamDates[team] || [])].sort(), tg = dates.length, last5 = dates.slice(-4);
    for (const x of list) {
      const p = gById.get(x.pid), log = (p.gameLog || []).filter((e) => e.team === team && e.gs);
      const started = new Set(log.map((e) => e.date));
      let streak = 0; for (let i = dates.length - 1; i >= 0 && started.has(dates[i]); i--) streak++;
      const sa = log.reduce((a, e) => a + e.sa, 0), sv = log.reduce((a, e) => a + e.sa - e.ga, 0);
      const pre = yRank.get(x.pid)?.pre;
      const elite = x.agTier != null && x.agTier <= 2;
      const prospect = p.age != null && p.age <= 25 && ((x.agTier != null && x.agTier <= 6) || (pre != null && pre <= 150));
      const established = (x.prev?.totals?.GS || 0) >= 40 || (x.agTier != null && x.agTier <= 3);
      x.crease = {
        team, tg, gs: started.size, recent: last5.filter((d) => started.has(d)).length, recentOf: last5.length, streak,
        svp: sa ? sv / sa : null, gsaa: sv - sa * LG_SV, perf: (sv - sa * LG_SV) / (started.size + 3), elite, prospect, established,
        leash: elite ? 0.75 : prospect ? 0.55 : established ? 0.45 : 0.2,
        leashWhy: elite ? 'elite starter' : prospect ? `${p.age}, a prospect` : established ? 'established starter' : '',
      };
    }
    // prior: last season's role / his sheet, with DailyFaceoff's depth chart as a light nudge
    const base = list.map((x) => (x.dfoShare != null && !dfoOut(x.dfo) ? (x.priorShare * 3 + x.dfoShare) / 4 : x.priorShare));
    const bSum = base.reduce((a, b) => a + b, 0) || 1;
    const rel = tg / (tg + 4);
    list.forEach((x, i) => {
      const c = x.crease;
      x.basePrior = base[i] / bSum;
      const seen = tg ? (tg >= 4 ? 0.65 * (c.gs / tg) + 0.35 * (c.recent / c.recentOf) : c.gs / tg) : x.basePrior;
      x.share = (1 - rel) * x.basePrior + rel * seen;
    });
    // outplaying the incumbent moves starts, scaled down by the loser's leash
    const inc = list.reduce((a, x) => (x.basePrior > a.basePrior ? x : a), list[0]);
    for (const x of list) {
      if (x === inc || !inc.crease.gs || !x.crease.gs) continue;
      const d = x.crease.perf - inc.crease.perf;
      const loser = d > 0 ? inc : x;
      const shift = clamp(0.1 * d, -0.15, 0.15) * (1 - loser.crease.leash);
      const moved = clamp(shift, -x.share * 0.8, inc.share * 0.8);
      x.share += moved; inc.share -= moved;
      x.crease.vs = { name: gById.get(inc.pid).name, svp: inc.crease.svp, leash: inc.crease.leashWhy, d };
      if (list.length === 2) inc.crease.vs = { name: gById.get(x.pid).name, svp: x.crease.svp, leash: x.crease.leashWhy, d: -d };
    }
    // a healthy elite starter keeps the net unless he's been bad over a real sample
    const el = list.find((x) => x.crease.elite && !(x.crease.gs >= 8 && x.crease.perf < -0.8));
    if (el) for (const x of list) if (x !== el && !x.crease.elite && x.share > 0.3) { el.share += x.share - 0.3; x.share = 0.3; x.crease.behindElite = gById.get(el.pid).name; }
  }
}
for (const list of Object.values(byTeamG)) { const s = list.reduce((a, x) => a + x.share, 0) || 1; list.forEach((x) => (x.share /= s)); }
// trade talk / holdouts around a goalie (Rotowire notes and ESPN headlines): his own crease and any team
// the story links him to are situations to monitor
const TEAM_WORDS = { ANA: 'Anaheim|Ducks', BOS: 'Boston|Bruins', BUF: 'Buffalo|Sabres', CAR: 'Carolina|Hurricanes', CBJ: 'Columbus|Blue Jackets', CGY: 'Calgary|Flames', CHI: 'Chicago|Blackhawks', COL: 'Colorado|Avalanche', DAL: 'Dallas|Stars', DET: 'Detroit|Red Wings', EDM: 'Edmonton|Oilers', FLA: 'Florida|Panthers', LAK: 'Los Angeles|Kings', MIN: 'Minnesota|Wild', MTL: 'Montreal|Canadiens', NJD: 'New Jersey|Devils', NSH: 'Nashville|Predators', NYI: 'Islanders', NYR: 'Rangers', OTT: 'Ottawa|Senators', PHI: 'Philadelphia|Flyers', PIT: 'Pittsburgh|Penguins', SEA: 'Seattle|Kraken', SJS: 'San Jose|Sharks', STL: 'St\\. Louis|Blues', TBL: 'Tampa Bay|Lightning', TOR: 'Toronto|Maple Leafs', UTA: 'Utah|Mammoth', VAN: 'Vancouver|Canucks', VGK: 'Vegas|Golden Knights', WPG: 'Winnipeg|Jets', WSH: 'Washington|Capitals' };
const TRADE_TALK = /\b(trade[sd]?|trading|holdout|holds? out|holding out|rumou?r\w*|linked to|suspen\w+ by the team|request\w* a trade)\b/i;
const goalieTalk = [];
for (const p of goalies) {
  const x = proj.get(p.playerId);
  if ((x.prev?.totals?.GS || 0) < 25 && !(x.agTier <= 4)) continue; // only goalies whose move would shake a crease
  const last = p.name.split(' ').pop();
  const items = [];
  const n = espnP(p.playerId)?.note;
  if (n?.at && (Date.now() - new Date(n.at)) / 86400000 <= 21 && TRADE_TALK.test(n.headline + ' ' + n.story)) items.push({ at: n.at, headline: n.headline, text: n.story });
  for (const a of ESPN?.news || []) if (new RegExp(`\\b${last}\\b`).test(a.headline + ' ' + a.text) && TRADE_TALK.test(a.headline + ' ' + a.text)) items.push(a);
  if (!items.length) continue;
  const txt = items.map((i) => i.headline + ' ' + i.text).join(' ');
  // a team counts as linked only in a sentence about the trade, not "the Jets face the Bruins Friday"
  const tradeSentences = txt.split(/(?<=[.!?])\s+/).filter((x) => TRADE_TALK.test(x) && !/\b(face[sd]?|against|vs\.?|host\w*|visit\w*)\b/i.test(x)).join(' ');
  const linked = Object.entries(TEAM_WORDS).filter(([t, w]) => t !== p.team && new RegExp(`\\b(${w})\\b`).test(tradeSentences)).map(([t]) => t);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  goalieTalk.push({ id: p.playerId, name: p.name, team: p.team, linked, headline: items[0].headline, at: String(items[0].at).slice(0, 10) });
}
for (const list of Object.values(byTeamG)) { const top = Math.max(...list.map((x) => x.share)); list.forEach((x) => (x.isStarter = x.share === top && top >= 0.5)); }
// a team whose usual starter is out: its healthy goalies are fill-ins, valued for a limited stretch
const injuredStarter = {};
for (const p of goalies) { const x = proj.get(p.playerId); if (x.injured && x.priorShare >= 0.5) injuredStarter[p.team] = { name: p.name, news: x.dfo?.news || null, games: returnGames(p) ?? FILL_IN_GAMES, back: returnDate(p) }; }
for (const p of goalies) { const x = proj.get(p.playerId); if (!x.injured && injuredStarter[p.team]) x.fillInFor = injuredStarter[p.team]; }
for (const p of goalies) { const x = proj.get(p.playerId); x.proj = x.perStart * x.share; }

// probability a goalie starts on a given date: the starter usually sits the 2nd night of a back-to-back
const B2B_STARTER = 0.35;
const starterNonB2B = {}; // per team: the starter's chance on a normal night so his average over the window equals his share
for (const [team, list] of Object.entries(byTeamG)) {
  const st = list.find((g) => g.isStarter); if (!st) continue;
  const games = dates14.filter((d) => teamPlays(team, d));
  const b = games.filter((d) => teamPlays(team, addDays(d, -1))).length, n = games.length;
  starterNonB2B[team] = n > b ? clamp((st.share * n - B2B_STARTER * b) / (n - b), st.share, 0.92) : st.share;
}
const isB2B = (team, date) => teamPlays(team, date) && teamPlays(team, addDays(date, -1));
function startProb(p, date) {
  const x = proj.get(p.playerId);
  if (!teamPlays(p.team, date) || (x.injured && !(LR && LR_ACTIVE.has(p.playerId)))) return 0;
  if (LR && x.fillInFor && (LR_WEEK + 1) * 3.5 >= x.fillInFor.games) { LR = false; const q = startProb(p, date); LR = true; return q * 0.35; } // the starter is back
  const list = byTeamG[p.team] || [x];
  const starter = list.find((g) => g.isStarter);
  if (!starter) return x.share;
  const ps = isB2B(p.team, date) ? B2B_STARTER : starterNonB2B[p.team] ?? starter.share;
  if (x === starter) return ps;
  const rest = list.filter((g) => g !== starter).reduce((a, g) => a + g.share, 0) || 1;
  return (x.share / rest) * (1 - ps);
}

// ---- Replacement level, value over the wire, tiers --------------------------------
const avail = all.filter((p) => !rostered.has(p.playerId));
const repl = {};
for (const pos of ['C', 'LW', 'RW', 'D', 'G']) {
  const pool = avail.filter((p) => posOf(p).includes(pos) && !proj.get(p.playerId).inactive).map((p) => proj.get(p.playerId).proj).sort((a, b) => b - a);
  const band = pool.slice(2, 6);
  repl[pos] = band.length ? band.reduce((a, b) => a + b, 0) / band.length : 0; // mean of the 3rd-6th best available
}
const vor = (p) => Math.max(...posOf(p).map((pos) => proj.get(p.playerId).proj - (repl[pos] ?? 0)));
const SLOTS = Object.entries(L.rosterSlots).filter(([k]) => ['C', 'LW', 'RW', 'D', 'G'].includes(k)).flatMap(([k, n]) => Array(n).fill(k));
const starterCount = (pos) => SLOTS.filter((s) => s === pos).length * L.numTeams;
const posRank = new Map(); // playerId -> best rank at an eligible position (by projection)
for (const pos of ['C', 'LW', 'RW', 'D']) {
  skaters.filter((p) => posOf(p).includes(pos)).sort((a, b) => proj.get(b.playerId).proj - proj.get(a.playerId).proj)
    .forEach((p, i) => { const r = { pos, rank: i + 1, starters: starterCount(pos) }; const cur = posRank.get(p.playerId); if (!cur || r.rank / r.starters < cur.rank / cur.starters) posRank.set(p.playerId, r); });
}
for (const list of [skaters, goalies]) {
  const isG = list === goalies;
  [...list].sort((a, b) => vor(b) - vor(a)).forEach((p, i) => {
    const x = proj.get(p.playerId);
    x.rank = i + 1; x.vor = vor(p); if (x.projLong != null) x.vorLong = x.vor - (x.proj - x.projLong);
    const pr = posRank.get(p.playerId);
    const startable = pr && pr.rank <= pr.starters;
    x.tier = i < (isG ? G_STUD_RANK : STUD_RANK) ? 'stud' : i < (isG ? G_STRONG_RANK : STRONG_RANK) ? 'strong'
      : i < (isG ? G_STARTER_RANK : STARTER_RANK) || startable ? 'starter' : 'depth';
  });
}

// ---- Lineups -----------------------------------------------------------------------
// opponent strength: skaters scale with the opponent's goals against; goalies lose ~4 pts per extra goal the opponent scores
const oppOf = (team, date) => (oppOn[team + '|' + date] || '').replace('@', '');
const isHome = (team, date) => !(oppOn[team + '|' + date] || '').startsWith('@');
// betting lines (DraftKings via ESPN, posted about a day ahead) replace the season goal rates on nights they exist
const ODDS = ESPN?.odds || {};
const oddsGoals = (() => { const v = Object.values(ODDS).flatMap((d) => Object.values(d).map((t) => t.goalsFor)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();
const lineFor = (team, date) => ODDS[date]?.[team] || null;
const skaterOppAdj = (team, date) => {
  const ln = lineFor(team, date);
  if (ln && oddsGoals) return clamp(1 + 0.6 * (ln.goalsFor / oddsGoals - 1), 0.85, 1.15);
  const o = oppOf(team, date); return teamGA[o] ? clamp(1 + 0.5 * (teamGA[o] / teamGA._avg - 1), 0.88, 1.12) : 1;
};
const goalieOppAdj = (team, date) => {
  const ln = lineFor(team, date);
  // win chance moves the W points; the implied goals against move the GA points
  if (ln && oddsGoals) return (ln.pWin - 0.5) * (GW.W || 0) + (ln.goalsAgainst - oddsGoals) * (GW.GA || 0);
  const o = oppOf(team, date); return (teamGF[o] ? -2 * (teamGF[o] - teamGF._avg) : 0) + (isHome(team, date) ? 0.2 : -0.2);
};
let LR = false, LR_WEEK = 0; // long-run mode: fill-in roles revert on schedule, day-to-day knocks heal
const lrValue = (x) => {
  let v = x.roleCheck ? (x.roleCheck.confirmed ? x.roleCheck.projIfRole : (x.proj + x.roleCheck.projIfRole) / 2) : x.proj;
  if (x.fillIn && (LR_WEEK + 1) * 3.5 >= (x.fillInGames ?? FILL_IN_GAMES)) v += (x.projLong ?? x.proj) - x.proj;
  return v;
};
const valueOn = (p, date) => {
  const x = proj.get(p.playerId);
  const back = !LR && x.injured && x.kind === 'S' && backBy(p, date);
  const healed = back || (LR && (LR_ACTIVE.has(p.playerId) || (x.inactive && !x.injured && LR_WEEK >= 2))); // scratched/missing players settle in 2 weeks
  if ((x.inactive && !healed) || !teamPlays(p.team, date)) return 0;
  if (x.kind === 'G') return (x.perStart + goalieOppAdj(p.team, date)) * startProb(p, date);
  return (LR ? lrValue(x) : x.proj * (back ? 0.9 : x.pPlay ?? 1)) * skaterOppAdj(p.team, date);
};
const dayLineup = (players, date) => bestLineup(players.map((p) => ({ key: p.playerId, pos: posOf(p), value: valueOn(p, date) })).filter((x) => x.value > 0), SLOTS);
function evalDays(rosterByDay, dates) {
  let pts = 0, starts = 0; const byStarts = new Map();
  // Goalies: each morning you start whichever of your goalies are confirmed, up to the G slots.
  // Per night, enumerate which of your goalies start (one per NHL team at most), then a DP over the
  // week tracks starts (capped at the minimum) with expected points: goalie points count only at 3+.
  const MIN = L.minGoalieStartsPerWeek || 3, GS = SLOTS.filter((x) => x === 'G').length;
  let mass = [1, ...Array(MIN).fill(0)], ptsAt = Array(MIN + 1).fill(0), gRaw = 0;
  dates.forEach((d, i) => {
    const roster = rosterByDay[i];
    const lu = dayLineup(roster.filter((p) => p.position !== 'G'), d);
    for (const [id] of lu.starters) { byStarts.set(id, (byStarts.get(id) || 0) + 1); starts++; pts += valueOn(byId.get(id), d); }
    const teams = {};
    for (const p of roster) {
      if (p.position !== 'G') continue;
      const q = startProb(p, d);
      if (q > 0) (teams[p.team] ||= []).push({ id: p.playerId, q, v: proj.get(p.playerId).perStart + goalieOppAdj(p.team, d) });
    }
    let outs = [{ pr: 1, list: [] }];
    for (const opts of Object.values(teams)) {
      const none = Math.max(0, 1 - opts.reduce((a, o) => a + o.q, 0));
      const next = [];
      for (const o of outs) {
        if (none > 0) next.push({ pr: o.pr * none, list: o.list });
        for (const g of opts) next.push({ pr: o.pr * g.q, list: [...o.list, g] });
      }
      outs = next;
    }
    const night = []; // [prob, starts counted, points]
    for (const o of outs) {
      const used = [...o.list].sort((a, b) => b.v - a.v).slice(0, GS);
      for (const g of used) byStarts.set(g.id, (byStarts.get(g.id) || 0) + o.pr / (teams[byId.get(g.id).team].find((x) => x.id === g.id).q));
      const v = used.reduce((a, g) => a + g.v, 0);
      gRaw += o.pr * v;
      night.push([o.pr, used.length, v]);
    }
    const m2 = Array(MIN + 1).fill(0), s2 = Array(MIN + 1).fill(0);
    for (let k = 0; k <= MIN; k++) for (const [pr, c, v] of night) {
      const k1 = Math.min(k + c, MIN);
      m2[k1] += mass[k] * pr; s2[k1] += (ptsAt[k] + mass[k] * v) * pr;
    }
    mass = m2; ptsAt = s2;
  });
  const gPts = ptsAt[MIN];
  return { pts: pts + gPts, starts, byStarts, gRaw, gPts, gLost: gRaw - gPts, pMin: mass[MIN] };
}

// Rest of season, roster level: your best daily lineup (slots, position overlap, goalie minimum, bench
// crowding) simulated over the next weeks' real schedules, with and without a move.
const PO_END = L.playoffs?.endDate || '2027-03-28';
const wkIdx = nhl.weeks.indexOf(week);
// every remaining week through the fantasy playoffs (a sample of weeks lets one week's schedule flip decisions)
const restWeeks = nhl.weeks.slice(wkIdx + 1).filter((w) => w.end <= PO_END);
const futureWeeks = restWeeks;
const weeksLeft = nhl.weeks.filter((w) => w.start > week.start && w.end <= PO_END).length;
const futureDays = futureWeeks.map((w) => w.nightly.map((n) => n.date));
const LR_SCALE = futureWeeks.length ? weeksLeft / futureWeeks.length : 0;
const rosterValueCache = new Map();
// your IR players come back: estimated return week from DailyFaceoff news / injury type / Yahoo IR status
const LR_ACTIVE = new Set();
const irReturn = new Map(); // playerId -> { weeks, why }
function returnWeeks(m) {
  const d = dfoP(m.p.playerId), t = d?.news?.text || '';
  let w = null, why = '';
  const r = returnDate(m.p);
  if (r) {
    const days = (new Date(r) - new Date(today)) / 86400000;
    return { weeks: Math.max(1, Math.round(days / 7)), why: `ESPN expects him back ~${r.slice(5).replace('-', '/')}${espnInj(m.p.playerId)?.type ? ` (${espnInj(m.p.playerId).type.toLowerCase()})` : ''}` };
  }
  const range = t.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(week|month)/i), one = t.match(/(\d+)\s*(week|month)/i);
  if (range) { w = ((+range[1] + +range[2]) / 2) * (/month/i.test(range[3]) ? 4.3 : 1); why = 'per news'; }
  else if (one) { w = +one[1] * (/month/i.test(one[2]) ? 4.3 : 1); why = 'per news'; }
  else if (/LT/.test(m.status) || d?.injury === 'ir' || /LTIR/i.test(t)) { w = 6; why = 'long-term IR, no timeline in the news: assumed ~6 weeks'; }
  else if (d?.injury === 'dtd') { w = 1; why = 'day-to-day'; }
  else { w = 3; why = 'no timeline in the news: assumed ~3 weeks'; }
  return { weeks: Math.max(1, Math.round(w)), why };
}
const ROSTER_MAX = SLOTS.length + (L.rosterSlots.BN || 0);
const PLAYOFF_WEEK_WEIGHT = 1.5; // fantasy playoff weeks decide the season
const PO_START = L.playoffs?.dates?.[0] || '2027-03-08';
// when IR players come back the active roster must fit: cut the least valuable non-protected player (keep 2 goalies)
// cut tiers: 0 anyone droppable, 1 positional starters, 2 studs / strong / PP1 top-6 (you'd cut these last)
const cutTier = (p) => { const x = proj.get(p.playerId); return x.tier === 'stud' || x.tier === 'strong' || x.vor > KEEP_VOR || roleProtected(p) ? 2 : protectedDrop(p) ? 1 : 0; };
const cutScore = (p) => { const x = proj.get(p.playerId); return cutTier(p) * 1000 + (x.kind === 'G' ? x.proj - repl.G : lrValue(x) - Math.max(...posOf(p).map((pos) => repl[pos] ?? 0))); };
function rosterValue(roster) {
  const key = roster.map((p) => p.playerId).sort().join(',');
  if (rosterValueCache.has(key)) return rosterValueCache.get(key);
  const back = mine.filter(onIR).filter((m) => irReturn.has(m.p.playerId));
  LR = true;
  let pts = 0;
  const starts = new Map(), games = new Map(), cuts = [];
  let cur = [...roster];
  futureDays.forEach((ds, wi) => {
    LR_WEEK = wi;
    const returning = back.filter((m) => irReturn.get(m.p.playerId).weeks === wi + 1).map((m) => m.p);
    returning.forEach((p) => LR_ACTIVE.add(p.playerId));
    cur = [...cur, ...returning];
    while (cur.length > ROSTER_MAX) {
      const nG = cur.filter((p) => p.position === 'G').length;
      const pool = cur.filter((p) => !returning.includes(p) && !(p.position === 'G' && nG <= 2));
      // of the 4 cheapest by value over the wire (protected players last), cut the one your lineup misses least that week
      const cands = pool.sort((a, b) => cutScore(a) - cutScore(b)).filter((p, i, arr) => i < 4 && cutTier(p) === cutTier(arr[0]));
      let out = null, bestPts = -Infinity;
      if (cands.length && cutTier(cands[0]) > 0) out = cands[0];
      else for (const c of cands) { const rr = cur.filter((p) => p !== c); const v = evalDays(ds.map(() => rr), ds).pts; if (v > bestPts) { bestPts = v; out = c; } }
      if (!out) break;
      cur = cur.filter((p) => p !== out);
      cuts.push({ week: futureWeeks[wi].start, name: out.name, id: out.playerId, tier: cutTier(out), near: cands.filter((c) => c !== out && cutTier(c) === cutTier(out)).slice(0, 2).map((c) => c.name), forName: returning.map((p) => p.name).join(' & '), why: returning.map((p) => irReturn.get(p.playerId)?.why).filter(Boolean)[0] || '' });
    }
    const e = evalDays(ds.map(() => cur), ds);
    pts += e.pts * (futureWeeks[wi].start >= PO_START ? PLAYOFF_WEEK_WEIGHT : 1);
    for (const p of cur) { games.set(p.playerId, (games.get(p.playerId) || 0) + gamesIn(p, ds)); starts.set(p.playerId, (starts.get(p.playerId) || 0) + (e.byStarts.get(p.playerId) || 0)); }
  });
  LR_ACTIVE.clear(); LR_WEEK = 0;
  LR = false;
  const v = { pts, starts, games, cuts };
  rosterValueCache.set(key, v);
  return v;
}
const seasonStartRate = (roster, p) => { const v = rosterValue(roster); const g = v.games.get(p.playerId) || 0; return g ? (v.starts.get(p.playerId) || 0) / g : null; };
const onIR = (m) => /^IR/.test(m.slot);
const active = mine.filter((m) => !onIR(m)).map((m) => m.p);
for (const m of mine.filter(onIR)) irReturn.set(m.p.playerId, returnWeeks(m));

// how often each of your players makes your best lineup over the next two weeks
const gamesIn = (p, dates) => dates.filter((d) => teamPlays(p.team, d)).length;
const startRate = new Map();
function refreshStartRates(roster) {
  const e = evalDays(dates14.map(() => roster), dates14);
  for (const p of roster) { const g = gamesIn(p, dates14); startRate.set(p.playerId, g ? (e.byStarts.get(p.playerId) || 0) / g : 0.5); }
}
refreshStartRates(active);

// rest-of-season value of a roster spot (points)
// games after this week (this week is counted in dWeek)
const gamesLeft = (p) => { const n = Math.max(0, SEASON_GAMES - (teamGP[p.team] || 0) - gamesIn(p, days)); return proj.get(p.playerId).fillInFor ? Math.min(n, proj.get(p.playerId).fillInFor.games) : n; };
const ros = (p, s) => {
  const x = proj.get(p.playerId), gl = gamesLeft(p), y = YOUTH_UPSIDE(p);
  const short = x.fillIn ? Math.min(gl, x.fillInGames ?? FILL_IN_GAMES) : gl;
  const v1 = Math.max(0, x.vor + y - ROS_NOISE), v2 = Math.max(0, (x.vorLong ?? x.vor) + y - ROS_NOISE);
  return (v1 * short + v2 * (gl - short)) * s * ROS_DISCOUNT;
};
const pClaim = (p) => {
  const isG = p.position === 'G';
  const base = 1 / (1 + Math.exp(-(proj.get(p.playerId).vor - (isG ? 1.0 : 0.6)) / (isG ? 0.4 : 0.25)));
  if (isG) { const r = agGoalie.get(p.playerId)?.rank; return r && r <= 30 && !proj.get(p.playerId).fillInFor ? Math.max(base, 0.8) : base; }
  const r = agById.get(p.playerId)?.rank;
  return r && r <= 200 ? Math.max(base, 0.8) : base; // a top-200 name gets claimed in a 14-team league
};
// room to improve this season, 0–1, by age on his position's development curve. Younger isn't simply better:
// a 20-year-old (above all a defenceman) is still learning the NHL, while players in their breakout window
// (forwards 21–23, defencemen 23–25) improve most reliably; past it the room fades fast. Goalies keep the
// old young-is-upside scale: their value rides on the share of starts (the hold score's role part).
const DEV_WINDOW = { F: [21, 23], D: [23, 25] };
const growth = (p) => {
  if (!p.age) return 0;
  if (p.position === 'G') return clamp((25 - p.age) * 0.16, 0, 1);
  const [lo, hi] = DEV_WINDOW[p.position === 'D' ? 'D' : 'F'];
  return clamp(p.age < lo ? 1 - (lo - p.age) * 0.15 : p.age > hi ? 1 - (p.age - hi) * 0.3 : 1, 0, 1);
};
const YOUTH_UPSIDE = (p) => (p.position !== 'G' ? 0.3 * growth(p) : 0);
const roleProtected = (p) => {
  const x = proj.get(p.playerId), d = x.dfo;
  if (x.kind !== 'S' || !d || x.vor <= ROS_NOISE) return false;
  const onPP1 = (d.pp === 1 && !dfoLastGame(p.team)) || (x.shiftPP ?? 0) >= 0.5; // any real PP1 deployment protects a top-6 F / top-4 D
  return onPP1 && ((d.line && d.line <= 2) || (d.pair && d.pair <= 2));
};
const protectedDrop = (p) => {
  const x = proj.get(p.playerId), pr = posRank.get(p.playerId);
  return x.tier === 'stud' || x.tier === 'strong' || (pr && pr.rank <= pr.starters && x.vor > KEEP_VOR * 0.5) || roleProtected(p);
};

for (const p of all) {
  const x = proj.get(p.playerId), gl = gamesLeft(p);
  if (x.kind === 'S') {
    const short = x.fillIn ? Math.min(gl, x.fillInGames ?? FILL_IN_GAMES) : gl;
    const mid = x.roleCheck ? (x.roleCheck.confirmed ? x.roleCheck.projIfRole : (x.proj + x.roleCheck.projIfRole) / 2) : x.proj;
    x.projLR = gl ? (mid * short + (mid + (x.projLong ?? x.proj) - x.proj) * (gl - short)) / gl : mid;
  } else if (x.fillInFor) {
    const full = Math.max(1, SEASON_GAMES - (teamGP[p.team] || 0) - gamesIn(p, days));
    x.lrShareFactor = (Math.min(full, x.fillInFor.games) + (full - Math.min(full, x.fillInFor.games)) * 0.35) / full; // ~35% of his starts once the starter is back
  }
}
// the wire player you'd realistically pick up instead: 4th best available at the position
function replacementFor(pos, exclude) {
  return avail.filter((p) => posOf(p).includes(pos) && !proj.get(p.playerId).inactive && !added.has(p.playerId) && !exclude.has(p.playerId))
    .sort((a, b) => proj.get(b.playerId).proj - proj.get(a.playerId).proj)[3] || null;
}
// rest of season = your roster's simulated points with the move minus without it, every remaining week
function longTermGain(add, drop, before) {
  if (!LR_SCALE) return { raw: 0, total: 0 };
  const raw = rosterValue([...before.filter((x) => x !== drop), add]).pts - rosterValue(before).pts;
  return { raw, total: raw * ROS_DISCOUNT * FUTURE_WEEK_WEIGHT };
}

// ---- Add/drop plan (greedy, up to the weekly add limit) ------------------------------------
// run mid-week, moves start today (nights already played can't change) and adds already used count
const FIRST_DAY = Math.max(0, days.findIndex((d) => d >= today));
// Yahoo's count is this week's only if the read was taken on or after the week's Monday (a Sunday read shows last week's)
const addsLeft = L.maxAddsPerWeek - (new Date(yl.fetchedAt).toLocaleDateString('en-CA') >= week.start ? yl.myTeam.addsUsedThisWeek || 0 : 0);
const fromDay = (pid) => {
  const w = waiverUntil.get(pid);
  if (!w) return FIRST_DAY;
  const i = days.findIndex((d) => d >= w);
  return i === -1 ? days.length : Math.max(i, FIRST_DAY); // clears after Sunday: not available this week
};
const candidates = avail
  .filter((p) => !proj.get(p.playerId).inactive)
  .map((p) => ({ p, wk: gamesIn(p, days) * proj.get(p.playerId).proj }))
  .sort((a, b) => b.wk - a.wk).slice(0, 70).map((x) => x.p);
for (const p of avail.filter((p) => !proj.get(p.playerId).inactive).sort((a, b) => vor(b) - vor(a)).slice(0, 25)) if (!candidates.includes(p)) candidates.push(p);

let rosterByDay = days.map(() => [...active]);
let base = evalDays(rosterByDay, days);
const startEval = base;
// H2H: points past what wins the week are worth less. Weight this week's gains by how close the matchup is.
const oppTotal = opponentRoster.length ? evalDays(days.map(() => opponentRoster), days).pts : null;
const marginBefore = oppTotal == null ? null : startEval.pts - oppTotal;
const MARGIN_SD = 80; // spread of weekly H2H margins in this scoring
const weekWeight = (pts) => (oppTotal == null ? 1 : Math.max(0.3, Math.exp(-((pts - oppTotal) ** 2) / (2 * MARGIN_SD ** 2))));
let WEEK_WEIGHT = weekWeight(startEval.pts);
const plan = [];
const added = new Set(), dropped = new Set();

function usageVeto(add, drop) {
  const a = proj.get(add.playerId), d = proj.get(drop.playerId);
  if (added.has(drop.playerId) || d.kind !== 'S' || (!d.gp && d.dfoUnit == null)) return false;
  if (d.vor <= ROS_NOISE) return false; // below-replacement players are never protected by role
  const strongCase = a.kind === 'S' && a.proj - d.proj >= 0.75 && (a.gp >= 3 || a.prior - d.prior >= 0.75);
  if (strongCase) return false;
  const pp1Drop = d.pp1 && !a.pp1; // never trade a real PP1 role for a lesser one on thin evidence, any position
  if (a.kind === 'G' || (add.position === 'D') !== (drop.position === 'D')) return pp1Drop; // EV usage isn't comparable across F, D and G
  const roleAtLeast = (d.curPP ?? 0) >= (a.curPP ?? 0) && (d.curEV ?? 0) >= (a.curEV ?? 0) * 0.95;
  return roleAtLeast || pp1Drop;
}
function evalMove(add, drop, di) {
  const next = rosterByDay.map((r, i) => (i >= di ? [...r.filter((x) => x !== drop), add] : r));
  const e = evalDays(next, days);
  const e2 = days2.length ? evalDays(days2.map(() => next[next.length - 1]), days2) : null;
  const addGames = days.slice(di).filter((d) => teamPlays(add.team, d)).length + gamesIn(add, days2);
  const xa = proj.get(add.playerId), xd = proj.get(drop.playerId);
  const sAdd = addGames ? ((e.byStarts.get(add.playerId) || 0) + (e2?.byStarts.get(add.playerId) || 0)) / addGames : 0.6;
  const dWeek = e.pts - base.pts;
  const lt = longTermGain(add, drop, rosterByDay[rosterByDay.length - 1]);
  let dLong = lt.total;
  // waiting a day to squeeze in the dropped player's game risks losing a wanted add to another team
  const wait = di - fromDay(add.playerId), delayCost = wait > 0 && dLong > 0 ? dLong * 0.08 * wait * pClaim(add) : 0;
  const churn = added.has(drop.playerId) ? CHURN_PENALTY : 0; // a second add spent on the same slot
  const gamesNet = e.starts - base.starts, gamesGain = add.position === 'G' ? 0 : e.byStarts.get(add.playerId) || 0;
  const gBonus = base.gLost - e.gLost; // goalie points rescued from the start minimum (already inside dWeek)
  return { next, e, dWeek, gBonus, dLong, ltRaw: lt.raw, delayCost, ww: WEEK_WEIGHT, net: dWeek * WEEK_WEIGHT + dLong - churn - delayCost, churn, gamesGain, gamesLost: gamesGain - gamesNet, gamesNet };
}

const singleMoves = [];
for (let k = 0; k < addsLeft; k++) {
  let best = null; const stepAlts = [];
  const dropPool = rosterByDay[rosterByDay.length - 1].filter((p) => !protectedDrop(p) || added.has(p.playerId));
  for (const add of candidates) {
    if (added.has(add.playerId) || dropped.has(add.playerId)) continue;
    const isG = add.position === 'G';
    let bestForAdd = null;
    for (const drop of dropPool) {
      if (drop.position === 'G' && !isG) continue; // keep two goalies for the two G slots
      if (usageVeto(add, drop)) continue;
      for (let di = fromDay(add.playerId); di < days.length; di++) {
        if (!rosterByDay[di].includes(drop)) continue;
        const m = evalMove(add, drop, di);
        if (!bestForAdd || m.net > bestForAdd.net) bestForAdd = { add, drop, di, ...m };
      }
    }
    if (!bestForAdd) continue;
    if (k === 0) singleMoves.push(bestForAdd);
    stepAlts.push(bestForAdd);
    if (!best || bestForAdd.net > best.net) best = bestForAdd;
  }
  if (!best || best.net < MIN_MOVE_GAIN) break;
  plan.push(best);
  rosterByDay = best.next; base = best.e; WEEK_WEIGHT = weekWeight(base.pts);
  best.pMinAfter = best.e.pMin;
  best.alts = stepAlts.filter((m) => m.add !== best.add && m.add.position !== 'G').sort((a, b) => b.net - a.net).slice(0, 3);
  refreshStartRates(rosterByDay[rosterByDay.length - 1]);
  added.add(best.add.playerId); dropped.add(best.drop.playerId);
}

// ---- Goalie starts vs the weekly minimum -------------------------------------------------
function goalieStarts(rbd) {
  const ev = evalDays(rbd, days);
  const probs = [];
  days.forEach((d, i) => { for (const p of rbd[i]) if (p.position === 'G') { const q = startProb(p, d); if (q > 0) probs.push(q); } });
  let dist = [1];
  for (const q of probs) { const n = new Array(dist.length + 1).fill(0); dist.forEach((v, k) => { n[k] += v * (1 - q); n[k + 1] += v * q; }); dist = n; }
  const min = L.minGoalieStartsPerWeek || 3;
  return { expected: round(probs.reduce((a, b) => a + b, 0), 1), pMin: round(ev.pMin, 2), pMinRoster: round(dist.slice(min).reduce((a, b) => a + b, 0), 2), min, gRaw: round(ev.gRaw, 1), gPts: round(ev.gPts, 1), gLost: round(ev.gLost, 1) };
}

// ---- Playoff schedule -----------------------------------------------------------------------
const po = Object.fromEntries(nhl.playoffSchedule.teams.map((t) => [t.team, t]));
const semiWeek = nhl.weeks.find((w) => w.start === '2027-03-08');
const playoffInfo = (team) => {
  const t = po[team];
  if (!t) return null;
  return { score: t.score, games: t.games, offNights: t.offNights, wk23: semiWeek?.teams[team]?.games ?? null, elite: t.score >= 85 };
};

// ---- Hockey-language notes ---------------------------------------------------------------
const pct = (x) => `${Math.round(x * 100)}%`;
const conf = (gp) => (gp >= 10 ? 'high' : gp >= 3 ? 'medium' : 'low');
const newerNote = (p, n) => { const r = freshNote(p.playerId); return r && r.at.slice(0, 10) >= n.at; };
function goalieNotes(p, x) {
  const out = [];
  const depth = !x.depth ? 'not on the depth chart' : dfoLastGame(p.team) ? (x.depth === 1 ? `started ${p.team}'s last game` : `backed up ${p.team}'s last game`) : `G${x.depth} per ${dfoSource(p.team)}`;
  const c = x.crease;
  if (c?.tg) out.push(`${pct(x.share)} of ${p.team} starts projected: ${c.gs} of ${c.tg} so far, ${c.recent} of the last ${c.recentOf}${c.svp != null && c.gs ? `, ${c.svp.toFixed(3).replace(/^0/, '')} save %` : ''}`);
  else out.push(`${depth}, ${pct(x.share)} of ${p.team} starts projected${x.gs ? ` (${x.gs} of ${teamGP[p.team]} so far)` : ''}`);
  if (x.fillInFor) out.push(`Starting while ${x.fillInFor.name} is out${x.fillInFor.news ? ` (${x.fillInFor.news.at}: ${x.fillInFor.news.text.slice(0, 110)}${x.fillInFor.news.text.length > 110 ? '...' : ''})` : ''}; long-term value counted for ~${x.fillInFor.games} games only${x.fillInFor.back ? ` (ESPN expects him back ~${x.fillInFor.back.slice(5).replace('-', '/')})` : ''}`);
  const prevRate = x.prev ? goalieFP(x.prev.totals) / x.prev.GP : null;
  out.push(`${round(x.perStart, 1)} pts/start${prevRate != null ? ` (last season ${round(prevRate, 1)} in ${x.prev.GP} GP)` : ''}${x.agTier ? `, your tier ${x.agTier}` : ''}`);
  const tf = TEAM_FORM[p.team];
  if (tf && Math.abs(x.teamAdj || 0) >= 0.3) out.push(`${p.team} ${tf.wins}-${tf.starts - tf.wins} this season, ${round(tf.est.GA, 1)} goals against/gm: ${x.teamAdj > 0 ? '+' : '−'}${round(Math.abs(x.teamAdj), 1)} pts/start for team form`);
  const gms = days.filter((d) => teamPlays(p.team, d)).map((d) => {
    const i = days.indexOf(d), o = oppOn[p.team + '|' + d];
    const adj = goalieOppAdj(p.team, d);
    const tags = [isB2B(p.team, d) ? '2nd of back-to-back' : '', lightNights.has(d) ? 'light night' : '', Math.abs(adj) >= 0.8 ? `${adj > 0 ? 'soft' : 'tough'} matchup ${adj > 0 ? '+' : '−'}${round(Math.abs(adj), 1)}/start` : ''].filter(Boolean);
    return `${week.nightly[i].day} ${o.startsWith('@') ? o : 'vs ' + o}${tags.length ? ' (' + tags.join(', ') + ')' : ''}`;
  });
  if (gms.length) out.push(`This week: ${gms.join(' · ')}`);
  if (x.dfo?.news && !newerNote(p, x.dfo.news) && !/contract|signed|extension|re-sign/i.test(x.dfo.news.text) && !((n) => (Date.now() - new Date(n.at)) / 86400000 > 1 && /monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|will start|opener/i.test(n.text))(x.dfo.news)) out.push(`News ${x.dfo.news.at}: ${x.dfo.news.text.length > 140 ? x.dfo.news.text.slice(0, 137) + '...' : x.dfo.news.text}`);
  return out;
}
function usageNotes(p) {
  const x = proj.get(p.playerId);
  const out = [];
  if (x.kind === 'G') return goalieNotes(p, x);
  const fgrp = p.position === 'D' ? 'D' : 'F';
  const d = x.dfo;
  if (d && !dfoOut(d)) {
    const ev = d.line ? `Line ${d.line}` : d.pair ? `Pair ${d.pair}` : 'Not in the lineup';
    const mates = (d.mates || []).map((id) => byId.get(id)?.name?.split(' ').slice(-1)[0]).filter(Boolean);
    const q = (d.mates || []).map((id) => proj.get(id)?.proj).filter((v) => v != null);
    const lq = q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
    let pu = d.pp ? `PP${d.pp}` : 'no PP unit';
    if (x.shiftPP != null && x.gp) pu += ` (${pct(x.shiftPP)} of ${p.team} PP time in ${x.gp} GP${d.pp === 1 && x.shiftPP < 0.35 ? ', so the PP1 spot is new' : d.pp !== 1 && x.shiftPP >= 0.55 ? ', so he just lost PP1 time' : ''})`;
    if (d.pp && evenSplit(p.team)) pu += `; ${p.team} splits its PP about evenly (PP1 ${pct(unitShare(p.team, 1))}, PP2 ${pct(unitShare(p.team, 2))})`;
    const sheet = x.a?.ppUnit && x.a.ppUnit != d.pp ? `; your sheet: PP${x.a.ppUnit}` : !x.a?.ppUnit && d.pp ? '; your sheet: no PP' : '';
    if (d.pk === 1) pu += ', PK1';
    out.push(`DailyFaceoff (${dfoSource(p.team)}): ${ev}${mates.length ? ' with ' + mates.join(', ') : ''}${lq != null ? ` (${fgrp === 'D' ? 'partner projects' : 'linemates project'} ${round(lq, 1)})` : ''}, ${pu}${sheet}${d.gtd || d.injury === 'dtd' ? ', day-to-day' : ''}`);
  }
  if (d?.news && !newerNote(p, d.news) && !/contract|signed|extension|re-sign/i.test(d.news.text) && !((n) => (Date.now() - new Date(n.at)) / 86400000 > 1 && /monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|will start|opener/i.test(n.text))(d.news)) out.push(`News ${d.news.at}: ${d.news.text.length > 140 ? d.news.text.slice(0, 137) + '...' : d.news.text}`);
  if (x.shiftPP != null && x.gp && !d) {
    const unit = x.shiftPP >= 0.55 ? 'PP1' : x.shiftPP >= 0.2 ? 'PP2' : 'no PP role';
    const was = x.prev?.toi?.PPshare != null && x.prev.GP >= 20 ? ` (${pct(x.prev.toi.PPshare)} last season)` : x.a?.ppUnit ? ` (projected PP${x.a.ppUnit})` : '';
    out.push(`Shift charts: ${unit} usage, ${pct(x.shiftPP)} of ${p.team} power-play time${was}`);
  } else if (x.a?.ppUnit && !d) out.push(`Projected PP${x.a.ppUnit}`);
  if (x.curEV && x.gp) {
    const r = evRank.get(p.playerId);
    const role = fgrp === 'F' ? `#${r} ${p.team} forward in EV+PP time` : `#${r} ${p.team} D in total ice time`;
    const was = x.baseEV ? ` (${pct(x.baseEV)} baseline)` : '';
    out.push(`${fmtToi(x.curEVsec)} even strength = ${pct(x.curEV)} of ${p.team} EV time${was}; ${role}`);
    const toi = x.cur?.toi?.TOI_pg, sheetToi = x.a?.ATOI ? x.a.ATOI * 60 : null;
    if (x.roleCheck) out.push(`Role check: playing ${fmtToi(toi)} a night vs the ${fmtToi(sheetToi)} your sheet assumes; if that holds he projects ${round(x.roleCheck.projIfRole, 1)}/gm (season value uses ${x.roleCheck.confirmed ? 'that, since the reported lineup confirms it' : 'the midpoint'})`);
    if (x.baseEV && x.curEV - x.baseEV >= 0.04) {
      const hurt = skaters.filter((q) => q.team === p.team && q !== p && (q.position === 'D') === (p.position === 'D') && proj.get(q.playerId).injured && proj.get(q.playerId).prior >= x.prior * 0.75);
      if (hurt.length) out.push(`Extra ice time likely shrinks when ${hurt.slice(0, 3).map((q) => `${q.name} (${injuryWord(q)})`).join(', ')} return${hurt.length === 1 ? 's' : ''}`);
    }
  }
  const ln = LINES?.players?.[p.playerId];
  if (ln?.line?.length && !(d?.mates?.length)) {
    const q = ln.line.map((m) => proj.get(Number(m.id))?.proj).filter((v) => v != null);
    const lq = q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
    out.push(`${fgrp === 'D' ? 'Paired with' : 'Line'}: ${ln.line.map((m) => `${m.name} (${pct(m.share)})`).join(', ')}${lq != null ? ` · ${fgrp === 'D' ? 'partner projects' : 'linemates project'} ${round(lq, 1)} pts/gm` : ''}`);
  }
  if (ln?.ppUnit && x.shiftPP == null && !d) out.push(`PP${ln.ppUnit} in shift charts (${pct(ln.ppTeamShare)} of team PP time)`);
  if (x.gp && x.sog >= 3) {
    const sh = x.goals / x.sog;
    if (x.goals - x.xG >= 1.5) out.push(`${x.goals} G on ${x.sog} shots (${pct(sh)}): goals will cool`);
    else if (x.xG - x.goals >= 1) out.push(`${x.goals} G on ${x.sog} shots: due for goals`);
  }
  if (x.missed && !x.injured && x.gp) out.push(`Missed ${x.missed} of ${teamGP[p.team]} games`);
  const yStatus = mine.find((m) => m.p.playerId === p.playerId)?.status || '';
  if (/^IR|^O$|NA/.test(yStatus)) out.push(`On your ${yStatus} slot in Yahoo`);
  else if (!x.gp && !x.injured && teamGP[p.team]) out.push(`Hasn't dressed: 0 of ${teamGP[p.team]} ${p.team} games (scratch or unlisted injury)`);
  if (x.fillIn) out.push(`Fill-in role: extra usage exists while ${x.fillIn.join(', ')}; worth ${round(x.proj, 1)}/gm now, about ${round(x.projLong, 1)}/gm after (valued that way past ~${x.fillInGames} games)${x.fillInMine?.length ? `. ${x.fillInMine.join(', ')} is on your IR: activating him ends this role` : ''}`);
  if (x.injured) out.push(dfoOut(d) ? `Injured (${d.injury === 'ir' ? 'IR' : 'out'} per DailyFaceoff)` : 'Not on the active roster (injured)');
  return out;
}

// ---- Intel: news, role reports, ice time, ownership -----------------------------------------
// Each tag has a tone (+ good for his value, − bad). Tags that the projection already prices in
// (PP unit, ice time, injuries, fill-in roles) are flagged so you see why; coach comments,
// call-ups, scratches and ownership moves are news the usage numbers can't see yet, and they
// nudge the long-term holds ranking only.
const COACH_RE = /\b(head coach|coach(?:es|ing staff)?|bench boss)\b/i;
const PRAISE_RE = /\b(prais\w*|impress\w*|happy with|pleased with|raved|complimented|credited|lauded|lik(?:es|ed) what|trust\w*|confiden\w*|singled out|rewarded|deserv\w*|excellent|terrific|outstanding)\b/i;
const KNOCK_RE = /\b(not happy|unhappy|frustrat\w*|criticiz\w*|called out|benched|send a message|challenged|disappoint\w*|needs to be better|not good enough)\b/i;
const OWN_PREV = (() => {
  const dir = path.join(ROOT, 'nhl/out/espn-history');
  if (!ESPN || !fs.existsSync(dir)) return null;
  const cut = new Date(new Date(ESPN.fetchedAt) - 5 * 86400000).toISOString().slice(0, 10);
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x.slice(0, 10) <= cut).sort().pop();
  return f ? { date: f.slice(0, 10), owned: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } : null;
})();
const md = (s) => (s ? s.slice(5, 10).replace('-', '/') : '');
const EVENT_TAG = {
  callup: ['Called up', +1], senddown: ['Sent down / waived', -3], claimed: ['Claimed on waivers', 0], scratch: ['Scratched', -2],
  return: ['Returning', +0.5], injury: ['Injury news', -1], debut: ['NHL debut', +0.5], minutes: ['Big minutes', +1], start: ['Confirmed start', 0], backup: ['Backing up', 0],
};
function intelFor(p) {
  const x = proj.get(p.playerId), e = espnP(p.playerId), note = freshNote(p.playerId), nr = newsRole(p);
  const tags = [];
  const tag = (kind, label, tone, why, priced = false) => tags.push({ kind, label, tone, why, priced });
  const isG = p.position === 'G';
  // injuries and who they open space for
  const inj = espnInj(p.playerId);
  if (x.injured || inj) tag('injured', x.injured ? `Out${returnDate(p) ? ` to ~${md(returnDate(p))}` : ''}` : 'Day-to-day', x.injured ? -2 : -0.5,
    `${inj?.status || 'Not on the active roster'}${inj?.type ? `: ${inj.type.toLowerCase()}${inj.detail ? ` (${inj.detail.toLowerCase()})` : ''}` : ''}${inj?.returnDate ? `. ESPN expects him back ~${md(inj.returnDate)}${returnGames(p) ? ` (${returnGames(p)} ${p.team} games)` : ''}` : ''}${inj?.comment ? `. ${inj.comment}` : ''}`, true);
  if (x.fillIn) tag('opening', 'Injury opening', +1.5, `Extra usage while ${x.fillIn.join(', ')}: worth ${round(x.proj, 1)}/gm now, ~${round(x.projLong, 1)} after (about ${x.fillInGames} games)`, true);
  if (x.fillInFor) tag('opening', 'Starter out', +1.5, `Starting while ${x.fillInFor.name} is out${x.fillInFor.back ? ` (ESPN: back ~${md(x.fillInFor.back)})` : ''}, valued for ~${x.fillInFor.games} games`, true);
  if (!isG && x.kind === 'S') {
    // power play: what is reported now vs what your sheet assumed
    const nowU = x.dfoUnit, src = x.ppFromNews ? `Rotowire ${md(nr.at)}` : 'DailyFaceoff';
    if (nowU === 1 && x.baseUnit !== 1 && !x.injured) tag('pp-up', 'PP1 promotion', +2, `On PP1 per ${src}; your sheet had ${x.baseUnit ? 'PP' + x.baseUnit : 'no PP role'}${x.shiftPP != null && x.gp ? ` (${pct(x.shiftPP)} of ${p.team} PP time so far)` : ''}`, true);
    else if (x.baseUnit === 1 && nowU != null && nowU !== 1 && !x.injured) tag('pp-down', 'Off PP1', -2, `${nowU ? 'PP' + nowU : 'No PP unit'} per ${src}; your sheet assumes PP1`, true);
    else if (nr?.pp != null && nr.pp !== (x.dfo?.pp ?? 0) && !x.ppFromNews && x.dfo) tag('pp-conflict', `PP${nr.pp || '–'} per Rotowire`, 0, `Rotowire (${md(nr.at)}) has him on ${nr.pp ? 'PP' + nr.pp : 'no PP unit'}; DailyFaceoff has ${x.dfo.pp ? 'PP' + x.dfo.pp : 'no PP unit'}`);
    // even-strength line vs where his projection ranks him on his team
    const line = nr?.line ?? x.dfo?.line, lineSrc = nr?.line ? `Rotowire ${md(nr.at)}` : 'DailyFaceoff';
    if (p.position !== 'D' && line && x.naturalLine && !x.injured) {
      if (line <= 2 && x.naturalLine >= 3) tag('line-up', line === 1 ? 'Top line' : 'Top-six role', +1.5, `Line ${line} per ${lineSrc}; his projection ranks him a line-${x.naturalLine} forward on ${p.team}`, x.lineFP > 0);
      else if (line === 1 && x.naturalLine === 2) tag('line-up', 'Top line', +0.75, `Line 1 per ${lineSrc}; projection ranks him line 2`, x.lineFP > 0);
      else if (line >= 3 && x.naturalLine <= 2) tag('line-down', `Line ${line}`, -1.5, `Line ${line} per ${lineSrc}; his projection ranks him a line-${x.naturalLine} forward`, x.lineFP < 0);
    }
    if (p.position === 'D' && nr?.pair === 1 && !x.injured) tag('line-up', 'Top pair', +0.5, `Top pairing per Rotowire ${md(nr.at)}`);
    // ice time: last 3 games vs his baseline
    const prevToi = x.prev && x.prev.GP >= 20 && (x.prev.teamAbbrevs || '').split(',').pop() === p.team ? x.prev.toi?.TOI_pg : null;
    const baseToi = prevToi || (x.a?.ATOI ? x.a.ATOI * 60 : null);
    if (e?.recentToi && e.recentGames >= 2 && baseToi && !x.injured) {
      const d = e.recentToi - baseToi;
      if (d >= 90 && d / baseToi >= 0.1) tag('minutes', 'Minutes up', +1, `${fmtToi(e.recentToi)} a night over his last ${e.recentGames} games vs ${fmtToi(baseToi)} ${prevToi ? 'last season' : 'in your sheet'}`, true);
      else if (d <= -120 && d / baseToi <= -0.12) tag('minutes-down', 'Minutes down', -1, `${fmtToi(e.recentToi)} a night over his last ${e.recentGames} games vs ${fmtToi(baseToi)} ${prevToi ? 'last season' : 'in your sheet'}`, true);
    }
  }
  // the crease: who has the net lately and who is outplaying whom (not a depth chart's G1/G2)
  if (isG && x.crease && !x.injured && !x.fillInFor) {
    const c = x.crease, recent = `started ${c.recent} of ${p.team}'s last ${c.recentOf}${c.streak >= 2 ? ` (${c.streak} straight)` : ''}`;
    const sv = (v) => (v == null ? '' : v.toFixed(3).replace(/^0/, ''));
    const vs = c.vs && c.svp != null && c.vs.svp != null ? `${sv(c.svp)} save % vs ${c.vs.name.split(' ').pop()} ${sv(c.vs.svp)}` : '';
    const outplay = c.vs && c.vs.d > 0.15 && c.gs >= 2;
    if (x.basePrior < 0.5 && x.share >= 0.5 && x.share - x.basePrior >= 0.1 && c.recent >= 3 && c.streak >= 2) tag('starter', 'Took the net', +1.5, `${recent}; ${pct(x.share)} of starts projected, ${pct(x.basePrior)} before the season${vs ? `; ${vs}` : ''}`, true);
    else if (outplay && x.basePrior < 0.5 && c.recent >= 2 && !c.behindElite) tag('pushing', 'Pushing for starts', +0.5, `${recent}; ${vs}${c.vs.leash ? `; ${c.vs.name.split(' ').pop()} has a longer leash (${c.vs.leash})` : ''}`, true);
    if (x.basePrior >= 0.5 && x.share <= x.basePrior - 0.1 && c.recent < c.recentOf / 2) tag('losing', 'Losing starts', -1, `${recent}; ${pct(x.share)} of starts projected, ${pct(x.basePrior)} before the season${vs ? `; ${vs}` : ''}`, true);
    if (c.behindElite && x.share >= 0.25) tag('crease-backup', `Backup to ${c.behindElite.split(' ').pop()}`, -0.5, `${recent}; ${c.behindElite} is an elite starter, so starts are capped near ${pct(x.share)}`, true);
  }
  // trade talk around a goalie: his own role is in question, and so is the crease of a team he's linked to
  if (isG) for (const t of goalieTalk) {
    if (t.id === p.playerId) tag('monitor', 'Trade talk', 0, `${t.headline} (${md(t.at)})`);
    else if (!x.injured && t.team === p.team) tag('monitor', 'Monitor', -0.5, `${t.name}'s situation decides this crease: ${t.headline} (${md(t.at)})`);
    else if (!x.injured && t.linked.includes(p.team)) tag('monitor', 'Monitor', -0.5, `${t.name} trade talk mentions ${p.team}; he'd take most starts: ${t.headline} (${md(t.at)})`);
  }
  // headline events
  for (const ev of note?.events || []) {
    const [label, tone] = EVENT_TAG[ev.kind] || [ev.kind, ev.tone];
    if (ev.kind === 'injury' && tags.some((t) => t.kind === 'injured')) continue;
    if ((ev.kind === 'start' || ev.kind === 'backup') && (Date.now() - new Date(note.at)) / 86400000 > 1.5) continue; // a single game's news
    if (ev.kind === 'return' && !x.injured && !inj && (Date.now() - new Date(note.at)) / 86400000 > 4) continue;
    tag(ev.kind, label, tone, note.headline);
  }
  // what the coach said (Rotowire note, then DailyFaceoff's news)
  const coach = note?.coach || (() => {
    const t = x.dfo?.news?.text;
    if (!t || !COACH_RE.test(t)) return null;
    return PRAISE_RE.test(t) && !KNOCK_RE.test(t) ? { tone: 1, text: t } : KNOCK_RE.test(t) ? { tone: -1, text: t } : null;
  })();
  if (coach) tag(coach.tone > 0 ? 'coach' : 'coach-down', coach.tone > 0 ? 'Coach praise' : 'Coach critical', coach.tone, coach.text.length > 220 ? coach.text.slice(0, 217) + '...' : coach.text);
  // fantasy managers moving on him
  const was = OWN_PREV?.owned?.[p.playerId];
  const ownedDelta = e?.owned != null && was != null ? round(e.owned - was, 1) : null;
  if (ownedDelta != null && ownedDelta >= 5) tag('trending', 'Trending up', +0.5, `Rostered in ${e.owned}% of ESPN leagues, +${ownedDelta} since ${md(OWN_PREV.date)}`);
  if (ownedDelta != null && ownedDelta <= -8) tag('trending-down', 'Being dropped', -0.5, `Rostered in ${e.owned}% of ESPN leagues, ${ownedDelta} since ${md(OWN_PREV.date)}`);
  const tone = tags.reduce((a, t) => a + t.tone, 0);
  return {
    tags, tone: round(tone, 1),
    note: note ? { at: note.at.slice(0, 10), headline: note.headline, story: note.story } : null,
    owned: e?.owned ?? null, ownedDelta, recentToi: e?.recentToi ? fmtToi(e.recentToi) : null,
  };
}
// news the projection can't see yet (coach, call-ups, scratches, ownership) nudges the holds score
const newsNudge = (it) => clamp(it.tags.filter((t) => !t.priced).reduce((a, t) => a + t.tone, 0), -4, 4);

// ---- Player cards -------------------------------------------------------------------------
function card(p) {
  const x = proj.get(p.playerId);
  const c = {
    id: p.playerId, name: p.name, team: p.team, pos: posOf(p), age: p.age, kind: x.kind,
    tier: x.tier || 'depth', rank: x.rank, proj: round(x.proj, 2), vor: round(x.vor ?? 0, 2),
    gamesWk: gamesIn(p, days), lightWk: days.filter((d) => teamPlays(p.team, d) && lightNights.has(d)).length,
    gamesNext: gamesIn(p, days2), lightNext: days2.filter((d) => teamPlays(p.team, d) && lightNights.has(d)).length,
    gameDays: days.map((d) => (teamPlays(p.team, d) ? 1 : 0)),
    opps: days.map((d) => (teamPlays(p.team, d) ? oppOn[p.team + '|' + d] || '' : '')),
    waiverUntil: waiverUntil.get(p.playerId) > today ? waiverUntil.get(p.playerId) : null,
    inactive: !!x.inactive, injured: !!x.injured, gp: x.gp, confidence: conf(x.gp),
    playoff: playoffInfo(p.team), posRank: posRank.get(p.playerId) || null,
    notes: usageNotes(p), intel: intelFor(p),
  };
  if (x.kind === 'S') {
    Object.assign(c, {
      prior: round(x.prior, 2), usageFP: round(x.usageFP, 2), src: x.src,
      lastFppg: x.prev ? round(skaterFP(x.prev.totals) / x.prev.GP, 2) : null, lastGp: x.prev?.GP ?? 0,
      curFppg: x.curFP != null ? round(x.curFP, 2) : null,
      ppShare: x.curPP, ppUnitNow: x.dfoUnit, line: x.dfo?.line ?? x.dfo?.pair ?? null, ppShareBase: round(x.basePP, 2), fillIn: x.fillIn || null, projLong: x.projLong != null ? round(x.projLong, 2) : null, lineFP: x.lineFP ? round(x.lineFP, 2) : 0, ev: x.curEVsec ? fmtToi(x.curEVsec) : null, evShare: x.curEV ? round(x.curEV, 3) : null, evShareBase: x.baseEV ? round(x.baseEV, 3) : null, pp1: !!x.pp1, evRank: evRank.get(p.playerId) || null,
    });
  } else {
    Object.assign(c, { fillInFor: x.fillInFor?.name ?? null, depth: x.depth, perStart: round(x.perStart, 2), share: round(x.share, 2), starts: x.gs, agTier: x.agTier ?? null, isStarter: !!x.isStarter });
  }
  return c;
}

// ---- Your roster: usage vs results ledger ----------------------------------------------------
function ledger(p) {
  const x = proj.get(p.playerId);
  if (x.kind !== 'S' || (!x.gp && x.dfoUnit == null)) return null;
  const roleDelta = x.usageFP - x.prior; // what the new role is worth vs the preseason line
  const luck = x.curFP != null ? x.curFP - x.usageFP : 0;
  let call, why;
  if (roleDelta >= 0.4) { call = 'Usage up'; why = `Role is worth +${round(roleDelta, 1)} pts/gm over his preseason line`; }
  else if (roleDelta <= -0.4) { call = 'Usage slipping'; why = `Role is worth ${round(roleDelta, 1)} pts/gm vs his preseason line`; }
  else call = 'Steady';
  if (x.gp >= 5) {
    const star = ['stud', 'strong'].includes(x.tier);
    if (luck <= -2 && roleDelta > -0.4) { call = star ? 'No concern' : 'Hold: buy-low'; why = `Scoring ${round(x.curFP, 1)}/gm, usage says ${round(x.usageFP, 1)}`; }
    if (luck >= 3 && roleDelta < 0.4) { call = 'Sell-high'; why = `Scoring ${round(x.curFP, 1)}/gm, usage says ${round(x.usageFP, 1)}`; }
  } else {
    const ppD = x.curPP != null ? x.curPP - x.basePP : 0;
    const sheetU = x.a?.ppUnit ? Number(x.a.ppUnit) : null, nowU = x.dfoUnit;
    const evD = x.curEV && x.baseEV ? x.curEV - x.baseEV : 0;
    const lineD = x.lineQuality != null ? x.lineQuality - x.lineExpected : 0; // vs the linemates his projection implies
    if (nowU != null && (sheetU || 0) !== nowU && (nowU === 1 || sheetU === 1)) {
      const up = nowU === 1;
      call = up ? 'Usage up' : 'Usage slipping';
      why = `PP ${up ? 'promotion' : 'demotion'}: DailyFaceoff has him on ${nowU ? 'PP' + nowU : 'neither PP unit'} (your sheet: ${sheetU ? 'PP' + sheetU : 'no PP'})${x.shiftPP != null ? `; ${pct(x.shiftPP)} of team PP time so far` : ''}`;
    }
    else if (ppD >= 0.1 + 0.15 / x.gp) { call = 'Usage up'; why = `PP promotion: ${pct(x.curPP)} of team PP time vs ${pct(x.basePP)} expected`; }
    else if (ppD <= -(0.1 + 0.15 / x.gp)) { call = 'Usage slipping'; why = `PP demotion: ${pct(x.curPP)} of team PP time vs ${pct(x.basePP)} expected`; }
    else if (lineD >= 1.2 && x.gp >= 3) { call = 'Usage up'; why = `Line upgrade: linemates project ${round(x.lineQuality, 1)} vs ${round(x.lineExpected, 1)} for a typical ${p.team} top-${x.naturalLine * 3} forward`; }
    else if (lineD <= -1.5 && x.gp >= 3) { call = 'Usage slipping'; why = `Line downgrade: linemates project ${round(x.lineQuality, 1)} vs ${round(x.lineExpected, 1)} for a typical ${p.team} top-${x.naturalLine * 3} forward${x.lineInjuries?.length ? ` (temporary? ${x.lineInjuries.join(', ')})` : ''}`; }
    else if (evD >= 0.05 + 0.08 / x.gp) { call = 'Usage up'; why = `Even-strength share up: ${pct(x.curEV)} of team EV time vs ${pct(x.baseEV)}`; }
    else if (evD <= -(0.05 + 0.08 / x.gp)) { call = 'Usage slipping'; why = `Even-strength share down: ${pct(x.curEV)} of team EV time vs ${pct(x.baseEV)}`; }
    else if (call === 'Steady') why = `Role intact; too early to judge results (${x.gp} GP)`;
  }
  return { call, why: why || `Usage in line with his projection (${round(x.usageFP, 1)}/gm)`, roleDelta: round(roleDelta, 2), luck: round(luck, 1), confidence: conf(x.gp) };
}

// ---- Long-term holds: quality at the position + what the role implies ---------------------------------
function holdScore(p) {
  const x = proj.get(p.playerId);
  // quality is long-term points over replacement at his position, so a 6.5/gm forward outranks a 4.4/gm
  // defenceman who merely sits high in the weaker D pool; growth is upside (see growth()), never a penalty
  // for a proven vet
  const quality = clamp(50 + (x.vorLong ?? x.vor) * 40, 0, 100);
  // a goalie's role is his share of the team's starts
  const roleGap = p.position === 'G' ? clamp(50 + (x.share - 0.5) * 100, 0, 100)
    : x.gp >= 1 ? clamp(50 + (x.usageFP - x.prior) * 40 * (x.gp / (x.gp + 2)), 0, 100) : 50;
  const youth = 50 + 50 * growth(p);
  // news the usage data hasn't caught up with (coach, call-up, scratch, ownership): up to ±8 points
  const news = newsNudge(intelFor(p)) * 2;
  return { score: 0.45 * quality + 0.3 * roleGap + 0.25 * youth + news, parts: { quality: Math.round(quality), role: Math.round(roleGap), youth: Math.round(youth), news: round(news, 1) } };
}
const provenRole = (p) => { const x = proj.get(p.playerId), r = evRank.get(p.playerId) || 99; if (p.position === 'G') return x.isStarter && !x.fillInFor; return (x.curPP ?? 0) >= 0.2 || (x.dfo?.line && x.dfo.line <= 2) || (x.dfo?.pair && x.dfo.pair <= 2) || (p.position === 'D' ? r <= 4 : r <= 6); };
// planned adds stay listed (flagged) when they rank as holds on their own merits
const plannedAdd = new Map(plan.map((m) => [m.add.playerId, week.nightly[m.di].day]));
const holds = avail.filter((p) => !proj.get(p.playerId).inactive && !(proj.get(p.playerId).tier === 'stud' || ((proj.get(p.playerId).vorLong ?? proj.get(p.playerId).vor) > KEEP_VOR && proj.get(p.playerId).tier !== 'depth')) && proj.get(p.playerId).gp >= 1 && provenRole(p))
  .map((p) => ({ p, ...holdScore(p) })).sort((a, b) => b.score - a.score).slice(0, 12)
  .map(({ p, score, parts }) => {
    const x = proj.get(p.playerId), c = card(p);
    const reasons = [...c.notes];
    if (p.position === 'G') reasons.unshift(`Projects ${round(x.perStart, 1)} pts per start × ${Math.round(x.share * 100)}% of ${p.team} starts = ${round(x.proj, 1)} per team game`);
    else reasons.unshift(`Projects ${round(x.proj, 1)} pts/gm (${x.src} ${round(x.prior, 1)}, role implies ${round(x.usageFP - (x.lineFP || 0), 1)}${x.lineFP && Math.abs(x.lineFP) >= 0.05 ? `, linemates ${x.lineFP > 0 ? '+' : ''}${round(x.lineFP, 1)}` : ''})`);
    if (p.age && p.age <= 23) reasons.push(`Age ${p.age}`);
    if (p.derived?.teamChanged) reasons.push(`New team: role reset`);
    if (c.playoff?.elite) reasons.push(`Playoff schedule: ${c.playoff.games} games, ${c.playoff.offNights} light nights Mar 15–28`);
    const toi = p.position === 'G' ? null : season(p, CUR)?.toi?.TOI_pg, toiPrev = p.position === 'G' ? null : season(p, PREV)?.toi?.TOI_pg;
    return { ...c, score: round(score, 1), parts, reasons, toi: toi ? fmtToi(toi) : null, toiPrev: toiPrev ? fmtToi(toiPrev) : null, planned: plannedAdd.get(p.playerId) || null };
  });

// ---- Assemble -------------------------------------------------------------------------
const studsAvailable = avail.filter((p) => {
  const x = proj.get(p.playerId);
  if (x.fillInFor) return false; // a fill-in goalie is a stream, not a keep (shown in the insights)
  return x.tier === 'stud' || ((x.vorLong ?? x.vor) > KEEP_VOR && x.tier !== 'depth');
}).map((p) => ({ ...card(p), wireCall: proj.get(p.playerId).tier === 'stud' ? 'stud' : 'keep' })).sort((a, b) => b.vor - a.vor);
// the wire's best: this week's planned adds first, then the long-term holds in the same order as that section
const bestOnWire = [...new Set([...plan.map((m) => m.add.playerId), ...holds.map((h) => h.id)])].slice(0, 5).map((id) => card(byId.get(id)));

// capacity: how many extra players of each position could start that night (multi-position players reshuffle)
function capacity(players, d, pos) {
  const real = players.map((p) => ({ key: p.playerId, pos: posOf(p), value: valueOn(p, d) })).filter((x) => x.value > 0);
  const dummies = Array.from({ length: 4 }, (_, k) => ({ key: 'x' + k, pos: [pos], value: 1e-6 }));
  const lu = bestLineup([...real, ...dummies], SLOTS);
  return dummies.filter((x) => lu.starters.has(x.key)).length;
}
function lineupView(rbd) {
  return days.map((d, i) => {
    const players = rbd[i];
    const lu = dayLineup(players, d);
    const fits = Object.fromEntries(['C', 'LW', 'RW', 'D'].map((pos) => [pos, capacity(players, d, pos)]));
    const skSlots = SLOTS.filter((s) => s !== 'G').length, gSlots = SLOTS.length - skSlots;
    const vals = [...lu.starters.values()];
    const goaliesPlaying = players.filter((p) => p.position === 'G' && teamPlays(p.team, d)).length;
    return {
      date: d, day: week.nightly[i].day, leagueGames: week.nightly[i].games, offNight: week.nightly[i].offNight,
      fits, openSkater: skSlots - vals.filter((s) => s !== 'G').length, openG: gSlots - Math.min(gSlots, goaliesPlaying),
      starters: [...lu.starters.entries()].map(([id, s]) => ({ id, slot: s })), points: round(lu.total, 1),
      roster: players.map((p) => p.playerId),
    };
  });
}

const addedCards = new Map(plan.map((m) => [m.add.playerId, card(m.add)]));
const myCards = mine.map((m) => {
  const c = card(m.p);
  const x = proj.get(m.p.playerId);
  const keep = x.tier === 'stud' ? 'untouchable' : protectedDrop(m.p) || x.vor > KEEP_VOR ? 'keep' : x.vor > ROS_NOISE ? 'borderline' : 'droppable';
  return { ...c, slot: m.slot, status: m.status, keep, startRate: round(startRate.get(m.p.playerId) ?? 0, 2), ledger: ledger(m.p) };
});

const describe = (m) => ({
  day: days[m.di], dayLabel: week.nightly[m.di].day,
  add: card(m.add), drop: card(m.drop),
  addGamesForYou: days.slice(m.di).filter((d) => teamPlays(m.add.team, d)).length,
  dropGamesBefore: days.slice(0, m.di).filter((d) => teamPlays(m.drop.team, d)).length,
  pMinAfter: m.pMinAfter != null ? round(m.pMinAfter, 2) : null,
  alts: (m.alts || []).map((a) => { const g = days.slice(a.di).filter((d) => teamPlays(a.add.team, d)).length; return { name: a.add.name, team: a.add.team, pos: posOf(a.add), proj: round(proj.get(a.add.playerId).proj, 1), drop: a.drop.name, net: round(a.net, 1), week: round(a.dWeek * WEEK_WEIGHT, 1), long: round(a.dLong, 1), starts: a.e.byStarts.get(a.add.playerId) || 0, games: g }; }),
  when: m.di === 0 ? 'Monday morning, before games lock' : `${week.nightly[m.di].day} morning, after ${m.drop.name.split(' ').slice(-1)[0]}'s ${days.slice(0, m.di).filter((d) => teamPlays(m.drop.team, d)).length ? 'earlier games' : 'idle days'}${waiverUntil.get(m.add.playerId) > days[0] ? ' (on waivers until ' + week.nightly[m.di].day + ')' : ''}`,
  weekGain: round(m.dWeek, 1), longTerm: round(m.dLong, 1), delayCost: round(m.delayCost || 0, 1), weekWeight: round(m.ww ?? WEEK_WEIGHT, 2),
  seasonStart: (() => { const r = seasonStartRate([...finalRosterPre(m)], m.add); return r == null ? null : round(r, 2); })(), net: round(m.net, 1),
  games: { gain: m.gamesGain, lost: m.gamesLost, net: m.gamesNet },
  confidence: conf(proj.get(m.add.playerId).gp),
  stream: proj.get(m.add.playerId).vor <= ROS_NOISE,
  goalieMin: round(m.gBonus || 0, 1),
  churn: m.churn || 0,
  dropWhy: (() => {
    const x = proj.get(m.drop.playerId), sr = startRate.get(m.drop.playerId);
    const bits = [x.vor <= 0 ? 'below replacement level: the wire has better' : `only ${round(x.vor, 1)} pts/gm over the wire`];
    if (sr != null && !added.has(m.drop.playerId)) bits.push(`makes your lineup in ${pct(sr)} of his games`);
    if (added.has(m.drop.playerId)) bits.push('streamer you added earlier this week');
    return bits.join(', ');
  })(),
});

const planRoster = rosterByDay;
// the roster right after a move (for season start rates on cards)
function finalRosterPre(m) { return m.next ? m.next[m.next.length - 1] : rosterByDay[rosterByDay.length - 1]; }
const finalRoster = rosterByDay[rosterByDay.length - 1];
// roster shape: healthy players by position vs lineup slots
const shape = (() => {
  const healthy = active.filter((p) => p.position !== 'G' && !proj.get(p.playerId).injured);
  const cnt = (pos) => healthy.filter((p) => posOf(p).includes(pos)).length;
  const wingers = healthy.filter((p) => posOf(p).some((x) => x === 'LW' || x === 'RW') && !posOf(p).includes('C')).length;
  const centres = healthy.filter((p) => posOf(p).includes('C')).length;
  const dmen = healthy.filter((p) => posOf(p).includes('D')).length;
  const slots = { C: SLOTS.filter((x) => x === 'C').length, W: SLOTS.filter((x) => x === 'LW' || x === 'RW').length, D: SLOTS.filter((x) => x === 'D').length };
  const notes = [];
  if (wingers > slots.W + 2) notes.push(`${wingers} wingers for ${slots.W} wing slots: your 5th+ wingers rarely start, so wing pickups add little. Consolidate (2-for-1 trade) or move a winger for a centre.`);
  if (centres < slots.C + 1) notes.push(`Only ${centres} healthy centre${centres === 1 ? '' : 's'} for ${slots.C} C slots: centre pickups fill the most empty nights.`);
  if (dmen < slots.D + 1) notes.push(`${dmen} healthy D for ${slots.D} D slots: no cover for a D injury.`);
  return { centres, wingers, dmen, slots, notes, cnt: { C: cnt('C'), LW: cnt('LW'), RW: cnt('RW'), D: cnt('D') } };
})();
// rest-of-season upgrades, ignoring this week's schedule: best wire player per position vs your weakest there
const upgrades = [];
for (const pos of ['C', 'LW', 'RW', 'D']) {
  const mineAt = finalRoster.filter((p) => p.position !== 'G' && posOf(p).includes(pos) && !protectedDrop(p) && !added.has(p.playerId)).sort((a, b) => proj.get(a.playerId).proj - proj.get(b.playerId).proj);
  const weakest = mineAt[0];
  const best = avail.filter((p) => posOf(p).includes(pos) && !proj.get(p.playerId).inactive && p.position !== 'G').sort((a, b) => proj.get(b.playerId).proj - proj.get(a.playerId).proj)[0];
  if (!weakest || !best) continue;
  const gap = proj.get(best.playerId).proj - proj.get(weakest.playerId).proj;
  if (gap > 0.3 && !upgrades.some((u) => u.add.id === best.playerId)) upgrades.push({ pos, add: card(best), over: card(weakest), gap: round(gap, 2), rosGain: round(longTermGain(best, weakest, finalRoster).total, 1), startRateIfAdded: (() => { const r = finalRoster.map((q) => (q === weakest ? best : q)); const e = evalDays(dates14.map(() => r), dates14); const g = gamesIn(best, dates14); return g ? round((e.byStarts.get(best.playerId) || 0) / g, 2) : 0; })() });
}
// goalie option when the start minimum is at risk
// alternatives on the roster AFTER the plan (the plan's drops are gone, its adds are in)
function bestMoveFor(add, dropFilter = () => true) {
  let best = null, blocked = 0, considered = 0;
  for (const drop of finalRoster) {
    if (drop.position === 'G' && add.position !== 'G') continue;
    if (!dropFilter(drop)) continue;
    if (protectedDrop(drop) && !added.has(drop.playerId)) { blocked++; continue; }
    if (usageVeto(add, drop)) { blocked++; continue; }
    considered++;
    for (let di = fromDay(add.playerId); di < days.length; di++) {
      if (!rosterByDay[di].includes(drop)) continue;
      const m = { add, drop, di, ...evalMove(add, drop, di) };
      if (!best || m.net > best.net) best = m;
    }
  }
  return { best, blocked, considered };
}
const altMoves = [];
for (const add of candidates) {
  if (added.has(add.playerId) || dropped.has(add.playerId)) continue;
  const { best } = bestMoveFor(add, (d) => !added.has(d.playerId));
  if (best) altMoves.push(best);
}
// why a keep-level wire player isn't in the plan
const blockerFor = (p) => {
  if (added.has(p.playerId)) return 'In this week\'s plan';
  const x = proj.get(p.playerId);
  const pre = singleMoves.find((m) => m.add === p);
  const fill = x.fillIn ? ` His role is a fill-in until ${x.fillIn.map((n) => n.replace(/ \(.*\)$/, '')).join(' and ')} return${x.fillIn.length > 1 ? '' : 's'}.` : '';
  if (pre) {
    const g = days.slice(pre.di).filter((d) => teamPlays(p.team, d)).length, st = pre.e.byStarts.get(p.playerId) || 0;
    const sr = seasonStartRate([...active.filter((x) => x !== pre.drop), p], p);
    const post = bestMoveFor(p).best;
    const after = post ? `After the plan his best move is drop ${post.drop.name}${added.has(post.drop.playerId) ? ' (this week\'s add, costs a second add)' : ''} for ${post.net >= 0 ? '+' : ''}${round(post.net, 1)}, under the ${MIN_MOVE_GAIN}-pt bar.` : 'After the plan nobody droppable is left (everyone else is protected), so a 2-for-1 trade is the way to open a spot.';
    return `Best single move was drop ${pre.drop.name} ${week.nightly[pre.di].day}: ${pre.dWeek >= 0 ? '+' : ''}${round(pre.dWeek, 1)} this week, ${pre.dLong >= 0 ? '+' : ''}${round(pre.dLong, 1)} rest of season. He'd start ${st} of his ${g} games this week${sr != null ? ` and ${Math.round(sr * 100)}% of his games over the season` : ''} for you${sr != null && sr < 0.65 ? ` (your ${posOf(p).join('/')} slots are usually full)` : ''}. ${after}${fill}`;
  }
  if (unusedAddsCount() <= 0) return 'All adds used by the plan.' + fill;
  const { best, considered } = bestMoveFor(p, (d) => !added.has(d.playerId));
  if (!best) return considered ? 'No drop gains anything this week' : 'Every player you could drop is protected (stud, strong, positional starter or PP1 top-6/top-4)';
  return `Best move: drop ${best.drop.name} ${week.nightly[best.di].day} for ${best.net >= 0 ? '+' : ''}${round(best.net, 1)} (${round(best.dWeek * WEEK_WEIGHT, 1)} this week, ${round(best.dLong, 1)} long-term), under the ${MIN_MOVE_GAIN}-pt bar`;
};
function unusedAddsCount() { return addsLeft - plan.length; }
for (const st of studsAvailable) { const p = byId.get(st.id); if (p && !proj.get(p.playerId).inactive) st.blocker = blockerFor(p); }
for (const c of bestOnWire) { const p = byId.get(c.id); if (p) c.blocker = blockerFor(p); }
// goalie stream check: the best goalie add on the post-plan roster, with its full breakdown
const goalieOk = (p) => { const x = proj.get(p.playerId); return !x.inactive && !added.has(p.playerId) && !(x.depth == null && x.dfo?.injury); };
const goalieStream = (() => {
  if (plan.some((m) => m.add.position === 'G')) return null;
  const gsNow = goalieStarts(rosterByDay);
  let g = null;
  for (const add of avail.filter((p) => p.position === 'G' && goalieOk(p))) {
    const { best } = bestMoveFor(add, (d) => d.position !== 'G');
    if (best && (!g || best.net > g.net)) g = best;
  }
  const others = avail.filter((p) => p.position === 'G' && goalieOk(p)).map((add) => bestMoveFor(add, (d) => d.position !== 'G').best).filter(Boolean)
    .sort((a, b) => b.net - a.net).slice(0, 4).map((m) => ({ name: m.add.name, team: m.add.team, day: week.nightly[m.di].day, drop: m.drop.name, net: round(m.net, 1), starts: round(days.slice(m.di).reduce((a, d) => a + startProb(m.add, d), 0), 1) }));
  if (!g) return { none: true, pMinBefore: gsNow.pMin, gPtsBefore: gsNow.gPts, gRaw: gsNow.gRaw, others };
  const after = goalieStarts(g.next);
  return {
    add: card(g.add), drop: card(g.drop), day: days[g.di], dayLabel: week.nightly[g.di].day,
    pMinBefore: gsNow.pMin, pMinAfter: after.pMin, gPtsBefore: gsNow.gPts, gPtsAfter: after.gPts,
    skaterGamesLost: base.starts - g.e.starts,
    gamesAfter: days.slice(g.di).filter((d) => teamPlays(g.add.team, d)).length,
    expStarts: round(days.slice(g.di).reduce((a, d) => a + startProb(g.add, d), 0), 1),
    b2bNights: days.slice(g.di).filter((d) => isB2B(g.add.team, d)).map((d) => week.nightly[days.indexOf(d)].day), weekPts: round(g.dWeek, 1), longTerm: round(g.dLong, 1), net: round(g.net, 1),
    others,
    verdict: plan.some((m) => m.add.position === 'G') ? 'in plan' : g.net >= MIN_MOVE_GAIN ? 'worth it' : 'below the bar',
  };
})();
const gsAfter = goalieStarts(planRoster);
let goalieOption = null;
if (false) {
  // search on the post-plan roster so the option doesn't reuse a drop already in the plan
  let gm = null;
  const finalRoster = rosterByDay[rosterByDay.length - 1];
  for (const add of avail.filter((p) => p.position === 'G' && !proj.get(p.playerId).injured)) {
    for (const drop of finalRoster.filter((p) => p.position !== 'G' && !added.has(p.playerId) && !protectedDrop(p) && !usageVeto(add, p))) {
      for (let di = fromDay(add.playerId); di < days.length; di++) {
        if (!rosterByDay[di].includes(drop)) continue;
        const m = { add, drop, di, ...evalMove(add, drop, di) };
        const pm = goalieStarts(m.next).pMin;
        if (pm >= 0.85 && (!gm || m.dWeek + m.dLong > gm.dWeek + gm.dLong)) gm = m;
      }
    }
  }
  if (gm) goalieOption = { add: card(gm.add), drop: card(gm.drop), day: days[gm.di], dayLabel: week.nightly[gm.di].day, pMinAfter: round(goalieStarts(gm.next).pMin, 2), weekPts: round(gm.dWeek, 1), longTerm: round(gm.dLong, 1) };
}
const unusedAdds = Math.max(0, addsLeft - plan.length);
const insights = [];
{
  const mineIds = new Set(mine.map((m) => m.p.playerId));
  const injuredPP1 = {};
  for (const p of skaters) { const x = proj.get(p.playerId); if (x.injured && Number(x.a?.ppUnit) === 1) (injuredPP1[p.team] ||= []).push(`${p.name} ${injuryWord(p) === 'day-to-day' ? 'is day-to-day' : 'is ' + injuryWord(p)}`); }
  const who = (p) => (mineIds.has(p.playerId) ? 'yours' : added.has(p.playerId) ? 'in your plan' : rostered.has(p.playerId) ? 'rostered' : 'on the wire');
  const pool = skaters.filter((p) => !proj.get(p.playerId).inactive && (mineIds.has(p.playerId) || !rostered.has(p.playerId)));
  const promo = pool.filter((p) => { const x = proj.get(p.playerId); return x.dfoUnit === 1 && x.baseUnit !== 1 && x.pp1; })
    .sort((a, b) => proj.get(b.playerId).proj - proj.get(a.playerId).proj).slice(0, 4);
  for (const p of promo) {
    const x = proj.get(p.playerId), inj = injuredPP1[p.team];
    insights.push({ kind: 'promotion', who: who(p), id: p.playerId, text: `${p.name} (${p.team}, ${who(p)}) is on PP1 per DailyFaceoff; your sheet had ${x.baseUnit ? 'PP' + x.baseUnit : 'no PP role'}${inj ? `, filling in while ${inj.join(', ')}` : ''}${x.fillInMine?.length ? ` (${x.fillInMine.join(', ')} is on your IR: activating him ends this)` : ''}. Projects ${round(x.proj, 1)}/gm${x.projLong != null ? ` now, ${round(x.projLong, 1)} once the regular returns` : ''}.` });
  }
  for (const m of mine) {
    const x = proj.get(m.p.playerId);
    if (x.kind === 'S' && x.baseUnit === 1 && x.dfoUnit != null && x.dfoUnit !== 1) insights.push({ kind: 'demotion', who: 'yours', id: m.p.playerId, text: `${m.p.name} is off PP1 per DailyFaceoff (now ${x.dfoUnit ? 'PP' + x.dfoUnit : 'no PP unit'}); your sheet assumes PP1.` });
    if (x.kind === 'S' && x.dfo?.pp === 1 && evenSplit(m.p.team) && !insights.some((i) => i.kind === 'split' && i.team === m.p.team)) {
      const names = mine.filter((q) => q.p.team === m.p.team && proj.get(q.p.playerId).dfo?.pp === 1).map((q) => q.p.name);
      insights.push({ kind: 'split', who: 'yours', team: m.p.team, id: m.p.playerId, text: `${m.p.team} splits its power play about evenly (PP1 ${pct(unitShare(m.p.team, 1))}, PP2 ${pct(unitShare(m.p.team, 2))} of PP time), so ${names.join(' and ')}'s PP1 tag${names.length > 1 ? 's are' : ' is'} worth less than usual.` });
    }
    const ppNow = x.cur?.toi?.PPTOI_pg, ppWas = x.prev?.GP >= 20 ? x.prev.toi?.PPTOI_pg : null;
    if (x.kind === 'S' && x.gp >= 2 && ppNow && ppWas && ppNow - ppWas >= 90) insights.push({ kind: 'ev', who: 'yours', id: m.p.playerId, text: `${m.p.name}: ${fmtToi(ppNow)} of power-play time a game vs ${fmtToi(ppWas)} last season, a bigger PP role than your sheet prices in (projects ${round(x.proj, 1)} now, ${round(x.usageFP, 1)} if the role holds).` });
    if (x.kind === 'S' && x.gp >= 2 && !insights.some((i) => i.id === m.p.playerId && i.kind === 'ev') && x.curEV && x.baseEV && Math.abs(x.curEV - x.baseEV) >= 0.06) insights.push({ kind: 'ev', who: 'yours', id: m.p.playerId, text: `${m.p.name}: ${pct(x.curEV)} of ${m.p.team} even-strength time over ${x.gp} games vs ${pct(x.baseEV)} expected (${x.curEV > x.baseEV ? 'more' : 'less'} ice time than your sheet assumes).` });
  }
  for (const p of goalies) {
    const x = proj.get(p.playerId);
    if (x.fillInFor && !rostered.has(p.playerId) && x.depth === 1) insights.push({ kind: 'goalie', who: 'on the wire', id: p.playerId, text: `${p.name} is ${p.team}'s G1 while ${x.fillInFor.name} is out: a time-boxed goalie stream (${round(days.reduce((a, d) => a + startProb(p, d), 0), 1)} expected starts in ${gamesIn(p, days)} games this week, ${round(x.perStart, 1)} pts/start).` });
  }
  if (DFO_PREV) {
    for (const p of pool) {
      const now = dfoP(p.playerId), was = DFO_PREV.players[p.playerId];
      if (!now || !was || dfoOut(now)) continue;
      if ((now.pp ?? 0) !== (was.pp ?? 0) && (now.pp === 1 || was.pp === 1)) insights.push({ kind: 'change', who: who(p), id: p.playerId, text: `${p.name} (${p.team}, ${who(p)}): ${was.pp ? 'PP' + was.pp : 'no PP'} → ${now.pp ? 'PP' + now.pp : 'no PP'} since ${DFO_PREV.date}.` });
      else if (now.line && was.line && Math.abs(now.line - was.line) >= 1 && (now.line <= 2 || was.line <= 2)) insights.push({ kind: 'change', who: who(p), id: p.playerId, text: `${p.name} (${p.team}, ${who(p)}): line ${was.line} → line ${now.line} since ${DFO_PREV.date}.` });
    }
  }
  // IR players coming back force cuts
  const rv = rosterValue(planRoster[planRoster.length - 1]);
  const byWeek = {};
  for (const c of rv.cuts) (byWeek[c.week] ||= []).push(c);
  for (const [wk, cs] of Object.entries(byWeek).slice(0, 2)) insights.push({ kind: 'ir', who: 'yours', id: cs[0].id, text: `${cs[0].forName} likely back the week of ${wk.slice(5)} (${cs[0].why}). With this week's moves your roster is then over the limit, so ${cs.length} must go. The season simulation cuts the player${cs.length > 1 ? 's' : ''} your lineup misses least: ${cs.map((c) => c.name + (c.tier >= 2 ? ` (one you value; next closest ${c.near.join(', ') || 'none'}). A 2-for-1 trade before then avoids losing one of them for nothing` : c.tier === 1 ? ' (a positional starter)' : '')).join(', ')}. ${cs.some((c) => added.has(c.id)) ? 'So this week\'s adds are rentals until then.' : ''}` });
  const order = { yours: 0, 'in your plan': 1, 'on the wire': 2, rostered: 3 };
  // your goalie behind on the depth chart (beat-writer pages only)
  for (const m of mine) { const x = proj.get(m.p.playerId); if (x.kind === 'G' && x.depth === 2 && !dfoLastGame(m.p.team)) insights.push({ kind: 'goalie', who: 'yours', id: m.p.playerId, text: `${m.p.name} is G2 per ${dfoSource(m.p.team)}: his ${pct(x.share)} start share is the main risk to your 3-start minimum.` }); }
  insights.sort((a, b) => order[a.who] - order[b.who]);
}
// intel feed: every flag on your roster, your planned adds and the wire players worth knowing about
const intelFeed = (() => {
  const mineIds = new Set(mine.map((m) => m.p.playerId));
  const who = (p) => (mineIds.has(p.playerId) ? 'yours' : added.has(p.playerId) ? 'in your plan' : rostered.has(p.playerId) ? 'rostered' : 'on the wire');
  const holdIds = new Set(holds.map((h) => h.id));
  const near = (p) => { const x = proj.get(p.playerId); return x.kind === 'G' ? x.share >= 0.35 || x.fillInFor : (x.vorLong ?? x.vor) > -0.9; };
  const scope = [...new Map([...mine.map((m) => m.p), ...plan.map((m) => m.add), ...avail.filter((p) => holdIds.has(p.playerId) || near(p))].map((p) => [p.playerId, p])).values()];
  const order = { yours: 0, 'in your plan': 1, 'on the wire': 2, rostered: 3 };
  return scope.map((p) => {
    const it = intelFor(p), x = proj.get(p.playerId);
    const tags = who(p) === 'yours' ? it.tags : it.tags.filter((t) => t.kind !== 'injured' && t.kind !== 'trending-down');
    if (!tags.length || (who(p) !== 'yours' && who(p) !== 'in your plan' && !tags.some((t) => t.tone > 0))) return null;
    const weight = tags.reduce((a, t) => a + Math.abs(t.tone), 0);
    return { id: p.playerId, name: p.name, team: p.team, pos: posOf(p), who: who(p), proj: round(x.proj, 2), vor: round(x.vor ?? 0, 2), tier: x.tier || 'depth', ...it, tags, weight: round(weight, 1), hold: holdIds.has(p.playerId) };
  }).filter(Boolean).sort((a, b) => order[a.who] - order[b.who] || b.weight - a.weight || b.proj - a.proj);
})();
// key injuries across the NHL: who is out, for how long, and who his absence opens space for
const keyInjuries = (() => {
  const mineIds = new Set(mine.map((m) => m.p.playerId));
  const benefit = new Map();
  for (const p of skaters) for (const id of proj.get(p.playerId).fillInIds || []) (benefit.get(id) || benefit.set(id, []).get(id)).push(p);
  for (const p of goalies) { const x = proj.get(p.playerId); if (x.fillInFor) { const s = goalies.find((g) => g.name === x.fillInFor.name && g.team === p.team); if (s) (benefit.get(s.playerId) || benefit.set(s.playerId, []).get(s.playerId)).push(p); } }
  return all.filter((p) => proj.get(p.playerId).injured && (benefit.has(p.playerId) || mineIds.has(p.playerId) || ['stud', 'strong'].includes(proj.get(p.playerId).tier) || (proj.get(p.playerId).kind === 'G' && proj.get(p.playerId).priorShare >= 0.5)))
    .map((p) => {
      const x = proj.get(p.playerId), i = espnInj(p.playerId);
      const bs = (benefit.get(p.playerId) || []).map((q) => ({ id: q.playerId, name: q.name, pos: posOf(q), who: mineIds.has(q.playerId) ? 'yours' : rostered.has(q.playerId) ? 'rostered' : 'on the wire', proj: round(proj.get(q.playerId).proj, 1), projLong: proj.get(q.playerId).projLong != null ? round(proj.get(q.playerId).projLong, 1) : null }));
      return { id: p.playerId, name: p.name, team: p.team, pos: posOf(p), mine: mineIds.has(p.playerId), tier: x.tier || 'depth', prior: round(x.prior ?? x.perStart ?? 0, 1), status: i?.status || (dfoOut(x.dfo) ? (x.dfo.injury === 'ir' ? 'IR' : 'Out') : 'Not on the active roster'), injury: i?.type ? i.type.toLowerCase() + (i.detail ? ` (${i.detail.toLowerCase()})` : '') : null, back: returnDate(p), games: returnGames(p), comment: i?.comment || null, beneficiaries: bs };
    })
    .sort((a, b) => (b.mine - a.mine) || (b.beneficiaries.some((q) => q.who !== 'rostered') - a.beneficiaries.some((q) => q.who !== 'rostered')) || b.prior - a.prior).slice(0, 25);
})();
// goalie nights for the grid: who can start in your G slots and why
// goalie trigger: chance of reaching 3 starts given how many you have by Friday morning
const goalieTimeline = (() => {
  const GS = SLOTS.filter((x) => x === 'G').length, MIN = L.minGoalieStartsPerWeek || 3;
  const dist = (idx) => {
    let d = [1];
    for (const i of idx) {
      const teams = {};
      for (const p of planRoster[i]) if (p.position === 'G') { const q = startProb(p, days[i]); if (q > 0) (teams[p.team] ||= []).push(q); }
      let outs = [{ pr: 1, n: 0 }];
      for (const qs of Object.values(teams)) {
        const none = Math.max(0, 1 - qs.reduce((a, b) => a + b, 0)), next = [];
        for (const o of outs) { if (none > 0) next.push({ pr: o.pr * none, n: o.n }); for (const q of qs) next.push({ pr: o.pr * q, n: o.n + 1 }); }
        outs = next;
      }
      const nd = new Array(d.length + GS).fill(0);
      d.forEach((m, k) => outs.forEach((o) => (nd[k + Math.min(GS, o.n)] += m * o.pr)));
      d = nd;
    }
    return d;
  };
  const cut = 4; // Mon-Thu, then decide Friday morning
  const early = dist([0, 1, 2, 3]), late = dist([4, 5, 6]);
  const pLateAtLeast = (k) => late.slice(Math.max(0, k)).reduce((a, b) => a + b, 0);
  const reach = [0, 1, 2].map((k) => round(pLateAtLeast(MIN - k), 2));
  const gExp = goalieStarts(planRoster).gRaw;
  const myG = planRoster[planRoster.length - 1].filter((p) => p.position === 'G');
  const perStartAvg = myG.length ? myG.reduce((a, p) => a + proj.get(p.playerId).perStart, 0) / myG.length : 8;
  const latePts = days.slice(4).reduce((a, d, j) => a + planRoster[4 + j].filter((p) => p.position === 'G').reduce((s2, p) => s2 + valueOn(p, d), 0), 0);
  const expLoss = reach.map((r, k) => round((1 - r) * (k * perStartAvg + latePts), 1));
  let trigger = -1;
  for (let k = 0; k < MIN; k++) if (expLoss[k] >= 6) trigger = k;
  const pTrigger = trigger >= 0 ? round(early.slice(0, trigger + 1).reduce((a, b) => a + b, 0), 2) : 0;
  const expEarly = days.slice(0, cut).reduce((a, d, i) => a + planRoster[i].filter((p) => p.position === 'G').reduce((s, p) => s + startProb(p, d), 0), 0);
  const expLate = days.slice(cut).reduce((a, d, j) => a + planRoster[cut + j].filter((p) => p.position === 'G').reduce((s, p) => s + startProb(p, d), 0), 0);
  return { early: round(expEarly, 1), late: round(expLate, 1), reach, expLoss, trigger, pTrigger };
})();
const goalieNights = days.map((d, i) => ({
  day: week.nightly[i].day, date: d,
  goalies: planRoster[i].filter((p) => p.position === 'G' && teamPlays(p.team, d) && !proj.get(p.playerId).injured).map((p) => ({ name: p.name, team: p.team, opp: oppOn[p.team + '|' + d], p: round(startProb(p, d), 2), b2b: isB2B(p.team, d), starter: !!proj.get(p.playerId).isStarter })),
}));
let opponent = null;
if (opponentRoster.length) {
  const opp = opponentRoster;
  const nights = days.map((d) => { const lu = dayLineup(opp, d); return { date: d, points: round(lu.total, 1), starts: [...lu.starters.values()].filter((s) => s !== 'G').length }; });
  const total = nights.reduce((a, n) => a + n.points, 0);
  const top = opp.map((p) => ({ p, pts: days.reduce((a, d) => a + valueOn(p, d), 0) })).sort((a, b) => b.pts - a.pts).slice(0, 5)
    .map(({ p, pts }) => ({ name: p.name, team: p.team, games: gamesIn(p, days), pts: round(pts, 1) }));
  const phi = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI))); // normal CDF (approx.)
  opponent = { name: yl.myTeam.opponent?.name, total: round(oppTotal, 1), rawTotal: round(total, 1), winBefore: round(phi((startEval.pts - oppTotal) / MARGIN_SD), 2), winAfter: round(phi((base.pts - oppTotal) / MARGIN_SD), 2), games: nights.reduce((a, n) => a + n.starts, 0), nights, top };
}
// what other managers will think a player is worth, per game: his reputation (last season's rate,
// weighted like 10 games; your sheet if he barely played) blended with this season's pace game by game.
// Hot starts inflate it, cold starts deflate it; your value (proj) regresses them properly. The gap is
// the sell-high / buy-low room in a trade. Goalies: their projection.
const MARKET_K = 10;
function marketFP(x) {
  if (x.kind !== 'S') return x.projLong ?? x.proj;
  const rep = x.prev && x.prev.GP >= 20 ? skaterFP(x.prev.totals) / x.prev.GP : x.prior;
  return x.gp && x.curFP != null ? (rep * MARKET_K + x.curFP * x.gp) / (MARKET_K + x.gp) : rep;
}
const board = {
  generatedAt: new Date().toISOString(), today,
  league: { name: L.name, teams: L.numTeams, scoring: L.scoring, slots: L.rosterSlots, maxAdds: L.maxAddsPerWeek, playoffs: L.playoffs, minGoalieStarts: L.minGoalieStartsPerWeek || 3 },
  team: { name: yl.myTeam.name, opponent: yl.myTeam.opponent || null, addsUsedThisWeek: yl.myTeam.addsUsedThisWeek, waiverPriority: yl.myTeam.waiverPriority },
  week: { start: week.start, end: week.end, firstDay: FIRST_DAY, addsLeft, nightly: week.nightly, leagueGames: week.leagueGames, next: week2 ? { start: week2.start, end: week2.end } : null },
  model: { ROSTER_MAX, PLAYOFF_WEEK_WEIGHT, weeksLeft, sampleWeeks: futureWeeks.map((w) => w.start), LR_SCALE: round(LR_SCALE, 2), FUTURE_WEEK_WEIGHT, FILL_IN_GAMES, DFO_GAMES, WEEK_WEIGHT: round(weekWeight(startEval.pts), 2), MARGIN_SD, marginBefore: marginBefore == null ? null : round(marginBefore, 1), CHURN_PENALTY, K, PROJ_GAMES, EV_ELASTICITY, GOALIE_PRIOR_STARTS, ROS_NOISE, ROS_DISCOUNT, MIN_MOVE_GAIN, replacement: Object.fromEntries(Object.entries(repl).map(([k, v]) => [k, round(v, 2)])) },
  roster: myCards,
  addedCards: [...addedCards.values()],
  lineupBefore: lineupView(days.map(() => active)),
  lineupAfter: lineupView(planRoster),
  projectedWeek: { before: round(startEval.pts, 1), after: round(base.pts, 1), gamesBefore: startEval.starts, gamesAfter: base.starts },
  goalieStarts: { before: goalieStarts(days.map(() => active)), after: goalieStarts(planRoster) },
  opponent, shape, upgrades, goalieOption, goalieStream, goalieNights, goalieTimeline, insights, intel: intelFeed, keyInjuries, unusedAdds, dfoPrev: DFO_PREV?.date ?? null,
  plan: plan.map((m, i) => ({ ...describe(m), order: i })).sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order),
  pickups: altMoves.filter((m) => proj.get(m.add.playerId).vor > 0 && m.add.position !== 'G' && !studsAvailable.some((x) => x.id === m.add.playerId)).sort((a, b) => b.net - a.net).slice(0, 8).map(describe),
  studsAvailable, bestOnWire,
  holds,
  goalies: avail.filter((p) => p.position === 'G' && goalieOk(p)).map(card).sort((a, b) => b.proj * b.gamesWk - a.proj * a.gamesWk).slice(0, 8),
  playoffTeams: nhl.playoffSchedule.teams.map((t) => ({ team: t.team, score: t.score, games: t.games, offNights: t.offNights, wk23: semiWeek?.teams[t.team]?.games ?? null })).sort((a, b) => b.score - a.score),
  dataNotes: { dfo: DFO?.fetchedAt ?? null, espn: ESPN?.fetchedAt ?? null, oddsNights: Object.keys(ODDS).filter((d) => days.includes(d)), statsPending, unmatched, agMatched: agById.size, agTotal: ag.skaters.length, rosteredMatched: rostered.size, yahooSnapshot: yl.fetchedAt, nhlData: nhl.meta.generatedAt, teamGP },
  // every rostered player's trade value and owner, for the trade market (engine/trades-core.js).
  // value = your view, per game: skaters at your sheet plus half of what their current role (line, PP
  // unit, ice time, linemates) changes, since early-season roles move too, and none of this season's hot
  // or cold results; goalies at their usual share of starts (a fill-in starter is valued as the backup
  // he'll go back to being)
  tradeData: {
    me: 1, slots: SLOTS, teamNames: yl.teamNames || {}, rosterSize: ROSTER_MAX, rules: tradeRules(ROOT, 'points'), rankNeeds: true,
    standings: yl.standings || null, regularWeeks: (yl.league?.playoffStartWeek || 23) - 1,
    players: all.filter((p) => rostered.has(p.playerId)).map((p) => {
      const x = proj.get(p.playerId);
      const value = x.kind === 'S' ? (x.usageFP != null && x.prior != null ? x.prior + 0.5 * (x.usageFP - x.prior) : x.proj) : x.fillInFor ? x.perStart * (x.priorShare ?? x.share) : x.projLong ?? x.proj;
      return { id: p.playerId, name: p.name, team: p.team, pos: posOf(p), age: p.age ?? null, owner: rostered.get(p.playerId) || null, value: round(value, 2), market: round(marketFP(x), 2), pre: yRank.get(p.playerId)?.pre ?? null, cur: yRank.get(p.playerId)?.cur ?? null, gp: x.gp || 0, injured: !!x.injured, back: returnDate(p) ?? null,
        // this season's points per game against what he was expected to score before it (team needs: over/underperformers)
        exp: x.prior != null ? round(x.prior, 2) : null, act: x.kind === 'S' ? (x.curFP != null ? round(x.curFP, 2) : null) : x.cur?.GP ? round(goalieFP(x.cur.totals) / x.cur.GP, 2) : null };
    }),
  },
};

fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out', 'board.json'), JSON.stringify(board, null, 1));

// ---- Player model export for the categories league board (engine/cats.mjs) ----------------
// The same usage-adjusted per-game rates, injuries, goalie start chances and intel, league-neutral.
{
  const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  const players = [];
  for (const p of all) {
    const x = proj.get(p.playerId);
    if (!x) continue;
    const rich = x.kind === 'G' ? x.share >= 0.15 : x.proj >= 2.5 || rostered.has(p.playerId);
    const o = {
      id: p.playerId, name: p.name, team: p.team, pos: posOf(p), age: p.age ?? null, kind: x.kind,
      injured: !!x.injured, inactive: !!x.inactive, dtd: !!x.dtd, back: returnDate(p), gp: x.gp || 0,
      gameDays: days.map((d) => (teamPlays(p.team, d) ? 1 : 0)), opps: days.map((d) => (teamPlays(p.team, d) ? oppOn[p.team + '|' + d] || '' : '')),
      gamesLeft: Math.max(0, SEASON_GAMES - (teamGP[p.team] || 0)), owned: espnP(p.playerId)?.owned ?? null,
      // Points league fantasy points: per game now and long run (goalies: per start), and who rosters him
      fp: r3(x.kind === 'S' ? x.proj : x.perStart), fpLong: r3(x.kind === 'S' ? x.projLong ?? x.proj : x.perStart), owner: rostered.get(p.playerId) ?? null,
    };
    if (x.kind === 'S') {
      const lf = x.lineAdj || 1;
      Object.assign(o, {
        rates: { G: r3(x.rates.G * lf), A: r3(x.rates.A * lf), PPP: r3(x.rates.PPP), SOG: r3(x.rates.SOG), BLK: r3(x.rates.BLK) },
        evAdj: r3(x.evAdj), pPlay: r3(x.pPlay), longFactor: x.projLong != null && x.proj > 0 ? r3(x.projLong / x.proj) : 1, fillInGames: x.fillInGames ?? null,
        pp: x.dfoUnit ?? null, line: x.dfo?.line ?? x.dfo?.pair ?? null, toi: season(p, CUR)?.toi?.TOI_pg ? fmtToi(season(p, CUR).toi.TOI_pg) : null,
      });
    } else {
      Object.assign(o, {
        share: r3(x.share), isStarter: !!x.isStarter, depth: x.depth ?? null, fillInFor: x.fillInFor ? { name: x.fillInFor.name, games: x.fillInFor.games, back: x.fillInFor.back } : null,
        startProb: days.map((d) => r3(startProb(p, d))), agTier: x.agTier ?? null, priorShare: r3(x.priorShare),
      });
    }
    if (rich) { o.notes = usageNotes(p); const it = intelFor(p); if (it.tags.length || it.note) o.intel = it; }
    players.push(o);
  }
  fs.writeFileSync(path.join(ROOT, 'out', 'players.json'), JSON.stringify({ generatedAt: board.generatedAt, today, week: { start: week.start, end: week.end, days, nightly: week.nightly, firstDay: FIRST_DAY }, keyInjuries, players }));
}
console.log(`Week ${week.start}..${week.end} | lineup ${board.projectedWeek.before} -> ${board.projectedWeek.after} pts, games ${startEval.starts} -> ${base.starts}, ${plan.length} moves`);
console.log(`Unmatched: ${unmatched.join(', ') || 'none'} | projections matched ${agById.size}/${ag.skaters.length} | rostered matched ${rostered.size}`);
console.log('Replacement level:', board.model.replacement, '| goalie base', round(G_BASE, 2));
