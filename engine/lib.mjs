// Shared helpers: name/team matching and the lineup optimizer.
import fs from 'node:fs';
import path from 'node:path';

// trade market rules for one league ('points' | 'cats'): engine/trade-rules.json, with the never-drop list
// (moves/protected.json) added to `keep` so generated trade packages never include those players
export function tradeRules(root, league) {
  const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } };
  const r = read('engine/trade-rules.json')?.[league] || {};
  const prot = (read('moves/protected.json')?.players || []).map((p) => p.name);
  return { noGoalieReturns: !!r.noGoalieReturns, blocked: r.blocked || [], keep: [...new Set([...(r.keep || []), ...prot])], notes: r.notes || {} };
}

const YAHOO_TEAM = { TB: 'TBL', LA: 'LAK', NJ: 'NJD', SJ: 'SJS', WAS: 'WSH', MON: 'MTL', CLB: 'CBJ', ANH: 'ANA', VEG: 'VGK', ARI: 'UTA' };
export const nhlTeam = (t) => YAHOO_TEAM[(t || '').toUpperCase()] || (t || '').toUpperCase();

const NICK = {
  matt: 'matthew', mathew: 'matthew', mitch: 'mitchell', alex: 'alexander', alexandre: 'alexander', nick: 'nicholas',
  nicolas: 'nicholas', zach: 'zachary', josh: 'joshua', will: 'william', jake: 'jacob', cam: 'cameron', sam: 'samuel',
  max: 'maxime', mike: 'michael', dan: 'daniel', danny: 'daniel', tim: 'timothy', tom: 'thomas', chris: 'christopher',
  pat: 'patrick', joe: 'joseph', ben: 'benjamin', jt: 'jt', tj: 'tj', vince: 'vincent', fred: 'frederick', freddy: 'frederick',
};

export function normName(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}
const canonFirst = (n) => { const [f, ...rest] = normName(n).split(' '); return [NICK[f] || f, ...rest].join(' '); };
const lastName = (n) => normName(n).split(' ').slice(-1)[0];

// Index NHL players so Yahoo / projection names can be resolved to NHL playerIds.
export function buildMatcher(players) {
  const byName = new Map(), byCanon = new Map(), byLastTeam = new Map();
  const push = (m, k, p) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
  for (const p of players) {
    push(byName, normName(p.name), p);
    push(byCanon, canonFirst(p.name), p);
    push(byLastTeam, lastName(p.name) + '|' + p.team, p);
  }
  return function match(name, team) {
    team = nhlTeam(team);
    const pick = (list) => {
      if (!list || !list.length) return null;
      if (list.length === 1) return list[0];
      return list.find((p) => p.team === team) || list.find((p) => p.onRoster) || list[0];
    };
    return pick(byName.get(normName(name))) || pick(byCanon.get(canonFirst(name)))
      || (team ? pick(byLastTeam.get(lastName(name) + '|' + team)) : null);
  };
}

// Hungarian algorithm (min cost) on a square matrix. Returns assignment row -> col.
function hungarian(cost) {
  const n = cost.length, INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}

// Best lineup for one day. players: [{key, pos:[...], value}] (value = projected pts tonight).
// slots: ['C','C','LW',...]. Returns {total, starters: Map(key -> slot)}.
export function bestLineup(players, slots) {
  const n = Math.max(players.length, slots.length);
  if (!players.length) return { total: 0, starters: new Map() };
  const cost = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const p = players[i], s = slots[j];
      row.push(p && s && p.pos.includes(s) ? -p.value : 0);
    }
    cost.push(row);
  }
  const a = hungarian(cost);
  let total = 0; const starters = new Map();
  players.forEach((p, i) => {
    const s = slots[a[i]];
    if (s && p.pos.includes(s) && p.value > 0) { total += p.value; starters.set(p.key, s); }
  });
  return { total, starters };
}

export const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const fmtToi = (sec) => { if (sec == null) return null; const t = Math.round(sec); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// How each team is playing in front of its goalies, from goalie results by team: wins per start, goals
// against and shots against per start. The estimate is last season (each goalie's last team) pulled 40% to
// the league average, blended with this season counted as K games (team results show fast: 8 games = 29%).
// winDelta / gaF / saF = how far the estimate has moved from last season, applied to every goalie on the
// team, whose own projection is built from last season's numbers.
export function teamGoalieForm(goalies, PREV, CUR, K = 20) {
  const T = {}, add = (t, k, x) => { const r = (T[t] ||= { p: { GS: 0, W: 0, GA: 0, SA: 0 }, c: { GS: 0, W: 0, GA: 0, SA: 0 } }); for (const s of ['GS', 'W', 'GA', 'SA']) r[k][s] += x[s] || 0; };
  for (const g of goalies) {
    const pv = g.seasons?.[PREV]; if (pv?.totals?.GS) add((pv.teamAbbrevs || '').split(',').pop(), 'p', pv.totals);
    const c = g.seasons?.[CUR]; if (c?.totals?.GS && g.team) add(g.team, 'c', c.totals);
  }
  const L = Object.values(T).reduce((a, t) => { for (const s of ['GS', 'W', 'GA', 'SA']) a[s] += t.p[s]; return a; }, { GS: 0, W: 0, GA: 0, SA: 0 });
  const avg = { W: L.W / L.GS, GA: L.GA / L.GS, SA: L.SA / L.GS };
  const out = { _avg: avg };
  for (const [t, r] of Object.entries(T)) {
    const prior = Object.fromEntries(['W', 'GA', 'SA'].map((s) => [s, avg[s] + 0.6 * ((r.p.GS ? r.p[s] / r.p.GS : avg[s]) - avg[s])]));
    const w = r.c.GS / (r.c.GS + K);
    const est = Object.fromEntries(['W', 'GA', 'SA'].map((s) => [s, prior[s] * (1 - w) + (r.c.GS ? r.c[s] / r.c.GS : 0) * w]));
    out[t] = { prior, est, winDelta: est.W - prior.W, gaF: est.GA / prior.GA, saF: est.SA / prior.SA, wins: r.c.W, starts: r.c.GS };
  }
  return out;
}
