// Cloudflare Worker for the shared fantasy hockey board (free plan; does no heavy work itself).
//   /             the board page and its files (static assets: index.html, seed.json, runner.js, pipeline/*)
//   /moves        the owner's auto moves page (static moves.html; its API needs the private moves key)
//   /api/latest   GET the newest board data; POST saves a refresh (x-board-key header)
//   /api/proxy    GET ?u=<url>: NHL, DailyFaceoff and ESPN data for a browser refresh (adds CORS)
//   /api/yahoo    GET ?r=<resource>: a read-only Yahoo Fantasy API call with the stored login
//   /api/moves/*  auto moves: Yahoo login, player search, queue/cancel (x-moves-key header)
//   cron          every minute: makes the queued moves that are due (see moves.js)
// The Yahoo login lives in D1 (table store), made once on /moves with Yahoo's code-on-screen ("oob")
// sign-in, so no redirect site is needed. App: your own Yahoo developer app.
import * as M from './moves.js';

const ALLOW = new Set(['api-web.nhle.com', 'api.nhle.com', 'www.dailyfaceoff.com', 'site.api.espn.com', 'site.web.api.espn.com']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-board-key, x-moves-key' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const YAHOO_API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const WRITE = 'fspt-w';

// ---- small key/value store in D1 ------------------------------------------------------------------
async function sget(env, key) {
  const r = await env.DB.prepare('select value, expires_at from store where key = ?').bind(key).first();
  return r && (!r.expires_at || r.expires_at > Date.now()) ? r.value : null;
}
const sput = (env, key, value, ttlMs) => env.DB.prepare('insert into store (key, value, expires_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at')
  .bind(key, value, ttlMs ? Date.now() + ttlMs : null).run();
const sdel = (env, ...keys) => env.DB.batch(keys.map((k) => env.DB.prepare('delete from store where key = ?').bind(k)));

// ---- Yahoo login ---------------------------------------------------------------------------------
async function tokenRequest(env, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ redirect_uri: 'oob', ...params }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok && typeof data.access_token === 'string', status: res.status, data };
}

async function saveTokens(env, d) {
  await sput(env, 'yahoo_access', d.access_token, Math.max(300, (d.expires_in || 3600) - 300) * 1000);
  if (d.refresh_token) await sput(env, 'yahoo_refresh', d.refresh_token);
}

/** { token } or { error, permanent } */
async function accessToken(env) {
  const cached = await sget(env, 'yahoo_access');
  if (cached) return { token: cached };
  const refresh = await sget(env, 'yahoo_refresh');
  if (!refresh) return { error: 'Yahoo is not connected yet.', permanent: true };
  const r = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!r.ok) {
    const permanent = r.status === 400 || r.status === 401;
    return { error: permanent ? 'Yahoo no longer accepts the saved login. Connect Yahoo again.' : 'Could not reach Yahoo to sign in. Will retry.', permanent };
  }
  await saveTokens(env, r.data);
  return { token: r.data.access_token };
}

async function yahoo(env, resource, init = {}, retry = true) {
  const t = await accessToken(env);
  if (!t.token) return { ok: false, status: 503, text: t.error, json: null, loginError: t };
  const url = init.method === 'POST' ? YAHOO_API + resource : `${YAHOO_API}${resource}${resource.includes('?') ? '&' : '?'}format=json`;
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${t.token}`, ...(init.headers || {}) } });
  if (res.status === 401 && retry) {
    await sdel(env, 'yahoo_access');
    return yahoo(env, resource, init, false);
  }
  const text = (await res.text()).trim();
  let body = null;
  if (res.ok && init.method !== 'POST') try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, text, json: body };
}

/** Has Yahoo turned on write access (fspt-w) for this app? Asks Yahoo's sign-in page, cached 1 hour. */
async function writeGranted(env) {
  const cached = await sget(env, 'write_granted');
  if (cached !== null) return cached === '1';
  let granted = false;
  try {
    const r = await fetch(`${AUTH_URL}?client_id=${encodeURIComponent(env.YAHOO_CLIENT_ID)}&redirect_uri=oob&response_type=code&scope=${WRITE}`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    granted = r.status >= 300 && r.status < 400 && !!loc && !/[?&]error=/.test(loc);
  } catch { return false; }
  await sput(env, 'write_granted', granted ? '1' : '0', 3600e3);
  return granted;
}

async function myTeams(env, fresh = false) {
  const cached = !fresh && await sget(env, 'teams');
  if (cached) return JSON.parse(cached);
  const r = await yahoo(env, '/users;use_login=1/games;game_keys=nhl/teams');
  if (!r.ok) return null;
  const teams = M.parseUserTeams(r.json).filter((t) => M.LEAGUES[t.league_key]).map((t) => ({ ...t, league: M.LEAGUES[t.league_key] }));
  await sput(env, 'teams', JSON.stringify(teams), 12 * 3600e3);
  return teams;
}

// ---- auto moves API -------------------------------------------------------------------------------
function keyOk(req, env) {
  const a = new TextEncoder().encode(req.headers.get('x-moves-key') || ''), b = new TextEncoder().encode(env.MOVES_KEY || '');
  let diff = (a.length ^ b.length) | (b.length ? 0 : 1);
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return !diff;
}
const listMoves = async (env) => (await env.DB.prepare('select * from moves order by created_at desc limit 50').all()).results;

async function status(env) {
  const refresh = await sget(env, 'yahoo_refresh');
  const scope = (await sget(env, 'yahoo_scope')) || '';
  const out = { connected: !!refresh, scope, canMove: !!refresh && scope.includes(WRITE), writeGranted: await writeGranted(env), connectedAt: await sget(env, 'connected_at'), moves: await listMoves(env) };
  if (refresh) out.teams = await myTeams(env);
  return out;
}

async function movesApi(req, env, path) {
  if (!env.MOVES_KEY || !keyOk(req, env)) return json({ error: 'This page needs your private auto moves link.' }, 403);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const q = new URL(req.url).searchParams;
  const now = new Date();

  if (path === 'status') return json(await status(env));

  if (path === 'connect-url') {
    const scope = (await writeGranted(env)) ? WRITE : 'fspt-r';
    await sput(env, 'pending_scope', scope, 3600e3);
    return json({ scope, url: `${AUTH_URL}?client_id=${encodeURIComponent(env.YAHOO_CLIENT_ID)}&redirect_uri=oob&response_type=code&scope=${scope}&language=en-us` });
  }

  if (path === 'connect' && req.method === 'POST') {
    const code = String(body.code || '').trim();
    if (!/^[\w.~-]{4,200}$/.test(code)) return json({ error: 'That does not look like the code Yahoo showed. Copy it again.' }, 400);
    const r = await tokenRequest(env, { grant_type: 'authorization_code', code });
    if (!r.ok) return json({ error: `Yahoo did not accept that code (${r.data.error_description || r.data.error || r.status}). Open Yahoo again for a fresh code.` }, 400);
    await saveTokens(env, r.data);
    await sput(env, 'yahoo_scope', (await sget(env, 'pending_scope')) || 'fspt-r');
    await sput(env, 'connected_at', now.toISOString());
    await myTeams(env, true);
    return json(await status(env));
  }

  if (path === 'disconnect' && req.method === 'POST') {
    await sdel(env, 'yahoo_refresh', 'yahoo_access', 'yahoo_scope', 'teams', 'connected_at');
    return json(await status(env));
  }

  if (path === 'search') {
    const team = q.get('team'), text = (q.get('q') || '').trim();
    if (!M.isTeamKey(team) || !M.LEAGUES[M.leagueOfTeam(team)]) return json({ error: 'Pick one of your teams.' }, 400);
    if (!/^[\p{L}\s.'-]{2,40}$/u.test(text)) return json({ error: 'Type at least two letters of a name.' }, 400);
    const r = await yahoo(env, `/league/${M.leagueOfTeam(team)}/players;search=${encodeURIComponent(text)};count=15;out=ownership`);
    if (!r.ok) return json({ error: `Yahoo search failed (${r.status}).` }, 502);
    return json({ players: M.parseLeaguePlayers(r.json) });
  }

  if (path === 'roster') {
    const team = q.get('team');
    if (!M.isTeamKey(team) || !M.LEAGUES[M.leagueOfTeam(team)]) return json({ error: 'Pick one of your teams.' }, 400);
    const r = await yahoo(env, `/team/${team}/roster`);
    const roster = r.ok && M.parseTeamRoster(r.json);
    if (!roster) return json({ error: `Could not load the roster from Yahoo (${r.status}).` }, 502);
    return json(roster);
  }

  if (path === 'create' && req.method === 'POST') {
    const b = { ...body, drop_player_key: body.drop_player_key || null };
    const bad = M.validateNewMove(b, now);
    if (bad) return json({ error: bad }, 400);
    if (!(await sget(env, 'yahoo_refresh'))) return json({ error: 'Connect Yahoo first.' }, 409);
    const r = await yahoo(env, `/team/${b.team_key}/roster`);
    const roster = r.ok && M.parseTeamRoster(r.json);
    if (!roster || roster.team_key !== b.team_key) return json({ error: 'Could not read your roster from Yahoo. Try again.' }, 502);
    if (roster.owned !== true) return json({ error: 'Yahoo says you do not manage this team.' }, 403);
    const keys = roster.players.map((p) => p.player_key);
    if (keys.includes(b.add_player_key)) return json({ error: 'That player is already on your team.' }, 400);
    if (b.drop_player_key && !keys.includes(b.drop_player_key)) return json({ error: 'The player to drop is not on your roster.' }, 400);
    const active = (await env.DB.prepare("select add_player_key from moves where status in ('queued', 'running')").all()).results;
    if (active.some((m) => m.add_player_key === b.add_player_key)) return json({ error: 'There is already a queued move for this player.' }, 409);
    if (active.length >= M.MAX_ACTIVE) return json({ error: `At most ${M.MAX_ACTIVE} queued moves.` }, 409);
    const runAt = b.trigger_type === 'at_time' ? new Date(b.run_at) : null;
    const t = now.toISOString();
    await env.DB.prepare(`insert into moves (id, league_key, team_key, add_player_key, add_player_name, drop_player_key, drop_player_name,
      trigger_type, run_at, expires_at, status, code, reason, next_check_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'new', 'Waiting for the first check.', ?, ?, ?)`)
      .bind(crypto.randomUUID(), M.leagueOfTeam(b.team_key), b.team_key, b.add_player_key, String(b.add_player_name || '').slice(0, 80) || null,
        b.drop_player_key, b.drop_player_key ? String(b.drop_player_name || '').slice(0, 80) || null : null, b.trigger_type,
        runAt ? runAt.toISOString() : null, M.expiresAt(b.trigger_type, runAt, now).toISOString(), runAt ? runAt.toISOString() : t, t, t).run();
    return json({ moves: await listMoves(env) });
  }

  if (path === 'cancel' && req.method === 'POST') {
    const r = await env.DB.prepare("update moves set status = 'cancelled', code = 'cancelled', reason = 'Cancelled.', updated_at = ? where id = ? and status = 'queued'")
      .bind(now.toISOString(), String(body.id || '')).run();
    if (!r.meta.changes) return json({ error: 'Only waiting moves can be cancelled (it may be running right now).' }, 409);
    return json({ moves: await listMoves(env) });
  }

  return json({ error: 'Unknown request.' }, 404);
}

// ---- the runner (cron) ----------------------------------------------------------------------------
export async function runMoves(env, now = new Date()) {
  const t = now.toISOString();
  const summary = { claimed: 0 };
  // moves stuck in 'running' (a run that died) go back in the queue; expired ones close
  await env.DB.batch([
    env.DB.prepare("update moves set status = 'queued', updated_at = ? where status = 'running' and updated_at < ?").bind(t, new Date(now - 5 * 60e3).toISOString()),
    env.DB.prepare("update moves set status = 'failed', code = 'expired', reason = 'Expired before the move could be made.', updated_at = ? where status = 'queued' and expires_at <= ?").bind(t, t),
  ]);
  const claimed = (await env.DB.prepare(`update moves set status = 'running', updated_at = ? where id in
    (select id from moves where status = 'queued' and next_check_at <= ? order by created_at limit 25) returning *`).bind(t, t).all()).results;
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;

  const canWrite = ((await sget(env, 'yahoo_scope')) || '').includes(WRITE);
  const settings = new Map();
  const save = (m, patch) => {
    const p = { attempts: (m.attempts || 0) + 1, last_checked_at: t, updated_at: t, ...patch };
    const cols = Object.keys(p);
    return env.DB.prepare(`update moves set ${cols.map((c) => `${c} = ?`).join(', ')} where id = ? and status = 'running'`).bind(...cols.map((c) => p[c]), m.id).run();
  };
  const wait = (m, d, next) => save(m, { status: 'queued', code: d.code, reason: d.reason, next_check_at: (next || M.nextCheck(m, d, now)).toISOString() });
  const close = (m, status, code, reason, result) => save(m, { status, code, reason, result: result ? JSON.stringify(result).slice(0, 4000) : null });

  for (const m of claimed) {
    try {
      const pre = M.decideMove(m, null, now);
      if (pre.action === 'expire' || pre.action === 'fail') { await close(m, 'failed', pre.code, pre.reason); continue; }
      if (pre.action === 'wait') { await wait(m, pre); continue; }
      if (!canWrite) {
        await wait(m, { code: 'no_write_access', reason: 'Waiting for Yahoo write access. Once Yahoo turns it on, connect Yahoo again on this page.' }, new Date(+now + 10 * 60e3));
        continue;
      }

      const own = await yahoo(env, `/league/${m.league_key}/players;player_keys=${m.add_player_key}/ownership`);
      if (!own.ok) {
        if (own.loginError?.permanent) { await close(m, 'failed', 'needs_reconnect', own.loginError.error); continue; }
        await wait(m, { code: 'yahoo_unavailable', reason: `Yahoo returned ${own.status} when checking the player. Will retry.` });
        continue;
      }
      const ownership = M.parseOwnership(own.json, m.add_player_key);
      // still on waivers: no need to read the roster yet
      if (ownership.ownership_type === 'waivers' && m.trigger_type === 'when_available') {
        const d = M.decideMove(m, { ownership, rosterKeys: [], owned: true }, now);
        if (d.action === 'wait') { await wait(m, d); continue; }
      }
      if (!settings.has(m.league_key)) {
        const s = await yahoo(env, `/league/${m.league_key}/settings`);
        settings.set(m.league_key, s.ok ? M.parseLeagueSettings(s.json) : null);
      }
      const ls = settings.get(m.league_key);
      const ro = await yahoo(env, `/team/${m.team_key}/roster`);
      const roster = ro.ok && M.parseTeamRoster(ro.json);
      const ok = roster && roster.team_key === m.team_key;
      const facts = {
        ownership,
        rosterKeys: ok ? roster.players.map((p) => p.player_key) : null,
        owned: ok ? roster.owned : null,
        addsUsed: ok ? roster.adds_used : null,
        maxAdds: ls ? ls.max_weekly_adds : null,
        openSpot: ok && ls ? M.hasOpenRosterSpot(roster.players, ls.roster_positions) : null,
      };
      const d = M.decideMove(m, facts, now);
      if (d.action === 'wait') { await wait(m, d); continue; }
      if (d.action !== 'attempt') { await close(m, 'failed', d.code, d.reason); continue; }

      const tx = await yahoo(env, `/league/${m.league_key}/transactions`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: M.buildTransactionXml(m) });
      if (tx.ok) {
        const what = m.drop_player_key ? `Added ${m.add_player_name || 'the player'} and dropped ${m.drop_player_name || 'your player'}.` : `Added ${m.add_player_name || 'the player'}.`;
        await close(m, 'done', 'ok', what, { http_status: tx.status });
        await sdel(env, 'teams');
      } else if (M.isPermissionError(tx.status, tx.text)) {
        await sput(env, 'yahoo_scope', 'fspt-r');
        await wait(m, { code: 'no_write_access', reason: 'Yahoo refused the move: this login can only read. Connect Yahoo again once write access is on.' }, new Date(+now + 10 * 60e3));
      } else {
        await close(m, 'failed', 'yahoo_rejected', `Yahoo rejected the move: ${M.yahooErrorText(tx.text) || `HTTP ${tx.status}`}`, { http_status: tx.status, response: tx.text.slice(0, 2000) });
      }
      summary[d.action] = (summary[d.action] || 0) + 1;
    } catch (e) {
      summary.errors = (summary.errors || 0) + 1;
      await wait(m, { code: 'internal_error', reason: 'Temporary error. Will retry.' }).catch(() => {});
      console.error('move', m.id, e?.message || e);
    }
  }
  return summary;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/api/latest') {
      if (req.method === 'POST') {
        if (req.headers.get('x-board-key') !== env.WRITE_KEY) return json({ error: 'bad key' }, 403);
        const body = await req.text();
        if (body.length > 20e6 || !body.startsWith('{')) return json({ error: 'bad body' }, 400);
        await env.BOARD.put('latest', body);
        return json({ ok: true });
      }
      const v = await env.BOARD.get('latest', 'stream');
      return v ? new Response(v, { headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ error: 'none yet' }, 404);
    }

    if (url.pathname === '/api/proxy') {
      let target;
      try { target = new URL(url.searchParams.get('u')); } catch { return json({ error: 'bad url' }, 400); }
      if (target.protocol !== 'https:' || !ALLOW.has(target.hostname)) return json({ error: 'host not allowed' }, 403);
      const r = await fetch(target.toString(), { headers: { 'user-agent': UA, accept: '*/*' } });
      return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/api/yahoo') {
      const r = url.searchParams.get('r') || '';
      if (!/^\/(users;use_login=1\/games|league\/|team\/)/.test(r) || req.method !== 'GET') return json({ error: 'resource not allowed' }, 403);
      const res = await yahoo(env, r);
      if (res.loginError) return json({ error: res.loginError.error }, 503);
      return new Response(res.text, { status: res.status, headers: { ...CORS, 'content-type': 'application/json' } });
    }

    if (url.pathname.startsWith('/api/moves/')) {
      try { return await movesApi(req, env, url.pathname.slice('/api/moves/'.length)); }
      catch (e) { console.error('moves api', e?.message || e); return json({ error: 'Something went wrong. Try again.' }, 500); }
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMoves(env).then((s) => s.claimed && console.log('moves', JSON.stringify(s))));
  },
};
