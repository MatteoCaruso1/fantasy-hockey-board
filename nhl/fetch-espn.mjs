#!/usr/bin/env node
// Player intel from ESPN's public NHL feeds (free, no key), matched to NHL ids:
//  - injuries: status, type, expected return date, beat note
//  - each player's latest Rotowire note (headline + analysis), classified into signals
//    (coach praise, PP / line promotion or demotion, scratch, call-up, return, goalie role)
//  - recent ice time (last 3 regular-season games) and fantasy ownership (% of ESPN leagues)
//  - DraftKings moneylines and totals for the next few days (posted about a day ahead)
//   node nhl/fetch-espn.mjs [--fresh]
// Writes nhl/out/espn.json plus a daily ownership snapshot in nhl/out/espn-history/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatcher } from '../engine/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache', 'espn');
const OUT = path.join(HERE, 'out', 'espn.json');
const HIST = path.join(HERE, 'out', 'espn-history');
const FRESH = process.argv.includes('--fresh');
const TTL = 6 * 3600 * 1000;
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl';
const fix = { UTAH: 'UTA', TB: 'TBL', LA: 'LAK', NJ: 'NJD', SJ: 'SJS' };
const team = (a) => fix[a] || a;

async function get(url, key, ttl = TTL) {
  const f = key && path.join(CACHE, key + '.json');
  if (f && !FRESH && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl) return JSON.parse(fs.readFileSync(f, 'utf8'));
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (f) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); }
      return j;
    } catch (e) { if (i >= 2) throw new Error(`${url}: ${e.message}`); await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message }; } } }));
  return out;
}
const toSec = (s) => { const m = /^(\d+):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
const day = (d) => new Date(d).toISOString().slice(0, 10);
const espnDate = (s) => { const d = new Date(String(s).replace(/ (PDT|PST|EDT|EST)/, (m, z) => ({ PDT: ' GMT-0700', PST: ' GMT-0800', EDT: ' GMT-0400', EST: ' GMT-0500' })[z])); return isNaN(d) ? null : d.toISOString(); };

// ---- what a note says ---------------------------------------------------------------
// A Rotowire note is a headline (the event: called up, scratched, will start Tuesday) and an
// analysis paragraph that usually states the player's current role ("skating on the top line
// and first power-play unit"). Events come from the headline only, so the analyst's
// speculation never reads as news; the role comes from factual sentences about him.
const ORD = { first: 1, '1st': 1, top: 1, 'no. 1': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, bottom: 4 };
const SPEC = /\b(could|might|may|would|if|chance|potential(?:ly)?|remains to be seen|hop(?:e|es|ing)|bid|in line for|penciled|poised|projected|competing|battle|vying|figures to|ought to|once|when he returns|upon his return|last (?:year|season|campaign)|in 20\d\d-\d\d)\b/i;
const EVENTS = [
  // [kind, tone, headline test]
  ['callup', +1, /\b(recalled|called up|summoned|promoted from)\b/i],
  ['senddown', -3, /\b(assigned to|sent down|reassigned to|loaned to|returned to)\b[^.]{0,40}\b(AHL|minors|junior|OHL|WHL|QMJHL|Europe|KHL|SHL)|\bplaced on waivers\b|\bwaived\b/i],
  ['claimed', 0, /\bclaimed off waivers\b/i],
  ['scratch', -2, /healthy scratch|\bscratched\b|won't dress|will sit out|out of the lineup (?:for|as) a/i],
  ['return', +0.5, /\b(activated|cleared to play|returns? to (?:the )?lineup|back in the lineup|will return|set to return|expected to return|will play|good to go|full participant|practic\w* fully|in the lineup)\b/i],
  ['injury', -1, /\(([a-z ]+)\)[^.]*\b(placed on injured reserve|will miss|won't play|out (?:for|indefinitely)|ruled out|sidelined|shelved|day-to-day|week-to-week|month-to-month|surgery|not play|unavailable|questionable|doubtful)\b|\b(placed on injured reserve|ruled out)\b/i],
  ['debut', +0.5, /\bNHL debut\b/i],
  ['minutes', +1, /\b(career-high|season-high)\b[^.]{0,30}\b(ice time|minutes)\b/i],
  ['start', 0, /\b(will|to|slated to|set to|expected to|gets?|getting) (?:get |make )?(?:the )?(?:start|starting nod|nod)\b|\bwill (?:be )?(?:in|between the pipes|guard the (?:cage|net|crease))\b|\bconfirmed (?:as|to be) (?:the )?starter\b/i],
  ['backup', 0, /\b(will|to|set to|expected to) (?:serve as (?:the )?)?back(?:\s|-)?up\b|\bwill dress as the backup\b/i],
];
const PRAISE = /\b(prais\w*|impress\w*|happy with|pleased with|raved|complimented|credited|lauded|lik(?:es|ed) what|trust\w*|confiden\w*|singled out|earned (?:a|more|his)|rewarded|deserv\w*|excellent|terrific|outstanding)\b/i;
const KNOCK = /\b(not happy|unhappy|frustrat\w*|criticiz\w*|called out|benched|send a message|challenged|disappoint\w*|needs to be better|not good enough)\b/i;
const COACH = /\b(head coach|coach(?:es|ing staff)?|bench boss|GM|general manager)\b/i;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readNote(note, name, isG) {
  if (!note) return null;
  const last = name.split(' ').slice(-1)[0];
  const about = new RegExp(`\\b${esc(last)}\\b|^(?:He|His|The (?:\\d+-year-old|young|veteran|rookie|gritty|winger|center|centre|forward|defenseman|defenceman|blueliner|netminder|goalie)\\b)`, 'i');
  const head = note.headline || '';
  const sents = [head, ...(note.story || '').split(/(?<=[.!?])\s+(?=[A-Z"'])/)];
  const out = { events: [], role: {}, coach: null };
  for (const [kind, tone, re] of EVENTS) {
    if ((kind === 'start' || kind === 'backup') && !isG) continue;
    if (re.test(head)) out.events.push({ kind, tone });
  }
  const has = (k) => out.events.some((e) => e.kind === k);
  if (has('claimed')) out.events = out.events.filter((e) => e.kind !== 'senddown');
  if (has('injury')) out.events = out.events.filter((e) => e.kind !== 'return');
  for (const t of sents) {
    if (!about.test(t)) continue;
    const factual = !SPEC.test(t);
    // power-play unit
    const pp = t.match(/\b(first|1st|top|No\. 1|second|2nd)[- ](?:power[- ]play|PP)(?:[- ](?:unit|group|assignment|duties))?\b|\bPP([12])\b/i);
    if (pp && factual && out.role.pp == null && !/\b(off|removed from|dropped from|lost (?:his|a) (?:spot|place) on)\b[^.]{0,25}\b(?:first|1st|top)/i.test(t)) out.role.pp = pp[2] ? +pp[2] : ORD[pp[1].toLowerCase()];
    if (factual && out.role.pp == null && /\bno power-play (?:role|time|work)\b|\bnot (?:on|part of) (?:either|the) power[- ]play/i.test(t)) out.role.pp = 0;
    // even-strength line / pair
    const ln = t.match(/\b(first|1st|top|second|2nd|third|3rd|fourth|4th|bottom)[- ](line|pair(?:ing)?|six|four)\b/i);
    if (ln && factual) {
      const o = ORD[ln[1].toLowerCase()], k = ln[2].toLowerCase();
      if (k === 'line' && out.role.line == null) out.role.line = o;
      else if (/^pair/.test(k) && out.role.pair == null) out.role.pair = Math.min(o, 3);
      else if (k === 'six' && out.role.line == null) out.role.six = o === 1 ? 'top' : 'bottom';
      else if (k === 'four' && out.role.pair == null) out.role.four = o === 1 ? 'top' : 'bottom';
    }
    // what the coach said about him
    if (COACH.test(t) && !out.coach && factual) {
      if (PRAISE.test(t) && !KNOCK.test(t)) out.coach = { tone: +1, text: t };
      else if (KNOCK.test(t)) out.coach = { tone: -1, text: t };
    }
  }
  return out;
}

// ---- fetch -----------------------------------------------------------------------------
const nhl = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'nhl-data.json'), 'utf8'));
const matchS = buildMatcher(nhl.skaters), matchG = buildMatcher(nhl.goalies);

const teams = (await get(`${SITE}/teams`, 'teams', 7 * 86400000)).sports[0].leagues[0].teams.map((t) => ({ id: t.team.id, abbr: team(t.team.abbreviation) }));
const rosters = await pool(teams, 8, (t) => get(`${SITE}/teams/${t.id}/roster`, `roster-${t.id}`));
const athletes = [];
rosters.forEach((r, i) => {
  if (!r?.athletes) { console.warn(`!! ESPN roster ${teams[i].abbr}: ${r?.error || 'empty'}`); return; }
  for (const grp of r.athletes) for (const a of grp.items || []) athletes.push({ espnId: a.id, name: a.fullName, team: teams[i].abbr, pos: a.position?.abbreviation || '' });
});

const inj = await get(`${SITE}/injuries`, null);
const injuries = new Map();
for (const t of inj.injuries || []) for (const i of t.injuries || []) {
  const d = i.details || {};
  injuries.set(String(i.athlete?.links?.[0]?.href?.match(/id\/(\d+)/)?.[1] || i.id), {
    status: i.status, date: i.date?.slice(0, 10) || null, type: d.type || null, detail: d.detail || null,
    returnDate: d.returnDate || null, fantasy: d.fantasyStatus?.abbreviation || null, comment: i.longComment && i.longComment.length > 10 ? i.longComment : null, name: i.athlete?.displayName,
  });
}

// injured players ESPN keeps off its active rosters
const known = new Set(athletes.map((a) => a.espnId));
const teamById = new Map(teams.map((t) => [t.id, t.abbr]));
for (const t of inj.injuries || []) for (const i of t.injuries || []) {
  const id = i.athlete?.links?.[0]?.href?.match(/id\/(\d+)/)?.[1];
  if (id && !known.has(id) && teamById.get(String(t.id))) { known.add(id); athletes.push({ espnId: id, name: i.athlete.displayName, team: teamById.get(String(t.id)), pos: i.athlete.position?.abbreviation || '' }); }
}
const overviews = await pool(athletes, 8, (a) => get(`https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/${a.espnId}/overview`, `ov-${a.espnId}`));

// odds: today and the next two days (books post about a day ahead)
const odds = {};
const devig = (a, b) => { const p = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100)); const x = p(a), y = p(b); return x / (x + y); };
for (let k = 0; k < 3; k++) {
  const d = new Date(Date.now() + k * 86400000), ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const sb = await get(`${SITE}/scoreboard?dates=${ymd}`, null).catch(() => null);
  for (const ev of sb?.events || []) {
    const c = ev.competitions?.[0], o = c?.odds?.[0];
    const ml = o?.moneyline, h = Number(ml?.home?.close?.odds ?? ml?.home?.open?.odds), aw = Number(ml?.away?.close?.odds ?? ml?.away?.open?.odds);
    if (!o || !isFinite(h) || !isFinite(aw)) continue;
    const home = team(c.competitors.find((x) => x.homeAway === 'home').team.abbreviation), away = team(c.competitors.find((x) => x.homeAway === 'away').team.abbreviation);
    const pH = devig(h, aw), tot = Number(o.overUnder) || 6;
    // implied goals: split the total by win chance (a 60% favourite gets ~54% of the goals)
    const gH = tot * (0.5 + (pH - 0.5) * 0.4), gA = tot - gH;
    const date = day(ev.date);
    (odds[date] ||= {})[home] = { opp: away, home: true, ml: h, pWin: +pH.toFixed(3), total: tot, goalsFor: +gH.toFixed(2), goalsAgainst: +gA.toFixed(2), book: o.provider?.name };
    odds[date][away] = { opp: home, home: false, ml: aw, pWin: +(1 - pH).toFixed(3), total: tot, goalsFor: +gA.toFixed(2), goalsAgainst: +gH.toFixed(2), book: o.provider?.name };
  }
}

// ---- assemble ---------------------------------------------------------------------------
const seasonStart = nhl.meta.regularSeason.start; // the game log mixes in preseason and last season's playoffs
// league news headlines (trade talk and other stories that aren't one player's Rotowire note)
let news = [];
try {
  const j = await get(`${SITE}/news?limit=100`, null);
  news = (j.articles || []).map((x) => ({ at: x.published, headline: (x.headline || '').trim(), text: (x.description || '').trim() }))
    .filter((x) => x.at && (Date.now() - new Date(x.at)) / 86400000 <= 14);
} catch { /* no news this run */ }
const out = { fetchedAt: new Date().toISOString(), source: 'ESPN public NHL feeds (Rotowire notes, injuries, DraftKings odds, news)', players: {}, odds, news, unmatched: [] };
athletes.forEach((a, i) => {
  const ov = overviews[i] || {}, isG = a.pos === 'G';
  const hit = (isG ? matchG : matchS)(a.name, a.team) || (isG ? matchS : matchG)(a.name, a.team);
  if (!hit) { out.unmatched.push(`${a.name} (${a.team})`); return; }
  const rw = ov.rotowire;
  const note = rw?.headline ? { at: espnDate(rw.published), headline: rw.headline.trim(), story: (rw.story || '').trim() } : null;
  // recent regular-season ice time from the game log
  const stat = ov.gameLog?.statistics?.[0], evs = ov.gameLog?.events || {};
  const ti = stat?.names?.indexOf('timeOnIcePerGame') ?? -1;
  const games = (stat?.events || []).map((e) => ({ date: evs[e.eventId]?.gameDate?.slice(0, 10), toi: ti >= 0 ? toSec(e.stats[ti]) : null }))
    .filter((g) => g.date && g.date >= seasonStart);
  const recent = games.slice(0, 3).filter((g) => g.toi);
  const P = {
    espnId: a.espnId, name: a.name, team: a.team,
    note: note && (Date.now() - new Date(note.at)) / 86400000 <= 21 ? { ...note, ...readNote(note, a.name, isG) } : null,
    injury: injuries.get(a.espnId) || null,
    owned: ov.fantasy?.percentOwned != null ? +Number(ov.fantasy.percentOwned).toFixed(1) : null,
    recentToi: !isG && recent.length ? Math.round(recent.reduce((s, g) => s + g.toi, 0) / recent.length) : null,
    recentGames: recent.length, lastGame: games[0]?.date || null,
  };
  out.players[hit.playerId] = P;
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
fs.mkdirSync(HIST, { recursive: true });
fs.writeFileSync(path.join(HIST, out.fetchedAt.slice(0, 10) + '.json'), JSON.stringify(Object.fromEntries(Object.entries(out.players).map(([id, p]) => [id, p.owned]))));
const n = Object.values(out.players);
console.log(`ESPN: ${n.length} players matched (${out.unmatched.length} unmatched), ${n.filter((p) => p.note).length} recent notes, ${n.filter((p) => p.note && (p.note.events.length || p.note.role.pp != null || p.note.role.line || p.note.role.pair || p.note.coach)).length} with role or event info, ${n.filter((p) => p.injury).length} injuries, odds for ${Object.values(odds).reduce((s, d) => s + Object.keys(d).length / 2, 0)} games`);
