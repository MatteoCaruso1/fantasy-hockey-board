# Fantasy hockey weekly board

A weekly decision board for Yahoo fantasy hockey, covering a **points league** and a **head-to-head categories league**. It pulls live data from the NHL and Yahoo, scores every player against your own projections, and turns that into the week's moves: who to start each night, who to add and drop, which trades the other managers would actually accept, and where you're projected to finish.

Shared with co-managers as a single web page on a free Cloudflare Worker.

## What the board does

- **Player model.** Season projections (from your own spreadsheet) are blended with this season's results, weighted by games played, then adjusted for ice time and power-play role from the NHL API. Every player gets a tier and a value over replacement.
- **Best lineup, every night.** Builds the optimal daily lineup across the week's schedule, including goalie streaming odds (the chance of reaching the weekly minimum of starts).
- **Add/drop plan.** Finds the adds that gain the most over the week within the league's add limit, and the drop each one costs, never cutting studs, positional starters or protected players.
- **Trade market.** Judges other managers the way they judge: positional need (their healthy players in Yahoo's top tier at each position), name value from Yahoo ranks with a star premium, and a discount for the second piece in a 2-for-1. Lists consolidations and "who would take X".
- **Categories tab.** For the head-to-head league: weekly category projections at adjustable weights against your opponent, and category-aware pickups.
- **Outlook.** Projected finish for every team, kept as a history so changes week to week show up.

## How it's built

| Path | What |
|---|---|
| `nhl/` | Fetchers for the public NHL APIs (skaters, goalies, ice time, power-play time, schedule), plus line combinations and injury news |
| `yahoo/` | Yahoo Fantasy API: OAuth login (`auth.mjs`), token refresh (`client.mjs`), league snapshot (`snapshot.mjs`) |
| `projections/` | Exports your projections spreadsheet to JSON (`export_ag.py` points, `export_cats.py` categories) |
| `engine/` | The model: `analyze.mjs` (points), `cats.mjs` + `cats-core.js` (categories), `trades-core.js`, `outlook.mjs` |
| `page/` | The board: one self-contained HTML page with the data inlined |
| `web/` | Cloudflare Worker: serves the shared board (KV) and re-runs the pipeline in the browser |

Plain Node.js (ES modules) with no framework; the worker is built with esbuild and deployed with Wrangler.

## Running it

1. `node nhl/fetch-nhl.mjs` works with no setup (public NHL data).
2. Projections: put your spreadsheet at `projections/My Projections.xlsm` and run the two export scripts (see their headers for the expected columns).
3. Yahoo: create an app at developer.yahoo.com, put its client ID and secret in `secrets/`, run `node yahoo/auth.mjs` once, then set your league IDs (the examples use `11111` for the points league and `22222` for the categories league).
4. `node refresh.mjs` runs the whole pipeline and writes `out/board.html`.
5. Optional shared board: fill in the placeholders in `web/wrangler.toml`, then `node web/deploy.mjs`.

Your league data, orders and secrets are git-ignored and never leave your machine except to Yahoo.
