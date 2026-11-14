// Cloudflare Worker: finds SPHEREx images and Gaia stars for a sky position, for the browser.
// IRSA's search (SIA) and ESA's Gaia archive send no CORS header and IRSA throws intermittent 502s, so this
// proxies both with retries and caches answers for a day. The pixels never pass through here: the browser
// reads them straight from NASA's public S3 copy (see web/live/fits.js).
//   GET /api/images?ra=&dec=&det=D1..D6   GET /api/gaia?ra=&dec=
//   GET /api/comets   GET /api/comets/:id   POST /api/comments   (D1)        GET /api/explored   (example data)   See docs/api.md.
// The same Worker serves the app's files from web/ (wrangler.toml [assets]); only /api/* reaches this code.
import { SUGGEST, exploredCells } from './example-data.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const WIDE = ['spherex_dr1', 'spherex_qr3'], DEEP = ['spherex_dr1_deep', 'spherex_qr3_deep'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

function position(url) {
  const ra = Number(url.searchParams.get('ra')), dec = Number(url.searchParams.get('dec'));
  if (!url.searchParams.has('ra') || !Number.isFinite(ra) || ra < 0 || ra >= 360) return { error: 'ra must be 0 to 360' };
  if (!url.searchParams.has('dec') || !Number.isFinite(dec) || dec < -90 || dec > 90) return { error: 'dec must be -90 to 90' };
  return { ra, dec };
}

// IRSA answers 502 now and then; a few quick retries with jitter get through (measured 2026-11-14)
async function fetchRetry(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (r.ok && !text.startsWith('Server busy') && !text.includes('Proxy Error')) return text;
      last = `HTTP ${r.status}`;
    } catch (e) { last = String(e); }
    // short waits: one 502 is common, a run of them is rare; doubling from 400 ms cost 14 s on 2026-11-14
    await new Promise(res => setTimeout(res, 300 * 1.5 ** i + Math.random() * 200));
  }
  throw new Error(last);
}

// CSV with quoted fields (cloud_access holds JSON with commas)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1) rows.push(row); row = []; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function s3Key(row) {
  try {
    const key = JSON.parse(row.cloud_access).aws.key;
    if (key) return key;
  } catch {}
  return row.access_url.replace('https://irsa.ipac.caltech.edu/ibe/data/spherex/', '');   // same layout (agent check 2026-11-14)
}

async function images(url) {
  const p = position(url);
  if (p.error) return json(p, 400);
  const det = url.searchParams.get('det') || 'D1';
  if (!/^D[1-6]$/.test(det)) return json({ error: 'det must be D1 to D6' }, 400);
  const search = coll => fetchRetry(`${SIA}?${new URLSearchParams({ COLLECTION: coll, POS: `CIRCLE ${p.ra} ${p.dec} 0.001`, RESPONSEFORMAT: 'CSV', MAXREC: '20000' })}`)
    .then(parseCsv);
  // the Deep Survey only covers the ecliptic poles (irsa-tutorials spherex_intro); elsewhere skip those searches
  const e = 23.4393 * Math.PI / 180, a = p.ra * Math.PI / 180, d = p.dec * Math.PI / 180;
  const beta = Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a)) * 180 / Math.PI;
  const colls = Math.abs(beta) > 75 ? [...WIDE, ...DEEP] : WIDE;
  const results = await Promise.allSettled(colls.map(search));
  if (results.slice(0, WIDE.length).some(r => r.status === 'rejected'))   // an empty answer must mean "no images", never "search failed"
    return json({ error: 'IRSA search is not answering, try again or pick a baked target', retry_after: 30 }, 503, { 'Retry-After': '30' });
  const seen = new Map(), counts = {};
  results.forEach((r, n) => {
    const coll = colls[n];
    if (r.status !== 'fulfilled') { counts[coll] = 'failed'; return; }
    const rows = r.value.filter(x => x.energy_bandpassname === `SPHEREx-${det}` && x.dataproduct_subtype === 'science');
    counts[coll] = rows.length;
    for (const x of rows) if (!seen.has(x.obs_id)) seen.set(x.obs_id, { t: Number(x.t_min), key: s3Key(x), obs: x.obs_id, coll });  // DR1 first wins
  });
  const list = [...seen.values()].sort((a, b) => a.t - b.t);
  return json({ ra: p.ra, dec: p.dec, det, images: list, collections: counts }, 200, { 'Cache-Control': 'public, max-age=86400' });
}

async function gaia(url) {
  const p = position(url);
  if (p.error) return json(p, 400);
  // a 0.04 degree cone: Gaia positions are for 2016.0 and fast stars move far by now; the browser propagates and matches
  const q = `SELECT ra, dec, pmra, pmdec, phot_g_mean_mag AS g FROM gaiadr3.gaia_source WHERE pmra IS NOT NULL AND 1=CONTAINS(POINT(ra, dec), CIRCLE(${p.ra}, ${p.dec}, 0.04))`;
  try {
    const text = await fetchRetry(`https://gea.esac.esa.int/tap-server/tap/sync?${new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: q })}`, 3);
    const stars = parseCsv(text).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])));
    return json({ epoch: 2016.0, stars }, 200, { 'Cache-Control': 'public, max-age=86400' });
  } catch {
    return json({ error: 'Gaia archive is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  }
}

// Tag tallies per comet: each person's latest tag is their vote (so nobody counts twice)
const TALLY = `SELECT comet_id, tag, COUNT(*) AS n FROM comments c
  WHERE tag IS NOT NULL AND id = (SELECT MAX(id) FROM comments d WHERE d.comet_id = c.comet_id AND d.author = c.author AND d.tag IS NOT NULL)
  GROUP BY comet_id, tag`;
const TALLY_ONE = `SELECT tag, COUNT(*) AS n FROM comments c
  WHERE comet_id = ?1 AND tag IS NOT NULL AND id = (SELECT MAX(id) FROM comments d WHERE d.comet_id = ?1 AND d.author = c.author AND d.tag IS NOT NULL)
  GROUP BY tag`;
const tallies = async (db) => {
  const out = {};
  for (const { comet_id, tag, n } of (await db.prepare(TALLY).all()).results)
    (out[comet_id] ??= { comet: 0, asteroid: 0, glitch: 0, unsure: 0 })[tag] = n;
  return out;
};
const cometRow = (c, tags) => ({ id: c.id, kind: c.kind, ra: c.ra, dec: c.dec, day: c.day, tail: c.tail, real: !!c.real, example: !c.real,
  ...(c.track ? { track: JSON.parse(c.track) } : {}),   // [[day, ra, dec], ...] every 10 days: where a known comet was
  ...(c.kind === 'comet' ? { tags: tags[c.id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0 } } : {}) });

// Comets people found plus known objects, for the map's markers
async function comets(url, env) {
  const [rows, tags] = await Promise.all([env.DB.prepare('SELECT id, kind, ra, dec, day, tail, real, track FROM comets').all(), tallies(env.DB)]);
  return json({ comets: rows.results.map(c => cometRow(c, tags)) });
}

// One comet for its page: position, tags, the measured detail (photos, spectrum) and its discussion
async function comet(id, env) {
  const c = await env.DB.prepare('SELECT * FROM comets WHERE id = ?').bind(id).first();
  if (!c) return json({ error: `no comet ${id}` }, 404);
  const [tags, talk] = await Promise.all([tallies(env.DB),
    env.DB.prepare('SELECT author, tag, body, created_at FROM comments WHERE comet_id = ? ORDER BY created_at').bind(id).all()]);
  return json({ ...cometRow(c, tags), tags: tags[id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0 },
    detail: c.detail ? JSON.parse(c.detail) : null, comments: talk.results });
}

// Post a comment (a tag makes it a vote). Turnstile first, so bots cost nothing below it.
const TAGS = ['comet', 'asteroid', 'glitch', 'unsure'];
async function post(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'body must be JSON', field: 'body' }, 400); }
  if (!b || typeof b !== 'object') return json({ error: 'body must be JSON', field: 'body' }, 400);
  const bad = (field, error) => json({ error, field }, 400);
  if (typeof b.comet_id !== 'string' || !b.comet_id) return bad('comet_id', 'comet_id is required');
  const tag = b.tag ?? null;
  if (tag !== null && !TAGS.includes(tag)) return bad('tag', 'tag must be comet, asteroid, glitch or unsure');
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (body.length < 1 || body.length > 1000) return bad('body', 'body must be 1 to 1000 characters');
  const author = typeof b.author === 'string' ? b.author.trim() : '';
  if (!/^[A-Za-z0-9 _.-]{1,24}$/.test(author)) return bad('author', 'author must be 1 to 24 letters, digits, spaces, _ . or -');
  if (typeof b.turnstile !== 'string' || !b.turnstile) return bad('turnstile', 'turnstile token is required');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET ?? '');
  form.append('response', b.turnstile);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  let check = {};
  try { check = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json(); }
  catch (e) { console.error(e); }
  if (check.success !== true) return json({ error: 'human check failed, try again' }, 403);
  // Local dev: the test site key's widget hands out the same dummy token every time, so it is not claimed (the test
  // secret accepts any token anyway). A real secret refuses the dummy token, so this opens nothing in production.
  const claim = !(check.metadata?.result_with_testing_key && b.turnstile === 'XXXX.DUMMY.TOKEN.XXXX');
  const db = env.DB;
  if (!await db.prepare('SELECT 1 FROM comets WHERE id = ?').bind(b.comet_id).first()) return json({ error: `no comet ${b.comet_id}` }, 404);
  const now = Date.now();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.turnstile)))].map(x => x.toString(16).padStart(2, '0')).join('');
  // One batch is one transaction: the rate limit, the comment, the token claim and the tally read happen together.
  // A reused token breaks the UNIQUE key and rolls the comment back; a rate-limited post inserts nothing and keeps the token.
  // ponytail: per-author limit on a free-text nickname; per-IP or signed-in limits once real accounts exist
  let res;
  try {
    res = await db.batch([
      db.prepare(`INSERT INTO comments (comet_id, author, tag, body, created_at) SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM comments WHERE author = ?2 AND created_at > ?5 - 60000) < 5`).bind(b.comet_id, author, tag, body, now),
      db.prepare('INSERT INTO turnstile_tokens (hash, created_at) SELECT ?, ? WHERE ? AND changes() = 1').bind(hash, now, claim ? 1 : 0),
      db.prepare(TALLY_ONE).bind(b.comet_id)
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message) + String(e?.cause?.message))) return json({ error: 'human check already used, try again' }, 403);
    throw e;
  }
  if (res[0].meta.changes !== 1) return json({ error: 'too many comments, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
  const tags = { comet: 0, asteroid: 0, glitch: 0, unsure: 0 };
  for (const { tag: t, n } of res[2].results) tags[t] = n;
  return json({ comment: { comet_id: b.comet_id, author, tag, body, created_at: now }, tags }, 201);
}

// Which patch-sized cells people have checked, and one nobody has, for the heat map and "Unexplored patch"
function explored() {
  const { total, cells } = exploredCells();
  return json({ example: true, total, checked: cells.length, cells, suggest: SUGGEST }, 200, { 'Cache-Control': 'public, max-age=60' });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/api/comments') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });
      try { return await post(request, env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    // live data from D1: never cached here, so a new comment shows at once
    if (url.pathname === '/api/comets' || url.pathname.startsWith('/api/comets/')) {
      let id = null;
      if (url.pathname !== '/api/comets') {
        try { id = decodeURIComponent(url.pathname.slice('/api/comets/'.length)); }
        catch { return json({ error: 'comet id is not valid' }, 400); }
      }
      try { return await (id === null ? comets(url, env) : comet(id, env)); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    const route = { '/api/images': images, '/api/gaia': gaia, '/api/explored': explored }[url.pathname];
    if (!route) return json({ error: 'not found' }, 404);
    const cache = caches.default, hit = await cache.match(request);
    if (hit) return hit;
    const res = await route(url);
    if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  }
};
