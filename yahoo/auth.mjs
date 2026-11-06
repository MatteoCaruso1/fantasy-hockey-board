// One-time Yahoo login: `node yahoo/auth.mjs`
// Opens Yahoo's approval page in the default browser. After you click Agree the
// browser shows "This site can't be reached" on localhost (expected). Copy that
// page's full address and paste it here. Saves secrets/yahoo-token.json.
// (You can also pass the address or the bare code as an argument.)
// Add --write to ask for move permission (fspt-w), needed for scheduled add/drops.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { exchangeCode, REDIRECT_URI } from './client.mjs';
import { askOrClip } from './clip.mjs';

const codeFrom = (text) => {
  const t = (text || '').trim().replace(/^"|"$/g, '');
  if (!t) return '';
  if (!t.includes('code=')) return t;
  try { return new URL(t).searchParams.get('code') || ''; } catch { return ''; }
};

const SCOPE = process.argv.includes('--write') ? 'fspt-w' : 'fspt-r';
let input = process.argv.slice(2).find((a) => a !== '--write');
if (!input) {
  const { client_id } = JSON.parse(fs.readFileSync(new URL('../secrets/yahoo.json', import.meta.url)));
  const url = `https://api.login.yahoo.com/oauth2/request_auth?client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${SCOPE}&language=en-us`;
  // Chrome, not the default browser: Yahoo is signed in there (Edge fails with "Uh oh")
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(chrome)) execFile(chrome, [url]);
  else execFile('rundll32', ['url.dll,FileProtocolHandler', url]);
  console.log('\nA Yahoo page just opened in Chrome. Click Agree if it asks.');
  console.log('The browser will then say "This site can\'t be reached". That is expected.');
  console.log('Click the address bar on that page and copy the whole address (Ctrl+C).\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  input = await askOrClip(rl, 'Then come back here and press Enter: ', (v) => v.includes('code=') && !!codeFrom(v),
    'That is not the address yet. Copy the address of the "can\'t be reached" page (it contains ?code=), then press Enter.');
  rl.close();
}

const code = codeFrom(input);
if (!code) {
  console.error('\nThat address has no code in it. Run `node yahoo/auth.mjs` again, click Agree on the Yahoo page,');
  console.error('then copy the address from the "can\'t be reached" page (it ends with ?code= followed by letters and numbers).');
  process.exit(1);
}
await exchangeCode(code);
console.log('\nYahoo connected. Saved secrets/yahoo-token.json');
