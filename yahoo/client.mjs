// Yahoo Fantasy API client: OAuth token storage/refresh + JSON GET helper.
// Credentials live in secrets/yahoo.json (client_id, client_secret) and
// secrets/yahoo-token.json (access/refresh tokens). Both are git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILE = path.join(ROOT, 'secrets', 'yahoo.json');
const TOKEN_FILE = path.join(ROOT, 'secrets', 'yahoo-token.json');
// Registered on the Yahoo app "NHL Waiver Hero"; yahoo/auth.mjs listens here once
export const REDIRECT_URI = 'https://localhost:8443/callback';
const TOKEN_URL ='https://api.login.yahoo.com/oauth2/get_token';
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const app = () => readJson(APP_FILE);

async function tokenRequest(params) {
  const { client_id, client_secret } = app();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ redirect_uri: REDIRECT_URI, ...params }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Yahoo token error: ${JSON.stringify(data)}`);
  const token = { ...data, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  // Yahoo sometimes omits refresh_token on refresh; keep the old one
  if (!token.refresh_token && fs.existsSync(TOKEN_FILE)) token.refresh_token = readJson(TOKEN_FILE).refresh_token;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
  return token;
}

export const exchangeCode = (code) => tokenRequest({ grant_type: 'authorization_code', code });

async function accessToken() {
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('No Yahoo token. Run: node yahoo/auth.mjs <code>');
  let token = readJson(TOKEN_FILE);
  if (Date.now() >= token.expires_at) token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
  return token.access_token;
}

// The board's worker holds the Yahoo login made on its auto moves page (/moves): the Yahoo app
// approved for API access. web/config.json has its address.
const WORKER_API = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'config.json'), 'utf8')).api; } catch { return null; }
})();

// GET a Fantasy API resource path (e.g. "/league/465.l.123/settings"); returns fantasy_content
export async function yget(resource, retry = true) {
  // in the browser (the shared board's Refresh) the worker holds the Yahoo login and makes the call
  const api = globalThis.BOARD_WEB?.api || (retry && WORKER_API);
  if (api) {
    const res = await fetch(`${api}/yahoo?r=${encodeURIComponent(resource)}`).catch(() => null);
    if (res?.ok) return (await res.json()).fantasy_content;
    // 503: Yahoo not connected on the worker yet; on this computer fall back to its own login
    if (globalThis.BOARD_WEB || (res && res.status !== 503)) throw new Error(`Yahoo ${res?.status ?? 'unreachable'} for ${resource}: ${res ? (await res.text()).slice(0, 300) : ''}`);
  }
  const url = `${API}${resource}${resource.includes('?') ? '&' : '?'}format=json`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 401 && retry) {
    const t = readJson(TOKEN_FILE);
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return yget(resource, false);
  }
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${resource}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).fantasy_content;
}

// Yahoo JSON encodes objects as arrays of single-key objects; flatten them.
export function flat(arr) {
  const out = {};
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.assign(out, x);
  };
  walk(arr);
  return out;
}

// Yahoo collections are {"0": {...}, "1": {...}, count: n}
export const items = (coll) =>
  coll ? Object.keys(coll).filter((k) => k !== 'count').map((k) => coll[k]) : [];
