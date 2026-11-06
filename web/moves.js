// Auto moves: queued Yahoo add/drops run by the worker's cron
// Pure logic here (node --test web/moves.test.mjs);
// the worker does the D1 and Yahoo calls.

// Only the owner's leagues: Points League (points) and Categories League (categories)
export const LEAGUES = { '477.l.11111': 'Points League', '477.l.22222': 'Categories League' };
export const WHEN_AVAILABLE_TTL_MS = 7 * 24 * 3600e3;
export const AT_TIME_GRACE_MS = 2 * 3600e3;
export const MAX_SCHEDULE_AHEAD_MS = 60 * 24 * 3600e3;
export const MAX_ACTIVE = 20;
// while a player sits on waivers, look again every 15 minutes (every minute once it is his clear day)
export const WAIVER_RECHECK_MS = 15 * 60e3;

const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^(\d+\.l\.\d+)\.t\.\d+$/;
const PLAYER_KEY_RE = /^\d+\.p\.\d+$/;
export const isLeagueKey = (k) => typeof k === 'string' && LEAGUE_KEY_RE.test(k);
export const isTeamKey = (k) => typeof k === 'string' && TEAM_KEY_RE.test(k);
export const isPlayerKey = (k) => typeof k === 'string' && PLAYER_KEY_RE.test(k);
export const leagueOfTeam = (k) => TEAM_KEY_RE.exec(k || '')?.[1] ?? null;

// Never drop these (Yahoo player IDs). Fill in your own; keep in sync with moves/protected.json.
export const NEVER_DROP = [];
export const isNeverDrop = (playerKey) => NEVER_DROP.includes(Number(/\.p\.(\d+)$/.exec(playerKey || '')?.[1]));

// ---- Yahoo transaction XML ------------------------------------------------------------------------
export const escapeXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function buildTransactionXml({ add_player_key: add, drop_player_key: drop, team_key: team }) {
  if (drop && isNeverDrop(drop)) throw new Error('Refused: that player is on the never-drop list.');
  const addPart = (indent) => [
    `${indent}<player>`,
    `${indent}  <player_key>${escapeXml(add)}</player_key>`,
    `${indent}  <transaction_data>`,
    `${indent}    <type>add</type>`,
    `${indent}    <destination_team_key>${escapeXml(team)}</destination_team_key>`,
    `${indent}  </transaction_data>`,
    `${indent}</player>`,
  ];
  const body = drop
    ? ['    <type>add/drop</type>', '    <players>', ...addPart('      '),
      '      <player>',
      `        <player_key>${escapeXml(drop)}</player_key>`,
      '        <transaction_data>',
      '          <type>drop</type>',
      `          <source_team_key>${escapeXml(team)}</source_team_key>`,
      '        </transaction_data>',
      '      </player>', '    </players>']
    : ['    <type>add</type>', ...addPart('    ')];
  return ['<?xml version="1.0"?>', '<fantasy_content>', '  <transaction>', ...body, '  </transaction>', '</fantasy_content>'].join('\n');
}

// ---- Yahoo JSON helpers ---------------------------------------------------------------------------
// Yahoo's JSON mirrors its XML: collections are {"0": x, "1": y, count}, resources are arrays whose
// first element is a list of single-key objects (with [] fillers).
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (v, ...path) => path.reduce((cur, p) => (Array.isArray(cur) && typeof p === 'number' ? cur[p] : isObj(cur) ? cur[String(p)] : undefined), v);
export const values = (v) => (Array.isArray(v) ? v : isObj(v) ? Object.keys(v).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b).map((k) => v[k]) : []);
function findKey(v, key, depth = 0) {
  if (depth > 4) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const f = findKey(item, key, depth + 1);
      if (f !== undefined) return f;
    }
    return undefined;
  }
  return isObj(v) && key in v ? v[key] : undefined;
}
const toInt = (v) => (typeof v === 'number' ? Math.trunc(v) : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? parseInt(v, 10) : null);
const toBool = (v) => (v === 1 || v === '1' || v === true ? true : v === 0 || v === '0' || v === false ? false : null);

/** /users;use_login=1/games;game_keys=nhl/teams -> [{team_key, name, league_key}] */
export function parseUserTeams(json) {
  const out = [];
  for (const u of values(get(json, 'fantasy_content', 'users'))) {
    for (const g of values(findKey(get(u, 'user'), 'games'))) {
      for (const t of values(findKey(get(g, 'game'), 'teams'))) {
        const meta = get(t, 'team', 0);
        const key = findKey(meta, 'team_key');
        if (typeof key === 'string') out.push({ team_key: key, name: findKey(meta, 'name') ?? key, league_key: leagueOfTeam(key) });
      }
    }
  }
  return out;
}

function parsePlayer(p) {
  const player = get(p, 'player');
  if (!Array.isArray(player)) return null;
  const meta = player[0];
  const key = findKey(meta, 'player_key');
  if (typeof key !== 'string') return null;
  const own = findKey(player.slice(1), 'ownership');
  const sel = findKey(player.slice(1), 'selected_position');
  return {
    player_key: key,
    name: get(findKey(meta, 'name'), 'full') ?? key,
    team: findKey(meta, 'editorial_team_abbr') ?? '',
    pos: findKey(meta, 'display_position') ?? '',
    status: findKey(meta, 'status') ?? '',
    selected_position: findKey(sel, 'position'),
    ownership: isObj(own) ? parseOwnershipObj(own) : null,
  };
}

function parseOwnershipObj(o) {
  const type = ['freeagents', 'waivers', 'team'].includes(o.ownership_type) ? o.ownership_type : 'unknown';
  const r = { ownership_type: type };
  if (typeof o.owner_team_key === 'string') r.owner_team_key = o.owner_team_key;
  if (typeof o.owner_team_name === 'string') r.owner_team_name = o.owner_team_name;
  if (typeof o.waiver_date === 'string') r.waiver_date = o.waiver_date;
  return r;
}

/** /league/{lk}/players;...;out=ownership (or /ownership) -> players with ownership */
export function parseLeaguePlayers(json) {
  const players = findKey(get(json, 'fantasy_content', 'league'), 'players');
  return values(players).map(parsePlayer).filter(Boolean);
}

/** Ownership of one player from a league players response; unknown when missing. */
export function parseOwnership(json, playerKey) {
  const p = parseLeaguePlayers(json).find((x) => x.player_key === playerKey);
  return p?.ownership ?? { ownership_type: 'unknown' };
}

/** /team/{tk}/roster -> { team_key, owned, adds_used, players } or null */
export function parseTeamRoster(json) {
  const team = get(json, 'fantasy_content', 'team');
  if (!Array.isArray(team)) return null;
  const meta = team[0];
  const roster = findKey(team.slice(1), 'roster');
  if (!isObj(roster)) return null;
  let players = roster.players;
  if (players === undefined) players = values(roster).find((v) => isObj(v) && 'players' in v)?.players;
  const adds = findKey(meta, 'roster_adds');
  return {
    team_key: findKey(meta, 'team_key') ?? null,
    owned: toBool(findKey(meta, 'is_owned_by_current_login')),
    adds_used: isObj(adds) ? toInt(adds.value) : null,
    players: values(players).map(parsePlayer).filter(Boolean),
  };
}

/** /league/{lk}/settings -> { max_weekly_adds, roster_positions } or null */
export function parseLeagueSettings(json) {
  const wrap = findKey(get(json, 'fantasy_content', 'league'), 'settings');
  const s = Array.isArray(wrap) ? wrap.find(isObj) : wrap;
  if (!isObj(s)) return null;
  const max = toInt(s.max_weekly_adds);
  const slots = values(s.roster_positions).map((rp) => get(rp, 'roster_position')).filter(isObj)
    .map((p) => ({ position: p.position, count: toInt(p.count) })).filter((p) => typeof p.position === 'string' && p.count !== null);
  return { max_weekly_adds: max > 0 ? max : null, roster_positions: slots };
}

/** /users;use_login=1 -> guid */
export function parseGuid(json) {
  for (const u of values(get(json, 'fantasy_content', 'users'))) {
    const g = findKey(get(u, 'user'), 'guid');
    if (typeof g === 'string' && g) return g;
  }
  return null;
}

const RESERVE = new Set(['IR', 'IR+', 'IL', 'IL+', 'NA']);
/** Room to add without a drop; null when it can't be told (Yahoo then decides). */
export function hasOpenRosterSpot(players, slots) {
  const cap = slots.filter((s) => !RESERVE.has(s.position)).reduce((n, s) => n + s.count, 0);
  if (!slots.length || cap <= 0 || players.some((p) => !p.selected_position)) return null;
  return players.filter((p) => !RESERVE.has(p.selected_position)).length < cap;
}

export function yahooErrorText(body) {
  const t = (body || '').trim();
  const xml = /<description>([\s\S]*?)<\/description>/i.exec(t);
  if (xml) return xml[1].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  try {
    const d = JSON.parse(t)?.error?.description;
    if (typeof d === 'string') return d;
  } catch { /* not JSON */ }
  return t.slice(0, 300);
}
export const isPermissionError = (status, body) => status === 403 || (status === 401 && /scope|permission|not authorized|unauthorized|forbidden/i.test(body || ''));

// ---- deciding a move ------------------------------------------------------------------------------
// Returns { action: 'wait' | 'attempt' | 'fail' | 'expire', code, reason }. With facts = null only the
// time checks run ('attempt' then means "go read Yahoo").
export function decideMove(move, facts, now) {
  const t = now.getTime();
  const exp = Date.parse(move.expires_at);
  if (!Number.isFinite(exp) || t >= exp) return { action: 'expire', code: 'expired', reason: 'Expired before the move could be made.' };
  if (move.trigger_type === 'at_time') {
    const run = Date.parse(move.run_at);
    if (!Number.isFinite(run)) return { action: 'fail', code: 'not_due', reason: 'No time was set for this move.' };
    if (t < run) return { action: 'wait', code: 'not_due', reason: 'Scheduled for later.' };
  }
  if (move.drop_player_key && isNeverDrop(move.drop_player_key)) return { action: 'fail', code: 'never_drop', reason: `${move.drop_player_name?.trim() || 'That player'} is on the never-drop list.` };
  if (!facts) return { action: 'attempt' };

  const add = move.add_player_name?.trim() || 'That player';
  const drop = move.drop_player_name?.trim() || 'The player to drop';
  const own = facts.ownership;
  if (facts.owned === false) return { action: 'fail', code: 'not_your_team', reason: 'Yahoo says you no longer manage this team.' };
  if (!facts.rosterKeys) return { action: 'wait', code: 'roster_unknown', reason: 'Could not read your roster from Yahoo. Will retry.' };
  if (facts.rosterKeys.includes(move.add_player_key) || (own.ownership_type === 'team' && own.owner_team_key === move.team_key)) {
    return { action: 'fail', code: 'already_on_team', reason: `${add} is already on your team.` };
  }
  if (own.ownership_type === 'team') return { action: 'fail', code: 'already_taken', reason: `${add} was taken by ${own.owner_team_name || 'another team'}.` };
  if (move.drop_player_key && !facts.rosterKeys.includes(move.drop_player_key)) {
    return { action: 'fail', code: 'drop_not_on_roster', reason: `${drop} is no longer on your roster.` };
  }
  if (own.ownership_type === 'waivers') {
    if (move.trigger_type === 'at_time') return { action: 'fail', code: 'on_waivers_at_time', reason: `${add} was on waivers at the scheduled time, so nothing was done.` };
    return { action: 'wait', code: 'on_waivers', until: own.waiver_date, reason: `${add} is on waivers${own.waiver_date ? ` until ${own.waiver_date}` : ''}.` };
  }
  if (own.ownership_type !== 'freeagents') return { action: 'wait', code: 'ownership_unknown', reason: `Could not read ${add}'s status from Yahoo. Will retry.` };
  if (facts.maxAdds != null && facts.addsUsed != null && facts.addsUsed >= facts.maxAdds) {
    return { action: 'fail', code: 'adds_exhausted', reason: `You have used all ${facts.maxAdds} adds this week.` };
  }
  if (!move.drop_player_key && facts.openSpot === false) return { action: 'fail', code: 'roster_full', reason: 'Your roster is full and no player to drop was chosen.' };
  return { action: 'attempt' };
}

/** When to look at a waiting move again. */
export function nextCheck(move, decision, now) {
  const t = now.getTime();
  if (decision.code === 'not_due' && move.run_at) return new Date(Math.max(t, Date.parse(move.run_at)));
  if (decision.code === 'on_waivers') {
    // waiver_date is the league's local day the player clears; before that day there's no rush
    if (decision.until && etDate(now) < decision.until) return new Date(t + WAIVER_RECHECK_MS);
  }
  return new Date(t + 60e3);
}

/** Today's date (YYYY-MM-DD) in New York, where Yahoo's NHL days turn over. */
export const etDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export const expiresAt = (trigger, runAt, now) => new Date(trigger === 'at_time' ? runAt.getTime() + AT_TIME_GRACE_MS : now.getTime() + WHEN_AVAILABLE_TTL_MS);

/** Checks a new move's fields (not Yahoo facts). Returns an error message or null. */
export function validateNewMove(b, now) {
  if (!isTeamKey(b.team_key) || !LEAGUES[leagueOfTeam(b.team_key)]) return 'Pick one of your teams.';
  if (!isPlayerKey(b.add_player_key)) return 'Pick a player to add.';
  if (b.drop_player_key != null && b.drop_player_key !== '' && !isPlayerKey(b.drop_player_key)) return 'Invalid player to drop.';
  if (b.drop_player_key && b.drop_player_key === b.add_player_key) return 'You cannot add and drop the same player.';
  if (b.drop_player_key && isNeverDrop(b.drop_player_key)) return 'That player is on the never-drop list.';
  if (b.trigger_type !== 'when_available' && b.trigger_type !== 'at_time') return 'Pick when the move should happen.';
  if (b.trigger_type === 'at_time') {
    const run = Date.parse(b.run_at);
    if (!Number.isFinite(run)) return 'Pick a date and time.';
    if (run <= now.getTime()) return 'The time must be in the future.';
    if (run - now.getTime() > MAX_SCHEDULE_AHEAD_MS) return 'The time must be within the next 60 days.';
  }
  return null;
}
