// Cloudflare Worker: finds SPHEREx images and Gaia stars for a sky position, for the browser.
// IRSA's search (SIA) and ESA's Gaia archive send no CORS header and IRSA throws intermittent 502s, so this
// proxies both with retries and caches answers for a day. The pixels never pass through here: the browser
// reads them straight from NASA's public S3 copy (see web/live/fits.js).
//   GET /api/images?ra=&dec=&det=D1..D6   GET /api/gaia?ra=&dec=
//   GET /api/comets   GET /api/explored   (example data until D1 holds real labels; see docs/api.md)
// The same Worker serves the app's files from web/ (wrangler.toml [assets]); only /api/* reaches this code.
import { COMETS, SUGGEST, exploredCells } from './example-data.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const WIDE = ['spherex_dr1', 'spherex_qr3'], DEEP = ['spherex_dr1_deep', 'spherex_qr3_deep'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

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

// Comets people found plus known objects, for the map's markers
const comets = () => json({ example: true, comets: COMETS }, 200, { 'Cache-Control': 'public, max-age=60' });

// Which patch-sized cells people have checked, and one nobody has, for the heat map and "Unexplored patch"
function explored() {
  const { total, cells } = exploredCells();
  return json({ example: true, total, checked: cells.length, cells, suggest: SUGGEST }, 200, { 'Cache-Control': 'public, max-age=60' });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const route = { '/api/images': images, '/api/gaia': gaia, '/api/comets': comets, '/api/explored': explored }[url.pathname];
    if (!route) return json({ error: 'not found' }, 404);
    const cache = caches.default, hit = await cache.match(request);
    if (hit) return hit;
    const res = await route(url);
    if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  }
};
