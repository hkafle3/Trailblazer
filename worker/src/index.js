// Cloudflare Worker: finds SPHEREx images and Gaia stars for a sky position, for the browser.
// IRSA's search (SIA) and ESA's Gaia archive send no CORS header and IRSA throws intermittent 502s, so this
// proxies both with retries and caches answers for a day. The pixels never pass through here: the browser
// reads them straight from NASA's public S3 copy (see web/live/fits.js).
//   GET /api/images?ra=&dec=&det=D1..D6   GET /api/gaia?ra=&dec=   GET /api/known?ra=&dec=&t=
//   GET /api/comets   GET /api/comets/:id   POST /api/comments   (D1)        GET /api/explored   POST /api/checks   GET /api/posts   GET /api/threads   (D1)   See docs/api.md.
// The same Worker serves the app's files from web/ (wrangler.toml [assets]); only /api/* reaches this code.

import { skyImagesJson, eclipticLat } from './sky_index.js';

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
    objstr: `${p.ra} ${p.dec}`, radius: '144', radunits: 'arcsec', outfmt: '1', selcols: 'ra,dec,pmra,pmdec,phot_g_mean_mag',
    constraints: 'pmra is not null and phot_g_mean_mag < 19' })}`;   // both sources: G < 19, fainter than SPHEREx measures; keeps crowded fields small
  const esa = `https://gea.esac.esa.int/tap-server/tap/sync?${new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv',
    QUERY: `SELECT ra, dec, pmra, pmdec, phot_g_mean_mag AS g FROM gaiadr3.gaia_source WHERE pmra IS NOT NULL AND phot_g_mean_mag < 19 AND 1=CONTAINS(POINT(ra, dec), CIRCLE(${p.ra}, ${p.dec}, 0.04))` })}`;
  const ok = (source, stars) => json({ epoch: 2016.0, source, stars }, 200, { 'Cache-Control': 'public, max-age=86400' });
  try { return ok('IRSA', ipacStars(await fetchRetry(irsa, 2, 10000))); } catch (e) { console.warn('IRSA Gaia', e); }
  try {
    return ok('ESA', esaStars(await fetchRetry(esa, 1, 8000)));
  } catch {
    return json({ error: 'Gaia archive is not answering', retry_after: 30 }, 503, { 'Retry-After': '30' });
  }
}

// ESA's CSV for the query above: five plain numbers a row (ra, dec, pmra, pmdec, g), read straight like ipacStars
function esaStars(text) {
  const lines = text.trim().split('\n');
  if (lines[0]?.replace(/\s/g, '') !== 'ra,dec,pmra,pmdec,g') throw new Error('ESA sent no table');
  const stars = [];
  for (let i = 1; i < lines.length; i++) { const [ra, dec, pmra, pmdec, g] = lines[i].split(',').map(Number); stars.push({ ra, dec, pmra, pmdec, g }); }
  return stars;
}

// IRSA's IPAC table: header lines start with \\ or |, the first | line names the columns, values are space separated
// and "null" when empty. Stars without a proper motion are dropped, as the ESA query did. Values are read straight into
// each star (no per-row temporary objects): a crowded field such as Baade's Window sends about 3,200 rows.
function ipacStars(text) {
  const lines = text.split('\n'), head = lines.find(l => l.startsWith('|'));
  if (!head) throw new Error('IRSA sent no table');
  const cols = head.split('|').map(c => c.trim()).filter(Boolean);
  const [iRa, iDec, iPmra, iPmdec, iG] = ['ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag'].map(k => cols.indexOf(k));
  if ([iRa, iDec, iPmra, iPmdec, iG].includes(-1)) throw new Error('IRSA table is missing a column');
  const stars = [];
  for (const l of lines) {
    const c0 = l.charCodeAt(0);
    if (!l || c0 === 92 || c0 === 124) continue;   // \ or |
    const v = l.trim().split(/\s+/);
    const pmra = +v[iPmra], pmdec = +v[iPmdec];   // "null" -> NaN
    if (pmra === pmra && pmdec === pmdec) stars.push({ ra: +v[iRa], dec: +v[iDec], pmra, pmdec, g: +v[iG] });
  }
  return stars;
}

// hours "16 28 36.29" or degrees "-16 48 16.4" -> decimal degrees
function sexagesimal(text, hours) {
  const n = String(text).trim().match(/[+-]?\d+(?:\.\d+)?/g);
  if (!n) return NaN;
  const sign = /^\s*-/.test(text) ? -1 : 1;
  const [a, b = 0, c = 0] = n.map(x => Math.abs(Number(x)));
  return sign * (a + b / 60 + c / 3600) * (hours ? 15 : 1);
}

// SkyBoT rows -> { comets, asteroids, omitted }, or null when any row cannot be read (then the answer is unavailable,
// never a cached partial or empty result). Comets always; asteroids V <= 21 on the exact magnitude, brightest 8.
function skybotRows(rows) {
  const comets = [], bright = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || typeof r.Class !== 'string' || !r.Class.trim() || !String(r.Name || r.Num || '').trim()) return null;   // no name: unrelated rows would merge into one path
    const hms = /^\s*(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*$/.exec(r['RA (hms)'] ?? ''), dms = /^\s*[+-]?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*$/.exec(r['DEC (dms)'] ?? '');
    if (!hms || !dms || +hms[2] >= 60 || +hms[3] >= 60 || +dms[2] >= 60 || +dms[3] >= 60) return null;
    const ra = sexagesimal(r['RA (hms)'], true), dec = sexagesimal(r['DEC (dms)'], false);
    if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) return null;
    const vm = r['VMag (mag)'];   // a magnitude may be missing (null or empty), never garbled
    if (vm != null && vm !== '' && !Number.isFinite(Number(vm))) return null;
    const mag = Number(vm);
    const body = { name: String(r.Name || r.Num), ra: +ra.toFixed(5), dec: +dec.toFixed(5), mag: Number.isFinite(mag) && mag > 0 ? mag : null, err: Number(r['Err (arcsec)']) || 0 };
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
  const q = new URLSearchParams({
    '-ep': String(t + 2400000.5), '-ra': String(p.ra), '-dec': String(p.dec), '-rd': '0.15',
    '-mime': 'json', '-output': 'object', '-objFilter': '101', '-from': 'comet-hunt',
  });
  let rows;
  try {
    const [status, text] = await fetchRetry(`https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?${q}`, 2, 15000, true);
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
  // for the Comets list: the CO2 verdict of a measured comet, how many SPHEREx photos it is in, and its thumbnail (the
  // brightest of the photos its page shows). Read inside D1, so the Worker never parses the large detail column.
  const [rows, tags] = await Promise.all([env.DB.prepare(`SELECT id, kind, ra, dec, day, tail, real, track,
    json_extract(detail, '$.co2_verdict') AS co2, COALESCE(json_extract(detail, '$.exposures'), json_array_length(detail, '$.spherex')) AS photos,
    json_extract(detail, '$.faint') AS faint,
    'data/comets/' || json_extract(detail, '$.dir') || '/' || (SELECT json_extract(p.value, '$.file') FROM json_each(detail, '$.photos') p
      ORDER BY json_extract(p.value, '$.flux') DESC LIMIT 1) AS thumb
    FROM comets`).all(), tallies(env.DB)]);
  return json({ comets: rows.results.map(c => ({ ...cometRow(c, tags), ...(c.kind === 'known' ? { co2: c.co2, photos: c.photos, faint: !!c.faint, thumb: c.thumb } : {}) })) });
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
    tags: tags[c.id] ?? { comet: 0, asteroid: 0, glitch: 0, unsure: 0 }, last: by[c.id].at(-1).created_at, comments: by[c.id] }));
  return json({ threads: list.sort((a, b) => b.last - a.last) }, 200, { 'Cache-Control': 'no-store' });
}

// The Forums feed: the latest comments across every comet, newest first, with where each comet is
async function posts(env) {
  const rows = (await env.DB.prepare(`SELECT m.comet_id, m.author, m.tag, m.body, m.created_at, c.kind, c.ra, c.dec, c.real
    FROM comments m JOIN comets c ON c.id = m.comet_id WHERE m.body != '' ORDER BY m.created_at DESC, m.id DESC LIMIT 200`).all()).results;
  return json({ posts: rows.map(r => ({ ...r, real: !!r.real })) }, 200, { 'Cache-Control': 'no-store' });
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
// A spot to suggest: RW Aurigae's patch while nobody has opened it, then the unopened cell nearest to it
const SUGGEST = { ra: 77, dec: 30.4 };
const sep = (ra1, d1, ra2, d2) =>
  Math.acos(Math.min(1, Math.sin(d1 * RAD) * Math.sin(d2 * RAD) + Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((ra1 - ra2) * RAD))) / RAD;
// every cell, nearest to RW Aurigae first: worked out once when the Worker starts, so a request only walks the list
// (scanning all 3,339 cells per request came close to the free plan's 10 ms CPU limit)
const NEAR = Array.from({ length: CELLS }, (_, c) => {
  const b = cellBox(c), ra = (b.ra_min + b.ra_max) / 2, dec = (b.dec_min + b.dec_max) / 2;
  return { c, ra: +ra.toFixed(2), dec: +dec.toFixed(2), d: sep(ra, dec, SUGGEST.ra, SUGGEST.dec) };
}).sort((x, y) => x.d - y.d);
function suggest(seen) {
  if (!seen.has(cellAt(SUGGEST.ra, SUGGEST.dec))) return SUGGEST;
  const near = NEAR.find(x => !seen.has(x.c));
  return near ? { ra: near.ra, dec: near.dec } : SUGGEST;   // ponytail: every cell checked keeps RW Aurigae; unreachable in practice
}

// Which patch-sized cells people have opened, and one nobody has, for the heat map and "Unexplored patch".
// Never cached, so a spot shows on the map as soon as someone opens it.
async function explored(env) {
  const rows = (await env.DB.prepare('SELECT cell, n FROM checks WHERE n > 0 AND cell >= 0 AND cell < ?').bind(CELLS).all()).results;
  const cells = rows.map(({ cell, n }) => ({ ...cellBox(cell), checks: n }));
  return json({ total: CELLS, cells, suggest: suggest(new Set(rows.map(r => r.cell))) }, 200, { 'Cache-Control': 'no-store' });
}

// Someone opened a spot (the time-lapse calls this once a live time-lapse has built): one more check for its cell.
// Cloudflare's rate limit (wrangler.toml) runs first, before the body is read, so every request counts, malformed ones too.
// It is per location and approximate; a script spread over many IPs can still light up cells, which only changes the map.
const MAX_CHECK_BODY = 1024;
async function check(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.CHECKS_LIMIT && !(await env.CHECKS_LIMIT.limit({ key: ip })).success) return json({ error: 'too many checks, wait a minute' }, 429);
  const tooBig = () => json({ error: 'body too large', field: 'body' }, 413);
  if (Number(request.headers.get('Content-Length')) > MAX_CHECK_BODY) return tooBig();
  // read at most MAX_CHECK_BODY bytes whatever Content-Length says (it can be absent or wrong with chunked bodies)
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (let r; !(r = await reader.read()).done;) {
        size += r.value.byteLength;
        if (size > MAX_CHECK_BODY) { reader.cancel().catch(() => {}); return tooBig(); }
        chunks.push(r.value);
      }
    } catch { return json({ error: 'body must be JSON', field: 'body' }, 400); }   // a broken upload is the client's fault, not the database's
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let b;
  try { b = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'body must be JSON', field: 'body' }, 400); }
  if (!b || typeof b !== 'object') return json({ error: 'body must be JSON', field: 'body' }, 400);
  if (typeof b.ra !== 'number' || !(b.ra >= 0 && b.ra <= 360)) return json({ error: 'ra must be 0 to 360', field: 'ra' }, 400);
  if (typeof b.dec !== 'number' || !(b.dec >= -90 && b.dec <= 90)) return json({ error: 'dec must be -90 to 90', field: 'dec' }, 400);
  const cell = cellAt(b.ra % 360, b.dec);
  const row = await env.DB.prepare('INSERT INTO checks (cell, n) VALUES (?1, 1) ON CONFLICT(cell) DO UPDATE SET n = n + 1 RETURNING n').bind(cell).first();
  return json({ cell, checks: row.n }, 201);
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
    if (url.pathname === '/api/checks') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { Allow: 'POST' });
      try { return await check(request, env); }
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
