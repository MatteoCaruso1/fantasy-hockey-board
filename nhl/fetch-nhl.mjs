#!/usr/bin/env node
// Fetches NHL skater/goalie stats, current rosters and the regular-season
// schedule, then writes nhl/out/nhl-data.json for the fantasy hockey tool.
//
// Usage: node fetch-nhl.mjs [--fresh]
//   --fresh  ignore the on-disk cache and refetch everything
//
// Requires Node 18+ (built-in fetch). No dependencies.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'cache');
const OUT_FILE = join(HERE, 'out', 'nhl-data.json');
const FRESH = process.argv.includes('--fresh');

const PREV_SEASON = 20252026;
const CUR_SEASON = 20262027;
const SEASONS = [PREV_SEASON, CUR_SEASON];
const CONCURRENCY = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // volatile data (current season, rosters, schedule)

// Fantasy playoff weeks (Mon-Sun) and the "off-night" threshold.
const PLAYOFF_WEEKS = [
  { name: 'Week 1', start: '2027-03-15' },
  { name: 'Week 2', start: '2027-03-22' },
];
const OFF_NIGHT_MAX_GAMES = 7;
const SCORE_WEIGHTS = { games: 0.75, offNights: 0.25 };
const UPCOMING_WEEK_START = '2026-10-05';

const TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL', 'DAL', 'DET', 'EDM',
  'FLA', 'LAK', 'MIN', 'MTL', 'NJD', 'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT',
  'SEA', 'SJS', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
];

const STATS_BASE = 'https://api.nhle.com/stats/rest/en';
const WEB_BASE = 'https://api-web.nhle.com/v1';

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;
let cacheHits = 0;

/** GET JSON with an on-disk cache. `immutable` entries never expire. */
async function getJson(url, { immutable = false } = {}) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  const file = join(CACHE_DIR, `${slug}_${key}.json`);

  if (!FRESH) {
    try {
      const age = Date.now() - (await stat(file)).mtimeMs;
      if (immutable || age < CACHE_TTL_MS) {
        cacheHits++;
        return JSON.parse(await readFile(file, 'utf8'));
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

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayName = (iso) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];
const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const round = (x, dp = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const lastTeam = (abbrevs) => (abbrevs ? abbrevs.split(',').pop().trim() : null);

function ageOn(birthDate, onDate) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00Z`);
  const d = new Date(`${onDate}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// ---------------------------------------------------------------- stats

/** Fetch one stats-REST report for a season (limit=-1 returns all rows). */
async function statsReport(kind, report, season) {
  const exp = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const url = `${STATS_BASE}/${kind}/${report}?limit=-1&cayenneExp=${exp}`;
  const json = await getJson(url, { immutable: season !== CUR_SEASON });
  if (json.data.length !== json.total) {
    console.warn(`  ! ${kind}/${report} ${season}: got ${json.data.length} of ${json.total} rows`);
  }
  return json.data;
}

// Skater counting stats (totals) keyed by Yahoo-friendly names.
const SKATER_COUNT_KEYS = [
  'G', 'A', 'PTS', 'PlusMinus', 'PIM', 'PPG', 'PPA', 'PPP', 'SHG', 'SHA', 'SHP',
  'GWG', 'SOG', 'FW', 'FL', 'HIT', 'BLK', 'TK', 'GV', 'EVG', 'EVP', 'OTG',
];

async function fetchSkaterSeason(season) {
  const reports = ['summary', 'realtime', 'timeonice', 'faceoffwins', 'powerplay', 'penaltykill'];
  const [summary, realtime, toi, fo, pp, pk] = await pool(reports, CONCURRENCY, (r) => statsReport('skater', r, season));
  const byId = (rows) => new Map(rows.map((r) => [r.playerId, r]));
  const [rt, ti, fw, ppm, pkm] = [realtime, toi, fo, pp, pk].map(byId);

  const out = new Map();
  for (const s of summary) {
    const r = rt.get(s.playerId) ?? {};
    const t = ti.get(s.playerId) ?? {};
    const f = fw.get(s.playerId) ?? {};
    const p = ppm.get(s.playerId) ?? {};
    const k = pkm.get(s.playerId) ?? {};
    const totals = {
      G: s.goals,
      A: s.assists,
      PTS: s.points,
      PlusMinus: s.plusMinus,
      PIM: s.penaltyMinutes,
      PPG: s.ppGoals,
      PPA: p.ppAssists ?? s.ppPoints - s.ppGoals,
      PPP: s.ppPoints,
      SHG: s.shGoals,
      SHA: k.shAssists ?? s.shPoints - s.shGoals,
      SHP: s.shPoints,
      GWG: s.gameWinningGoals,
      SOG: s.shots,
      FW: f.totalFaceoffWins ?? 0,
      FL: f.totalFaceoffLosses ?? 0,
      HIT: r.hits ?? 0,
      BLK: r.blockedShots ?? 0,
      TK: r.takeaways ?? 0,
      GV: r.giveaways ?? 0,
      EVG: s.evGoals,
      EVP: s.evPoints,
      OTG: s.otGoals,
    };
    const gp = s.gamesPlayed;
    out.set(s.playerId, {
      playerId: s.playerId,
      name: s.skaterFullName,
      positionCode: s.positionCode,
      shoots: s.shootsCatches,
      teamAbbrevs: s.teamAbbrevs,
      GP: gp,
      totals,
      perGame: Object.fromEntries(SKATER_COUNT_KEYS.map((key) => [key, gp ? round(totals[key] / gp, 4) : null])),
      // Per-game TOI in seconds; totals in seconds too.
      toi: {
        TOI_pg: round(t.timeOnIcePerGame ?? s.timeOnIcePerGame, 1),
        EVTOI_pg: round(t.evTimeOnIcePerGame, 1),
        PPTOI_pg: round(t.ppTimeOnIcePerGame, 1),
        SHTOI_pg: round(t.shTimeOnIcePerGame, 1),
        TOI_total: t.timeOnIce ?? null,
        PPTOI_total: t.ppTimeOnIce ?? null,
        shifts_pg: round(t.shiftsPerGame, 2),
        // share of his team's power-play time in the games he played (0-1)
        PPshare: p.ppTimeOnIcePctPerGame != null ? round(p.ppTimeOnIcePctPerGame, 3) : null,
      },
      rates: {
        FOpct: f.totalFaceoffs ? round(f.totalFaceoffWins / f.totalFaceoffs, 4) : null,
        shootingPct: s.shootingPct != null ? round(s.shootingPct, 4) : null,
      },
    });
  }
  return out;
}

const GOALIE_COUNT_KEYS = ['GS', 'W', 'L', 'OTL', 'GA', 'SV', 'SA', 'SO', 'G', 'A', 'PTS', 'PIM'];

async function fetchGoalieSeason(season) {
  const rows = await statsReport('goalie', 'summary', season);
  const out = new Map();
  for (const g of rows) {
    const gp = g.gamesPlayed;
    const totals = {
      GS: g.gamesStarted,
      W: g.wins,
      L: g.losses,
      OTL: g.otLosses,
      GA: g.goalsAgainst,
      SV: g.saves,
      SA: g.shotsAgainst,
      SO: g.shutouts,
      G: g.goals,
      A: g.assists,
      PTS: g.points,
      PIM: g.penaltyMinutes,
    };
    out.set(g.playerId, {
      playerId: g.playerId,
      name: g.goalieFullName,
      positionCode: 'G',
      catches: g.shootsCatches,
      teamAbbrevs: g.teamAbbrevs,
      GP: gp,
      TOI_total: g.timeOnIce,
      totals,
      perGame: Object.fromEntries(GOALIE_COUNT_KEYS.map((key) => [key, gp ? round(totals[key] / gp, 4) : null])),
      // Ratio stats: not summable, recompute from totals when aggregating.
      GAA: round(g.goalsAgainstAverage, 3),
      SVPCT: round(g.savePct, 4),
    });
  }
  return out;
}

// ---------------------------------------------------------------- rosters

async function fetchRosters() {
  const rosters = await pool(TEAMS, CONCURRENCY, (team) => getJson(`${WEB_BASE}/roster/${team}/current`));
  const players = new Map();
  TEAMS.forEach((team, i) => {
    const r = rosters[i];
    for (const group of ['forwards', 'defensemen', 'goalies']) {
      for (const p of r[group] ?? []) {
        players.set(p.id, {
          playerId: p.id,
          name: `${p.firstName?.default ?? ''} ${p.lastName?.default ?? ''}`.trim(),
          team,
          positionCode: p.positionCode,
          sweaterNumber: p.sweaterNumber ?? null,
          shootsCatches: p.shootsCatches ?? null,
          birthDate: p.birthDate ?? null,
          birthCountry: p.birthCountry ?? null,
          heightInInches: p.heightInInches ?? null,
          weightInPounds: p.weightInPounds ?? null,
          headshot: p.headshot ?? null,
        });
      }
    }
  });
  return players;
}

// ---------------------------------------------------------------- schedule

/** Walk the weekly schedule endpoint across the regular season. */
async function fetchSchedule() {
  // The first call tells us the official regular-season window.
  const first = await getJson(`${WEB_BASE}/schedule/2026-09-28`);
  const seasonStart = first.regularSeasonStartDate;
  const seasonEnd = first.regularSeasonEndDate;

  const weekStarts = [];
  for (let d = mondayOf(seasonStart); d <= seasonEnd; d = addDays(d, 7)) weekStarts.push(d);
  const weeks = await pool(weekStarts, CONCURRENCY, (d) => getJson(`${WEB_BASE}/schedule/${d}`));

  const games = new Map();
  for (const wk of weeks) {
    for (const day of wk.gameWeek ?? []) {
      for (const g of day.games ?? []) {
        if (g.gameType !== 2 || games.has(g.id)) continue;
        games.set(g.id, {
          id: g.id,
          date: day.date, // NHL's local game date (not the UTC date of startTimeUTC)
          away: g.awayTeam.abbrev,
          home: g.homeTeam.abbrev,
          startTimeUTC: g.startTimeUTC,
          state: g.gameState,
          scheduleState: g.gameScheduleState,
          ...(g.neutralSite ? { neutralSite: true } : {}),
        });
      }
    }
  }
  const list = [...games.values()].sort((a, b) => a.date.localeCompare(b.date) || a.startTimeUTC.localeCompare(b.startTimeUTC) || a.id - b.id);
  return { seasonStart, seasonEnd, preSeasonStart: first.preSeasonStartDate, games: list };
}

/** Per-night league counts and per-team game dates for a Mon-Sun week. */
function summarizeWeek(games, monday) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const nightly = Object.fromEntries(dates.map((d) => [d, 0]));
  const teams = Object.fromEntries(TEAMS.map((t) => [t, { games: 0, offNights: 0, dates: [] }]));
  const inWeek = games.filter((g) => g.date >= dates[0] && g.date <= dates[6]);
  for (const g of inWeek) nightly[g.date]++;
  for (const g of inWeek) {
    const off = nightly[g.date] <= OFF_NIGHT_MAX_GAMES;
    for (const t of [g.home, g.away]) {
      const rec = teams[t] ?? (teams[t] = { games: 0, offNights: 0, dates: [] });
      rec.games++;
      if (off) rec.offNights++;
      rec.dates.push(g.date);
    }
  }
  return {
    start: dates[0],
    end: dates[6],
    leagueGames: inWeek.length,
    nightly: dates.map((d) => ({ date: d, day: dayName(d), games: nightly[d], offNight: nightly[d] <= OFF_NIGHT_MAX_GAMES })),
    teams,
  };
}

/** Fantasy-playoff schedule score: 75% games, 25% off-nights, each normalized to the max. */
function playoffScore(games) {
  const weeks = PLAYOFF_WEEKS.map((w) => ({ name: w.name, ...summarizeWeek(games, w.start) }));
  const rows = TEAMS.map((team) => {
    const perWeek = weeks.map((w) => ({ games: w.teams[team].games, offNights: w.teams[team].offNights }));
    return {
      team,
      weeks: perWeek,
      games: perWeek.reduce((s, w) => s + w.games, 0),
      offNights: perWeek.reduce((s, w) => s + w.offNights, 0),
    };
  });
  const maxGames = Math.max(...rows.map((r) => r.games));
  const maxOff = Math.max(...rows.map((r) => r.offNights));
  for (const r of rows) {
    r.score = round(100 * (SCORE_WEIGHTS.games * r.games / maxGames + SCORE_WEIGHTS.offNights * (maxOff ? r.offNights / maxOff : 0)), 1);
  }
  rows.sort((a, b) => b.score - a.score || a.team.localeCompare(b.team));
  return {
    formula: 'score = 100 * (0.75 * games/maxGames + 0.25 * offNights/maxOffNights); off-night = night with <= 7 NHL games',
    maxGames,
    maxOffNights: maxOff,
    weeks: weeks.map(({ name, start, end, leagueGames, nightly }) => ({ name, start, end, leagueGames, nightly })),
    teams: rows,
  };
}

// ---------------------------------------------------------------- assembly

function seasonDelta(prev, cur, key) {
  const a = prev?.toi?.[key];
  const b = cur?.toi?.[key];
  return a != null && b != null ? round(b - a, 1) : null;
}

function buildPlayers(rosters, skaterSeasons, goalieSeasons, asOf) {
  const [skPrev, skCur] = skaterSeasons;
  const [gPrev, gCur] = goalieSeasons;
  const skaters = [];
  const goalies = [];

  const ids = new Set([...rosters.keys(), ...skPrev.keys(), ...skCur.keys(), ...gPrev.keys(), ...gCur.keys()]);
  for (const id of ids) {
    const ros = rosters.get(id);
    const isGoalie = ros ? ros.positionCode === 'G' : gPrev.has(id) || gCur.has(id);
    const [prev, cur] = isGoalie ? [gPrev.get(id), gCur.get(id)] : [skPrev.get(id), skCur.get(id)];
    if (!ros && !prev && !cur) continue;
    const latest = cur ?? prev;

    const base = {
      playerId: id,
      name: ros?.name ?? latest.name,
      position: ros?.positionCode ?? latest.positionCode,
      // Roster team is authoritative (captures offseason moves); otherwise last team in stats.
      team: ros?.team ?? lastTeam(latest.teamAbbrevs),
      onRoster: Boolean(ros),
      birthDate: ros?.birthDate ?? null,
      age: ageOn(ros?.birthDate, asOf),
      shootsCatches: ros?.shootsCatches ?? latest?.shoots ?? latest?.catches ?? null,
      sweaterNumber: ros?.sweaterNumber ?? null,
      headshot: ros?.headshot ?? null,
      seasons: {
        [PREV_SEASON]: prev ? stripSeason(prev) : null,
        [CUR_SEASON]: cur ? stripSeason(cur) : null,
      },
    };

    if (isGoalie) {
      goalies.push(base);
    } else {
      base.derived = {
        TOI_pg_prev: prev?.toi?.TOI_pg ?? null,
        TOI_pg_cur: cur?.toi?.TOI_pg ?? null,
        TOI_pg_delta: seasonDelta(prev, cur, 'TOI_pg'),
        PPTOI_pg_prev: prev?.toi?.PPTOI_pg ?? null,
        PPTOI_pg_cur: cur?.toi?.PPTOI_pg ?? null,
        PPTOI_pg_delta: seasonDelta(prev, cur, 'PPTOI_pg'),
        SHTOI_pg_delta: seasonDelta(prev, cur, 'SHTOI_pg'),
        teamChanged: Boolean(ros && prev && lastTeam(prev.teamAbbrevs) !== ros.team),
      };
      skaters.push(base);
    }
  }
  const sortKey = (p) => -((p.position === 'G' ? p.seasons[PREV_SEASON]?.totals.W : p.seasons[PREV_SEASON]?.totals.PTS) ?? -1);
  skaters.sort((a, b) => sortKey(a) - sortKey(b) || a.name.localeCompare(b.name));
  goalies.sort((a, b) => sortKey(a) - sortKey(b) || a.name.localeCompare(b.name));
  return { skaters, goalies };
}

// Season record minus fields that are duplicated at the player level.
function stripSeason({ playerId, name, positionCode, shoots, catches, ...rest }) {
  return rest;
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(dirname(OUT_FILE), { recursive: true });
  const asOf = new Date().toISOString().slice(0, 10);

  console.log('Fetching skater stats...');
  const skaterSeasons = [];
  for (const s of SEASONS) skaterSeasons.push(await fetchSkaterSeason(s));
  console.log('Fetching goalie stats...');
  const goalieSeasons = await pool(SEASONS, CONCURRENCY, fetchGoalieSeason);
  console.log('Fetching rosters...');
  const rosters = await fetchRosters();
  console.log('Fetching schedule...');
  const schedule = await fetchSchedule();

  const { skaters, goalies } = buildPlayers(rosters, skaterSeasons, goalieSeasons, asOf);

  // every start this season, game by game: who has the net lately and how each goalie played
  // (the engine's crease model reads these; a failed fetch just leaves the log out)
  console.log('Fetching goalie game logs...');
  await pool(goalies.filter((g) => g.seasons?.[CUR_SEASON]?.GP > 0), CONCURRENCY, async (g) => {
    try {
      const j = await getJson(`${WEB_BASE}/player/${g.playerId}/game-log/${CUR_SEASON}/2`);
      g.gameLog = (j.gameLog || []).map((e) => ({ date: e.gameDate, team: e.teamAbbrev, gs: e.gamesStarted || 0, sa: e.shotsAgainst || 0, ga: e.goalsAgainst || 0, dec: e.decision || null }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch { /* keep going without this goalie's log */ }
  });

  // Every Mon-Sun week of the regular season, for weekly streaming decisions.
  const weeks = [];
  for (let d = mondayOf(schedule.seasonStart); d <= schedule.seasonEnd; d = addDays(d, 7)) {
    weeks.push(summarizeWeek(schedule.games, d));
  }

  const data = {
    meta: {
      generatedAt: new Date().toISOString(),
      asOf,
      seasons: { previous: PREV_SEASON, current: CUR_SEASON },
      regularSeason: { preSeasonStart: schedule.preSeasonStart, start: schedule.seasonStart, end: schedule.seasonEnd },
      counts: {
        skaters: skaters.length,
        goalies: goalies.length,
        skatersWithPrevStats: skaterSeasons[0].size,
        skatersWithCurStats: skaterSeasons[1].size,
        goaliesWithPrevStats: goalieSeasons[0].size,
        goaliesWithCurStats: goalieSeasons[1].size,
        rosterPlayers: rosters.size,
        games: schedule.games.length,
      },
      notes: {
        stats: 'seasons[season].totals are raw counting totals (fantasy pts = sum(total * weight)); perGame = total / GP.',
        toi: 'All TOI values are seconds. *_pg = per game. derived.*_delta = current - previous season.',
        skaterKeys: SKATER_COUNT_KEYS,
        goalieKeys: [...GOALIE_COUNT_KEYS, 'GAA', 'SVPCT'],
        team: 'team = current roster team (api-web roster/current); falls back to last team in stats if not on an NHL roster.',
        schedule: 'game.date is the NHL local game date from the schedule gameWeek, not the UTC date.',
      },
    },
    skaters,
    goalies,
    teams: TEAMS,
    schedule: { games: schedule.games },
    weeks,
    upcomingWeek: summarizeWeek(schedule.games, UPCOMING_WEEK_START),
    playoffSchedule: playoffScore(schedule.games),
  };

  await writeFile(OUT_FILE, JSON.stringify(data, null, 1));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  skaters=${skaters.length} goalies=${goalies.length} games=${schedule.games.length}`);
  console.log(`  requests=${requestCount} cacheHits=${cacheHits} time=${secs}s`);
}

// awaited so a browser run (web/runner.js) knows when the data is written
await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
