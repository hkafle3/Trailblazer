// "Then and now": the older survey's picture of a spot, for the blink (web/live/blinkworker.js). Contract in docs/api.md.
//   GET /api/oldsky?survey=allwise|2mass&band=W1|W2|Ks&ra=&dec=   a JSON manifest (tiles, size, R2 etag, dates, release)
//   GET /api/oldsky/v1/...   the tile bytes, same origin, from R2 (OLDSKY)   GET /api/blink/v1/...   a baked blink
//   GET /api/blink?ra=&dec=   a baked blink's result, when there is one (the showcase), else 404 and the page builds live
// IRSA's cutouts are FITS, often gzip whatever the name says. They are streamed into R2 as IRSA sent them (never through
// fetchRetry's .text(), which would corrupt them), at their declared length, and checked from their header and size. Only complete answers are stored;
// an error is never cached. R2 answers first; a miss is rate limited per IP (OLDSKY_LIMIT) before IRSA is asked.
const IRSA = 'https://irsa.ipac.caltech.edu';
const SIZE = 780, MAX_TILE = 4 << 20, MAX_TILES = 8, MAX_TEXT = 1 << 20, TIMEOUT = 20000;
// the only survey/band pairs: the band each one compares with SPHEREx
export const BANDS = { allwise: ['W1', 'W2'], '2mass': ['Ks'] };
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

// the position rounded to 0.001 degree, as it appears in keys: 84.018-6.578, 10.000+4.500
// (halves away from zero, so a spot and its mirror in Dec round alike)
const round3 = v => Math.sign(v) * Math.round(Math.abs(v) * 1000) / 1000;
export const posKey = (ra, dec) => `${(round3(ra) % 360).toFixed(3)}${dec < 0 ? '-' : '+'}${Math.abs(round3(dec)).toFixed(3)}`;
// GET parameters -> { survey, band, ra, dec, prefix } or { error }
export function readRequest(url) {
  const q = url.searchParams, survey = q.get('survey'), band = q.get('band');
  if (!Object.hasOwn(BANDS, survey ?? '')) return { error: 'survey must be allwise or 2mass' };
  if (!BANDS[survey].includes(band)) return { error: `band must be ${BANDS[survey].join(' or ')} for ${survey}` };
  if (q.has('size') && q.get('size') !== String(SIZE)) return { error: `size must be ${SIZE} (arcsec)` };
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  if (!q.has('ra') || q.get('ra').trim() === '' || !Number.isFinite(ra) || ra < 0 || ra >= 360) return { error: 'ra must be 0 to 360' };
  if (!q.has('dec') || q.get('dec').trim() === '' || !Number.isFinite(dec) || dec < -90 || dec > 90) return { error: 'dec must be -90 to 90' };
  const r = round3(ra) % 360, d = round3(dec);
  return { survey, band, ra: r, dec: d, prefix: `oldsky/v1/${survey}/${band}/${SIZE}/${posKey(r, d)}/` };
}

// bytes of an IRSA URL: host fixed, no redirects, at most max bytes, at most TIMEOUT
export async function irsaBytes(url, max, fetchFn = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.host !== 'irsa.ipac.caltech.edu') throw new Error(`not an IRSA URL: ${u.host}`);
  const r = await fetchFn(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status >= 300 && r.status < 400 || r.type === 'opaqueredirect') { r.body?.cancel?.(); throw new Error(`IRSA redirected (${r.status})`); }
  if (!r.ok) { r.body?.cancel?.(); throw new Error(`IRSA HTTP ${r.status} for ${u.pathname}`); }
  if (Number(r.headers.get('Content-Length')) > max) { r.body?.cancel?.(); throw new Error('IRSA answer too large'); }
  const reader = r.body.getReader(), chunks = []; let n = 0;
  for (let c; !(c = await reader.read()).done;) {
    n += c.value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('IRSA answer too large'); }
    chunks.push(c.value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
// a few tries, a short wait between (IRSA's cutout service answers 503 now and then, or drops a body); anything else is final
const retriable = e => /^IRSA (HTTP|sent a short)/.test(e.message) || ['TimeoutError', 'AbortError', 'TypeError'].includes(e.name);
const tries = async (n, fn) => {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; if (!retriable(e)) break; }
    if (i < n - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  throw last;
};

// A tile goes from IRSA straight into R2 without passing through this code: the Worker plan's CPU (10 ms, and a cold miss
// must stay under half of it) cannot afford to copy, inflate or hash a megabyte. What is read here, back from R2: the first
// 64 KB (the header, inflated from the start of a gzip) and, for a gzip, its 4-byte size trailer. Checked before the manifest
// is written: a 2-D FITS image of a known BITPIX, of the band asked, and enough bytes for NAXIS1 x NAXIS2 x |BITPIX|/8
// after the header, padded to 2880 (the stored length for a plain file, the gzip's ISIZE for a gzip, which also caps what
// it inflates to). The browser inflates every byte anyway: a gzip cut short or failing its checksum is caught there.
export const isGzip = b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const MAX_INFLATED = 16 << 20, BLOCK = 2880, PREFIX = 24 << 10;   // headers of these atlases are 4 to 11 blocks (11 to 32 KB inflated, a few KB as gzip)
// the header cards and the bytes the whole file must hold, from the file's start (plain FITS, or the start of a gzip)
// the 80 characters of the header card at byte i of the inflated pieces so far
function cardAt(parts, i) {
  let at = 0, out = '';
  for (const p of parts) { if (i < at + p.byteLength && out.length < 80) for (let k = Math.max(0, i - at); k < p.byteLength && out.length < 80; k++) out += String.fromCharCode(p[k]); at += p.byteLength; }
  return out.slice(0, 8).trim();
}
export async function fitsHead(prefix, DS = DecompressionStream) {
  let b = prefix;
  if (isGzip(prefix)) {
    // fed in 512-byte pieces, read as they come out, stopped at the END card: a highly compressible tile (16 MB of zeros
    // is 16 KB of gzip) is never inflated whole inside the Worker (Codex re-review 3)
    const ds = new DS('gzip'), w = ds.writable.getWriter(), rd = ds.readable.getReader(), parts = [];
    let n = 0, stop = false;
    const hasEnd = () => { for (let i = Math.max(0, n - 4096 - 80) - (Math.max(0, n - 4096 - 80) % 80); i + 80 <= n; i += 80) if (cardAt(parts, i) === 'END') return true; return false; };
    const reading = (async () => {
      try { while (!stop) { const c = await rd.read(); if (c.done) break; parts.push(c.value); n += c.value.byteLength; if (hasEnd() || n >= 40 * BLOCK) stop = true; } }
      catch { /* the start of a gzip ends mid-stream: what came out before is the header */ }
      stop = true;
    })();
    for (let off = 0; off < prefix.length && !stop; off += 512) { try { await w.write(prefix.subarray(off, off + 512)); } catch { break; } await new Promise(r => setTimeout(r, 0)); }
    stop = true;
    w.abort().catch(() => {}); rd.cancel().catch(() => {});
    await Promise.race([reading, new Promise(r => setTimeout(r, 50))]);
    b = new Uint8Array(n); let at = 0; for (const p of parts) { b.set(p, at); at += p.byteLength; }
  }
  const cards = {}, dec = new TextDecoder('latin1');
  if (dec.decode(b.subarray(0, 9)) !== 'SIMPLE  =') throw new Error('not a FITS file');
  let end = -1;
  for (let i = 0; i + 80 <= b.length; i += 80) {
    const c = dec.decode(b.subarray(i, i + 80)), k = c.slice(0, 8).trim();
    if (k === 'END') { end = i + 80; break; }
    if (c[8] !== '=') continue;
    let v = c.slice(10).trim();
    v = v.startsWith("'") ? v.slice(1, v.indexOf("'", 1)).trim() : v.split('/')[0].trim();
    cards[k] = v;
  }
  if (end < 0) throw new Error('FITS header has no END in its first blocks');
  const bitpix = Number(cards.BITPIX), nx = Number(cards.NAXIS1), ny = Number(cards.NAXIS2);
  if (cards.SIMPLE !== 'T' || ![8, 16, 32, -32, -64].includes(bitpix) || cards.NAXIS !== '2') throw new Error('not a 2-D FITS image');
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1 || nx > 8192 || ny > 8192) throw new Error('FITS image size out of range');
  return { cards, need: Math.ceil(end / BLOCK) * BLOCK + Math.ceil(nx * ny * Math.abs(bitpix) / 8 / BLOCK) * BLOCK };
}
// one tile: IRSA's body handed straight to R2 (R2 holds it to its Content-Length: a short body fails the put; nothing
// passes through JavaScript), then read back in two small ranges: the first 64 KB for the header, and for a gzip its
// 4-byte size trailer. Anything wrong deletes what was stored. { gzip, bytes, etag, cards }
// deps.wrapBody: for the Node tests only, where a stream has no known length (they enforce it with a FixedLengthStream)
async function storeTile(t, key, req, env, fetchFn, wrapBody = b => b, DS, testHost = null) {
  const u = new URL(t.url);
  if (!(u.protocol === 'https:' && u.host === 'irsa.ipac.caltech.edu') && !(testHost && u.host === testHost)) throw new Error(`not an IRSA URL: ${u.host}`);
  const r = await fetchFn(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status >= 300 && r.status < 400 || r.type === 'opaqueredirect') { r.body?.cancel?.(); throw new Error(`IRSA redirected (${r.status})`); }
  if (!r.ok) { r.body?.cancel?.(); throw new Error(`IRSA HTTP ${r.status} for ${u.pathname}`); }
  const len = Number(r.headers.get('Content-Length'));
  if (!Number.isInteger(len) || len < 9) { r.body?.cancel?.(); throw new Error('IRSA sent no length'); }
  if (len > MAX_TILE) { r.body?.cancel?.(); throw new Error('IRSA answer too large'); }
  let stored;
  try { stored = await env.OLDSKY.put(key, wrapBody(r.body, len), { httpMetadata: { contentType: 'application/fits' }, customMetadata: { source: t.url } }); }
  catch (e) { await env.OLDSKY.delete(key).catch(() => {}); throw new Error(`IRSA sent a short tile (${e.message})`); }
  try {
    if (!stored || stored.size !== len) throw new Error(`stored ${stored?.size} of ${len} bytes`);
    const bytesAt = async range => new Uint8Array(await new Response((await env.OLDSKY.get(key, { range })).body).arrayBuffer());
    const gzip = isGzip(await bytesAt({ offset: 0, length: 2 }));
    let full = len;
    if (gzip) {   // the gzip's ISIZE trailer first: what it inflates to (mod 2^32; tiles are far smaller), checked before any inflating
      full = new DataView((await bytesAt({ suffix: 4 })).buffer).getUint32(0, true);
      if (full > MAX_INFLATED) throw new Error('gzip inflates past the size cap');
    }
    const h = await fitsHead(await bytesAt({ offset: 0, length: Math.min(len, PREFIX) }), DS);
    if (full < h.need) throw new Error(`FITS image is short: ${full} bytes, ${h.need} needed`);
    if (!/_cov\.fits$/.test(t.name) && bandOf(req.survey, h.cards) !== req.band) throw new Error(`${t.name} is ${bandOf(req.survey, h.cards)}, not ${req.band}`);
    return { gzip, bytes: len, etag: stored.etag, cards: h.cards };
  } catch (e) { await env.OLDSKY.delete(key).catch(() => {}); throw e; }
}

// IRSA's CSV: a header line, then rows; quoted fields are not expected in the columns we read
function csvRows(text, need) {
  const lines = text.split('\n'), head = lines[0].replace(/\r$/, '').split(',');
  if (need.some(k => !head.includes(k))) throw new Error('IRSA sent no table');
  return lines.slice(1).filter(l => l.includes(',')).map(l => { const v = l.replace(/\r$/, '').split(','); return Object.fromEntries(head.map((h, i) => [h, v[i]])); });
}
// which tiles to cut out, from IRSA's searches: [{ name, url }]
async function plan_(req, fetchFn) {
  const { survey, band, ra, dec } = req, cut = `center=${ra},${dec}&size=${SIZE}arcsec`;
  const text = async u => new TextDecoder().decode(await tries(2, () => irsaBytes(u, MAX_TEXT, fetchFn)));
  if (survey === 'allwise') {
    // the AllWISE Atlas tile nearest the spot (the reference's rule), its intensity image and its coverage map
    const rows = csvRows(await text(`${IRSA}/SIA?COLLECTION=wise_allwise&POS=circle+${ra}+${dec}+0.01&RESPONSEFORMAT=CSV`), ['s_ra', 's_dec', 'dataproduct_subtype', 'energy_bandpassname', 'access_url', 'obs_id']);
    const sci = rows.filter(x => x.dataproduct_subtype === 'science' && x.energy_bandpassname === band)
      .sort((a, b) => ((a.s_ra - ra) ** 2 + (a.s_dec - dec) ** 2) - ((b.s_ra - ra) ** 2 + (b.s_dec - dec) ** 2))[0];
    if (!sci || !/-int-3\.fits$/.test(sci.access_url)) return [];
    return [{ name: `allwise_${band}_int.fits`, url: `${sci.access_url}?${cut}`, tile: sci.obs_id },
      { name: `allwise_${band}_cov.fits`, url: `${sci.access_url.replace(/-int-3\.fits$/, '-cov-3.fits.gz')}?${cut}`, tile: sci.obs_id }];
  }
  // 2MASS: every Ks atlas image overlapping the 12 arcmin field (one box search gives the reference's 25-point set)
  const rows = csvRows(await text(`${IRSA}/ibe/search/twomass/allsky/allsky?POS=${ra},${dec}&SIZE=0.2006&INTERSECT=OVERLAPS&RESPONSEFORMAT=CSV`), ['fname', 'ordate', 'hemisphere', 'scanno', 'filter']);
  const seen = new Map();
  for (const x of rows) if (x.filter === 'k' && /^[a-z0-9]+\.fits(\.gz)?$/.test(x.fname) && /^\d{6}$/.test(x.ordate) && /^[ns]$/.test(x.hemisphere) && /^\d+$/.test(x.scanno)) seen.set(x.ordate + x.fname, x);
  return [...seen.values()].sort((a, b) => (a.ordate + a.fname < b.ordate + b.fname ? -1 : 1)).map(k => ({
    name: `2mass_Ks_${k.ordate}_${k.fname.split('.')[0]}.fits`, tile: k.fname,
    url: `${IRSA}/ibe/data/twomass/allsky/allsky/${k.ordate}${k.hemisphere}/s${String(Number(k.scanno)).padStart(3, '0')}/image/${k.fname}?${cut}` }));
}
// what the header must say for the band asked: a wrong tile is never stored
function bandOf(survey, h) { return survey === 'allwise' ? `W${h.BAND}` : h.FILTER === 'k' ? 'Ks' : `?${h.FILTER}`; }
const KEEP = ['NAXIS1', 'NAXIS2', 'BAND', 'FILTER', 'DATEOBS1', 'DATEOBS2', 'MIDOBS', 'ORDATE', 'MAGZP', 'NUMFRMS', 'MEDCOV', 'COADDID'];

// A cold miss is split over several requests, each a fraction of the plan's 10 ms CPU (one request doing a whole 2MASS
// mosaic measured 17.6 ms on preview, 2026-11-18): this one searches IRSA and stores the plan (rate limited per IP);
// then GET /api/oldsky/tile stores one tile per request (the browser asks for each, in turn); then this one again
// writes the manifest once every tile has passed its checks. Answers: 200 manifest, or 202 { pending: [tile names] }.
const PENDING_KEY = 'plan.json', OK = name => `ok/${name}.json`;
const manifestOf = (req, plan, done) => ({ v: 2, survey: req.survey, band: req.band, size_arcsec: SIZE, ra: req.ra, dec: req.dec,
  release: req.survey === 'allwise' ? 'AllWISE Atlas (p3am_cdd)' : '2MASS All-Sky Release', fetched_at: new Date().toISOString(),
  tiles: plan.tiles.map(t => { const { key, ...rec } = done.get(t.name); return { name: t.name, path: `api/${key}`, source: t.url, tile: t.tile, ...rec }; }) });
// A test hook for the tile step's CPU and its gzip handling in workerd and on a preview, never in production: only when
// the Worker has OLDSKY_TEST_ORIGIN ('self', or an origin; set in worker/.dev.vars and worker/wrangler.preview.toml, not in
// worker/wrangler.toml) and the request says test=zeros16m. Its plan is one tile, web/tests/fixtures/zeros16m-w2.fits.gz
// (a valid 16 MB W2 image of zeros, 15.6 KB as gzip), under oldsky/test/, apart from real keys.
function testPlan(url, env, req) {
  if (!env.OLDSKY_TEST_ORIGIN || url.searchParams.get('test') !== 'zeros16m') return null;
  const origin = env.OLDSKY_TEST_ORIGIN === 'self' ? url.origin : env.OLDSKY_TEST_ORIGIN;
  return { host: new URL(origin).host, prefix: req.prefix.replace('oldsky/v1/', 'oldsky/test/'), tiles: [{ name: `allwise_${req.band}_int.fits`, url: `${origin}/tests/fixtures/zeros16m-w2.fits.gz`, tile: 'test' }] };
}
async function readJsonObject(env, key) { const o = await env.OLDSKY.get(key); return o ? JSON.parse(await new Response(o.body).text()) : null; }
export async function oldsky(request, url, env, deps = {}) {
  const fetchFn = deps.fetch ?? fetch, req = readRequest(url);
  if (req.error) return json({ error: req.error }, 400);
  if (!env.OLDSKY) return json({ error: 'older survey unavailable', reason: 'no store' }, 503);
  const test = testPlan(url, env, req);
  if (test) req.prefix = test.prefix;
  const hit = await env.OLDSKY.get(req.prefix + 'manifest.json');
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Oldsky': 'hit' } });
  const down = reason => json({ error: 'older survey unavailable', reason }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  let plan = await readJsonObject(env, req.prefix + PENDING_KEY);
  if (!plan) {
    // a new spot costs IRSA requests and storage: limited per IP (misses only)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (env.OLDSKY_LIMIT && !(await env.OLDSKY_LIMIT.limit({ key: `oldsky:${ip}` })).success)
      return json({ error: 'too many new spots, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
    let tiles;
    try { tiles = test ? test.tiles : await plan_(req, fetchFn); } catch (e) { return down(`search: ${e.message}`); }
    if (!tiles.length) return json({ error: 'no older survey picture of this spot', survey: req.survey, band: req.band }, 404, { 'Cache-Control': 'no-store' });
    if (tiles.length > MAX_TILES) return down(`${tiles.length} tiles, more than ${MAX_TILES}`);
    plan = { tiles };
    await env.OLDSKY.put(req.prefix + PENDING_KEY, JSON.stringify(plan), { httpMetadata: { contentType: 'application/json' } });
  }
  const done = new Map((await env.OLDSKY.list({ prefix: req.prefix + 'ok/' })).objects.map(o => [o.key.slice(req.prefix.length + 3, -5), o]));
  const pending = plan.tiles.filter(t => !done.has(t.name)).map(t => t.name);
  if (pending.length) return json({ pending, tile: `api/oldsky/tile?${url.searchParams}` }, 202, { 'Cache-Control': 'no-store', 'X-Oldsky': 'pending' });
  // every tile passed: the manifest, from each tile's own record (last: a manifest means every tile is there)
  const recs = new Map(await Promise.all(plan.tiles.map(async t => [t.name, await readJsonObject(env, req.prefix + OK(t.name))])));
  const body = JSON.stringify(manifestOf(req, plan, recs));
  await env.OLDSKY.put(req.prefix + 'manifest.json', body, { httpMetadata: { contentType: 'application/json' } });
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Oldsky': 'miss' } });
}
// GET /api/oldsky/tile?survey=&band=&ra=&dec=&name=: one tile of the stored plan from IRSA into R2, checked; only names in
// the plan, never a URL from the request. Rate limited per IP (OLDSKY_TILE_LIMIT). 200 { name, done } or 503 (nothing kept).
export async function oldskyTile(request, url, env, deps = {}) {
  const fetchFn = deps.fetch ?? fetch, req = readRequest(url), name = url.searchParams.get('name') ?? '';
  if (req.error) return json({ error: req.error }, 400);
  if (!env.OLDSKY) return json({ error: 'older survey unavailable', reason: 'no store' }, 503);
  const test = testPlan(url, env, req);
  if (test) req.prefix = test.prefix;
  const plan = await readJsonObject(env, req.prefix + PENDING_KEY), t = plan?.tiles.find(x => x.name === name);
  if (!t) return json({ error: 'no such tile in this spot\'s plan; ask GET /api/oldsky first' }, 404, { 'Cache-Control': 'no-store' });
  // done already: never fetched again (and never touched by a later attempt)
  if (await env.OLDSKY.head(req.prefix + OK(name))) return json({ name, done: true }, 200, { 'Cache-Control': 'no-store' });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.OLDSKY_TILE_LIMIT && !(await env.OLDSKY_TILE_LIMIT.limit({ key: `oldsky-tile:${ip}` })).success)
    return json({ error: 'too many tiles at once, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
  // each attempt writes its own object: one that fails deletes only that, so attempts that overlap never undo each other,
  // and the record (written only after the checks) names the object it vouches for
  const key = `${req.prefix}${name.replace(/\.fits$/, '')}.${crypto.randomUUID().slice(0, 8)}.fits`;
  try {
    const s = await tries(2, () => storeTile(t, key, req, env, fetchFn, deps.wrapBody, deps.DecompressionStream, test?.host));
    const rec = { key, bytes: s.bytes, gzip: s.gzip, etag: s.etag, header: Object.fromEntries(KEEP.filter(k => k in s.cards).map(k => [k, s.cards[k]])) };
    await env.OLDSKY.put(req.prefix + OK(name), JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
    return json({ name, done: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ error: 'older survey unavailable', reason: e.message }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }
}

// stored bytes, by canonical key only: oldsky/v1/<survey>/<band>/780/<pos>/<tile>, blink/v1/<pos>/<file>
const POS = '\\d{1,3}\\.\\d{3}[+-]\\d{1,2}\\.\\d{3}';
const FILE = new RegExp(`^(oldsky/v1/(allwise/(W1|W2)|2mass/Ks)/${SIZE}/${POS}/[A-Za-z0-9_.]{1,80}|blink/v1/${POS}/(result\\.json|frames\\.bin|centre\\.json))$`);
export async function stored(url, env) {
  const key = url.pathname.slice('/api/'.length);
  if (!FILE.test(key)) return json({ error: 'not found' }, 404);
  const o = await env.OLDSKY?.get(key);
  if (!o) return json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' });
  return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType ?? 'application/octet-stream', ...CORS,
    'Cache-Control': 'public, max-age=31536000, immutable', ETag: o.httpEtag } });
}
// GET /api/blink?ra=&dec=: the baked blink at this spot (bake/blink_bake.mjs), or 404: the page then builds it live
export async function blinkBaked(url, env) {
  const ra = Number(url.searchParams.get('ra')), dec = Number(url.searchParams.get('dec'));
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90) return json({ error: 'ra must be 0 to 360 and dec -90 to 90' }, 400);
  // the key rounds to 0.001 degree (up to 2.5 arcsec): the bake's own centre (centre.json, written with it) must be within
  // 2 arcsec of the spot asked for, or another spot's measurements would be served
  const dir = `blink/v1/${posKey(ra, dec)}/`, c = await env.OLDSKY?.get(dir + 'centre.json'), none = () => json({ error: 'no baked blink here' }, 404, { 'Cache-Control': 'no-store' });
  if (!c) return none();
  const cen = JSON.parse(await new Response(c.body).text()), D = Math.PI / 180;
  const sep = Math.acos(Math.min(1, Math.sin(dec * D) * Math.sin(cen.dec * D) + Math.cos(dec * D) * Math.cos(cen.dec * D) * Math.cos((ra - cen.ra) * D))) / D * 3600;
  if (!(sep <= 2)) return none();
  const o = await env.OLDSKY.get(dir + 'result.json');
  if (!o) return none();
  return new Response(o.body, { headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=300' } });
}
