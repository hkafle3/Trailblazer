// Cloudflare Worker: finds SPHEREx images and Gaia stars for a sky position, for the browser.
// IRSA's search (SIA) and ESA's Gaia archive send no CORS header and IRSA throws intermittent 502s, so this
// proxies both with retries and caches answers for a day. The pixels never pass through here: the browser
// reads them straight from NASA's public S3 copy (see web/live/fits.js).
//   GET /api/images?ra=&dec=&det=D1..D6   GET /api/gaia?ra=&dec=   GET /api/known?ra=&dec=&t=   GET /api/depth?ra=&dec=[&t=]
//   GET /api/oldsky?survey=&band=&ra=&dec=   GET /api/oldsky/v1/...   GET /api/blink?ra=&dec=   GET /api/blink/v1/...   (R2 OLDSKY, worker/src/oldsky.js)
//   GET /api/comets   GET /api/comets/:id (with `now`, the daily snapshot: cron, worker/src/now.js)   POST /api/comments   POST /api/candidates   GET /api/candidates/near   POST /api/sightings   (D1)        GET /api/explored   POST /api/checks   GET /api/posts   GET /api/threads   (D1)   See docs/api.md.
// The same Worker serves the app's files from web/ (wrangler.toml [assets]); only /api/* reaches this code.

import { skyImagesJson, eclipticLat } from './sky_index.js';
import { parseCsv, skybotRow, skybotUrl, depthAnswer, devFlags } from './depth.js';
import { snapshot, nowRow } from './now.js';
import { oldsky, stored, blinkBaked } from './oldsky.js';
// the clearest SPHEREx photo of each known comet without measured photos (bake/known_thumbs.py), for the Comets list
import THUMBS from '../../web/data/comets/thumbs/index.json';

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
async function fetchRetry(url, tries = 5, ms = 20000, withStatus = false) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      if (r.ok && !text.startsWith('Server busy') && !text.includes('Proxy Error')) return withStatus ? [r.status, text] : text;
      last = `HTTP ${r.status}`;
    } catch (e) { last = String(e); }
    // short waits: one 502 is common; doubling from 400 ms cost 14 s on 2026-11-14. Capped at 2 s for long retry runs.
    await new Promise(res => setTimeout(res, Math.min(2000, 300 * 1.5 ** i + Math.random() * 200)));
  }
  throw new Error(last);
}

// SPHEREx search results: only the columns we use, all before any quoted field, so a plain split per line is enough.
// The full parser cost about 100 ms of CPU on a deep-field answer (free plan: 10 ms); this costs about 5 ms.
// Any line where that shortcut could be wrong sends the whole answer through the full parser.
const SPX_COLS = ['obs_id', 't_min', 'access_url', 'energy_bandpassname', 'dataproduct_subtype'];
function spherexRows(text) {
  if (text.includes('\r')) return parseCsv(text);   // IRSA ends lines with \n alone; anything else takes the careful path
  const lines = text.split('\n'), head = lines[0].split(',');
  const ix = SPX_COLS.map(k => head.indexOf(k)), need = Math.max(...ix) + 1;
  // unexpected layout (a column missing or named twice, a quoted header): be correct, not fast
  if (ix.includes(-1) || ix.some(i => head.indexOf(head[i], i + 1) !== -1) || lines[0].includes('"')) return parseCsv(text);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(',')) continue;   // the full parser skips one-field lines too
    const f = line.split(',', need), q = line.indexOf('"');
    if (q !== -1) {   // a quote among our columns, or an odd count (a field running onto the next line): parse it all properly
      let end = need - 1, n = 0;
      for (const x of f) end += x.length;
      for (let k = q; k !== -1; k = line.indexOf('"', k + 1)) n++;
      if (q <= end || n % 2) return parseCsv(text);
    }
    out.push(Object.fromEntries(SPX_COLS.map((k, n) => [k, f[ix[n]]])));
  }
  return out;
}
// one wavelength well inside each detector's range (they overlap a little at the edges), so IRSA returns one detector
const BAND = { D1: '8.5e-7 9.5e-7', D2: '1.3e-6 1.4e-6', D3: '1.9e-6 2.1e-6', D4: '3.0e-6 3.2e-6', D5: '4.0e-6 4.2e-6', D6: '4.6e-6 4.8e-6' };

function s3Key(row) {
  try {
    const key = JSON.parse(row.cloud_access).aws.key;
    if (key) return key;
  } catch {}
  return row.access_url.replace('https://irsa.ipac.caltech.edu/ibe/data/spherex/', '');   // same layout (agent check 2026-11-14)
}

async function images(url, env) {
  const p = position(url);
  if (p.error) return json(p, 400);
  const det = url.searchParams.get('det') || 'D1';
  if (!/^D[1-6]$/.test(det)) return json({ error: 'det must be D1 to D6' }, 400);
  // Our own index of the level-2 images (bake/sky_index.py, in R2) answers first; IRSA's search only when it cannot
  // (no binding, a missing file, an R2 error). Same answer: checked against IRSA at 47 D1 positions, 0 differences.
  // The answer is written as JSON text straight from the index rows (the same bytes json() would give), which halves
  // the CPU of a deep-field answer of about 1 MB.
  // skyImagesJson accepts only the pinned version of the file (SKY_ETAG_D1..D6 in wrangler.toml), checks every read and
  // tries once more with a fresh head; if it still cannot answer, IRSA does.
  try {
    return new Response(await skyImagesJson(r2Read(env), p.ra, p.dec, det.slice(1), env[`SKY_ETAG_${det}`]),
      { headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) { console.warn('sky index', e); }
  // the Deep Survey only covers the ecliptic poles (irsa-tutorials spherex_intro); elsewhere skip those searches
  const colls = Math.abs(eclipticLat(p.ra, p.dec)) > 75 ? [...WIDE, ...DEEP] : WIDE;
  // On 2026-11-15 IRSA's search failed most requests with an instant 502 and answered about one in three after ~21 s,
  // so each try waits up to 45 s and the instant failures are retried, one at a time per search. 40 tries are shared
  // out (the free plan allows 50 outside requests per visit, and D1 and the cache need a few).
  const search = coll => fetchRetry(`${SIA}?${new URLSearchParams({ COLLECTION: coll, POS: `CIRCLE ${p.ra} ${p.dec} 0.001`, BAND: BAND[det], RESPONSEFORMAT: 'CSV', MAXREC: '20000' })}`,
    Math.floor(40 / colls.length), 45000).then(spherexRows);
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
  // a failed collection (the deep fields' searches are the slow ones) must never be remembered as "no images"
  const partial = Object.values(counts).includes('failed');
  if (partial && !list.length)
    return json({ error: 'IRSA search is not answering, try again or pick a baked target', retry_after: 30 }, 503, { 'Retry-After': '30' });
  return json({ ra: p.ra, dec: p.dec, det, images: list, collections: counts, source: 'IRSA' }, 200, { 'Cache-Control': partial ? 'no-store' : 'public, max-age=86400' });
}

// skyImagesJson reads byte ranges of d1.bin .. d6.bin from the R2 bucket bound as SKY, each with the file's etag and
// size so it can tell a replaced or short file
const r2Read = env => async (name, offset, length) => {
  if (!env.SKY) throw new Error('no SKY binding');
  const o = await env.SKY.get(name, { range: { offset, length } });
  if (!o) throw new Error(`${name} is not in the sky index bucket`);
  return { buf: await o.arrayBuffer(), etag: o.etag, size: o.size };
};

// Gaia DR3 stars in a 0.04 degree cone, with proper motions. Gaia positions are for 2016.0 and fast stars move far by
// now; the browser propagates and matches. IRSA's copy of Gaia DR3 (its Gator catalog service, about 1.5 s) comes first:
// ESA's own archive stopped answering on 2026-11-14 and every lookup then hung for a minute. ESA is the fallback.
async function gaia(url) {
  const p = position(url);
  if (p.error) return json(p, 400);
  const irsa = `https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?${new URLSearchParams({ catalog: 'gaia_dr3_source', spatial: 'cone',
    objstr: `${p.ra} ${p.dec}`, radius: '144', radunits: 'arcsec', outfmt: '1', selcols: 'ra,dec,pmra,pmdec,phot_g_mean_mag,source_id',
    constraints: 'pmra is not null and phot_g_mean_mag < 19' })}`;   // both sources: G < 19, fainter than SPHEREx measures; keeps crowded fields small
  const esa = `https://gea.esac.esa.int/tap-server/tap/sync?${new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv',
    QUERY: `SELECT ra, dec, pmra, pmdec, phot_g_mean_mag AS g, source_id FROM gaiadr3.gaia_source WHERE pmra IS NOT NULL AND phot_g_mean_mag < 19 AND 1=CONTAINS(POINT(ra, dec), CIRCLE(${p.ra}, ${p.dec}, 0.04))` })}`;
  const ok = (source, stars) => json({ epoch: 2016.0, source, stars }, 200, { 'Cache-Control': 'public, max-age=86400' });
  try { return ok('IRSA', ipacStars(await fetchRetry(irsa, 2, 10000))); } catch (e) { console.warn('IRSA Gaia', e); }
  try {
    return ok('ESA', esaStars(await fetchRetry(esa, 1, 8000)));
  } catch {
    return json({ error: 'Gaia archive is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  }
}

// ESA's CSV for the query above: five plain numbers a row (ra, dec, pmra, pmdec, g) and the Gaia DR3 id, read straight like
// ipacStars. The id stays text: 19 digits are more than a JavaScript number holds exactly.
function esaStars(text) {
  const lines = text.trim().split('\n');
  if (lines[0]?.replace(/\s/g, '') !== 'ra,dec,pmra,pmdec,g,source_id') throw new Error('ESA sent no table');
  const stars = [];
  for (let i = 1; i < lines.length; i++) { const v = lines[i].split(','), [ra, dec, pmra, pmdec, g] = v.map(Number); stars.push({ ra, dec, pmra, pmdec, g, id: v[5].trim() }); }
  return stars;
}

// IRSA's IPAC table: header lines start with \\ or |, the first | line names the columns, values are space separated
// and "null" when empty. Stars without a proper motion are dropped, as the ESA query did. Values are read straight into
// each star (no per-row temporary objects): a crowded field such as Baade's Window sends about 3,200 rows.
function ipacStars(text) {
  const lines = text.split('\n'), head = lines.find(l => l.startsWith('|'));
  if (!head) throw new Error('IRSA sent no table');
  const cols = head.split('|').map(c => c.trim()).filter(Boolean);
  const [iRa, iDec, iPmra, iPmdec, iG, iId] = ['ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag', 'source_id'].map(k => cols.indexOf(k));
  if ([iRa, iDec, iPmra, iPmdec, iG, iId].includes(-1)) throw new Error('IRSA table is missing a column');
  const stars = [];
  for (const l of lines) {
    const c0 = l.charCodeAt(0);
    if (!l || c0 === 92 || c0 === 124) continue;   // \ or |
    const v = l.trim().split(/\s+/);
    const pmra = +v[iPmra], pmdec = +v[iPmdec];   // "null" -> NaN
    if (pmra === pmra && pmdec === pmdec) stars.push({ ra: +v[iRa], dec: +v[iDec], pmra, pmdec, g: +v[iG], id: v[iId] });
  }
  return stars;
}

// SkyBoT rows -> { comets, asteroids, omitted }, or null when any row cannot be read (then the answer is unavailable,
// never a cached partial or empty result). Comets always; asteroids V <= 21 on the exact magnitude, brightest 8.
function skybotRows(rows) {
  const comets = [], bright = [];
  for (const r of rows) {
    const body = skybotRow(r);
    if (!body) return null;
    if (r.Class === 'Comet') comets.push(body);
    else if (body.mag != null && body.mag <= 21) bright.push(body);
  }
  bright.sort((a, b) => a.mag - b.mag);
  const out = b => ({ ...b, mag: b.mag == null ? null : +b.mag.toFixed(1) });   // round only for the answer
  return { comets: comets.map(out), asteroids: bright.slice(0, 8).map(out), omitted: Math.max(0, bright.length - 8) };
}

// Known comets and asteroids in a time-lapse frame at its time, from IMCCE SkyBoT (planets left out). Geocentric.
// Asteroids fainter than V = 21 are dropped and at most 8 kept; comets are kept even without a magnitude.
// From kzkei's version (branch include-documentation-and-scope). Contract: docs/api.md.
async function known(url) {
  const p = position(url);
  if (p.error) return json(p, 400);
  const t = Number(url.searchParams.get('t'));
  if (!url.searchParams.has('t') || !Number.isFinite(t) || t < 40000 || t > 80000) return json({ error: 't must be an MJD' }, 400);
  let rows;
  try {
    const [status, text] = await fetchRetry(skybotUrl(p.ra, p.dec, t, 'object'), 2, 15000, true);
    // SkyBoT says "nothing in the cone" with 204; a blank 200 is a broken answer, never a cached "nothing here"
    rows = status === 204 ? [] : text.trim() ? JSON.parse(text) : null;
  } catch {
    return json({ error: 'SkyBoT is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  }
  if (!Array.isArray(rows)) return json({ error: 'SkyBoT is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  const read = skybotRows(rows);
  if (!read) return json({ error: 'SkyBoT is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  return json({ ra: p.ra, dec: p.dec, t, ...read }, 200, { 'Cache-Control': 'public, max-age=86400' });
}

// Per-patch Depth view data (worker/src/depth.js, contract in docs/api.md). Each source is cached on its own in the Cache
// API and never saved to D1: in an outage a source says "unavailable" rather than serving an older answer.
async function depth(url, env, ctx) {
  const p = position(url);
  if (p.error) return json(p, 400);
  let t = null;
  if (url.searchParams.has('t')) {
    t = Number(url.searchParams.get('t'));
    if (!Number.isFinite(t) || t < 40000 || t > 80000) return json({ error: 't must be an MJD' }, 400);
    t = +t.toFixed(4);
  }
  const { body, complete } = await depthAnswer({ ra: +p.ra.toFixed(4) % 360, dec: +p.dec.toFixed(4), t }, {
    get: url => fetchRetry(url, 2, 8000), getWithStatus: url => fetchRetry(url, 2, 15000, true),
    cache: caches.default, waitUntil: job => ctx.waitUntil(job), ...devFlags(url, env) });
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': complete ? 'public, max-age=3600' : 'no-store' } });
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
    (out[comet_id] ??= { comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 })[tag] = n;
  return out;
};
const cometRow = (c, tags) => ({ id: c.id, kind: c.kind, ra: c.ra, dec: c.dec, day: c.day, tail: c.tail, real: !!c.real,
  ...(c.track ? { track: JSON.parse(c.track) } : {}),   // [[day, ra, dec], ...] every 10 days: where a known comet was
  ...(c.kind === 'comet' ? { tags: tags[c.id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 } } : {}),
  ...(c.visit ? { candidate: true, det: c.det, visit: c.visit, author: c.author, created_at: c.created_at } : {}) });   // reported from a time-lapse

// Comets people found plus known objects, for the map's markers
async function comets(url, env) {
  // for the Comets list: the CO2 verdict of a measured comet, how many SPHEREx photos it is in, and its thumbnail (the
  // brightest of the photos its page shows; for a known comet without them, its clearest baked SPHEREx photo, THUMBS).
  // Read inside D1, so the Worker never parses the large detail column.
  const [rows, tags] = await Promise.all([env.DB.prepare(`SELECT id, kind, ra, dec, day, tail, real, track, det, visit, author, created_at,
    json_extract(detail, '$.co2_verdict') AS co2, COALESCE(json_extract(detail, '$.exposures'), json_array_length(detail, '$.spherex')) AS photos,
    json_extract(detail, '$.faint') AS faint,
    json_extract(detail, '$.facts.inv.n') AS pictures, json_extract(detail, '$.facts.inv.first') AS first, json_extract(detail, '$.facts.inv.last') AS last,
    (SELECT count(*) FROM json_each(detail, '$.facts.inv.visits') v WHERE json_extract(v.value, '$.verdict') = 'seen') AS seen,
    (SELECT count(*) FROM json_each(detail, '$.facts.inv.visits') v WHERE json_extract(v.value, '$.verdict') != 'unmeasured') AS measured,
    (SELECT count(*) FROM json_each(detail, '$.facts.inv.visits') v WHERE json_extract(v.value, '$.verdict') = 'parent') AS parent,
    (SELECT count(*) FROM json_each(detail, '$.facts.inv.visits') v WHERE json_extract(v.value, '$.verdict') = 'unseen') AS unseen,
    json_array_length(detail, '$.facts.inv.visits') AS visits,
    json_extract(detail, '$.facts.peri.prev.jd') AS peri_prev, json_extract(detail, '$.facts.peri.next.jd') AS peri_next,
    'data/comets/' || json_extract(detail, '$.dir') || '/' || (SELECT json_extract(p.value, '$.file') FROM json_each(detail, '$.photos') p
      ORDER BY json_extract(p.value, '$.flux') DESC LIMIT 1) AS thumb
    FROM comets`).all(), tallies(env.DB)]);
  return json({ comets: rows.results.map(c => ({ ...cometRow(c, tags), ...(c.kind === 'known' ? { co2: c.co2, photos: c.photos, faint: !!c.faint, pictures: c.pictures, first: c.first, last: c.last, seen: c.seen, measured: c.measured, parent: c.parent, unseen: c.unseen,
    visits: c.visits, peri_prev: c.peri_prev, peri_next: c.peri_next, thumb: c.thumb ?? (THUMBS[c.id] ? `data/comets/thumbs/${THUMBS[c.id].file}` : null) } : {}) })) });
}

// One comet for its page: position, tags, the measured detail (photos, spectrum) and its discussion
async function comet(id, env) {
  const c = await env.DB.prepare('SELECT * FROM comets WHERE id = ?').bind(id).first();
  if (!c) return json({ error: `no comet ${id}` }, 404);
  const [tags, talk, now] = await Promise.all([tallies(env.DB),
    env.DB.prepare('SELECT author, tag, body, created_at FROM comments WHERE comet_id = ? ORDER BY created_at').bind(id).all(),
    env.DB.prepare('SELECT as_of, soln, now FROM comet_now WHERE id = ?').bind(id).first()]);
  return json({ ...cometRow(c, tags), tags: tags[id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 },
    detail: c.detail ? JSON.parse(c.detail) : null, now: nowRow(now), comments: talk.results });
}

// Every comet with written comments is a thread, for the Forums page: the comet, its votes and its comments, oldest
// first; threads with the newest comment first. Votes with no text stay out (they are counted in tags).
async function threads(env) {
  const [rows, talk, tags] = await Promise.all([
    env.DB.prepare(`SELECT id, kind, ra, dec, day, real FROM comets WHERE id IN (SELECT comet_id FROM comments WHERE body != '')`).all(),
    env.DB.prepare(`SELECT comet_id, author, tag, body, created_at FROM comments WHERE body != '' ORDER BY created_at, id`).all(),
    tallies(env.DB)]);
  const by = {};
  for (const { comet_id, ...c } of talk.results) (by[comet_id] ??= []).push(c);
  const list = rows.results.map(c => ({ id: c.id, kind: c.kind, ra: c.ra, dec: c.dec, day: c.day, real: !!c.real,
    tags: tags[c.id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 }, last: by[c.id].at(-1).created_at, comments: by[c.id] }));
  return json({ threads: list.sort((a, b) => b.last - a.last) }, 200, { 'Cache-Control': 'no-store' });
}

// The Forums feed: the latest comments across every comet, newest first, with where each comet is
async function posts(env) {
  const rows = (await env.DB.prepare(`SELECT m.comet_id, m.author, m.tag, m.body, m.created_at, c.kind, c.ra, c.dec, c.real
    FROM comments m JOIN comets c ON c.id = m.comet_id WHERE m.body != '' ORDER BY m.created_at DESC, m.id DESC LIMIT 200`).all()).results;
  return json({ posts: rows.map(r => ({ ...r, real: !!r.real })) }, 200, { 'Cache-Control': 'no-store' });
}

// Post a comment (a tag makes it a vote). Turnstile first, so bots cost nothing below it.
const TAGS = ['comet', 'asteroid', 'glitch', 'unsure', 'star'], AUTHOR = /^[A-Za-z0-9 _.-]{1,24}$/;
// Turnstile: { claim, hash } for a token that passed, or { refused: response }. Callers claim the hash in the same
// batch as their write, so one token pays for one write.
async function human(b, request, env) {
  if (typeof b.turnstile !== 'string' || !b.turnstile) return { refused: json({ error: 'turnstile token is required', field: 'turnstile' }, 400) };
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET ?? '');
  form.append('response', b.turnstile);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  let check = {};
  try { check = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json(); }
  catch (e) { console.error(e); }
  if (check.success !== true) return { refused: json({ error: 'human check failed, try again' }, 403) };
  // Local dev: the test site key's widget hands out the same dummy token every time, so it is not claimed (the test
  // secret accepts any token anyway). A real secret refuses the dummy token, so this opens nothing in production.
  const claim = !(check.metadata?.result_with_testing_key && b.turnstile === 'XXXX.DUMMY.TOKEN.XXXX');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.turnstile)))].map(x => x.toString(16).padStart(2, '0')).join('');
  return { claim, hash };
}
async function post(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'body must be JSON', field: 'body' }, 400); }
  if (!b || typeof b !== 'object') return json({ error: 'body must be JSON', field: 'body' }, 400);
  const bad = (field, error) => json({ error, field }, 400);
  if (typeof b.comet_id !== 'string' || !b.comet_id) return bad('comet_id', 'comet_id is required');
  const tag = b.tag ?? null;
  if (tag !== null && !TAGS.includes(tag)) return bad('tag', 'tag must be comet, asteroid, glitch, unsure or star');
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  // a tag alone is a vote (the candidate page's Tags card); without a tag there must be words
  if (body.length < (tag ? 0 : 1) || body.length > 1000) return bad('body', 'body must be 1 to 1000 characters');
  const author = typeof b.author === 'string' ? b.author.trim() : '';
  if (!AUTHOR.test(author)) return bad('author', 'author must be 1 to 24 letters, digits, spaces, _ . or -');
  const h = await human(b, request, env);
  if (h.refused) return h.refused;
  const { claim, hash } = h;
  const db = env.DB;
  if (!await db.prepare('SELECT 1 FROM comets WHERE id = ?').bind(b.comet_id).first()) return json({ error: `no comet ${b.comet_id}` }, 404);
  const now = Date.now();
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
  const tags = { comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 };
  for (const { tag: t, n } of res[2].results) tags[t] = n;
  return json({ comment: { comet_id: b.comet_id, author, tag, body, created_at: now }, tags }, 201);
}

// ---------- candidates: "Discuss this" on the time-lapse (docs/api.md) ----------
// One moving dot in one visit is one candidate. A report within 1 arcmin of a candidate in the same visit joins that
// thread instead: the check runs inside the insert, in one D1 batch (one transaction), so two posts at once make one row.
const NEAR_DEG = 1 / 60, MJD0 = 60789;   // MJD0: day 0 of Explore's timeline (web/skymap.js)
const DATE = /^\d{4}-\d{2}-\d{2}$/, ZERO = () => ({ comet: 0, asteroid: 0, glitch: 0, unsure: 0, star: 0 });
// candidates within NEAR_DEG of (?1 ra, ?2 dec) whose visit shares a day with ?3 to ?6 (first and last day; NULL: any
// visit). A visit's days, not its first day alone: the exposures in a visit depend on the channel and detector it was
// built at, so one dot seen in one visit can start a day apart. ?4 is cos(dec): flat sky is exact enough at 1 arcmin;
// RA wraps at 0/360. ?5 is NEAR_DEG.
const NEAR_SQL = `visit IS NOT NULL AND (?3 IS NULL OR (visit <= ?6 AND coalesce(json_extract(detail, '$.candidate.visit.end'), visit) >= ?3))
  AND abs(dec - ?2) <= ?5 AND
  (min(abs(ra - ?1), 360 - abs(ra - ?1)) * ?4) * (min(abs(ra - ?1), 360 - abs(ra - ?1)) * ?4) + (dec - ?2) * (dec - ?2) <= ?5 * ?5`;
const nearArgs = (ra, dec, from, to = from) => [ra, dec, from, Math.cos(dec * RAD), NEAR_DEG, to];
const CAND_COLS = `id, ra, dec, det, visit, json_extract(detail, '$.candidate.visit.end') AS visit_end,
  json_extract(detail, '$.candidate.channel') AS channel, author, created_at`;

// the visit as the time-lapse knows it (live/pipeline.js frames): first and last day, mean time, exposures, wavelength
function readVisit(v) {
  if (!v || typeof v !== 'object') return null;
  const { start, end, mjd, exposures, lam, epochs } = v;
  if (typeof start !== 'string' || !DATE.test(start) || !Number.isFinite(Date.parse(start))) return null;
  if (typeof end !== 'string' || !DATE.test(end) || !Number.isFinite(Date.parse(end)) || end < start) return null;
  if (typeof mjd !== 'number' || !(mjd >= MJD0 - 30 && mjd <= MJD0 + 3000)) return null;
  // the dates are this visit's: its mean time falls in its first to last day, and a visit spans at most 14 days (live/pipeline.js visits())
  const first = Date.parse(start) / 864e5 + 40587, last = Date.parse(end) / 864e5 + 40587;
  if (!(mjd >= first && mjd < last + 1 && last - first <= 14)) return null;
  if (!Number.isInteger(exposures) || exposures < 1 || exposures > 1000) return null;
  if (typeof lam !== 'number' || !(lam >= 0.7 && lam <= 5.1)) return null;
  if (epochs !== undefined && !(Array.isArray(epochs) && epochs.length <= 100 && epochs.every(t => typeof t === 'number' && Math.abs(t - mjd) <= 30))) return null;
  return { start, end, mjd: +mjd.toFixed(5), exposures, lam: +lam.toFixed(4), ...(epochs ? { epochs: epochs.map(t => +t.toFixed(5)) } : {}) };
}
// where and when, and who: the fields a candidate and a sighting share. { spot } or { refused }
function readSpot(b) {
  const bad = (field, error) => ({ refused: json({ error, field }, 400) });
  if (typeof b.ra !== 'number' || !(b.ra >= 0 && b.ra < 360)) return bad('ra', 'ra must be 0 to 360');
  if (typeof b.dec !== 'number' || !(b.dec >= -90 && b.dec <= 90)) return bad('dec', 'dec must be -90 to 90');
  if (typeof b.det !== 'string' || !/^D[1-6]$/.test(b.det)) return bad('det', 'det must be D1 to D6');
  const visit = readVisit(b.visit);
  if (!visit) return bad('visit', 'visit must be {start, end, mjd, exposures, lam} from a SPHEREx visit');
  // the Spectral channel the time-lapse was built at (1 to 102, 17 per detector, as in ?ch=), or none: the best-covered wavelength
  const channel = b.channel ?? null;
  if (channel !== null && !(Number.isInteger(channel) && channel >= 1 && channel <= 102 && `D${Math.ceil(channel / 17)}` === b.det))
    return bad('channel', 'channel must be 1 to 102, on the detector det');
  const author = typeof b.author === 'string' ? b.author.trim() : '';
  if (!AUTHOR.test(author)) return bad('author', 'author must be 1 to 24 letters, digits, spaces, _ . or -');
  return { spot: { ra: +b.ra.toFixed(6), dec: +b.dec.toFixed(6), det: b.det, channel, visit, author } };
}
// Cloudflare's rate limit (wrangler.toml CANDIDATES_LIMIT), per IP and per route, before the body is read
async function limited(request, env, route) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (!env.CANDIDATES_LIMIT || (await env.CANDIDATES_LIMIT.limit({ key: `${route}:${ip}` })).success) return null;
  return json({ error: 'too many reports, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
}

// POST /api/candidates: a new candidate (201) or, within 1 arcmin in the same visit, the existing one (200, merged).
// Either way the tag (and comment) goes into that thread as the poster's vote.
async function createCandidate(request, env) {
  const slow = await limited(request, env, 'new');
  if (slow) return slow;
  const read = await readJson(request, 8192);
  if (read.refused) return read.refused;
  const b = read.body, r = readSpot(b);
  if (r.refused) return r.refused;
  const s = r.spot;
  if (!TAGS.includes(b.tag)) return json({ error: 'tag must be comet, asteroid, glitch, unsure or star', field: 'tag' }, 400);
  if (b.body !== undefined && typeof b.body !== 'string') return json({ error: 'body must be text', field: 'body' }, 400);
  const body = (b.body ?? '').trim();
  if (body.length > 1000) return json({ error: 'body must be at most 1000 characters', field: 'body' }, 400);
  const h = await human(b, request, env);
  if (h.refused) return h.refused;
  const db = env.DB, now = Date.now(), near = nearArgs(s.ra, s.dec, s.visit.start, s.visit.end);
  // what the candidate page rebuilds its frames with: the detector and channel it was reported at
  const detail = JSON.stringify({ candidate: { visit: s.visit, det: s.det, channel: s.channel } });
  let res;
  try {
    res = await db.batch([
      // the next free id, C-0175 and up; nothing when a candidate is already within 1 arcmin in this visit
      db.prepare(`INSERT INTO comets (id, kind, ra, dec, day, tail, real, detail, det, visit, author, created_at)
        SELECT (SELECT printf('C-%04d', coalesce(max(CAST(substr(id, 3) AS INTEGER)), 174) + 1) FROM comets WHERE id GLOB 'C-[0-9][0-9][0-9][0-9]'),
          'comet', ?1, ?2, ?7, -150, 1, ?8, ?9, ?3, ?10, ?11
        WHERE NOT EXISTS (SELECT 1 FROM comets WHERE ${NEAR_SQL})`).bind(...near, Math.max(0, Math.floor(s.visit.mjd - MJD0)), detail, s.det, s.author, now),
      db.prepare(`INSERT INTO comments (comet_id, author, tag, body, created_at)
        SELECT id, ?7, ?8, ?9, ?10 FROM comets WHERE ${NEAR_SQL} ORDER BY created_at, id LIMIT 1`).bind(...near, s.author, b.tag, body, now),
      db.prepare('INSERT INTO turnstile_tokens (hash, created_at) SELECT ?, ? WHERE ? AND changes() = 1').bind(h.hash, now, h.claim ? 1 : 0),
      db.prepare(`SELECT ${CAND_COLS} FROM comets WHERE ${NEAR_SQL} ORDER BY created_at, id LIMIT 1`).bind(...near),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message) + String(e?.cause?.message))) return json({ error: 'human check already used, try again' }, 403);
    throw e;
  }
  const c = res[3].results[0], created = res[0].meta.changes === 1;
  return json({ id: c.id, ...(created ? { created: true } : { merged: true }), candidate: c }, created ? 201 : 200);
}

// GET /api/candidates/near?ra=&dec=[&visit=YYYY-MM-DD]: candidates within 1 arcmin, oldest first, with their tallies
async function nearCandidates(url, env) {
  const p = position(url);
  if (p.error) return json(p, 400);
  const visit = url.searchParams.get('visit');
  if (visit !== null && !DATE.test(visit)) return json({ error: 'visit must be YYYY-MM-DD' }, 400);
  const [rows, tags] = await Promise.all([
    env.DB.prepare(`SELECT ${CAND_COLS} FROM comets WHERE ${NEAR_SQL} ORDER BY created_at, id LIMIT 50`).bind(...nearArgs(p.ra, p.dec, visit)).all(),
    tallies(env.DB)]);
  return json({ candidates: rows.results.map(c => ({ ...c, tags: tags[c.id] ?? ZERO(), sep: +(sep(p.ra, p.dec, c.ra, c.dec) * 3600).toFixed(1) })) },
    200, { 'Cache-Control': 'no-store' });
}

// POST /api/sightings: "It's <name>", a dot matched to a known object. Stored and nothing else (no candidate, no page).
const KNOWN_NAME = /^[A-Za-z0-9 ()\/'._+-]{1,40}$/;
async function sighting(request, env) {
  const slow = await limited(request, env, 'seen');
  if (slow) return slow;
  const read = await readJson(request, 4096);
  if (read.refused) return read.refused;
  const b = read.body, r = readSpot(b);
  if (r.refused) return r.refused;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!KNOWN_NAME.test(name)) return json({ error: 'name must be a catalog name, 1 to 40 characters', field: 'name' }, 400);
  const s = r.spot, now = Date.now();
  const row = await env.DB.prepare('INSERT INTO sightings (name, ra, dec, det, visit, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(name, s.ra, s.dec, s.det, s.visit.start, s.author, now).first();
  return json({ sighting: { id: row.id, name, ra: s.ra, dec: s.dec, det: s.det, visit: s.visit.start, author: s.author, created_at: now } }, 201);
}

// The heat map's grid: 51 bands of Dec from the north pole, each cut into about 3.5 degree steps of RA (one SPHEREx
// patch). A cell's number is its position in the grid, band by band.
const BANDS = 51, DEC_STEP = 180 / BANDS, RAD = Math.PI / 180;
const GRID = [];   // per band: [first cell number, cells in the band]
for (let i = 0, k = 0; i < BANDS; i++) {
  const n = Math.max(1, Math.round(360 * Math.cos((90 - (i + .5) * DEC_STEP) * RAD) / 3.5));
  GRID.push([k, n]); k += n;
}
const CELLS = GRID[BANDS - 1][0] + GRID[BANDS - 1][1];
const cellAt = (ra, dec) => {
  const i = Math.min(BANDS - 1, Math.floor((90 - dec) / DEC_STEP)), [k, n] = GRID[i];
  return k + Math.min(n - 1, Math.floor(ra / 360 * n));
};
const cellBox = c => {
  let i = 0; while (i + 1 < BANDS && GRID[i + 1][0] <= c) i++;
  const [k, n] = GRID[i], j = c - k, r = x => +x.toFixed(3);
  return { ra_min: r(360 * j / n), ra_max: r(360 * (j + 1) / n), dec_min: r(90 - (i + 1) * DEC_STEP), dec_max: r(90 - i * DEC_STEP) };
};
// angle between two sky positions, in degrees
const sep = (ra1, d1, ra2, d2) =>
  Math.acos(Math.min(1, Math.sin(d1 * RAD) * Math.sin(d2 * RAD) + Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((ra1 - ra2) * RAD))) / RAD;
// Galactic latitude (J2000 north galactic pole at RA 192.85948, Dec 27.12825)
const galacticLat = (ra, dec) => Math.asin(Math.sin(dec * RAD) * Math.sin(27.12825 * RAD)
  + Math.cos(dec * RAD) * Math.cos(27.12825 * RAD) * Math.cos((ra - 192.85948) * RAD)) / RAD;
// Cells worth suggesting for a first look: away from the crowded Milky Way plane (|b| > 10) and outside the deep-field
// polar caps (|ecliptic latitude| < 75). Worked out once per isolate, so a request only walks this list
// (scanning all 3,339 cells with trig per request came close to the free plan's 10 ms CPU limit).
const ELIGIBLE = Array.from({ length: CELLS }, (_, c) => {
  const b = cellBox(c), ra = (b.ra_min + b.ra_max) / 2, dec = (b.dec_min + b.dec_max) / 2;
  return { c, ra: +ra.toFixed(2), dec: +dec.toFixed(2), ok: Math.abs(galacticLat(ra, dec)) > 10 && Math.abs(eclipticLat(ra, dec)) < 75 };
}).filter(x => x.ok);
// A spot to suggest: one of the eligible cells with the fewest checks (unchecked first), picked at random per request
function suggest(counts) {
  let low = Infinity, pick = [];
  for (const x of ELIGIBLE) {
    const n = counts.get(x.c) ?? 0;
    if (n < low) { low = n; pick = [x]; } else if (n === low) pick.push(x);
  }
  const { ra, dec } = pick[Math.floor(Math.random() * pick.length)];
  return { ra, dec };
}

// Which patch-sized cells people have opened, and one nobody has, for the heat map and "Unexplored patch".
// Never cached, so a spot shows on the map as soon as someone opens it.
async function explored(env) {
  const rows = (await env.DB.prepare('SELECT cell, n FROM checks WHERE n > 0 AND cell >= 0 AND cell < ?').bind(CELLS).all()).results;
  const cells = rows.map(({ cell, n }) => ({ ...cellBox(cell), checks: n }));
  return json({ total: CELLS, cells, suggest: suggest(new Map(rows.map(r => [r.cell, r.n]))) }, 200, { 'Cache-Control': 'no-store' });
}

// Someone opened a spot (the time-lapse calls this once a live time-lapse has built): one more check for its cell.
// Cloudflare's rate limit (wrangler.toml) runs first, before the body is read, so every request counts, malformed ones too.
// It is per location and approximate; a script spread over many IPs can still light up cells, which only changes the map.
const MAX_CHECK_BODY = 1024;
// A JSON object body of at most max bytes: { body } or { refused: response }
async function readJson(request, max) {
  const tooBig = { refused: json({ error: 'body too large', field: 'body' }, 413) }, notJson = { refused: json({ error: 'body must be JSON', field: 'body' }, 400) };
  if (Number(request.headers.get('Content-Length')) > max) return tooBig;
  // read at most max bytes whatever Content-Length says (it can be absent or wrong with chunked bodies)
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (let r; !(r = await reader.read()).done;) {
        size += r.value.byteLength;
        if (size > max) { reader.cancel().catch(() => {}); return tooBig; }
        chunks.push(r.value);
      }
    } catch { return notJson; }   // a broken upload is the client's fault, not the database's
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let b;
  try { b = JSON.parse(new TextDecoder().decode(bytes)); } catch { return notJson; }
  return b && typeof b === 'object' && !Array.isArray(b) ? { body: b } : notJson;
}
async function check(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.CHECKS_LIMIT && !(await env.CHECKS_LIMIT.limit({ key: ip })).success) return json({ error: 'too many checks, wait a minute' }, 429);
  const read = await readJson(request, MAX_CHECK_BODY);
  if (read.refused) return read.refused;
  const b = read.body;
  if (typeof b.ra !== 'number' || !(b.ra >= 0 && b.ra <= 360)) return json({ error: 'ra must be 0 to 360', field: 'ra' }, 400);
  if (typeof b.dec !== 'number' || !(b.dec >= -90 && b.dec <= 90)) return json({ error: 'dec must be -90 to 90', field: 'dec' }, 400);
  const cell = cellAt(b.ra % 360, b.dec);
  const row = await env.DB.prepare('INSERT INTO checks (cell, n) VALUES (?1, 1) ON CONFLICT(cell) DO UPDATE SET n = n + 1 RETURNING n').bind(cell).first();
  return json({ cell, checks: row.n }, 201);
}

export default {
  // the daily "right now" snapshot of each known comet (worker/src/now.js; wrangler.toml [triggers])
  async scheduled(event, env, ctx) { ctx.waitUntil(snapshot(env).then(r => console.log('snapshot', JSON.stringify(r)))); },
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/api/comments') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });
      try { return await post(request, env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    if (url.pathname === '/api/checks') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });
      try { return await check(request, env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    const write = { '/api/candidates': createCandidate, '/api/sightings': sighting }[url.pathname];
    if (write) {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });
      try { return await write(request, env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    if (url.pathname === '/api/candidates/near') {
      try { return await nearCandidates(url, env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    if (url.pathname === '/api/posts') {
      try { return await posts(env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    if (url.pathname === '/api/explored') {
      try { return await explored(env); }
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
    if (url.pathname === '/api/threads') {
      try { return await threads(env); }
      catch (e) { console.error(e); return json({ error: 'database is not answering, try again' }, 503); }
    }
    if (url.pathname === '/api/depth') return depth(url, env, ctx);   // its own per-source cache, no saved fallback
    // "Then and now": the older survey's tiles (R2 first, IRSA on a rate-limited miss) and the baked showcase blink
    if (url.pathname === '/api/oldsky' || url.pathname === '/api/blink' || url.pathname.startsWith('/api/oldsky/') || url.pathname.startsWith('/api/blink/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'use GET' }, 405, { Allow: 'GET' });
      try {
        if (url.pathname === '/api/oldsky') return await oldsky(request, url, env);
        if (url.pathname === '/api/blink') return await blinkBaked(url, env);
        return await stored(url, env);
      } catch (e) { console.error(e); return json({ error: 'older survey unavailable', reason: 'store is not answering' }, 503, { 'Cache-Control': 'no-store' }); }
    }
    const route = { '/api/images': images, '/api/gaia': gaia, '/api/known': known }[url.pathname];
    if (!route) return json({ error: 'not found' }, 404);
    // v2: answers cached before 2026-11-14's fix could hold a failed deep-field search as "no images"
    // keyed like the saved copy (only the parameters a search reads), so junk parameters cannot force fresh searches;
    // the old full-URL key is tried once on a miss, so answers cached before 2026-11-15 still serve (and get saved)
    const id = savedKey(url), key = new URL(url.origin + id), old = new URL(url);
    key.searchParams.set('cache', 'v2'); old.searchParams.set('cache', 'v2');
    const cache = caches.default, hit = await cache.match(key) || await cache.match(old);
    if (hit) { ctx.waitUntil(backfill(env, id, hit.clone()).catch(e => console.warn('saving cached search', e))); return hit; }
    const res = await withSaved(route, url, id, env, ctx);
    if (complete(res)) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
};

// IRSA's image search answered 502 for hours on 2026-11-15. Every complete answer is also kept in D1, and when the
// service fails (or answers only in part) the last complete answer to that exact search is served instead, uncached,
// so a spot that worked once keeps working through an outage and fresh answers return as soon as the service does.
const SAVED_MAX = 100e6, PART = 500000;   // bytes kept (the migration's CHECK is the hard cap); characters a row (under 2 MB at 3 bytes each)
const complete = res => res.status === 200 && !/no-store/.test(res.headers.get('Cache-Control') || '');
// keyed on the parameters the searches read, exactly as sent (a bad value misses and gets its 400), plus v, which marks a
// new answer shape and is read by no search, cut to 8 characters. Junk parameters add no keys; save() skips long keys.
const savedKey = url => url.pathname + '?' + new URLSearchParams(['ra', 'dec', 'det', 't', 'v'].filter(n => url.searchParams.has(n))
  .map(n => [n, n === 'v' ? url.searchParams.get(n).slice(0, 8) : url.searchParams.get(n)]));

// One transaction. An answer saved less than a day before this one, or after it, is kept as it is and nothing is written:
// each data center's cache misses on its own, and rewriting a 2 MB answer for each would spend D1's daily writes. So only
// answers over a day older are deleted, and the parts go in only when no other answer from that window is there (checked
// inside the transaction, so two saves at once write once). Past the byte cap an insert fails and all of it rolls back.
// The first read skips the work early; text() is read only when the save goes ahead.
const DAY = 86400e3;
async function save(env, id, text, at) {
  if (id.length > 120) return;
  const r = await env.DB.prepare('SELECT (SELECT n FROM saved_bytes) AS n, (SELECT saved_at FROM searches WHERE key = ? AND part = 0) AS at, ' +
    'coalesce((SELECT sum(length(CAST(body AS BLOB)) + 2 * length(CAST(key AS BLOB)) + 64) FROM searches WHERE key = ?), 0) AS old').bind(id, id).first();
  if (r.at !== null && r.at > at - DAY) return;
  const body = await text();
  if (r.n - r.old + body.length > SAVED_MAX) return;   // ponytail: a full store takes no new searches; evict the oldest if that ever bites
  const parts = [];
  for (let i = 0; i < body.length; i += PART) parts.push(body.slice(i, i + PART));   // a deep field's answer can pass 2 MB
  await env.DB.batch([env.DB.prepare('DELETE FROM searches WHERE key = ? AND saved_at <= ?').bind(id, at - DAY),
    ...parts.map((b, i) => env.DB.prepare('INSERT INTO searches (key, part, body, saved_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM searches WHERE key = ? AND saved_at > ? AND saved_at <> ?)')
      .bind(id, i, b, at, id, at - DAY, at))]);
}

// a cached answer with none saved (answers cached before saving existed, or a save that failed while D1 was down), or
// more than a day newer than the saved one, is saved on its next cache hit, so it survives an outage too
async function backfill(env, id, hit) {
  if (complete(hit)) await save(env, id, () => hit.text(), Number(hit.headers.get('X-Answered-At')) || Date.parse(hit.headers.get('Date')) || 0);
}

async function withSaved(route, url, id, env, ctx) {
  const res = await route(url, env);
  if (complete(res)) {
    const at = Date.now();
    res.headers.set('X-Answered-At', String(at));   // kept with the cached copy, so a later backfill knows its age
    const copy = res.clone();   // read after the answer has gone out, so saving never delays or endangers it
    ctx.waitUntil(save(env, id, () => copy.text(), at).catch(e => console.warn('saving search', e)));   // D1 down: just not saved this time
    return res;
  }
  if (res.status !== 200 && res.status < 500) return res;   // a bad request stays an error
  let rows = [];
  try { rows = (await env.DB.prepare('SELECT body, saved_at FROM searches WHERE key = ? ORDER BY part').bind(id).all()).results; } catch {}
  if (!rows.length) return res;
  return new Response(rows.map(r => r.body).join(''), { status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'no-store', 'X-Saved-At': new Date(rows[0].saved_at).toISOString() } });
}
