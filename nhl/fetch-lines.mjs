#!/usr/bin/env node
// Builds line combinations and power-play units for the current regular season
// from NHL shift charts, then writes nhl/out/lines.json.
//
// Usage: node fetch-lines.mjs [--fresh] [--last N]
//   --fresh   ignore the on-disk cache and refetch everything
//   --last N  only use each team's N most recent completed games (default: all)
//
// Reads nhl/out/nhl-data.json (from fetch-nhl.mjs) for the schedule and positions.
// Requires Node 18+ (built-in fetch). No dependencies.
//
// Method: every skater shift (typeCode 517) is expanded to the seconds it covers
// ([start, end) within its period). For each second we count skaters and goalies
// on the ice per team; that count is the strength state (more precise than the
// play-by-play situationCode, which only updates at the next recorded event and so
// lags penalty expiries). Line-change noise (a few seconds of 6 or 4 skaters) is
// smoothed by folding state runs shorter than MIN_RUN_SEC into the previous run.
// Even-strength seconds with a goalie pulled (6v5 extra attacker) are excluded;
// a pulled goalie on a power play (6v4) still counts as PP, matching NHL PP TOI.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'cache');
const DATA_FILE = join(HERE, 'out', 'nhl-data.json');
const OUT_FILE = join(HERE, 'out', 'lines.json');
const FRESH = process.argv.includes('--fresh');
const LAST_N = (() => {
  const i = process.argv.indexOf('--last');
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
})();

const SEASON = '20262027';
const CONCURRENCY = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // non-final games
const PERIOD_SEC = 1200;
const MIN_RUN_SEC = 5; // strength-state runs shorter than this are treated as line-change noise
const TOP_MATES = 4;
const FORWARD = new Set(['C', 'L', 'R']);

const STATS_BASE = 'https://api.nhle.com/stats/rest/en';
const WEB_BASE = 'https://api-web.nhle.com/v1';

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;
let cacheHits = 0;

/**
 * GET JSON with an on-disk cache. `immutable(json)` decides whether a cached
 * copy never expires (e.g. a game that is officially final).
 */
async function getJson(url, { immutable = () => false, maxAgeMs = CACHE_TTL_MS } = {}) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  const file = join(CACHE_DIR, `${slug}_${key}.json`);

  if (!FRESH) {
    try {
      const age = Date.now() - (await stat(file)).mtimeMs;
      const json = JSON.parse(await readFile(file, 'utf8'));
      if (immutable(json) || age < maxAgeMs) {
        cacheHits++;
        return json;
      }
    } catch { /* cache miss */ }
  }

  for (let attempt = 1; ; attempt++) {
    try {
      requestCount++;
      const res = await fetch(url, { headers: { 'User-Agent': 'fantasy-hockey-data/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await writeFile(file, JSON.stringify(json));
      return json;
    } catch (err) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

/** Map over items with at most `limit` promises in flight. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const round = (x, dp = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const mmss = (s) => {
  const m = /^(\d+):(\d{2})$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const FINAL_STATES = new Set(['OFF', 'FINAL']);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const addTo = (map, k, v) => map.set(k, (map.get(k) ?? 0) + v);

// ---------------------------------------------------------------- fetching

/** Play-by-play (for final state and goalie ids) + shift chart for one game. */
async function fetchGame(game) {
  const pbp = await getJson(`${WEB_BASE}/gamecenter/${game.id}/play-by-play`, {
    immutable: (j) => j.gameState === 'OFF',
    maxAgeMs: 10 * 60 * 1000,
  });
  if (!FINAL_STATES.has(pbp.gameState)) return { game, skipped: `state ${pbp.gameState}` };
  const isOff = pbp.gameState === 'OFF';
  const shifts = await getJson(`${STATS_BASE}/shiftcharts?cayenneExp=gameId=${game.id}`, {
    immutable: (j) => isOff && j.data?.some((r) => r.typeCode === 517),
    maxAgeMs: 10 * 60 * 1000,
  });
  const rows = (shifts.data ?? []).filter((r) => r.typeCode === 517);
  if (!rows.length) return { game, skipped: 'no shift rows' };
  return { game, pbp, rows };
}

// ---------------------------------------------------------------- per-game analysis

/**
 * Turn one game's shifts into per-team segments of constant on-ice skaters and
 * strength class. Returns { teams: { ABBR: { segs: [{cls, ids, sec}], players: Set } } }.
 */
function analyzeGame({ pbp, rows }, goalieIds) {
  const home = pbp.homeTeam.abbrev;
  const away = pbp.awayTeam.abbrev;
  for (const s of pbp.rosterSpots ?? []) if (s.positionCode === 'G') goalieIds.add(s.playerId);

  const maxPeriod = Math.max(...rows.map((r) => r.period));
  const total = maxPeriod * PERIOD_SEC;
  // onIce[team][t] = array of playerIds on ice at absolute second t
  const onIce = { [home]: Array.from({ length: total }, () => []), [away]: Array.from({ length: total }, () => []) };
  const players = { [home]: new Set(), [away]: new Set() };
  let badRows = 0;

  for (const r of rows) {
    const side = onIce[r.teamAbbrev];
    const s = mmss(r.startTime);
    const e = mmss(r.endTime);
    if (!side || s == null || e == null || e <= s || e > PERIOD_SEC) { badRows++; continue; }
    const base = (r.period - 1) * PERIOD_SEC;
    for (let t = s; t < e; t++) {
      const arr = side[base + t];
      if (!arr.includes(r.playerId)) arr.push(r.playerId);
    }
    if (!goalieIds.has(r.playerId)) players[r.teamAbbrev].add(r.playerId);
  }

  // Raw strength state per second, in situationCode order: awayG awaySk homeSk homeG.
  const raw = new Array(total).fill(null);
  for (let t = 0; t < total; t++) {
    const a = onIce[away][t];
    const h = onIce[home][t];
    if (!a.length && !h.length) continue; // not played (e.g. unused OT seconds)
    const aG = a.some((id) => goalieIds.has(id)) ? 1 : 0;
    const hG = h.some((id) => goalieIds.has(id)) ? 1 : 0;
    raw[t] = `${aG}${a.length - aG}${h.length - hG}${hG}`;
  }
  const state = smoothStates(raw, maxPeriod);

  // Per-team segments: consecutive seconds with identical class + skater set.
  const teams = {};
  for (const [team, isHome] of [[home, true], [away, false]]) {
    const segs = [];
    let cur = null;
    for (let t = 0; t < total; t++) {
      const st = state[t];
      const cls = st ? classify(st, isHome) : null;
      if (!cls) { cur = null; continue; }
      const ids = onIce[team][t].filter((id) => !goalieIds.has(id)).sort((x, y) => x - y);
      const key = `${cls}:${ids.join(',')}`;
      if (cur && cur.key === key && t % PERIOD_SEC !== 0) cur.sec++;
      else { cur = { key, cls, ids, sec: 1 }; segs.push(cur); }
    }
    teams[team] = { segs, players: players[team], opp: isHome ? away : home };
  }
  return { teams, badRows };
}

/** Fold runs shorter than MIN_RUN_SEC into the preceding run (or following one at period start). */
function smoothStates(raw, maxPeriod) {
  const out = raw.slice();
  for (let p = 0; p < maxPeriod; p++) {
    const lo = p * PERIOD_SEC;
    const hi = lo + PERIOD_SEC;
    const runs = [];
    for (let t = lo; t < hi; t++) {
      if (raw[t] == null) continue;
      const last = runs[runs.length - 1];
      if (last && last.state === raw[t] && last.end === t) last.end++;
      else runs.push({ state: raw[t], start: t, end: t + 1 });
    }
    let prev = null;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.end - r.start >= MIN_RUN_SEC) { prev = r.state; continue; }
      const fill = prev ?? runs.slice(i + 1).find((x) => x.end - x.start >= MIN_RUN_SEC)?.state ?? r.state;
      for (let t = r.start; t < r.end; t++) out[t] = fill;
    }
  }
  return out;
}

/**
 * 'EV' | 'PP' | 'SH' for one team, or null. With a goalie pulled, the extra
 * attacker is discounted: 6v4 still counts as a power play (as the NHL counts
 * it), but 6v5 / 6v6 extra-attacker time is excluded so it doesn't pollute lines.
 */
function classify(code, isHome) {
  const aG = code[0] === '1';
  const hG = code[3] === '1';
  const aS = Number(code[1]);
  const hS = Number(code[2]);
  if (!aG && !hG) return null;
  if (aS < 3 || hS < 3 || aS > (aG ? 5 : 6) || hS > (hG ? 5 : 6)) return null;
  const mine = isHome ? hS : aS;
  const theirs = isHome ? aS : hS;
  const myEff = mine - ((isHome ? hG : aG) ? 0 : 1);
  const theirEff = theirs - ((isHome ? aG : hG) ? 0 : 1);
  if (myEff === theirEff) return aG && hG ? 'EV' : null;
  return myEff > theirEff ? 'PP' : 'SH';
}

// ---------------------------------------------------------------- aggregation

function newTeamAgg() {
  return { games: 0, ppSec: 0, evPair: new Map(), ppPair: new Map(), evTriple: new Map(), lastDate: '' };
}

function newPlayerAgg(id) {
  return { id, games: 0, evSec: 0, ppSec: 0, shSec: 0, teamPpSec: 0, team: null, lastDate: '', teams: new Set() };
}

function accumulate(gameTeam, team, date, tAgg, pAggFor, posOf) {
  tAgg.games++;
  let teamPp = 0;
  for (const seg of gameTeam.segs) {
    const { cls, ids, sec } = seg;
    if (cls === 'PP') teamPp += sec;
    for (const id of ids) {
      const p = pAggFor(id);
      if (cls === 'EV') p.evSec += sec;
      else if (cls === 'PP') p.ppSec += sec;
      else p.shSec += sec;
    }
    if (cls === 'SH') continue;
    const pairMap = cls === 'EV' ? tAgg.evPair : tAgg.ppPair;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addTo(pairMap, pairKey(ids[i], ids[j]), sec);
    if (cls === 'EV') {
      const fw = ids.filter((id) => FORWARD.has(posOf(id)));
      for (let i = 0; i < fw.length; i++) for (let j = i + 1; j < fw.length; j++) for (let k = j + 1; k < fw.length; k++) {
        addTo(tAgg.evTriple, `${fw[i]}|${fw[j]}|${fw[k]}`, sec);
      }
    }
  }
  tAgg.ppSec += teamPp;
  for (const id of gameTeam.players) {
    const p = pAggFor(id);
    p.games++;
    p.teamPpSec += teamPp;
    p.teams.add(team);
    if (date >= p.lastDate) { p.lastDate = date; p.team = team; }
  }
}

/** mates of `id` from a team pair map: Map(mateId -> sec). */
function matesOf(id, pairMaps) {
  const out = new Map();
  for (const m of pairMaps) {
    for (const [k, sec] of m) {
      const [a, b] = k.split('|').map(Number);
      if (a === id) addTo(out, b, sec);
      else if (b === id) addTo(out, a, sec);
    }
  }
  return [...out].sort((x, y) => y[1] - x[1]);
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(dirname(OUT_FILE), { recursive: true });

  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const info = new Map();
  for (const s of data.skaters) info.set(s.playerId, { name: s.name, pos: s.position, team: s.team });
  const goalieIds = new Set(data.goalies.map((g) => g.playerId));

  const today = localToday();
  const candidates = data.schedule.games.filter((g) => FINAL_STATES.has(g.state) || g.date < today);
  console.log(`Fetching ${candidates.length} candidate games (play-by-play + shift charts)...`);
  const fetched = await pool(candidates, CONCURRENCY, fetchGame);
  const games = fetched.filter((g) => !g.skipped).sort((a, b) => a.game.date.localeCompare(b.game.date) || a.game.id - b.game.id);
  for (const g of fetched.filter((x) => x.skipped)) console.log(`  - skip ${g.game.id} ${g.game.away}@${g.game.home} (${g.skipped})`);

  // Names/positions for players missing from nhl-data (call-ups etc.).
  for (const g of games) {
    const abbrById = { [g.pbp.homeTeam.id]: g.pbp.homeTeam.abbrev, [g.pbp.awayTeam.id]: g.pbp.awayTeam.abbrev };
    for (const s of g.pbp.rosterSpots ?? []) {
      if (!info.has(s.playerId)) {
        info.set(s.playerId, {
          name: `${s.firstName?.default ?? ''} ${s.lastName?.default ?? ''}`.trim(),
          pos: s.positionCode,
          team: abbrById[s.teamId],
        });
      }
    }
  }
  const posOf = (id) => info.get(id)?.pos;
  const nameOf = (id) => info.get(id)?.name ?? String(id);

  // Optionally keep only each team's last N games.
  const allowed = new Map(); // team -> Set(gameId)
  {
    const byTeam = new Map();
    for (const g of games) for (const t of [g.game.home, g.game.away]) (byTeam.get(t) ?? byTeam.set(t, []).get(t)).push(g.game.id);
    for (const [t, ids] of byTeam) allowed.set(t, new Set(LAST_N ? ids.slice(-LAST_N) : ids));
  }

  const teamAgg = new Map();
  const playerAgg = new Map();
  const pAggFor = (id) => playerAgg.get(id) ?? playerAgg.set(id, newPlayerAgg(id)).get(id);
  let badRows = 0;
  const strength = { EV: 0, PP: 0, SH: 0 };

  for (const g of games) {
    const res = analyzeGame(g, goalieIds);
    badRows += res.badRows;
    for (const [team, gt] of Object.entries(res.teams)) {
      if (!allowed.get(team)?.has(g.game.id)) continue;
      const tAgg = teamAgg.get(team) ?? teamAgg.set(team, newTeamAgg()).get(team);
      accumulate(gt, team, g.game.date, tAgg, pAggFor, posOf);
      for (const s of gt.segs) strength[s.cls] += s.sec;
    }
  }

  // ------------------------------------------------ players
  const teamPpRank = new Map(); // team -> [ids sorted by ppSec], current players only
  for (const p of playerAgg.values()) {
    if (!teamPpRank.has(p.team)) teamPpRank.set(p.team, []);
    teamPpRank.get(p.team).push(p);
  }
  for (const [t, list] of teamPpRank) teamPpRank.set(t, list.sort((a, b) => b.ppSec - a.ppSec).map((p) => p.id));

  const players = {};
  for (const p of [...playerAgg.values()].sort((a, b) => a.team.localeCompare(b.team) || b.evSec + b.ppSec - (a.evSec + a.ppSec))) {
    const pos = posOf(p.id);
    const isF = FORWARD.has(pos);
    const teams = [...p.teams].map((t) => teamAgg.get(t));
    const ev = matesOf(p.id, teams.map((t) => t.evPair));
    const pp = matesOf(p.id, teams.map((t) => t.ppPair));
    const mate = ([id, sec], denom) => ({ id, name: nameOf(id), pos: posOf(id) ?? null, sec, share: denom ? round(sec / denom) : null });

    const partners = ev.filter(([id]) => (isF ? FORWARD.has(posOf(id)) : posOf(id) === 'D')).slice(0, isF ? 2 : 1);
    const ppTeamShare = p.teamPpSec ? round(p.ppSec / p.teamPpSec) : null;
    const rank = teamPpRank.get(p.team).indexOf(p.id);
    let ppUnit = null;
    if (p.ppSec > 0 && ppTeamShare != null) {
      if ((rank < 5 && ppTeamShare >= 0.3) || ppTeamShare >= 0.5) ppUnit = 1;
      else if (ppTeamShare >= 0.2) ppUnit = 2;
    }

    players[p.id] = {
      name: nameOf(p.id),
      team: p.team,
      pos: pos ?? null,
      games: p.games,
      evSec: p.evSec,
      ppSec: p.ppSec,
      shSec: p.shSec,
      ppTeamShare,
      ppUnit,
      line: partners.map(([id, sec]) => ({ id, name: nameOf(id), share: p.evSec ? round(sec / p.evSec) : null })),
      evMates: ev.slice(0, TOP_MATES).map((m) => mate(m, p.evSec)),
      ppMates: pp.slice(0, TOP_MATES).map((m) => mate(m, p.ppSec)),
    };
  }

  // ------------------------------------------------ teams
  const teams = {};
  for (const team of [...teamAgg.keys()].sort()) {
    const t = teamAgg.get(team);
    const current = new Set(teamPpRank.get(team) ?? []); // players whose latest game was for this team
    const fw = [...current].filter((id) => FORWARD.has(posOf(id)));
    const dmen = [...current].filter((id) => posOf(id) === 'D');
    const pairSec = (a, b) => t.evPair.get(pairKey(a, b)) ?? 0;
    const tripleSec = (a, b, c) => t.evTriple.get([a, b, c].sort((x, y) => x - y).join('|')) ?? 0;

    // Forward lines: best remaining pair, plus the forward with most time together with both.
    const lines = [];
    const fLeft = new Set(fw);
    while (lines.length < 4 && fLeft.size >= 3) {
      let best = null;
      const arr = [...fLeft];
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const s = pairSec(arr[i], arr[j]);
        if (!best || s > best.s) best = { a: arr[i], b: arr[j], s };
      }
      if (!best || best.s === 0) break;
      let third = null;
      for (const c of arr) {
        if (c === best.a || c === best.b) continue;
        const s = tripleSec(best.a, best.b, c);
        if (!third || s > third.s) third = { c, s };
      }
      const ids = third && third.s > 0 ? [best.a, best.b, third.c] : [best.a, best.b];
      ids.forEach((id) => fLeft.delete(id));
      lines.push({ ids, names: ids.map(nameOf), sec: ids.length === 3 ? third.s : best.s });
    }

    // D pairs: greedy by shared EV seconds.
    const pairs = [];
    const dLeft = new Set(dmen);
    while (pairs.length < 3 && dLeft.size >= 2) {
      let best = null;
      const arr = [...dLeft];
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const s = pairSec(arr[i], arr[j]);
        if (!best || s > best.s) best = { ids: [arr[i], arr[j]], s };
      }
      if (!best || best.s === 0) break;
      best.ids.forEach((id) => dLeft.delete(id));
      pairs.push({ ids: best.ids, names: best.ids.map(nameOf), sec: best.s });
    }

    const ppOrder = (teamPpRank.get(team) ?? []).filter((id) => playerAgg.get(id).ppSec > 0);
    teams[team] = {
      games: t.games,
      ppSec: t.ppSec,
      lines,
      pairs,
      pp1: ppOrder.slice(0, 5).map(nameOf),
      pp2: ppOrder.slice(5, 10).map(nameOf),
      pp1Ids: ppOrder.slice(0, 5),
      pp2Ids: ppOrder.slice(5, 10),
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    games: games.length,
    lastNGames: LAST_N,
    notes: {
      method: 'On-ice skaters per second from shift charts (typeCode 517); strength from on-ice skater/goalie counts, runs < '
        + `${MIN_RUN_SEC}s smoothed as line-change noise; 6v5 extra-attacker seconds excluded, 6v4 counts as PP.`,
      units: 'All *Sec values are seconds. share = shared seconds / the player\'s own EV (or PP) seconds.',
      ppTeamShare: 'player PP seconds / his team\'s PP seconds in the games he played for that team.',
      ppUnit: '1 if among his current team\'s top 5 by PP seconds (with ppTeamShare >= 0.3) or ppTeamShare >= 0.5; 2 if ppTeamShare >= 0.2; else null.',
      team: 'player.team = team of his most recent game in the sample; team lines/pp use only those players.',
      lines: 'Greedy: best remaining forward pair by shared EV seconds + the forward with the most EV seconds on ice with both; sec = all three together.',
    },
    players,
    teams,
  };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 1));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tot = strength.EV + strength.PP + strength.SH;
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  games=${games.length} players=${Object.keys(players).length} teams=${Object.keys(teams).length} badShiftRows=${badRows}`);
  console.log(`  team-seconds: EV ${(100 * strength.EV / tot).toFixed(1)}% PP ${(100 * strength.PP / tot).toFixed(1)}% SH ${(100 * strength.SH / tot).toFixed(1)}%`);
  console.log(`  requests=${requestCount} cacheHits=${cacheHits} time=${secs}s`);
}

// awaited so a browser run (web/runner.js) knows when the data is written
await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
