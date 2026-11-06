// Pull a league snapshot from the Yahoo Fantasy API (needs secrets/yahoo-token.json,
// created once by yahoo/auth.mjs). Writes yahoo/data/league-<id>.json in the same
// shape the engines read, so this replaces the hand-read Chrome snapshot.
//   node yahoo/snapshot.mjs                   points league (Points League)
//   node yahoo/snapshot.mjs --league 22222    Categories League (categories)
// In a browser refresh the worker makes the Yahoo calls and globalThis.BOARD_ARGV carries the arguments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yget, flat, items } from './client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = globalThis.BOARD_ARGV || process.argv;
const LEAGUE_ID = ARGV.includes('--league') ? String(ARGV[ARGV.indexOf('--league') + 1]) : '11111';
const CATEGORIES = LEAGUE_ID !== '11111';
const OUT = path.join(ROOT, 'yahoo', 'data', `league-${LEAGUE_ID}.json`);
const STAT = { G: 'G', A: 'A', PPP: 'PPP', SHP: 'SHP', SOG: 'SOG', BLK: 'BLK', W: 'W', GA: 'GA', SV: 'SV', SHO: 'SO' };

// find this season's league key (e.g. "465.l.11111")
const games = (await yget('/users;use_login=1/games;game_keys=nhl/leagues')).users[0].user[1].games;
let leagueKey = null;
for (const g of items(games)) for (const l of items(g.game[1]?.leagues)) if (l.league[0].league_id === LEAGUE_ID) leagueKey = l.league[0].league_key;
if (!leagueKey) throw new Error(`League ${LEAGUE_ID} not found for this Yahoo login`);

// settings: scoring, roster slots, add limit
const lg = (await yget(`/league/${leagueKey}/settings`)).league;
const meta = lg[0], set = lg[1].settings[0];
const cats = Object.fromEntries(set.stat_categories.stats.map(({ stat }) => [stat.stat_id, stat.display_name]));
const scoring = { skater: {}, goalie: {} };
for (const { stat } of set.stat_modifiers?.stats || []) { // categories leagues have no point values
  const name = STAT[cats[stat.stat_id]];
  const cat = set.stat_categories.stats.find((s) => s.stat.stat_id === stat.stat_id)?.stat;
  if (name) scoring[cat?.position_type === 'G' ? 'goalie' : 'skater'][name] = parseFloat(stat.value);
}
const rosterSlots = {};
for (const { roster_position: r } of set.roster_positions) rosterSlots[r.position] = Number(r.count);

// every team's roster
const teams = items((await yget(`/league/${leagueKey}/teams/roster`)).league[1].teams);
const parsePlayer = (pl) => {
  const info = flat(pl.player[0]);
  const sel = flat(pl.player[1]?.selected_position || []);
  return {
    slot: sel.position || '', yid: Number(info.player_id), name: info.name.full,
    team: (info.editorial_team_abbr || '').toUpperCase(),
    pos: (info.eligible_positions || []).map((p) => p.position).filter((p) => !['IR', 'IR+', 'IR-LT', 'BN', 'Util', 'F', 'NA'].includes(p)),
    status: info.status || undefined,
  };
};
let myTeam = null; const others = [], teamNames = {};
for (const t of teams) {
  const info = flat(t.team[0]);
  teamNames[info.team_id] = info.name;
  const players = items(t.team[1].roster[0].players).map(parsePlayer).map((p) => ({ ...p, ft: Number(info.team_id) }));
  if (Number(info.is_owned_by_current_login) === 1) {
    myTeam = { id: Number(info.team_id), key: info.team_key, name: info.name, addsUsedThisWeek: Number(info.roster_adds?.value ?? 0), waiverPriority: Number(info.waiver_priority ?? 0), currentWeek: Number(meta.current_week), roster: players.map(({ ft, ...p }) => p) };
  } else others.push(...players);
}

// the board's week opponent: the coming week on Sunday, otherwise the week in progress (same rule as the engine)
try {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mon = new Date(et); mon.setDate(et.getDate() + (et.getDay() === 0 ? 1 : 1 - et.getDay()));
  const monIso = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
  const cw = Number(meta.current_week);
  const mus = items((await yget(`/team/${myTeam.key}/matchups;weeks=${cw},${cw + 1}`)).team[1].matchups).map((m) => m.matchup);
  const mu = mus.find((m) => m.week_start === monIso) || mus[mus.length - 1];
  const opp = items(mu?.['0']?.teams).map((t) => flat(t.team[0])).find((t) => t.team_key !== myTeam.key);
  if (opp) myTeam.opponent = { week: Number(mu.week), name: opp.name, teamId: Number(opp.team_id) };
} catch (e) { console.warn('No matchup info:', e.message); }

// standings: record, rank and points so far (the points league's team needs: projected finish)
let standings = null;
try {
  standings = {};
  for (const t of items((await yget(`/league/${leagueKey}/standings`)).league[1].standings[0].teams)) {
    const info = flat(t.team[0]), st = t.team.find((x) => x?.team_standings)?.team_standings;
    if (!st) continue;
    const o = st.outcome_totals || {};
    standings[info.team_id] = { rank: Number(st.rank), w: Number(o.wins || 0), l: Number(o.losses || 0), t: Number(o.ties || 0), pf: Number(st.points_for || 0), pa: Number(st.points_against || 0) };
  }
} catch (e) { console.warn('No standings:', e.message); standings = null; }

// players on waivers, with clear dates
const waivers = [], seenW = new Set();
for (const pos of ['', ';position=G']) for (let start = 0; start < 200; start += 25) {
  const ps = items((await yget(`/league/${leagueKey}/players;status=W${pos};start=${start};count=25;out=ownership`)).league[1].players);
  for (const pl of ps) {
    const p = parsePlayer(pl);
    if (seenW.has(p.yid)) continue;
    seenW.add(p.yid);
    const own = flat(pl.player[1]?.ownership || []);
    waivers.push(`${p.name}/${p.team}/${own.waiver_date ? new Date(own.waiver_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}`);
  }
  if (ps.length < 25) break;
}

// position eligibility for the top available skaters (Yahoo grants dual eligibility the NHL feed lacks)
const multi = [];
for (let start = 0; start < (CATEGORIES ? 0 : 400); start += 25) { // eligibility is the same in every league: read it once
  const ps = items((await yget(`/league/${leagueKey}/players;status=A;position=P;sort=OR;start=${start};count=25`)).league[1].players).map(parsePlayer);
  for (const p of ps) if (p.pos.length > 1) multi.push(`${p.name} > ${p.pos.join(' ')}`);
  if (ps.length < 25) break;
}

if (!myTeam?.roster?.length || others.length < 50) throw new Error(`Yahoo read looks incomplete (${myTeam?.roster?.length ?? 0} mine, ${others.length} others); not saving.`);
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const snapshot = {
  fetchedAt: new Date().toISOString(),
  source: 'Yahoo Fantasy API',
  league: {
    ...(prev?.league || {}),
    id: Number(LEAGUE_ID), key: leagueKey, name: meta.name, numTeams: Number(meta.num_teams),
    maxAddsPerWeek: Number(set.max_weekly_adds || prev?.league?.maxAddsPerWeek || 4),
    rosterSlots, scoring,
    playoffStartWeek: Number(set.playoff_start_week || prev?.league?.playoffStartWeek || 0) || null,
  },
  myTeam,
  teamNames,
  standings: standings || prev?.standings || null,
  otherRostered: others.map((p) => `${p.ft}:${p.name}/${p.team}${p.pos.includes('G') ? '/G' : ''}`).join(';'),
  waivers: waivers.join(';'),
  multiPosition: multi.join('; '),
};
if (CATEGORIES) snapshot.multiPosition = prev?.multiPosition || '';
// The API has no Yahoo Pre-Season / Current ranks (the trade market's "market value"): keep the newest
// Chrome read's, else the last saved ones
const chromeRaw = path.join(ROOT, 'yahoo', 'data', CATEGORIES ? `chrome-raw-${LEAGUE_ID}.json` : 'chrome-raw.json');
let chromeRanks = '';
try { chromeRanks = JSON.parse(fs.readFileSync(chromeRaw, 'utf8')).ranks || ''; } catch { /* no Chrome read yet */ }
snapshot.ranks = chromeRanks || prev?.ranks || '';
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
console.log(`Yahoo snapshot: ${myTeam.name}, ${myTeam.roster.length} players, ${others.length} rostered elsewhere, ${waivers.length} on waivers`);
