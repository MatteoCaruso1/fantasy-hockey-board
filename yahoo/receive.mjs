// Local receiver for Chrome reads: `node yahoo/receive.mjs <file>` listens on 127.0.0.1:8766 and
// saves the first POSTed body to yahoo/data/<file>, then exits. The snapshot script running in
// the signed-in Yahoo tab posts its JSON here, so nothing has to be copied by hand.
import http from 'node:http';
import fs from 'node:fs';

const name = process.argv[2] || 'chrome-raw.json';
if (!/^[\w.-]+\.json$/.test(name)) throw new Error('bad file name');
const out = new URL(`./data/${name}`, import.meta.url);
const cors = {
  'access-control-allow-origin': 'https://hockey.fantasysports.yahoo.com',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-private-network': 'true',
};
const srv = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { JSON.parse(body); } catch { res.writeHead(400, cors); return res.end('not json'); }
    fs.writeFileSync(out, body);
    res.writeHead(200, cors); res.end('saved');
    console.log(`Saved ${body.length} bytes to yahoo/data/${name}`);
    setTimeout(() => process.exit(0), 200);
  });
});
srv.listen(8766, '127.0.0.1', () => console.log(`Waiting for the Chrome read on 127.0.0.1:8766 -> yahoo/data/${name}`));
setTimeout(() => { console.log('No read arrived within 10 minutes.'); process.exit(1); }, 600000);
