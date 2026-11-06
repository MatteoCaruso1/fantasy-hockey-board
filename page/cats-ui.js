// Categories League tab (head-to-head categories). Uses CatsCore (engine/cats-core.js) on the CATS data,
// so changing category priorities re-ranks the wire and re-plans the week right here in the page.
window.CATS_DATA = /*__CATS__*/null;
/*__CATSCORE__*/
// (re)build the tab from a categories data set: on load, and again after a Refresh
window.initCats = (CATS) => {
  if (!CATS) { window.renderCats = null; return; }
  const root = document.getElementById('app-cats');
  const D = CATS.core, byId = new Map(D.players.map((p) => [p.id, p]));
  const disp = (id) => CATS.display[id] || {};
  const CL = CatsCore.CATS, SKC = CL.filter((c) => c.grp === 'S'), GC = CL.filter((c) => c.grp === 'G');
  const V = (x) => x * 10; // value units: 10 = one category's typical weekly spread between teams
  const fmtV = (x) => (x >= 0 ? '+' : '−') + Math.abs(V(x)).toFixed(1);
  const pc = (x) => Math.round(x * 100) + '%';
  const KEY = 'lol-cat-priorities';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { prefs = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window */ } };
  let posFilter = 'all';
  let S = null;

  function compute() {
    const w = CatsCore.weights(prefs);
    const pl = CatsCore.plan(D, w);
    const opp = D.players.filter((p) => p.opp && !p.injured);
    const mineNow = D.players.filter((p) => p.mine && !p.ir);
    const mu0 = CatsCore.matchup(D, D.days.map(() => mineNow), opp, w);
    const mu1 = CatsCore.matchup(D, pl.rosterByDay, opp, w);
    const repl = CatsCore.replacement(D, w);
    const vor = (p) => Math.max(...p.pos.filter((x) => x !== 'Util').map((pos) => CatsCore.perWeek(p, w) - (repl[pos] ?? 0)));
    // trade market at the same weights: every rostered player, valued over the wire
    let T = null;
    if (typeof TradesCore !== 'undefined' && CATS.teamNames) {
      const weekly = (p) => (p.kind === 'G' ? 3.5 * (p.shareLong ?? p.share ?? 0) : 3.5 * (p.pPlayLong ?? 1));
      T = TradesCore.build({
        me: CATS.team.id, slots: CATS.league.slots, teamNames: CATS.teamNames, repl, rules: CATS.tradeRules, rosterSize: CATS.rosterSize,
        rankNeeds: !!CATS.standings, standings: CATS.standings, regularWeeks: CATS.regularWeeks, catsPerWeek: CL.length, prevFinish: CATS.prevFinish, seed: CATS.seed,
        players: D.players.filter((p) => p.mine || p.rosteredBy).map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos.filter((x) => x !== 'Util'), owner: p.mine ? CATS.team.id : p.rosteredBy, value: CatsCore.perWeek(p, w), age: p.age ?? null, pre: p.pre, cur: p.cur, gp: p.gp, injured: !!(p.injured || p.ir), back: p.back || null, src: p })),
        catsOf: (q) => Object.fromEntries(CL.map((c) => [c.short, (q.src.contrib[c.k] || 0) * weekly(q.src)])),
      });
    }
    S = { w, pl, mu0, mu1, repl, vor, T };
  }

  // this week's closest races (40-60% either way), at most four, closest first
  const swingCats = () => S.mu0.rows.filter((r) => r.pWin >= 0.4 && r.pWin <= 0.6).sort((a, b) => Math.abs(a.pWin - 0.5) - Math.abs(b.pWin - 0.5)).slice(0, 4).map((r) => r.k);
  // ---- small pieces --------------------------------------------------------------------------
  const heat = (z) => { if (z == null) return ''; const a = Math.min(1, Math.abs(z) / 2.2); return `background:color-mix(in srgb, ${z >= 0 ? 'var(--good)' : 'var(--red)'} ${Math.round(a * 45)}%, transparent)`; };
  const zCell = (p, c) => { const z = p.z?.[c.k]; return `<td class="n zc" style="${heat(z)}">${z == null ? '' : (z > 0 ? '+' : '') + z.toFixed(1)}</td>`; };
  function strengthChips(p, max = 3) {
    const s = CatsCore.strengths(p).filter((x) => x.z >= 0.75).slice(0, max);
    return s.map((x) => `<span class="chip ${S.w[x.k] === 2 ? 'i-up' : 'i-flat'}">${x.short} ${x.z > 0 ? '+' : ''}${x.z.toFixed(1)}</span>`).join('');
  }
  function catComment(p) {
    const s = CatsCore.strengths(p);
    const elite = s.filter((x) => x.z >= 1.5).map((x) => x.short), strong = s.filter((x) => x.z >= 0.75 && x.z < 1.5).map((x) => x.short);
    const weak = s.filter((x) => x.z <= -0.75).map((x) => x.short);
    const bits = [];
    if (elite.length) bits.push(`elite in ${elite.join(', ')}`);
    if (strong.length) bits.push(`strong in ${strong.join(', ')}`);
    if (weak.length) bits.push(`a drag on ${weak.join(', ')}`);
    if (!bits.length) bits.push(p.kind === 'G' ? 'around average in every goalie category' : 'no category far from average');
    const pri = s.filter((x) => S.w[x.k] === 2 && x.z >= 0.75).map((x) => x.short);
    const txt = bits.join('; ');
    return txt.charAt(0).toUpperCase() + txt.slice(1) + (pri.length ? `. Helps your priorities: ${pri.join(', ')}.` : '.');
  }
  const meta = (p) => [p.team, p.pos.filter((x) => x !== 'Util').join('/'), p.kind === 'G' ? `${Math.round((p.shareLong ?? p.share ?? 0) * 100)}% of starts` : null, disp(p.id).toi ? disp(p.id).toi + ' TOI' : null, p.age ? 'age ' + p.age : null].filter(Boolean).join(' · ');
  const games = (p) => (p.kind === 'G' ? `${(p.startProb || []).slice(D.firstDay || 0).reduce((a, b) => a + b, 0).toFixed(1)} exp. starts` : `${p.gameDays.slice(D.firstDay || 0).filter((g, i) => g && i + (D.firstDay || 0) >= (p.healthyFrom || 0)).length} games left`);
  const injChip = (p) => (p.injured ? `<span class="chip inj">${p.back ? 'Out to ~' + short(p.back) : 'Injured'}</span>` : '');
  const waiverChip = (p) => (p.waiverDay != null && p.waiverDay > (D.firstDay || 0) ? `<span class="chip w">Waivers: FAB bid, clears ${D.days[p.waiverDay] ? short(D.days[p.waiverDay]) : 'next week'}</span>` : '');

  const unitEx = () => { const sp = CATS.spread || {}; return [['G', 'goals'], ['SOG', 'shots'], ['HIT', 'hits'], ['SV', 'saves']].filter(([k]) => sp[k]).map(([k, l]) => `${sp[k] >= 10 ? Math.round(sp[k]) : sp[k].toFixed(1)} ${l}`).join(', '); };
  // ---- sections ------------------------------------------------------------------------------
  function head() {
    const t = CATS.team, o = t.opponent;
    return `<header>
      <div><div class="eyebrow">${esc(CATS.league.name)} · Week ${o?.week ?? ''} · head-to-head categories</div>
        <h1>${esc(t.name)} weekly board</h1>
        <p class="sub">${dayName(CATS.week.start)} to ${dayName(CATS.week.end)}${o ? ` vs <b>${esc(o.name)}</b>` : ''}</p>
        <p class="sub">Yahoo rosters read ${new Date(CATS.yahooRead).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}. ${D.addsLeft} of ${CATS.league.maxAdds} adds left this week.</p></div>
      <div class="board" aria-label="Expected categories">
        <div><span class="eyebrow">Cats won, as is</span><b>${S.mu0.expCats.toFixed(1)}</b><span class="bsub">of ${CL.length}</span></div>
        <div><span class="eyebrow">With moves</span><b class="up">${S.mu1.expCats.toFixed(1)}</b><span class="bsub">${S.pl.moves.length} move${S.pl.moves.length === 1 ? '' : 's'}</span></div>
        <div><span class="eyebrow">Goalie min</span><b>${pc(S.pl.after.pMin)}</b><span class="bsub">${S.pl.after.expStarts.toFixed(1)} exp. starts</span></div>
      </div></header>`;
  }
  function priorities() {
    const swing = swingCats();
    const st = (k) => prefs[k] || 'normal';
    const lab = { normal: '', priority: '★ ', punt: '✕ ' };
    return `<section class="decide">
      <div class="eyebrow">Category priorities</div>
      <p class="small" style="margin:4px 0 8px">Tap to cycle: normal → ★ priority (×2) → ✕ punt.</p>
      <div class="filters" role="group" aria-label="Category priorities">${CL.map((c) => `<button type="button" data-cat="${c.k}" aria-pressed="${st(c.k) !== 'normal'}" class="cat-${st(c.k)}" title="${esc(c.label)}">${lab[st(c.k)]}${c.short}</button>`).join('')}</div>
      <div class="filters" style="margin-top:8px">${swing.length ? `<button type="button" data-catset="swing">Prioritize this week's swing categories (${swing.map((k) => CL.find((c) => c.k === k).short).join(', ')})</button>` : ''}<button type="button" data-catset="reset">Reset all to normal</button></div>
    </section>`;
  }
  function movesSec() {
    const ms = S.pl.moves;
    const head = `<div class="sec-head"><h2>This week's moves</h2><span class="count">${ms.length} of ${D.addsLeft} adds left</span></div><p class="unit">Value: 10 = one category's typical weekly gap between two teams (≈${unitEx()}). Each move: what it adds to your lineup this week, and every week after.</p>`;
    if (!ms.length) return `<section>${head}<p class="muted">Hold your adds: no add/drop clears the bar with these priorities.</p></section>`;
    return `<section>${head}${D.firstDay ? `<p class="small muted">Moves start ${CATS.week.labels[D.firstDay]}.</p>` : ''}<div class="moves">${ms.map((m) => {
      const a = byId.get(m.addId), d = byId.get(m.dropId);
      return `<div class="move">
        <div class="when">${CATS.week.labels[m.day]}<small>${short(D.days[m.day])}</small></div>
        <div class="swap">
          <div><span class="tag add">Add</span><div class="pname">${esc(a.name)}</div><div class="pmeta">${esc(meta(a))} · ${games(a)}</div><div class="itags">${strengthChips(a)}${waiverChip(a)}</div>${intelTags(disp(a.id).intel, 3)}<ul class="why"><li>${esc(catComment(a))}</li>${(disp(a.id).notes || []).slice(0, 2).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
          <div><span class="tag drop">Drop</span><div class="pname">${esc(d.name)}</div><div class="pmeta">${esc(meta(d))} · ${games(d)}</div><div class="itags">${strengthChips(d)}</div><ul class="why"><li>${esc(catComment(d))}</li></ul></div>
        </div>
        <div class="gain"><b>${fmtV(m.longPerWeek)}/wk</b><span>every week after</span><b class="g2">${fmtV(m.weekGain)}</b><span>this week</span>${m.pMinAfter - m.pMinBefore >= 0.02 ? `<span>Goalie minimum ${pc(m.pMinBefore)} → ${pc(m.pMinAfter)}</span>` : ''}</div>
      </div>`;
    }).join('')}</div></section>`;
  }
  function matchupSec() {
    const r0 = S.mu0.rows, r1 = S.mu1.rows;
    const f = (k, v) => (v == null ? '–' : k === 'SVP' ? v.toFixed(3).replace(/^0/, '') : k === 'GAA' ? v.toFixed(2) : v.toFixed(1));
    return `<section>
      <div class="sec-head"><h2>Matchup by category</h2><span class="count">vs ${esc(CATS.team.opponent?.name || '')}</span></div><p class="unit">Expected weekly totals as your roster stands; win chance = odds you take the category.</p>
      <div class="scroll"><table class="mini">
        <thead><tr><th>Category</th><th class="n">You</th><th class="n">${esc(CATS.team.opponent?.name || 'Opponent')}</th><th class="n">Win chance</th></tr></thead>
        <tbody>${r1.map((r, i) => `<tr><td>${esc(CL[i].label)}${S.w[r.k] === 2 ? ' <span class="chip i-up">priority</span>' : S.w[r.k] === 0 ? ' <span class="chip">punted</span>' : ''}</td><td class="n">${f(r.k, r0[i].mine)}</td><td class="n">${f(r.k, r.opp)}</td><td class="n" style="${heat((r0[i].pWin - 0.5) * 4)}"><b>${pc(r0[i].pWin)}</b></td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  }
  function holdsSec() {
    const inPlan = new Map(S.pl.moves.map((m) => [m.addId, CATS.week.labels[m.day]]));
    const list = D.players.filter((p) => p.avail && (p.healthyFrom < 7 || (p.back && (new Date(p.back) - new Date(CATS.today)) / 864e5 <= 21)) && (p.kind === 'S' || (p.shareLong ?? p.share ?? 0) >= 0.35))
      .filter((p) => posFilter === 'all' || (posFilter === 'f' && p.kind === 'S' && !p.pos.includes('D')) || (posFilter === 'd' && p.pos.includes('D')) || (posFilter === 'g' && p.kind === 'G'))
      .sort((a, b) => S.vor(b) - S.vor(a)).slice(0, 14);
    const opts = [['all', 'All'], ['f', 'Forwards'], ['d', 'Defense'], ['g', 'Goalies']];
    return `<section>
      <div class="sec-head"><h2>Long-term holds on the wire</h2><span class="count">by your category priorities</span></div><p class="unit">+x/wk = value per week over the 3rd–6th best free agent at his position. Value: 10 = one category's typical weekly gap between two teams (≈${unitEx()}).</p>
      <div class="filters" role="group" aria-label="Filter holds">${opts.map(([k, l]) => `<button type="button" data-cpos="${k}" aria-pressed="${k === posFilter}">${l}</button>`).join('')}</div>
      <div class="sleepers">${list.map((p, i) => {
        const it = disp(p.id).intel;
        return `<article class="sl${i >= 4 ? ' extra' : ''}">
          <div class="sl-top"><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${esc(meta(p))}</div>${inPlan.has(p.id) ? `<div class="badges"><span class="chip w">In this week's plan: add ${esc(inPlan.get(p.id))}</span></div>` : ''}</div>
            <div class="score">${fmtV(S.vor(p))}<small>over the wire / wk</small></div></div>
          <div class="itags">${strengthChips(p, 4)}${injChip(p)}${waiverChip(p)}</div>
          <ul><li>${esc(catComment(p))}</li>${(disp(p.id).notes || []).slice(0, 2).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
          ${intelTags(it)}${rwNote(it)}
        </article>`;
      }).join('') || '<p class="muted">Nobody on the wire matches this filter.</p>'}</div>
      ${list.length > 4 ? `<button type="button" class="m-only more-btn" data-ctoggle="show-extra">Show all ${list.length}</button>` : ''}
    </section>`;
  }
  function rosterSec() {
    const ms = D.players.filter((p) => p.mine);
    const dropIds = new Set(S.pl.moves.map((m) => m.dropId));
    const order = (p) => (p.ir ? 2 : 0) + (p.kind === 'G' ? 1 : 0);
    const row = (p, cats) => `<tr class="${p.ir ? 'muted' : ''}"><td><b>${esc(p.name)}</b>${dropIds.has(p.id) ? ' <span class="tag drop">Drop</span>' : ''}<div class="pmeta">${esc(p.slot || '')} · ${esc(meta(p))}</div>${injChip(p)}${intelTags(disp(p.id).intel, 3)}</td><td class="n">${fmtV(S.vor(p))}</td>${cats.map((c) => zCell(p, c)).join('')}</tr>`;
    const sk = ms.filter((p) => p.kind === 'S').sort((a, b) => order(a) - order(b) || S.vor(b) - S.vor(a));
    const gs = ms.filter((p) => p.kind === 'G').sort((a, b) => order(a) - order(b) || S.vor(b) - S.vor(a));
    return `<section>
      <div class="sec-head"><h2>Your roster by category</h2><span class="count">value/wk and category scores</span></div><p class="unit">Value/wk: over the wire; 10 = one category's weekly gap between two teams. Category score: per-game strength vs the player pool on your CATS sheet; ±1 strong/weak, ±2 elite.</p>
      <div class="scroll"><table class="mini cz"><thead><tr><th>Skater</th><th class="n">Value/wk</th>${SKC.map((c) => `<th class="n">${c.short}</th>`).join('')}</tr></thead><tbody>${sk.map((p) => row(p, SKC)).join('')}</tbody></table></div>
      <div class="scroll"><table class="mini cz"><thead><tr><th>Goalie</th><th class="n">Value/wk</th>${GC.map((c) => `<th class="n">${c.short}</th>`).join('')}</tr></thead><tbody>${gs.map((p) => row(p, GC)).join('')}</tbody></table></div>
    </section>`;
  }
  function intelSec() {
    const inPlan = new Set(S.pl.moves.map((m) => m.addId));
    const top = D.players.filter((p) => p.avail).sort((a, b) => S.vor(b) - S.vor(a)).slice(0, 60);
    const items = [...D.players.filter((p) => p.mine), ...top].map((p) => {
      const it = disp(p.id).intel;
      if (!it || !it.tags.length) return null;
      const who = p.mine ? 'yours' : inPlan.has(p.id) ? 'in your plan' : 'on the wire';
      const tags = who === 'yours' ? it.tags : it.tags.filter((t) => t.kind !== 'injured');
      if (!tags.length || (who === 'on the wire' && !tags.some((t) => t.tone > 0))) return null;
      return { p, it: { ...it, tags }, who };
    }).filter(Boolean);
    if (!items.length) return '';
    return `<section>
      <div class="sec-head"><h2>Intel</h2><span class="count">your team and the wire in this league</span></div>
      <div class="intel">${items.map(({ p, it, who }, k) => `<article class="it${k >= 8 ? ' extra' : ''}">
        <div class="it-top"><div><span class="pname">${esc(p.name)}</span> <span class="pmeta">${esc(meta(p))}</span></div><span class="chip ${who === 'yours' ? 'who-yours' : who === 'in your plan' ? 'who-plan' : ''}">${who}</span></div>
        <div class="itags">${strengthChips(p)}</div>${intelTags(it, 8)}
        <ul>${it.tags.map((t) => `<li><b>${esc(t.label)}:</b> ${esc(t.why)}</li>`).join('')}</ul>${rwNote(it)}
      </article>`).join('')}</div>
      ${items.length > 8 ? `<button type="button" class="more-btn" data-ctoggle="show-extra">Show all ${items.length}</button>` : ''}
    </section>`;
  }
  function injuriesSec() {
    const who = (id) => { const p = byId.get(id); return p?.mine ? 'yours' : p?.avail ? 'on the wire' : 'rostered'; };
    const list = (CATS.keyInjuries || []).map((k) => ({ ...k, mine: byId.get(k.id)?.mine || false, beneficiaries: k.beneficiaries.map((q) => ({ ...q, who: who(q.id) })) }))
      .sort((a, b) => b.mine - a.mine || b.beneficiaries.some((q) => q.who !== 'rostered') - a.beneficiaries.some((q) => q.who !== 'rostered'));
    return injurySection({ keyInjuries: list });
  }
  function notesSec() {
    const sp = CATS.spread;
    return `<section class="notes"><details class="wide-open notes-d"><summary><h2 style="display:inline">Key</h2></summary><ul class="key">
      <li><b>Value (+5.7/wk)</b>: what he adds per week over the 3rd–6th best free agent at his position. 10 = one category's typical weekly gap between teams (${[['G', 'G'], ['A', 'A'], ['PPP', 'PPP'], ['SOG', 'SOG'], ['HIT', 'HIT'], ['BLK', 'BLK'], ['W', 'W'], ['SV', 'SV'], ['SO', 'SHO'], ['GAA', 'GAA'], ['SVP', 'SV%']].map(([k, l]) => `${k === 'SVP' ? sp[k].toFixed(3).replace(/^0/, '') : k === 'GAA' ? sp[k].toFixed(2) : sp[k] >= 10 ? Math.round(sp[k]) : sp[k].toFixed(1)} ${l}`).join(', ')}), so +5 ≈ half a category a week. Follows your priorities.</li>
      <li><b>Projections</b>: your CATS sheet (goalies: last season + your tier), adjusted for current role, counts as 50 games; each game played adds one (5 GP = 91% projection). <b>Forwards</b> share one replacement level, since Util takes any forward.</li>
      <li><b>Category score (G +1.2)</b>: per-game strength in that category, in standard deviations from the player pool on your CATS sheet. ±1 = clearly strong/weak, ±2 = elite.</li>
      <li><b>Moves</b>: the add/drop and day that gain the most. <b>/wk every week after</b> = how much a typical future week of your best nightly lineups gains (each team plays about every other night, so it counts only nights he'd actually fill a slot); ranked on this week + 35% of the rest of season. Top ${CATS.league.teams * D.skaterSlots} skaters and top ${CATS.league.teams * 2} goalies are never dropped.</li>
      <li><b>Win chance</b>: odds you win the category this week, from both sides' best nightly lineups. <b>Goalie min</b>: odds of ${CATS.league.minG}+ starts; short of it, your goalie categories count as lost.</li>
      <li><b>Intel</b>: green helps him, red hurts. Same sources as the points tab (ESPN, Rotowire, DailyFaceoff).</li>
      ${tradeKey()}
    </ul></details></section>`;
  }

  // ---- render + events ------------------------------------------------------------------------
  function render() {
    compute();
    root.innerHTML = head() + (S.T ? modelThinks(S.T) : '') + priorities() + movesSec() + matchupSec() + holdsSec() + (S.T ? tradeMarket('cats', S.T, fmtV, 'value per week', `Value: per week over the wire; 10 = one category's weekly gap between two teams (≈${unitEx()}).`) : '') + rosterSec() + intelSec() + injuriesSec() + notesSec();
    if (S.T) bindTrades(root, 'cats', S.T, fmtV);
    root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.cat, cur = prefs[k] || 'normal';
      const nx = cur === 'normal' ? 'priority' : cur === 'priority' ? 'punt' : 'normal';
      if (nx === 'normal') delete prefs[k]; else prefs[k] = nx;
      save(); render();
    }));
    root.querySelectorAll('[data-catset]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.catset === 'reset') prefs = {};
      else { prefs = {}; for (const k of swingCats()) prefs[k] = 'priority'; }
      save(); render();
    }));
    root.querySelectorAll('[data-cpos]').forEach((b) => b.addEventListener('click', () => { posFilter = b.dataset.cpos; render(); }));
    root.querySelectorAll('[data-ctoggle], [data-toggle]').forEach((b) => { b.dataset.label = b.textContent; b.addEventListener('click', () => { const sec = b.closest('section'), cls = b.dataset.ctoggle || b.dataset.toggle; sec.classList.toggle(cls); b.textContent = sec.classList.contains(cls) ? 'Show fewer' : b.dataset.label; }); });
    if (typeof matchMedia === 'function' && matchMedia('(min-width: 641px)').matches) root.querySelectorAll('details.wide-open').forEach((d) => (d.open = true));
  }
  window.renderCats = render;
};
