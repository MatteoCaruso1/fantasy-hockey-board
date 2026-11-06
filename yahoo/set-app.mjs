// Save a Yahoo developer app's keys: `node yahoo/set-app.mjs`
// Asks for the Client ID and Client Secret shown on developer.yahoo.com/apps (copy
// each one in Chrome, then press Enter here; pasting works too),
// keeps the previous app's file as secrets/yahoo-previous-app.json, and writes
// secrets/yahoo.json. The old login token belongs to the old app, so it is set
// aside too; run `node yahoo/auth.mjs` afterwards to log in with the new app.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { askOrClip } from './clip.mjs';

const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'secrets');
const APP = path.join(DIR, 'yahoo.json'), TOKEN = path.join(DIR, 'yahoo-token.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const idOk = (v) => v.length >= 40 && !/\s/.test(v) && !/^[0-9a-f]{40}$/i.test(v);
const secretOk = (v) => /^[0-9a-f]{40}$/i.test(v);
const client_id = await askOrClip(rl, 'In Chrome, copy the Client ID (Consumer Key). Then come back here and press Enter: ', idOk,
  'That is not the Client ID (it is about 96 characters, no spaces). Copy it again, then press Enter.');
console.log('Got the Client ID.');
const client_secret = await askOrClip(rl, 'Now copy the Client Secret (Consumer Secret). Then come back here and press Enter: ', secretOk,
  'That is not the Client Secret (it is 40 letters and digits). Copy it again, then press Enter.');
rl.close();

fs.mkdirSync(DIR, { recursive: true });
if (fs.existsSync(APP)) fs.copyFileSync(APP, path.join(DIR, 'yahoo-previous-app.json'));
if (fs.existsSync(TOKEN)) fs.renameSync(TOKEN, path.join(DIR, 'yahoo-previous-token.json'));
fs.writeFileSync(APP, JSON.stringify({ client_id, client_secret }, null, 2));
console.log('\nSaved the new app keys. Now logging in with the new app...');
// `--no-auth` stops here; otherwise go straight into the one-time Yahoo login
if (!process.argv.includes('--no-auth')) await import('./auth.mjs');
