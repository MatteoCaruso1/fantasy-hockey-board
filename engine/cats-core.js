// Categories-league core: valuation, daily lineups, the weekly add/drop plan and the matchup by
// category. Plain JavaScript with no imports, so the same code runs when the board is built
// (engine/cats.mjs loads it) and in the page, where changing category priorities re-runs it.
const CatsCore = (() => {
  const CATS = [
    { k: 'G', label: 'Goals', short: 'G', grp: 'S' }, { k: 'A', label: 'Assists', short: 'A', grp: 'S' },
    { k: 'PPP', label: 'Power-play points', short: 'PPP', grp: 'S' }, { k: 'SOG', label: 'Shots', short: 'SOG', grp: 'S' },
    { k: 'HIT', label: 'Hits', short: 'HIT', grp: 'S' }, { k: 'BLK', label: 'Blocks', short: 'BLK', grp: 'S' },
    { k: 'W', label: 'Wins', short: 'W', grp: 'G' }, { k: 'GAA', label: 'Goals against avg', short: 'GAA', grp: 'G' },
    { k: 'SV', label: 'Saves', short: 'SV', grp: 'G' }, { k: 'SVP', label: 'Save %', short: 'SV%', grp: 'G' },
    { k: 'SO', label: 'Shutouts', short: 'SHO', grp: 'G' },
  ];
  const LEVEL = { priority: 2, normal: 1, punt: 0 };
  const weights = (prefs) => Object.fromEntries(CATS.map((c) => [c.k, LEVEL[prefs?.[c.k] || 'normal']]));

  // value of one game (skater) or one start (goalie) under the category weights, in "weekly
  // category" units: each category's contribution is standardized, so a full week of a lineup
  // is worth about 1 per category
  const perGame = (p, w) => CATS.reduce((a, c) => a + (w[c.k] || 0) * (p.contrib[c.k] || 0), 0);
  // long-term value per week: games he plays in a normal week (goalies: his share of starts)
  const perWeek = (p, w) => perGame(p, w) * (p.kind === 'G' ? 3.5 * (p.shareLong ?? p.share ?? 0) : 3.5 * (p.pPlayLong ?? 1));
  const zTotal = (p, w) => CATS.reduce((a, c) => a + (w[c.k] || 0) * (p.z[c.k] || 0), 0);
  const strengths = (p) => CATS.filter((c) => (p.z[c.k] ?? null) != null && (c.grp === 'G') === (p.kind === 'G'))
    .map((c) => ({ k: c.k, short: c.short, z: p.z[c.k] })).sort((a, b) => b.z - a.z);

  // replacement level per position: the 3rd-6th best healthy free agent (goalies only if they start 30%+).
  // Forwards share one level: your two Util slots take any forward, so a C and a winger are interchangeable.
  function replacement(D, w) {
    const lvl = (ok) => { const v = D.players.filter((p) => p.avail && p.healthyFrom < 7 && ok(p)).map((p) => perWeek(p, w)).sort((a, b) => b - a).slice(2, 6); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    const F = lvl((p) => ['C', 'LW', 'RW'].some((x) => p.pos.includes(x)));
    return { C: F, LW: F, RW: F, D: lvl((p) => p.pos.includes('D')), G: lvl((p) => p.pos.includes('G') && (p.shareLong ?? p.share) >= 0.3) };
  }

  // ---- assignment solver and best daily lineup ---------------------------------------------
  function hungarian(cost) {
    const n = cost.length, INF = 1e18;
    const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), pp = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      pp[0] = i; let j0 = 0;
      const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
      do {
        used[j0] = true; const i0 = pp[j0]; let delta = INF, j1 = 0;
        for (let j = 1; j <= n; j++) if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) if (used[j]) { u[pp[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        j0 = j1;
      } while (pp[j0] !== 0);
      do { const j1 = way[j0]; pp[j0] = pp[j1]; j0 = j1; } while (j0);
    }
    const ans = new Array(n).fill(-1);
    for (let j = 1; j <= n; j++) if (pp[j]) ans[pp[j] - 1] = j - 1;
    return ans;
  }
  function bestLineup(items, slots) {
    items = items.filter((x) => x.value > 0);
    if (!items.length) return { total: 0, gTotal: 0, starters: new Map() };
    const n = Math.max(items.length, slots.length), cost = [];
    for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < n; j++) { const p = items[i], s = slots[j]; row.push(p && s && p.pos.includes(s) ? -p.value : 0); } cost.push(row); }
    const a = hungarian(cost);
    let total = 0, gTotal = 0; const starters = new Map();
    items.forEach((p, i) => { const s = slots[a[i]]; if (s && p.pos.includes(s)) { total += p.value; if (s === 'G') gTotal += p.value; starters.set(p.key, s); } });
    return { total, gTotal, starters };
  }

  // ---- one night, one week ------------------------------------------------------------------
  const playing = (p, t) => t >= (p.healthyFrom ?? 0);
  const nightValue = (p, t, w) => {
    if (!playing(p, t)) return 0;
    if (p.kind === 'G') return (p.startProb?.[t] || 0) * perGame(p, w);
    return p.gameDays[t] ? perGame(p, w) * (p.pPlay ?? 1) : 0;
  };
  const nightLineup = (roster, t, w, slots) => bestLineup(roster.map((p) => ({ key: p.id, pos: p.pos, value: nightValue(p, t, w) })), slots);
  // chance of reaching the weekly goalie-appearance minimum, from the goalies actually slotted
  function pMin(starts, min) {
    let d = [1];
    for (const q of starts) { const nd = new Array(d.length + 1).fill(0); d.forEach((m, k) => { nd[k] += m * (1 - q); nd[k + 1] += m * q; }); d = nd; }
    return d.slice(min).reduce((a, b) => a + b, 0);
  }
  function evalWeek(D, rosterByDay, w, from = 0) {
    let sk = 0, gv = 0; const starts = [];
    const nights = [];
    for (let t = 0; t < D.days.length; t++) {
      const lu = nightLineup(rosterByDay[t], t, w, D.slots);
      nights.push(lu);
      if (t < from) continue;
      sk += lu.total - lu.gTotal; gv += lu.gTotal;
      for (const [id, s] of lu.starters) if (s === 'G') { const p = rosterByDay[t].find((x) => x.id === id); starts.push(p.startProb?.[t] || 0); }
    }
    const pm = pMin(starts, D.minG ?? 3);
    return { total: sk + gv * pm, sk, gv, pMin: pm, expStarts: starts.reduce((a, b) => a + b, 0), nights };
  }

  // a typical future week for a roster: best lineup on each of 14 sample nights where every team plays
  // half the time (a fixed pseudo-random schedule per team, so no team is favoured by this week's
  // calendar), everyone healthy at his long-run role and goalie share, scaled to 7 nights. Lineup-aware:
  // a 5th goalie or a skater who'd sit on your bench adds only the nights he'd actually fill.
  const SAMPLE_NIGHTS = 14;
  const plays = (team, k) => { let h = 2166136261; for (const ch of `${team}|${k}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) < 500; };
  function typicalWeek(D, roster, w) {
    let total = 0;
    for (let k = 0; k < SAMPLE_NIGHTS; k++) {
      total += bestLineup(roster.map((p) => ({ key: p.id, pos: p.pos, value: !plays(p.team, k) ? 0 : p.kind === 'G' ? (p.shareLong ?? p.share ?? 0) * perGame(p, w) : perGame(p, w) * (p.pPlayLong ?? 1) })), D.slots).total;
    }
    return (total * 7) / SAMPLE_NIGHTS;
  }

  // ---- the plan --------------------------------------------------------------------------------
  // Greedy: up to the adds left, each time the add/drop pair (and day) that gains the most this
  // week plus a discounted share of the rest of the season. Never drops a starter-level player.
  function plan(D, w, opts = {}) {
    const LONG_W = opts.longWeight ?? 0.35, MIN_GAIN = opts.minGain ?? 0.12;
    const all = D.players;
    const mine = all.filter((p) => p.mine && !p.ir);
    const avail = all.filter((p) => p.avail && playing(p, D.days.length - 1));
    // starter level in a league this size, by these weights
    const lv = (ps) => ps.map((p) => perWeek(p, w)).sort((a, b) => b - a);
    const skLine = lv(all.filter((p) => p.kind === 'S'))[D.teams * D.skaterSlots - 1] ?? 0;
    const gLine = lv(all.filter((p) => p.kind === 'G'))[D.teams * 2 - 1] ?? 0;
    const protectedP = (p) => perWeek(p, w) >= (p.kind === 'G' ? gLine : skLine);
    const from = D.firstDay || 0;
    let rbd = D.days.map(() => [...mine]);
    const startEval = evalWeek(D, rbd, w, from);
    let base = startEval;
    const moves = [], added = new Set(), dropped = new Set();
    const cand = [...avail.filter((p) => p.kind === 'S').sort((a, b) => perWeek(b, w) - perWeek(a, w)).slice(0, 36),
      ...avail.filter((p) => p.kind === 'G').sort((a, b) => b.startProb.reduce((s, x) => s + x, 0) * perGame(b, w) - a.startProb.reduce((s, x) => s + x, 0) * perGame(a, w)).slice(0, 8)];
    for (let k = 0; k < (D.addsLeft ?? 0); k++) {
      let best = null;
      const cur = rbd[rbd.length - 1];
      const baseNight = D.days.map((_, t) => nightLineup(rbd[t], t, w, D.slots).total);
      const baseLong = typicalWeek(D, cur, w);
      for (const add of cand) {
        if (added.has(add.id)) continue;
        const d0 = Math.max(from, add.waiverDay ?? 0);
        if (d0 >= D.days.length) continue;
        for (const drop of cur) {
          if (added.has(drop.id) || protectedP(drop) || (drop.kind === 'G') !== (add.kind === 'G') && drop.kind === 'G' && cur.filter((p) => p.kind === 'G').length <= 2) continue;
          // rest of season: how much a typical week of your lineup gains, × weeks left × LONG_W
          const longGain = (typicalWeek(D, cur.filter((p) => p !== drop).concat(add), w) - baseLong) * (D.weeksLeft || 20) * LONG_W;
          if (longGain < -0.6) continue;
          // gain per night if the swap is in place that night
          const dd = D.days.map((_, t) => (t < d0 ? 0 : nightLineup(rbd[t].filter((p) => p !== drop).concat(add), t, w, D.slots).total - baseNight[t]));
          let bestDay = d0, bestSum = -Infinity;
          for (let d = d0; d < D.days.length; d++) { const s = dd.slice(d).reduce((a, b) => a + b, 0); if (s > bestSum + 1e-9) { bestSum = s; bestDay = d; } }
          // goalie for goalie: start shares are guesses, so only a clear edge is worth an add
          // (+5/wk on the board every week after, or +10 this week, e.g. a stream for the start minimum)
          if (add.kind === 'G' && drop.kind === 'G' && longGain / ((D.weeksLeft || 20) * LONG_W) < (opts.goalieMargin ?? 0.5) && bestSum < 1) continue;
          const approx = bestSum + longGain;
          if (!best || approx > best.approx) best = { add, drop, day: bestDay, approx, longGain };
        }
      }
      if (!best) break;
      const next = rbd.map((r, t) => (t >= best.day ? r.filter((p) => p !== best.drop).concat(best.add) : r));
      const after = evalWeek(D, next, w, from);
      const weekGain = after.total - base.total;
      const net = weekGain + best.longGain;
      if (net < MIN_GAIN) break;
      moves.push({ addId: best.add.id, dropId: best.drop.id, day: best.day, weekGain, longGain: best.longGain, longPerWeek: best.longGain / ((D.weeksLeft || 20) * LONG_W), net, pMinBefore: base.pMin, pMinAfter: after.pMin });
      added.add(best.add.id); dropped.add(best.drop.id);
      rbd = next; base = after;
    }
    return { moves, before: startEval, after: base, rosterByDay: rbd, skLine, gLine };
  }

  // ---- matchup by category ----------------------------------------------------------------------
  // expected weekly totals from each side's best nightly lineup; ratio categories from totals
  function matchup(D, rosterByDay, oppRoster, w) {
    const tot = (rbd) => {
      const s = { G: 0, A: 0, PPP: 0, SOG: 0, HIT: 0, BLK: 0, W: 0, GA: 0, SV: 0, SA: 0, SO: 0, starts: 0 };
      for (let t = 0; t < D.days.length; t++) {
        const lu = nightLineup(rbd[t], t, w, D.slots);
        for (const [id, slot] of lu.starters) {
          const p = rbd[t].find((x) => x.id === id);
          if (slot === 'G') { const q = p.startProb?.[t] || 0; s.starts += q; for (const k of ['W', 'GA', 'SV', 'SA', 'SO']) s[k] += q * (p.rate[k] || 0); }
          else for (const k of ['G', 'A', 'PPP', 'SOG', 'HIT', 'BLK']) s[k] += (p.pPlay ?? 1) * (p.rate[k] || 0);
        }
      }
      s.GAA = s.starts ? s.GA / s.starts : null; s.SVP = s.SA ? s.SV / s.SA : null;
      return s;
    };
    const a = tot(rosterByDay), b = tot(D.days.map(() => oppRoster));
    const phi = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));
    const rows = CATS.map((c) => {
      const x = a[c.k], y = b[c.k];
      let pw = 0.5;
      if (x != null && y != null) {
        if (c.k === 'GAA') pw = phi((y - x) / Math.hypot(1.5 / Math.sqrt(Math.max(a.starts, 1)), 1.5 / Math.sqrt(Math.max(b.starts, 1))));
        else if (c.k === 'SVP') pw = phi((x - y) / Math.hypot(0.045 / Math.sqrt(Math.max(a.starts, 1)), 0.045 / Math.sqrt(Math.max(b.starts, 1))));
        else pw = phi((x - y) / (1.3 * Math.sqrt(Math.max(x + y, 1))));
      }
      return { k: c.k, short: c.short, mine: x, opp: y, pWin: pw };
    });
    return { rows, mine: a, opp: b, expCats: rows.reduce((s, r) => s + r.pWin, 0) };
  }

  return { CATS, weights, replacement, perGame, perWeek, zTotal, strengths, bestLineup, evalWeek, plan, matchup };
})();
