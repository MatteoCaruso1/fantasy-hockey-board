#!/usr/bin/env node
// Line combinations, power-play units, goalie depth and injury flags for all 32
// teams from DailyFaceoff team pages (their __NEXT_DATA__ JSON), matched to NHL ids.
//   node nhl/fetch-dfo.mjs [--fresh]
// Writes nhl/out/dfo.json. Cached for 3 hours in nhl/cache/dfo-*.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatcher } from '../engine/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const OUT = path.join(HERE, 'out', 'dfo.json');
const FRESH = process.argv.includes('--fresh');
const TTL = 3 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(slug) {
  const f = path.join(CACHE, `dfo-${slug}.json`);
  if (!FRESH && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < TTL) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const res = await fetch(`https://www.dailyfaceoff.com/teams/${slug}/line-combinations`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`${slug}: no data block`);
  const pp = JSON.parse(m[1]).props.pageProps;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(pp));
  await sleep(400);
  return pp;
}

const nhl = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'nhl-data.json'), 'utf8'));
const matchS = buildMatcher(nhl.skaters), matchG = buildMatcher(nhl.goalies);
const fix = { TB: 'TBL', LA: 'LAK', NJ: 'NJD', SJ: 'SJS', UTA: 'UTA' };

const first = await page('florida-panthers');
const teams = first.sortedTeams;
const out = { fetchedAt: new Date().toISOString(), source: 'DailyFaceoff line combinations', teams: {}, players: {}, unmatched: [] };
for (const t of teams) {
  let pp;
  try { pp = t.slug === 'florida-panthers' ? first : await page(t.slug); }
  catch (e) { console.warn('!! DailyFaceoff', e.message); continue; }
  const c = pp.combinations;
  const abbr = fix[c.teamAbbreviation] || c.teamAbbreviation;
  const T = { name: c.teamName, slug: t.slug, sourceName: c.sourceName, updatedAt: c.updatedAt, lines: {}, injuries: [] };
  for (const p of c.players) {
    const isG = p.groupIdentifier === 'g';
    const hit = (isG ? matchG : matchS)(p.name, abbr) || (isG ? matchS : matchG)(p.name, abbr);
    const id = hit?.playerId ?? null;
    if (!id) out.unmatched.push(`${p.name} (${abbr})`);
    const g = p.groupIdentifier; // f1-f4, d1-d3, g, pp1, pp2, pk1, pk2, ir
    (T.lines[g] ||= []).push({ id, name: p.name, slot: p.positionIdentifier });
    if (!id) continue;
    const P = (out.players[id] ||= { name: p.name, team: abbr });
    if (/^f\d$/.test(g)) P.line = Number(g[1]);
    else if (/^d\d$/.test(g)) P.pair = Number(g[1]);
    else if (g === 'g') P.goalie = Number(p.positionIdentifier.replace('g', '')) || null;
    else if (g === 'pp1' || g === 'pp2') P.pp = Math.min(P.pp ?? 9, Number(g[2]));
    else if (g === 'pk1' || g === 'pk2') P.pk = Math.min(P.pk ?? 9, Number(g[2]));
    else if (g === 'ir') { P.injury = p.injuryStatus || 'ir'; T.injuries.push({ id, name: p.name, status: P.injury }); }
    if (p.injuryStatus && g !== 'ir') P.injury = p.injuryStatus;
    if (p.gameTimeDecision) P.gtd = true;
    if (p.latestNews?.createdAt && p.latestNews.details) {
      const age = (Date.now() - new Date(p.latestNews.createdAt)) / 86400000;
      if (age <= 10) P.news = { at: p.latestNews.createdAt.slice(0, 10), text: p.latestNews.details.trim() };
    }
  }
  // linemates on his DFO line / pair
  for (const [g, list] of Object.entries(T.lines)) if (/^[fd]\d$/.test(g)) for (const x of list) if (x.id) out.players[x.id].mates = list.filter((y) => y !== x && y.id).map((y) => y.id);
  out.teams[abbr] = T;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
// dated snapshot (one per day) so the board can show week-over-week PP/line changes
const HIST = path.join(HERE, 'out', 'dfo-history');
fs.mkdirSync(HIST, { recursive: true });
const slim = Object.fromEntries(Object.entries(out.players).map(([id, p]) => [id, { pp: p.pp ?? null, line: p.line ?? null, pair: p.pair ?? null, goalie: p.goalie ?? null, injury: p.injury ?? null }]));
fs.writeFileSync(path.join(HIST, out.fetchedAt.slice(0, 10) + '.json'), JSON.stringify({ fetchedAt: out.fetchedAt, players: slim }));
console.log(`DailyFaceoff: ${Object.keys(out.teams).length} teams, ${Object.keys(out.players).length} players matched, ${out.unmatched.length} unmatched${out.unmatched.length ? ': ' + out.unmatched.slice(0, 12).join(', ') : ''}`);
