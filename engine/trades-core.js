// Trade market for either league. Plain JavaScript with no imports (like cats-core.js), so the page
// and engine/trades.mjs run the same code.
// A player is worth what he adds over the wire at his position (value minus replacement level), so a
// goalie you could pick up for free is worth nothing in a trade however good his raw numbers look.
//   const T = TradesCore.build({ players, slots, me, teamNames, repl, catsOf? })
//   players: [{ id, name, team, pos: ['C','LW',...], owner (fantasy team id or null), value, market, injured, back }]
//            value = your projection; market = what other managers see (defaults to value)
//   slots:   starting slots, e.g. ['C','C','LW','LW','RW','RW','D','D','D','Util','Util','G','G']
//   repl:    { C, LW, RW, D, G } replacement value; catsOf(p) -> { G: .., HIT: .. } weekly category totals
//   rules:   { blocked: [team names that won't trade with you], keep: [your player names never offered in
//            generated packages] } (engine/trade-rules.json); rosterSize: active roster (starters + bench)
const TradesCore = (() => {
  const POS = ['C', 'LW', 'RW', 'D', 'G'];
  const FULL = { C: 'C', LW: 'LW', RW: 'RW', D: 'D', G: 'G' };
  // how managers price age in a trade: up-and-coming players carry a premium, veterans a discount
  const AGE_MKT = (a) => (a <= 21 ? 1.25 : a <= 23 ? 1.12 : a <= 32 ? 1 : a <= 34 ? 0.9 : 0.8);
  const ord = (k) => k + (k % 10 === 1 && k !== 11 ? 'st' : k % 10 === 2 && k !== 12 ? 'nd' : k % 10 === 3 && k !== 13 ? 'rd' : 'th');

  function build(M) {
    const vor = (p) => Math.max(...p.pos.filter((x) => POS.includes(x)).map((x) => p.value - (M.repl[x] ?? 0)));
    // the market's value over the wire. With Yahoo ranks (pre = Pre-Season rank: name value, pedigree,
    // draft hype; cur = Current rank: this season's production) a rank is worth what the player at that
    // place in your own ordering of rostered players is worth. Pedigree (preseason rank, roughly draft
    // position) carries the market early: a hot start buys credibility slowly, so the current rank counts
    // a quarter after 7 games and half after 20 (gp / (gp + 20)). Yahoo shows rank 1 for players who haven't played:
    // ignored. Age moves it the way managers do: young players with pedigree carry a premium, veterans
    // a discount (AGE_MKT). Without ranks: the market field (reputation + pace) or your value.
    // Forwards, defensemen and goalies are laddered separately: Yahoo's overall rank orders them on its own
    // scale, so a defenseman's rank among rostered D maps onto your D values (managers price "a top-5 D", and
    // Yahoo's default ranks undersell D in a points league; else a categories league, where goalies top your
    // values, would price every top-15 skater like a goalie)
    const kindOf = (p) => (p.pos.includes('G') ? 'G' : p.pos.includes('D') ? 'D' : 'F');
    const curOk = (p) => (p.cur && !(p.cur === 1 && p.pre > 5) && !p.injured ? p.cur : null);
    // buy low: off to a slow start against expectations, so his owner is frustrated and the price is down.
    // Yahoo's current rank at least double his preseason rank and 50+ places worse, after 3+ games
    const slump = (p) => { const c = curOk(p); return p.pre && c && (p.gp || 0) >= 3 && c >= 2 * p.pre && c - p.pre >= 50 ? { pre: p.pre, cur: c } : null; };
    const ladder = {}, preOrd = new Map(), curOrd = new Map();
    for (const k of ['F', 'D', 'G']) {
      const ps = M.players.filter((p) => p.owner && kindOf(p) === k);
      ladder[k] = ps.map(vor).sort((a, b) => b - a);
      const ord = (rankOf, out) => {
        const rs = ps.filter(rankOf).sort((a, b) => rankOf(a) - rankOf(b));
        rs.forEach((p, i) => out.set(p, ((i + 0.5) * ps.length) / rs.length)); // scaled to the full ladder
      };
      ord((p) => p.pre, preOrd);
      ord(curOk, curOrd);
    }
    const vorAt = (k, r) => ladder[k][Math.min(Math.max(1, Math.round(r)), ladder[k].length) - 1] ?? 0;
    const mvorCache = new Map();
    const mvor = (p) => {
      if (mvorCache.has(p)) return mvorCache.get(p);
      let v;
      if (p.pre && preOrd.has(p)) {
        const k = kindOf(p), cur = curOrd.get(p);
        const w = cur ? (p.gp || 0) / ((p.gp || 0) + (M.marketGames ?? 20)) : 0;
        v = (1 - w) * vorAt(k, preOrd.get(p)) + w * (cur ? vorAt(k, cur) : 0);
      } else v = vor(p) + ((p.market ?? p.value) - p.value);
      if (v > 0 && p.age) v *= AGE_MKT(p.age);
      mvorCache.set(p, v);
      return v;
    };
    const name = (t) => M.teamNames?.[t] || `Team ${t}`;
    const order = [...M.slots].sort((a, b) => (a === 'Util') - (b === 'Util')); // fixed positions before Util

    // best lineup: each slot gets the most valuable healthy player who fits; an empty slot is a wire
    // player at replacement level (adds 0). total = value over replacement of the starters.
    // val: score players by another value (the market's, for how the other manager sees his lineup)
    function lineup(roster, val) {
      const v = val || vor;
      const pool = roster.filter((p) => !p.injured).sort((a, b) => v(b) - v(a));
      const used = new Set(), byPos = Object.fromEntries(POS.map((x) => [x, []]));
      let total = 0;
      for (const s of order) {
        const p = pool.find((q) => !used.has(q) && (s === 'Util' ? !q.pos.includes('G') : q.pos.includes(s)));
        if (!p) continue;
        used.add(p);
        total += Math.max(0, val ? val(p) : s === 'Util' ? vor(p) : p.value - (M.repl[s] ?? 0));
        if (s !== 'Util') byPos[s].push(p);
      }
      return { total, byPos, starters: used, bench: pool.filter((p) => !used.has(p) && v(p) > 0) };
    }

    const rosters = {};
    for (const p of M.players) if (p.owner) (rosters[p.owner] ||= []).push(p);
    const ids = Object.keys(rosters).map(Number).sort((a, b) => a - b);
    const n = ids.length;
    const LU = Object.fromEntries(ids.map((t) => [t, lineup(rosters[t])]));
    const startVals = ids.flatMap((t) => [...LU[t].starters].map(vor));
    const starterScale = startVals.length ? startVals.reduce((a, b) => a + Math.max(0, b), 0) / startVals.length : 1;
    const strength = (t, pos) => LU[t].byPos[pos].reduce((a, p) => a + Math.max(0, p.value - (M.repl[pos] ?? 0)), 0);
    const rank = {};
    for (const pos of POS) [...ids].sort((a, b) => strength(b, pos) - strength(a, pos)).forEach((t, i) => { (rank[t] ||= {})[pos] = i + 1; });

    // How other managers see their own depth: a player is a real starter to his manager when Yahoo ranks him
    // inside the league's starting pool, this season or preseason (the better of the two: a slow-starting
    // name still counts to his owner). Cut = 65% of the league's skater starting slots (points league: 91),
    // so a team with three pure centers in Yahoo's top 90 has a spare and won't take a fourth however low your
    // sheet rates them. Dual-position players count part to each position. depth >= slots + 1 = spare (can
    // trade one), about = slots = thin (every one starts), below = short (needs one).
    const rules = M.rules || {};
    const blockedSet = new Set((rules.blocked || []).map((x) => String(x).toLowerCase()));
    const blocked = (t) => blockedSet.has(String(t)) || blockedSet.has(name(t).toLowerCase());
    const slotsAt = Object.fromEntries(POS.map((x) => [x, M.slots.filter((s) => s === x).length]));
    const CUT = M.startCut ?? n * M.slots.filter((s) => s !== 'G').length;
    const yRank = (p) => { const r = [p.pre, curOk(p)].filter((x) => x > 0); return r.length ? Math.min(...r) : Infinity; };
    const legit = (p) => !p.injured && yRank(p) <= CUT;
    const depth = (roster, x) => roster.filter((p) => legit(p) && p.pos.includes(x)).reduce((a, p) => a + 1 / p.pos.filter((y) => POS.includes(y)).length, 0);
    const level = (roster, x) => { const d = depth(roster, x); return d < slotsAt[x] - 0.25 ? 'short' : d < slotsAt[x] + 0.75 ? 'thin' : 'spare'; };
    const half = (d) => (Math.round(d * 2) / 2).toString().replace('.5', '½').replace(/^0½/, '½');
    const depthText = (t, x) => `${level(rosters[t], x)} at ${FULL[x]} (${half(depth(rosters[t], x))} in Yahoo's top ${CUT})`;
    // name value in a trade: managers pay up for big names beyond what they produce (preseason top 10 / 25 / 50)
    const STAR = (p) => (!p.pre ? 1 : p.pre <= 10 ? 1.35 : p.pre <= 25 ? 1.2 : p.pre <= 50 ? 1.1 : 1);
    const nameVal = (p) => Math.max(0, mvor(p)) * STAR(p);
    const LUm = Object.fromEntries(ids.map((t) => [t, lineup(rosters[t], nameVal)]));
    // what a trade looks like from their side, judged the way managers judge: by name value and their own lineup.
    //   - package: the best piece they get at full value, every other piece at a third (they have to cut someone
    //     for it, and two quarters aren't a dollar), so a 2-for-1 for a star needs a near-star in it
    //   - need: does what they get START for them, and was that position short, thin, or already covered
    //   - spare: what they give sits on their bench / has a real backup behind him
    //   - their lineup: if it gets worse by their own rankings, they say no however much "value" they get
    // likely (0-1) = need x spare x value x lineup; a team on the blocked list is 0
    function theirView(t, giveList, getList) {
      const after = lineup(rosters[t].filter((p) => !getList.includes(p)).concat(giveList), nameVal);
      const lineupGain = after.total - LUm[t].total;
      const vals = giveList.map(nameVal).sort((a, b) => b - a);
      const pkg = (vals[0] || 0) + 0.35 * vals.slice(1).reduce((a, b) => a + b, 0);
      const out = getList.reduce((a, p) => a + nameVal(p), 0);
      const ratio = pkg / Math.max(0.01, out);
      const best = Math.max(0, ...getList.map(nameVal));
      const bestRatio = (vals[0] || 0) / Math.max(0.01, best);
      const reasons = [];
      let needF = 0.08;
      for (const p of giveList) {
        if (!after.starters.has(p)) { reasons.push(`${p.name} wouldn't start for them${p.injured ? ' (hurt)' : ''}`); continue; }
        const x = POS.find((y) => after.byPos[y].includes(p)) || p.pos.find((y) => POS.includes(y));
        const lv = level(rosters[t], x), f = lv === 'short' ? 1 : lv === 'thin' ? 0.65 : 0.2;
        needF = Math.max(needF, f);
        reasons.push(lv === 'spare' ? `${p.name} would start, but they're already ${depthText(t, x)}` : `${p.name} fills a need: ${depthText(t, x)}`);
      }
      let spareF = 1;
      for (const g of getList) {
        if (g.injured) { spareF = Math.min(spareF, 0.8); reasons.push(`${g.name} is hurt: easier to pry loose`); continue; }
        if (!LUm[t].starters.has(g)) { reasons.push(`${g.name} sits on their bench`); continue; }
        const x = POS.find((y) => LUm[t].byPos[y].includes(g)) || g.pos.find((y) => POS.includes(y));
        const lv = level(rosters[t], x);
        spareF = Math.min(spareF, lv === 'spare' ? 1 : lv === 'thin' ? 0.7 : 0.5);
        reasons.push(lv === 'spare' ? `they can spare ${g.name}: ${depthText(t, x)}` : `${g.name} is a starter they can't replace: ${depthText(t, x)}`);
      }
      const valueF = Math.min(1, Math.max(0, 0.5 + 1.5 * (ratio - 1))) * (bestRatio < 0.7 ? 0.35 : 1);
      // a lineup that gets worse by their own rankings is close to a dealbreaker: losing a fifth of his value
      // in lineup strength takes them to the floor (15%)
      const lineupF = lineupGain >= 0 ? 1 : Math.min(1, Math.max(0.15, 1 + lineupGain / Math.max(0.01, 0.3 * out)));
      if (lineupGain < -0.05 * starterScale) reasons.push('their lineup gets worse by their own rankings');
      if (bestRatio < 0.7) reasons.push(`no piece close to ${getList.map((g) => g.name).join(' + ')}'s name value`);
      const likely = blocked(t) ? 0 : Math.min(0.95, needF * spareF * valueF * lineupF);
      return { them: pkg - out, pkg, out, ratio, lineupGain, likely, reasons, needF, spareF, valueF, lineupF };
    }

    // labels: "weak on RW (10th of 14)", "strong on goalies (2nd of 14)"; a team's holes are its bottom
    // third at a position, its strengths the top quarter. A trade partner only needs to be in the
    // bottom half at the position you're offering (see shop).
    const posText = (t, pos) => `${rank[t][pos] > n / 2 ? 'weak' : 'strong'} at ${FULL[pos]} (${ord(rank[t][pos])} of ${n})`;
    function posLabel(t, pos) {
      const r = rank[t][pos];
      if (r > n * 0.66) return { pos, r, weak: true, text: posText(t, pos) };
      if (r <= Math.max(2, n * 0.25)) return { pos, r, weak: false, text: posText(t, pos) };
      return null;
    }
    // categories league: each team's rank in each category, from its starting lineup's weekly totals
    const catRank = {};
    if (M.catsOf) {
      const tot = Object.fromEntries(ids.map((t) => { const s = {}; for (const p of LU[t].starters) for (const [k, v] of Object.entries(M.catsOf(p))) s[k] = (s[k] || 0) + v; return [t, s]; }));
      for (const k of Object.keys(tot[ids[0]] || {})) {
        [...ids].sort((a, b) => (k === 'GAA' ? tot[a][k] - tot[b][k] : tot[b][k] - tot[a][k])).forEach((t, i) => { (catRank[t] ||= {})[k] = i + 1; });
      }
    }
    // the trade a team is most open to, in one line: "Swap top D (Makar) for a top LW/RW". What they'd give:
    // their best bench player, else the weakest starter where they're deepest. What they'd want: their
    // weakest positions. Tier by value over the wire against a typical starter.
    const tier = (p, starting) => {
      if (p.pos.includes('G') && !starting) return 'backup';
      const r = vor(p) / starterScale;
      return r >= 1.6 ? 'elite' : r >= 1 ? 'top' : r >= 0.5 ? 'mid' : 'depth';
    };
    function openTo(t) {
      const lu = LU[t];
      const dep = (x) => depth(rosters[t], x) - slotsAt[x];
      let give = lu.bench.find((p) => !p.injured), gpos;
      if (give) gpos = give.pos.filter((x) => POS.includes(x)).sort((a, b) => dep(b) - dep(a))[0];
      else {
        gpos = POS.filter((x) => level(rosters[t], x) === 'spare' && lu.byPos[x].length).sort((a, b) => dep(b) - dep(a))[0];
        if (gpos) give = [...lu.byPos[gpos]].sort((a, b) => vor(a) - vor(b))[0];
      }
      // M.rankNeeds (points league): short form "D (Makar) for LW", wanting the positions where their starters
      // rank worst of the league (the same ranks as their holes), else their worst position if bottom half; never
      // a position their manager sees as covered (spare by Yahoo's ranks: Misfit Army's three top-90 centers)
      if (M.rankNeeds) {
        const cand = POS.filter((x) => x !== gpos && level(rosters[t], x) !== 'spare');
        const weak = cand.filter((x) => rank[t][x] > n * 0.66).sort((a, b) => rank[t][b] - rank[t][a]);
        const worst = cand.sort((a, b) => rank[t][b] - rank[t][a])[0];
        const want = (weak.length ? weak : rank[t][worst] > n / 2 ? [worst] : []).slice(0, 2).join(' or ');
        const what = give ? `${gpos} (${give.name})` : '';
        if (!give && !want) return 'No clear need or surplus';
        if (!give) return `Needs ${want}, little to spare`;
        if (!want) return `Has ${what} to spare`;
        return `${what} for ${want}`;
      }
      const holes = POS.filter((x) => level(rosters[t], x) === 'short' && x !== gpos).sort((a, b) => dep(a) - dep(b));
      const fw = holes.filter((x) => ['C', 'LW', 'RW'].includes(x));
      const want = fw.length === 3 ? ['F', ...holes.filter((x) => !fw.includes(x))] : holes;
      const need = want.slice(0, 2).join(' or ').replace(/^(C|LW|RW) or (C|LW|RW)$/, '$1/$2');
      if (!give && !need) return 'No clear need or surplus';
      if (!give) return `Buyer: needs ${need}, little to spare`;
      const tw = tier(give, lu.starters.has(give));
      const what = `${tw} ${gpos} (${give.name})`;
      if (!need) return `Seller: ${what}, no clear need`;
      return `Swap ${what} for ${tw === 'backup' || tw === 'depth' ? 'depth' : tw === 'elite' ? 'an elite' : 'a ' + tw} ${need}`;
    }
    // biggest over- and underperformer on a team: this season's points per game (act) against what he was
    // expected to score before it (exp), each as a percentile among rostered players of his kind (forwards,
    // D, goalies apart) with enough games. Over: now in the top 40% and above his expected place, and expected
    // to be at least a decent rostered player (no bum having an okay run). Under: expected top 40%, healthy,
    // now below his expected place. The biggest gap wins; a team with nobody who qualifies shows none.
    const pctOf = (() => {
      const ok = (p) => p.exp != null && p.act != null && (p.gp || 0) >= (p.pos.includes('G') ? 4 : 5);
      const out = new Map();
      for (const k of ['F', 'D', 'G']) {
        const ps = M.players.filter((p) => p.owner && kindOf(p) === k && ok(p));
        const pct = (key) => { const s = ps.map((p) => p[key]).sort((a, b) => a - b); return (v) => s.filter((x) => x < v).length / Math.max(1, s.length - 1); };
        const e = pct('exp'), a = pct('act');
        for (const p of ps) out.set(p, { exp: e(p.exp), act: a(p.act) });
      }
      return out;
    })();
    function performers(t) {
      const ps = rosters[t].filter((p) => pctOf.has(p)).map((p) => ({ p, ...pctOf.get(p) }));
      const over = ps.filter((x) => x.act >= 0.6 && x.exp >= 0.3 && x.act - x.exp >= 0.1 && x.p.act > x.p.exp)
        .sort((a, b) => b.act - b.exp - (a.act - a.exp))[0];
      const under = ps.filter((x) => !x.p.injured && x.exp >= 0.6 && x.exp - x.act >= 0.1 && x.p.act < x.p.exp)
        .sort((a, b) => b.exp - b.act - (a.exp - a.act))[0];
      return { over: over?.p ?? null, under: under?.p ?? null };
    }
    // Season outlook (M.standings, both leagues): team strength = best lineup's value over the wire, half the
    // healthy lineup and half with everyone back. Each remaining regular-season week is a coin weighted by the
    // strength gap to an average opponent (weekly score gap sd about 60 points); projected finish = wins so
    // far plus expected wins, then strength. The verdict is one deliberately harsh line, built for screenshots.
    const outlook = (() => {
      if (!M.standings) return null;
      // categories league (M.catsPerWeek): the record counts categories, and a value gap of 10 is about one
      // category of weekly margin, so each week a team wins half the categories plus 0.05 per point of gap
      const S = M.standings, C = M.catsPerWeek, GPW = C ? 1 : 3.5, SD = 60;
      const phi = (z) => 1 / (1 + Math.exp(-1.702 * z)); // normal CDF, close enough
      const str = Object.fromEntries(ids.map((t) => [t, GPW * (0.5 * LU[t].total + 0.5 * lineup(rosters[t].map((p) => ({ ...p, injured: false }))).total)]));
      const sRank = Object.fromEntries([...ids].sort((a, b) => str[b] - str[a]).map((t, i) => [t, i + 1]));
      const exp = {};
      for (const t of ids) {
        const s = S[t] || { w: 0, l: 0, t: 0 }, played = (s.w + s.l + s.t) / (C || 1), rem = Math.max(0, (M.regularWeeks || 22) - played);
        const share = (o) => (C ? Math.min(0.85, Math.max(0.15, 0.5 + (0.05 * (str[t] - str[o])) / C)) : phi((str[t] - str[o]) / SD));
        const p = ids.filter((o) => o !== t).reduce((a, o) => a + share(o), 0) / Math.max(1, n - 1);
        exp[t] = s.w + 0.5 * s.t + rem * (C || 1) * p;
      }
      const fRank = Object.fromEntries([...ids].sort((a, b) => exp[b] - exp[a] || str[b] - str[a]).map((t, i) => [t, i + 1]));
      const paRank = Object.fromEntries([...ids].sort((a, b) => (S[b]?.pa || 0) - (S[a]?.pa || 0)).map((t, i) => [t, i + 1]));
      return { str, sRank, exp, fRank, paRank };
    })();
    // One harsh line per team, built for screenshots. Each situation (tier) has a pool of lines; the league's
    // teams are visited in projected order and each takes the first line of its pool, rotated by M.seed (the
    // refresh date), that no other team in the league has used, so lines change every refresh and never repeat
    // within a league. With M.prevFinish (last refresh's projected finishes) a move of 3+ places gets a
    // rising/sliding line instead. A line needing a detail the team lacks (a hole, a hot player) is skipped.
    const QUIPS = {
      rising: [
        (x) => `Climbing: ${x.P} last time, ${x.F} now. The model is cautiously impressed.`,
        (x) => `Up from ${x.P} to ${x.F}. Somebody's been working the waiver wire.`,
        (x) => `${x.P} to ${x.F}: the hottest stock in the league, which isn't saying much.`,
        (x) => `The model moved them from ${x.P} to ${x.F}. Don't get used to it.`,
        (x) => x.hole && `Rising fast (${x.P} to ${x.F}); fix ${x.hole} and it gets interesting.`,
        (x) => `From ${x.P} to ${x.F}. Even the model didn't see that coming.`,
      ],
      falling: [
        (x) => `Sliding: ${x.P} last time, ${x.F} now. The model noticed.`,
        (x) => `From ${x.P} to ${x.F} in one refresh. Whatever they're doing, stop.`,
        (x) => `${x.P} to ${x.F}. The wheels aren't off yet, but they're wobbling.`,
        (x) => x.hole && `Down to ${x.F} from ${x.P}, with ${x.hole} dragging them there.`,
        (x) => `The model had them ${x.P}. Now ${x.F}. That's the wrong direction.`,
        (x) => `${x.P} last time, ${x.F} now. The vibes are leaving the building.`,
      ],
      elite: [
        (x) => `Legit, unfortunately: the model has them finishing ${x.F}${x.hole ? ` and can only complain about ${x.hole}` : ' and has nothing mean to say'}.`,
        (x) => `The model hates to say it, but ${x.F} looks real${x.hole ? `, ${x.hole} and all` : ''}.`,
        (x) => `Projected ${x.F}. Everyone else is playing for the other playoff spots.`,
        (x) => x.top && `${x.F} and deserved: the scariest lineup in the model's numbers, starting with ${x.top}.`,
        (x) => `No notes, just ${x.F}. The model looked for a weakness and found ${x.hole || 'nothing worth mocking'}.`,
        (x) => `Projected ${x.F}, which is bad news for the other ${x.n - 1} teams.`,
      ],
      mirage: [
        (x) => `That ${x.rec} is a mirage: the model has them finishing ${x.F}${x.ov ? ` once ${x.last(x.ov)} stops scoring like a star` : ' once the easy schedule runs out'}.`,
        (x) => `${x.rec} and feeling good? The model says ${x.F}. Enjoy it while it lasts.`,
        (x) => `Currently ${x.C}, projected ${x.F}: the regression is coming, it's just running late.`,
        (x) => `The standings say ${x.C}. The model says ${x.F} and is not taking questions.`,
        (x) => x.ov && `Built on ${x.last(x.ov)}'s hot streak and vibes: ${x.C} now, ${x.F} by the end.`,
        (x) => `A ${x.rec} start with a ${x.F}-place roster. Someone should tell them.`,
      ],
      last: [
        (x) => `Dead last (${x.F} of ${x.n}). The model ran it twice to be sure${x.un ? `, and ${x.last(x.un)} at ${x.un.act.toFixed(1)}/gm isn't helping` : ''}.`,
        (x) => `Projected ${x.F} of ${x.n}. At least the draft pick will be fun.`,
        (x) => `${x.F} of ${x.n}: the model's numbers for this roster look like a typo, but they aren't.`,
        (x) => `The basement has a tenant (${x.F} of ${x.n})${x.hole ? `, with ${x.hole} as the welcome mat` : ''}.`,
        (x) => `Projected ${x.F} of ${x.n}. The model looked for a bright side and gave up${x.top ? ` after ${x.top}` : ''}.`,
        (x) => `Last place (${x.F} of ${x.n}) is only a projection, but it feels earned.`,
      ],
      secondLast: [
        (x) => `Projected ${x.F} of ${x.n}: the only thing between them and last place is a team that's even worse${x.hole ? `, and ${x.hole} is why` : ''}.`,
        (x) => `${x.F} of ${x.n}. Not last, which is the only good news here.`,
        (x) => `Projected ${x.F}: one bad week away from the basement${x.hole ? `, thanks to ${x.hole}` : ''}.`,
        (x) => `The model has them ${x.F} of ${x.n}, and that's with generous rounding.`,
        (x) => `${x.F} of ${x.n}. Their best trade target is a time machine.`,
      ],
      unlucky: [
        (x) => `Better than ${x.rec}${x.pa}, but the model's best case is ${x.F}: not good, just less sad.`,
        (x) => `${x.rec} undersells them a bit. The model says ${x.F}, which is still nothing to brag about.`,
        (x) => `Unlucky so far at ${x.rec}. A climb to ${x.F} is coming, if anyone's still watching.`,
        (x) => `The model sees the ${x.S}-best lineup stuck at ${x.rec}. Projected ${x.F}: a rescue, not a revival.`,
        (x) => `Things should get better than ${x.rec}. ${x.F} better, apparently.`,
      ],
      playoff: [
        (x) => `A playoff team on paper (${x.F}), held together by ${x.top || 'vibes'} and prayers${x.hole ? ` at ${x.hole}` : ''}.`,
        (x) => `Projected ${x.F}: in the playoffs, out in the first round${x.hole ? `, and ${x.hole} is why` : ''}.`,
        (x) => `${x.F} and safely in, which says more about the league than about them.`,
        (x) => x.top && `Playoff-bound at ${x.F}, mostly thanks to ${x.top}${x.hole ? `. ${x.hole} is a problem for March` : ''}.`,
        (x) => `The model has them ${x.F}: good enough to make it, not good enough to scare anyone.`,
        (x) => x.hole && `Projected ${x.F}. A real team with a ${x.hole} problem, which in this league counts as a contender.`,
        (x) => `${x.F} projected. Solid, unspectacular, and one injury from the bubble.`,
      ],
      bottom: [
        (x) => `Projected ${x.F}. Not the worst team in the league, which is the nicest thing the model can say${x.hole ? ` with ${x.hole} in the lineup` : ''}.`,
        (x) => `${x.F} projected, and the model is being polite.`,
        (x) => `Projected ${x.F}: too good to tank, too bad to matter.`,
        (x) => `${x.F}. The model checked twice and the vibes did not improve${x.hole ? `; neither did ${x.hole}` : ''}.`,
        (x) => x.hole && `Projected ${x.F}, with ${x.hole} doing the heavy lifting in the wrong direction.`,
        (x) => `${x.F} and fading. The playoffs are a rumour from here.`,
      ],
      middle: [
        (x) => x.hole && `Projected ${x.F}: a team that technically exists, with ${x.hole} doing most of the damage.`,
        (x) => x.ov && `Projected ${x.F}, and the whole season rides on ${x.last(x.ov)} keeping up ${x.ov.act.toFixed(1)}/gm. He won't.`,
        (x) => x.un && `Projected ${x.F}, and ${x.last(x.un)} scoring ${x.un.act.toFixed(1)}/gm instead of ${x.un.exp.toFixed(1)} is the reason why.`,
        (x) => `Aggressively average: projected ${x.F}, and nobody in the model's numbers is scared of them.`,
        (x) => `${x.F} projected: the bubble, where good intentions go to die.`,
        (x) => `Projected ${x.F}. One good trade away from relevance, and they won't make it.`,
        (x) => `The model has them ${x.F}: not bad enough to pity, not good enough to fear.`,
        (x) => `${x.F}, give or take, on the bubble${x.top ? ` despite ${x.top}` : ''}.`,
      ],
    };
    const usedQuips = new Set();
    const verdictCache = new Map();
    function verdict(t, holes, strengths, perf) {
      if (verdictCache.has(t)) return verdictCache.get(t);
      const O = outlook, s = M.standings[t] || { w: 0, l: 0, t: 0, rank: n }, f = O.fRank[t], c = s.rank || n;
      const prev = M.prevFinish?.[t], moved = prev ? prev - f : 0;
      const x = {
        n, F: ord(f), C: ord(c), S: ord(O.sRank[t]), P: prev ? ord(prev) : null,
        rec: `${s.w}-${s.l}${s.t ? '-' + s.t : ''}`,
        pa: O.paRank[t] <= 4 && s.pa ? ` (${ord(O.paRank[t])}-most points against)` : ' on paper',
        hole: holes[0] ? `${FULL[holes[0].pos]} (${ord(holes[0].r)} of ${n})` : null,
        top: strengths[0] ? `${FULL[strengths[0].pos]} (${ord(strengths[0].r)} of ${n})` : null,
        ov: perf.over, un: perf.under, last: (p) => p.name.split(' ').slice(1).join(' ') || p.name,
      };
      const tier = moved >= 3 ? 'rising' : moved <= -3 ? 'falling' : f <= 2 ? 'elite' : c <= 5 && f >= c + 4 ? 'mirage' : f === n ? 'last'
        : f === n - 1 ? 'secondLast' : c >= n - 4 && O.sRank[t] <= c - 5 ? 'unlucky' : f <= 6 ? 'playoff' : f >= n - 3 ? 'bottom' : 'middle';
      const pool = QUIPS[tier], start = Math.abs(Math.round(M.seed || 0)) % pool.length;
      let v = null, fallback = null;
      for (let i = 0; i < pool.length && !v; i++) {
        const k = `${tier}${(start + i) % pool.length}`, line = pool[(start + i) % pool.length](x);
        if (!line) continue;
        fallback ||= line;
        if (!usedQuips.has(k)) { v = line; usedQuips.add(k); }
      }
      v ||= fallback || `Projected ${x.F}.`;
      verdictCache.set(t, v);
      return v;
    }
    function profile(t) {
      // your team: strength ranks by your values. Everyone else: depth the way their manager sees it, or with
      // M.rankNeeds (team table built for screenshots) the same ranks out of every team as yours
      const labels = t === M.me || M.rankNeeds ? POS.map((pos) => posLabel(t, pos)).filter(Boolean)
        : POS.map((pos) => { const lv = level(rosters[t], pos); return lv === 'thin' ? null : { pos, weak: lv === 'short', text: depthText(t, pos) }; }).filter(Boolean);
      const cr = Object.entries(catRank[t] || {});
      const holes = labels.filter((l) => l.weak).sort((a, b) => (b.r ?? 0) - (a.r ?? 0)), strengths = labels.filter((l) => !l.weak).sort((a, b) => (a.r ?? 0) - (b.r ?? 0));
      const perf = performers(t), st = M.standings?.[t];
      return {
        id: t, name: name(t), total: LU[t].total, openTo: blocked(t) ? "Won't trade with you" : openTo(t), blocked: blocked(t),
        holes, strengths, bench: LU[t].bench.slice(0, 3), ...perf,
        outlook: outlook ? { strength: outlook.sRank[t], finish: outlook.fRank[t], now: st?.rank ?? null, record: st ? `${st.w}-${st.l}${st.t ? '-' + st.t : ''}` : null, verdict: verdict(t, holes, strengths, perf) } : null,
        catsWeak: cr.filter(([, r]) => r >= n - 1).sort((a, b) => b[1] - a[1]).map(([k, r]) => `${ord(r)} in ${k}`),
        catsStrong: cr.filter(([, r]) => r <= 2).sort((a, b) => a[1] - b[1]).map(([k, r]) => `${ord(r)} in ${k}`),
      };
    }

    // the trade market for the player(s) you give. Two values per player: yours (value: your sheet and
    // his current role, not hot or cold results) and the market's (mvor: Yahoo ranks and age). A return
    // is listed when
    //   - you get the better player by YOUR values (gain >= 0), or a slightly worse one (flagged) who
    //     improves your lineup at a position where you're in the bottom half, and
    //   - the other team gets at least about as much MARKET value as it gives up (so they'd say yes),
    //   - and the trade answers a need of theirs (see reasons).
    // Hot starts on your side buy more; cold starts on theirs come cheap. At most two per team, the
    // biggest gains (player value + lineup change) first. "them" = market value they gain.
    // a goalie you'd acquire counts at M.goalieTradeDiscount of his value (points league: goalies are volatile,
    // so a top skater for a top goalie needs a big edge)
    const tradeVal = (g) => vor(g) * (g.pos.includes('G') && M.goalieTradeDiscount ? M.goalieTradeDiscount : 1);
    // the same caution on what he adds to your lineup
    const goalieLineupCut = (g, afterLU) => (g.pos.includes('G') && M.goalieTradeDiscount && afterLU.starters.has(g) ? (1 - M.goalieTradeDiscount) * Math.max(0, g.value - (M.repl.G ?? 0)) : 0);
    // one trade, any players: what it does for you (player value, best lineup) and for them (market value, their lineup)
    function evalSwap(giveIds, getId) {
      const give = M.players.filter((p) => giveIds.includes(p.id)), g = M.players.find((p) => p.id === getId);
      if (!give.length || !g) return null;
      const mine = rosters[M.me] || [], t = g.owner;
      const after = lineup(mine.filter((p) => !give.includes(p)).concat(g));
      const you = after.total - lineup(mine).total - goalieLineupCut(g, after);
      const gain = tradeVal(g) - give.reduce((a, p) => a + Math.max(0, vor(p)), 0);
      // their side the way the shop judges it (theirView): fair = at least a 15% chance they say yes
      const tv = t ? theirView(t, give, [g]) : null;
      return { gain, you, them: tv ? tv.them : 0, theirLineup: tv ? tv.lineupGain : 0, likely: tv ? tv.likely : 0, reasons: tv ? tv.reasons : [], blocked: t ? blocked(t) : false, fair: !!tv && tv.likely >= 0.15, goalieDiscount: g.pos.includes('G') && M.goalieTradeDiscount ? M.goalieTradeDiscount : null };
    }
    // how open an owner is to moving one of his players: deep at his position or he's on their bench = open;
    // short at it and losing him costs their lineup most of his value = hesitant
    function sellerFit(p) {
      const t = p.owner, lu = LU[t];
      const pos = p.pos.filter((x) => POS.includes(x));
      const at = pos.find((x) => lu.byPos[x].includes(p)) || pos.sort((a, b) => rank[t][a] - rank[t][b])[0];
      const lv = level(rosters[t], at);
      const weakest = POS.filter((x) => level(rosters[t], x) === 'short').slice(0, 2).map((x) => depthText(t, x));
      let fit, why;
      if (!lu.starters.has(p)) { fit = 'open'; why = 'he sits on their bench'; }
      else if (lv === 'spare') { fit = 'open'; why = `can spare him: ${depthText(t, at)}`; }
      else if (lv === 'short') { fit = 'hesitant'; why = `won't want to lose one: ${depthText(t, at)}`; }
      else { fit = 'neutral'; why = `every one starts: ${depthText(t, at)}`; }
      return { fit, why, weakest };
    }

    function shop(giveIds, opts = {}) {
      const give = M.players.filter((p) => giveIds.includes(p.id));
      if (!give.length) return [];
      let mine = rosters[M.me] || [];
      if (opts.addIds?.length) {
        const adds = M.players.filter((p) => opts.addIds.includes(p.id));
        const drops = mine.filter((p) => !p.injured && !give.includes(p)).sort((a, b) => vor(a) - vor(b)).slice(0, adds.length);
        mine = mine.filter((p) => !drops.includes(p)).concat(adds);
      }
      const baseLU = lineup(mine), base = baseLU.total;
      const want = (opts.for || []).flatMap((x) => (x === 'F' ? ['C', 'LW', 'RW'] : [x]));
      const givePos = [...new Set(give.flatMap((p) => p.pos.filter((x) => POS.includes(x))))];
      const giveMkt = give.reduce((a, p) => a + Math.max(0, mvor(p)), 0);
      if (giveMkt <= 0) return [];
      const giveMine = give.reduce((a, p) => a + Math.max(0, vor(p)), 0);
      const slight = Math.max(0.1 * giveMine, 0.15 * starterScale);
      const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
      // why giving him up is fine for you (the same for every return)
      const giveWhy = [];
      for (const p of give) {
        if (heat(p) === 'hot') giveWhy.push(give.length > 1 ? `sell high on ${p.name}` : 'sell high');
        if (!baseLU.starters.has(p) && !p.injured) giveWhy.push(give.length > 1 ? `${p.name} is on your bench` : 'on your bench');
      }
      for (const x of givePos) if (rank[M.me][x] <= n / 3) giveWhy.push(`you're ${posText(M.me, x)}`);
      const rows = [];
      // their side: theirView. Quick cut first: a package worth under two thirds of his name value never flies
      const giveVals = give.map(nameVal).sort((a, b) => b - a);
      const pkgMax = giveVals[0] + 0.35 * giveVals.slice(1).reduce((a, b) => a + b, 0);
      for (const t of ids.filter((x) => x !== M.me && !blocked(x))) {
        for (const g of rosters[t]) {
          if (want.length && !g.pos.some((x) => want.includes(x))) continue;
          // The owner almost never trades for a goalie (too risky, replaceable): only when asked with --for G
          if (rules.noGoalieReturns && !want.includes('G') && g.pos.includes('G')) continue;
          if (pkgMax < 0.67 * nameVal(g)) continue;
          const tv = theirView(t, give, [g]);
          if (tv.likely < (opts.minLikely ?? 0.08)) continue;
          const them = tv.them;
          const afterLU = lineup(mine.filter((p) => !give.includes(p)).concat(g));
          const you = afterLU.total - base - goalieLineupCut(g, afterLU);
          const gp = g.pos.filter((x) => POS.includes(x));
          // winning = you get the better player by your values. A slightly worse player only when he
          // improves your lineup at a position where you're weak; a better player who doesn't fit your
          // lineup right now (it dips) is flagged too
          const fills = gp.filter((x) => rank[M.me][x] > n / 2);
          const pv = tradeVal(g) - giveMine;
          let flag = null;
          if (pv < 0 && opts.lineupOnly) {
            // 2-for-1 (consolidate): the second player you send is one you'd cut when the injured come back, so
            // your side is judged by your lineup, not by adding up both players' values
            if (you < 0.1 * starterScale) continue;
          } else if (pv < 0) {
            if (pv < -slight || you <= 0.02 || !fills.length) continue;
            flag = { text: `Slight loss, but fills your ${fills.map((x) => posText(M.me, x)).join(', ')}` };
          } else if (you < -0.02) {
            if (you < -slight) continue;
            flag = { text: `Better player, but your lineup dips: he doesn't fit it yet` };
          }
          // why they'd talk (or balk): what starts for them, whether they can spare him, their lineup
          const reasons = tv.reasons;
          // why it works for you: who covers the spot he leaves, and what the new player adds
          const stepIn = [...afterLU.starters].filter((p) => p !== g && !baseLU.starters.has(p));
          const forYou = {
            giveWhy, // the same for every return: shown once above the list
            stepIn: stepIn.slice(0, 2).map((p) => p.name),
            pv, fills: you > 0.02 ? fills.map((x) => `fills your ${posText(M.me, x)}`) : [],
            starts: afterLU.starters.has(g),
            goalieDiscount: g.pos.includes('G') && M.goalieTradeDiscount ? M.goalieTradeDiscount : null,
          };
          // how likely they are to deal (0-1): theirView; a slumping player's owner is a little easier to deal with
          const buyLow = slump(g);
          const likely = Math.min(0.95, tv.likely * (buyLow ? 1.2 : 1));
          // how much it wins for you, in typical starters: mostly the lineup change, since a better player
          // who wouldn't start for you only adds depth
          const win = clamp((you + 0.3 * pv) / starterScale, -0.5, 1.5);
          const score = likely + 0.6 * win - (flag ? 0.4 : 0);
          rows.push({ team: t, teamName: name(t), player: g, gain: pv, you, them, flag, reasons, forYou, likely, win, score, hype: hype(g), buyLow });
        }
      }
      // ranked by potential: how likely they are to say yes, plus how much it wins for you; flagged trades drop
      rows.sort((a, b) => b.score - a.score);
      const per = {};
      return opts.all ? rows : rows.filter((r) => (per[r.team] = (per[r.team] || 0) + 1) <= 2);
    }

    // the league's biggest buy lows: players on other teams that your model ranks in the top `top`, whose
    // Yahoo current rank sits furthest below that. Ranks are compared on one scale: skaters against rostered
    // skaters and goalies against rostered goalies (as in the market value), stretched to the whole league
    // so "your #40" and "Yahoo #300" read like Yahoo's overall ranks.
    function buyLows(top = 170, limit = 15) {
      const ros = M.players.filter((p) => p.owner);
      const nAll = ros.length, out = [];
      for (const k of ['F', 'D', 'G']) {
        const ps = ros.filter((p) => kindOf(p) === k);
        const scale = nAll / Math.max(1, ps.length);
        const mine = [...ps].sort((a, b) => vor(b) - vor(a));
        const curs = ps.filter(curOk).sort((a, b) => curOk(a) - curOk(b));
        const curRank = new Map(curs.map((p, i) => [p, Math.round((i + 1) * scale)]));
        mine.forEach((p, i) => {
          const yourRank = Math.round((i + 1) * scale);
          if (p.owner === M.me || blocked(p.owner) || yourRank > top || p.injured || (p.gp || 0) < 3 || !curRank.has(p)) return;
          const gap = curRank.get(p) - yourRank;
          if (gap > 0) out.push({ p, team: p.owner, teamName: name(p.owner), yourRank, curRank: curRank.get(p), yahooCur: p.cur, yahooPre: p.pre, gap });
        });
      }
      // biggest buy lows whose owner is most open first; small ones the owner won't want to move last
      const MULT = { open: 1.3, neutral: 1, hesitant: 0.6 };
      const list = out.sort((a, b) => b.gap - a.gap).slice(0, limit);
      for (const b of list) { Object.assign(b, sellerFit(b.p)); b.score = b.gap * MULT[b.fit]; }
      list.sort((a, b) => b.score - a.score);
      // what to offer: your players whose fair 1-for-1 returns (shop) include him, best for you first
      const offers = new Map();
      for (const q of (rosters[M.me] || []).filter((x) => !x.injured)) {
        for (const r of shop([q.id], { all: true })) {
          if (!list.some((b) => b.p === r.player)) continue;
          (offers.get(r.player) || offers.set(r.player, []).get(r.player)).push({ p: q, gain: r.gain, you: r.you, flag: r.flag });
        }
      }
      for (const b of list) b.offers = (offers.get(b.p) || []).sort((x, y) => !!x.flag - !!y.flag || y.gain + y.you - (x.gain + x.you)).slice(0, 3);
      return list;
    }

    // 2-for-1 consolidation: every pair of your skaters (never the rules.keep list; goalies only with
    // opts.skaters === false) shopped for one better player. A 2-for-1
    // frees a roster spot, so when injured players come back you cut one fewer: `cutBefore` / `cutAfter` =
    // who you'd have to cut once everyone listed with a return date is healthy (lowest value first).
    // Rows: { give: [p, q], player, team, teamName, likely, you, gain, them, reasons, forYou, score, cutBefore, cutAfter }
    function consolidate(opts = {}) {
      const keep = new Set((rules.keep || []).map((x) => x.toLowerCase()));
      const mine = rosters[M.me] || [];
      const pool = mine.filter((p) => !keep.has(p.name.toLowerCase()) && (!p.injured || p.back) && vor(p) > 0 && !(opts.skaters !== false && p.pos.includes('G')));
      const size = M.rosterSize ?? M.slots.length + 4, gNeed = M.slots.filter((s) => s === 'G').length;
      // when everyone with a return date is back: the roster that fits (keep list and the best goalies kept,
      // then the most valuable) and who gets cut; the lineup is judged both now and with everyone back
      const back = (roster) => roster.filter((p) => !p.injured || p.back).map((p) => (p.injured ? { ...p, injured: false, _orig: p } : p));
      const orig = (p) => p._orig || p;
      function fit(roster) {
        const r = back(roster);
        const gs = r.filter((p) => p.pos.includes('G')).sort((a, b) => vor(b) - vor(a)).slice(0, gNeed);
        const first = r.filter((p) => gs.includes(p) || keep.has(p.name.toLowerCase()));
        const rest = r.filter((p) => !first.includes(p)).sort((a, b) => vor(b) - vor(a));
        const kept = first.concat(rest).slice(0, size);
        return { kept, cut: r.filter((p) => !kept.includes(p)).map(orig) };
      }
      const before = fit(mine), fullBase = lineup(before.kept).total;
      const cutBefore = before.cut;
      const out = [];
      for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
        const pair = [pool[i], pool[j]];
        for (const r of shop(pair.map((p) => p.id), { all: true, for: opts.for, lineupOnly: true })) {
          if (r.flag && r.you <= 0) continue;
          if (r.likely < (opts.minLikely ?? 0.1)) continue;
          const after = fit(mine.filter((p) => !pair.includes(p)).concat(r.player));
          const youFull = lineup(after.kept).total - fullBase;
          if (Math.max(r.you, youFull) < 0.1 * starterScale) continue; // a consolidation must upgrade your lineup
          // value kept: players you no longer have to cut (bench depth and injury cover, at a third)
          const saved = cutBefore.filter((p) => !after.cut.includes(p) && !pair.includes(p)).reduce((a, p) => a + Math.max(0, vor(p)), 0);
          const win = Math.min(1.5, Math.max(-0.5, (0.5 * r.you + 0.5 * youFull + 0.3 * r.gain + 0.33 * saved) / starterScale));
          // ranked by expected gain: chance they say yes x what it wins you (a long shot with a big win drops)
          out.push({ ...r, give: pair, cutBefore, cutAfter: after.cut, youFull, saved, score: r.likely * (0.3 + win) });
        }
      }
      out.sort((a, b) => b.score - a.score);
      // at most one row per target player and two per team, so the list shows different options
      const seenP = new Set(), perT = {};
      return out.filter((r) => !seenP.has(r.player.id) && (perT[r.team] = (perT[r.team] || 0) + 1) <= 2 && seenP.add(r.player.id)).slice(0, opts.limit ?? 12);
    }

    // how far the market's value sits from yours (+: others rate him higher, sell high; -: lower, buy low)
    function hype(p) { return mvor(p) - vor(p); }

    // your trade chips: sell-high players (the market rates them well above your value), then healthy players better than the wire who don't start for you, then the lowest-value
    // starter at each position where you're among the league's strongest
    function chips() {
      const me = LU[M.me];
      if (!me) return [];
      const out = (rosters[M.me] || []).filter((p) => !p.injured && vor(p) > 0 && hype(p) >= 0.1 * starterScale).sort((a, b) => hype(b) - hype(a))
        .map((p) => ({ p, why: 'sell high: the market rates him above you', sellHigh: true }));
      for (const p of me.bench) if (!out.some((c) => c.p === p)) out.push({ p, why: 'on your bench' });
      for (const pos of ['C', 'LW', 'RW', 'D']) {
        const l = posLabel(M.me, pos);
        if (l && !l.weak && me.byPos[pos].length) {
          const p = [...me.byPos[pos]].sort((a, b) => vor(a) - vor(b))[0];
          if (!out.some((c) => c.p === p)) out.push({ p, why: `you're ${l.text}` });
        }
      }
      return out;
    }

    // "hot" (sell high): the market rates him a tenth of a typical starter (and 5% of his value) above you;
    // "cold" (trading sells low): a tenth of a starter and 20% of his value below you, so a star the
    // market merely rates a little lower isn't called a sell-low
    const heat = (p) => {
      const h = hype(p), v = Math.abs(vor(p));
      return h >= Math.max(0.1 * starterScale, 0.05 * v) ? 'hot' : h <= -Math.max(0.1 * starterScale, 0.2 * v) ? 'cold' : null;
    };
    if (outlook) [...ids].sort((a, b) => outlook.fRank[a] - outlook.fRank[b]).forEach(profile); // verdicts rotate in projected order
    return { vor, mvor, nameVal, hype, heat, slump, buyLows, evalSwap, sellerFit, lineup, ids, n, me: M.me, rosters, profile, rankNeeds: !!M.rankNeeds, shop, consolidate, theirView, depth, level, blocked, rules, cut: CUT, chips, name, repl: M.repl, scale: starterScale };
  }
  return { build, POS };
})();
if (typeof module !== 'undefined') module.exports = TradesCore;
