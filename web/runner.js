// The shared board's Refresh: runs the board's own pipeline in the viewer's browser.
// Data requests go through the board's Cloudflare worker (it adds CORS and holds the Yahoo login);
// the scripts read and write an in-memory file system seeded with the inputs from the last Sunday
// run (projections, league reads, shift-chart lines). The result is saved back to the worker so
// everyone who opens the board next sees it.
//   const { refresh } = await import(base + '/runner.js'); await refresh({ base, api, key, onStatus })
const PROXY_HOSTS = ['api-web.nhle.com', 'api.nhle.com', 'www.dailyfaceoff.com', 'site.api.espn.com', 'site.web.api.espn.com'];
const STEPS = [
  // [label, bundle, required]
  ['NHL stats and schedule', 'fetch-nhl', true],
  ['DailyFaceoff lines and PP units', 'fetch-dfo', false],
  ['ESPN injuries, Rotowire notes and odds', 'fetch-espn', false],
  ['Yahoo rosters (points league)', 'yahoo-snapshot', false],
  ['Yahoo rosters (Categories League)', 'yahoo-snapshot', false, ['--league', '22222']],
  ['Points league analysis', 'analyze', true],
  ['Categories League analysis', 'cats', true],
];

export async function refresh({ base, api, key, onStatus = () => {} }) {
  const realFetch = globalThis.__boardRealFetch || (globalThis.__boardRealFetch = globalThis.fetch.bind(globalThis));
  const realLog = console.log;
  const log = [];
  globalThis.BOARD_WEB = { api };
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* relative */ }
    if (PROXY_HOSTS.includes(host)) return realFetch(`${api}/proxy?u=${encodeURIComponent(url)}`, { method: 'GET', signal: init.signal });
    return realFetch(input, init);
  };
  console.log = (...a) => { log.push(a.join(' ')); realLog(...a); };
  const warnings = [];
  try {
    onStatus('Loading this week\'s inputs…', 0);
    const seed = await (await realFetch(`${base}/seed.json?v=${Date.now()}`)).json();
    globalThis.__VFS = { files: new Map(Object.entries(seed.files)), mtime: new Map(Object.entries(seed.mtime || {})) };
    for (let i = 0; i < STEPS.length; i++) {
      const [label, name, required, argv] = STEPS[i];
      globalThis.BOARD_ARGV = argv ? ['node', name, ...argv] : null;
      onStatus(`${label}… (${i + 1} of ${STEPS.length})`, (i + 0.5) / STEPS.length);
      try {
        await import(`${base}/pipeline/${name}.js?run=${Date.now()}`);
      } catch (e) {
        if (required) throw new Error(`${label}: ${e.message}`);
        warnings.push(`${label}: ${String(e.message).slice(0, 160)}`);
      }
    }
    globalThis.BOARD_ARGV = null;
    const V = globalThis.__VFS.files;
    const board = JSON.parse(V.get('/app/out/board.json'));
    const cats = V.has('/app/out/cats.json') ? JSON.parse(V.get('/app/out/cats.json')) : null;
    board.refresh = { at: new Date().toISOString(), warnings, via: 'browser' };
    onStatus('Saving for everyone…', 0.97);
    const res = await realFetch(`${api}/latest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board-key': key }, body: JSON.stringify({ board, cats }) });
    if (!res.ok) warnings.push(`Saving: ${res.status}`);
    return { board, cats, warnings, log };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}
