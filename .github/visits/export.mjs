// Hourly: pull new pageviews from GoatCounter's CSV export and add them to visits.json, locked with
// the GOAT key (AES-256-GCM, key from PBKDF2-SHA256). The stats page unlocks it with the same key.
// Run from the visits-data checkout: node export.mjs <path to visits.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const KEY = (process.env.GOAT_KEY || '').trim(), SITE = 'prestinartis', FILE = process.argv[2] || 'visits.json';
const API = `https://${SITE}.goatcounter.com/api/v0`, ITER = 200000;
if (!KEY) { console.log('GOAT_KEY secret is not set'); process.exit(1); }
const { subtle } = globalThis.crypto, enc = new TextEncoder(), b64 = b => Buffer.from(b).toString('base64');
const wait = ms => new Promise(r => setTimeout(r, ms));
const derive = salt => subtle.importKey('raw', enc.encode(KEY), 'PBKDF2', false, ['deriveKey'])
  .then(k => subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));

async function open() { // the hits kept so far, or none
  if (!existsSync(FILE)) return { last: 0, hits: [] };
  const f = JSON.parse(readFileSync(FILE, 'utf8'));
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(f.iv, 'base64') }, await derive(Buffer.from(f.salt, 'base64')), Buffer.from(f.data, 'base64'));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { console.log('visits.json is locked with a different key: starting over'); return { last: 0, hits: [] }; }
}
async function lock(state) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, await derive(salt), enc.encode(JSON.stringify(state)));
  writeFileSync(FILE, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(data) }));
}
const gc = (path, opt = {}) => fetch(API + path, { ...opt, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' } });

function csv(text) { // RFC 4180
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const state = await open();
let r = await gc('/export', { method: 'POST', body: JSON.stringify({ format: 'csv', ...(state.last ? { start_from_hit_id: state.last } : {}) }) });
let j = await r.json().catch(() => ({}));
if (r.status === 429) { console.log('rate limited:', j.error); process.exit(0); } // next hour
if (!r.ok || !j.id) { console.log('export failed:', r.status, JSON.stringify(j)); process.exit(1); }
console.log('export', j.id);
for (let i = 0; i < 60 && !j.finished_at; i++) { await wait(3000); j = await (await gc('/export/' + j.id)).json(); }
if (!j.finished_at) { console.log('export took too long'); process.exit(1); }
r = await gc('/export/' + j.id + '/download');
if (!r.ok) { console.log('download failed:', r.status); process.exit(1); }
let buf = Buffer.from(await r.arrayBuffer());
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
const text = buf.toString('utf8').trim();
if (!text) { console.log('no new pageviews'); process.exit(0); } // an export with nothing new is an empty file
const rows = csv(text);
if (!rows.length || !/^2,?Path$/.test(rows[0][0] === '2' ? '2Path' : rows[0][0]) || rows[0].length < 14) { // the header starts "2Path,…": version 2
  console.log('export format changed:', rows[0]?.slice(0, 3)); process.exit(1); }
// path, event, browser, system, session, referrer, screen size, location, date, title (no bots, no user agent)
const fresh = rows.slice(1).filter(x => x.length >= 14 && (x[7] === '0' || x[7] === '' || x[7] === 'false'))
  .map(x => [x[0], x[2] === 'true' ? 1 : 0, x[4], x[5], x[6], x[8], x[10], x[11], x[13], x[1]]); // + title: the 'visit' event's carries the full screen size
const seen = new Set(state.hits.map(h => h.join('\t')));
const added = fresh.filter(h => !seen.has(h.join('\t')));
state.hits.push(...added);
if (j.last_hit_id) state.last = j.last_hit_id;
if (!added.length && existsSync(FILE)) { console.log('no new pageviews'); process.exit(0); } // nothing to commit
state.at = new Date().toISOString();
await lock(state);
console.log(`added ${added.length} pageviews, ${state.hits.length} kept, last hit ${state.last}`);
