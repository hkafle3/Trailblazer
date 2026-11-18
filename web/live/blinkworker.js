// "Then and now", fetched and built: a Web Worker for the page (web/thenandnow.js), also run in Node by the bake
// (bake/blink_bake.mjs). For each band it reads the older survey's tiles (GET /api/oldsky, R2 then IRSA) and every
// SPHEREx exposure that touches the 12 arcmin field (GET /api/images, then NASA's S3 copy with range reads), and runs
// live/blink.js. A baked blink (GET /api/blink, the showcase) is used instead when there is one.
// in: { id, ra, dec, api, bands: ['W2', 'W1', 'Ks'], live?: true (skip the baked one) }
// out: { id, type: 'progress', band, text } | { id, type: 'band', band, state, reason, report, frames: { ow, sw }, info } | { id, type: 'done', source }
import * as B from './blink.js';
import { imageHeader, imageRows, flagsHeader, flagRows, parseCards } from './fits.js';

const SURVEY = { W1: ['allwise', 'W1'], W2: ['allwise', 'W2'], Ks: ['2mass', 'Ks'] };
const SIZE = 2040, HALF = (B.N - 1) / 2 * B.PIX / 3600;   // the field's half width, degrees

export { oldSky };
export class Unavailable extends Error { constructor(state, reason) { super(reason); this.state = state; } }
function limiter(n) {
  let busy = 0; const wait = [];
  const next = () => { if (busy >= n || !wait.length) return; busy++; const [fn, ok, no] = wait.shift(); Promise.resolve().then(fn).then(ok, no).finally(() => { busy--; next(); }); };
  return fn => new Promise((ok, no) => { wait.push([fn, ok, no]); next(); });
}
const s3 = limiter(12), api = limiter(4);
const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
async function retry(fn, n = 3) { let last; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; if (e.name === 'AbortError') throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))); } } throw last; }
async function inflate(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

// ---------- the older survey: manifest, then each tile (gzip sniffed and inflated, checked against its sha256) ----------
async function oldSky(base, band, ra, dec, signal, progress) {
  const [survey, b] = SURVEY[band];
  progress(`Fetching the ${survey === 'allwise' ? 'AllWISE' : '2MASS'} picture`);
  let r;
  try { r = await fetch(`${base}/api/oldsky?survey=${survey}&band=${b}&ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`, { signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Unavailable('old-unavailable', 'NASA\'s image archive (IRSA) is not answering'); }
  if (r.status === 404) throw new Unavailable('comparison-unavailable', `No ${survey === 'allwise' ? 'AllWISE' : '2MASS'} picture covers this spot`);
  if (r.status === 429) throw new Unavailable('old-unavailable', 'Too many new spots at once. Try again in a minute');
  if (!r.ok) throw new Unavailable('old-unavailable', 'NASA\'s image archive (IRSA) is not answering');
  const man = await r.json(), tiles = [];
  // The Worker streams tiles into R2 unread (its CPU allows no more), so the full check is here: the bytes stored as
  // declared, a gzip that inflates whole (its length and checksum), and a complete FITS image. A damaged stored tile
  // makes the comparison inconclusive, said plainly; it is not fetched again and again.
  const damaged = why => new Unavailable('inconclusive', `the older survey's stored picture of this spot is damaged (${why})`);
  for (const t of man.tiles) {
    const raw = new Uint8Array(await retry(async () => { const x = await fetch(`${base}/${t.path}`, { signal }); if (!x.ok) throw new Error(`tile HTTP ${x.status}`); return x.arrayBuffer(); }));
    if (t.bytes !== undefined && raw.length !== t.bytes) throw damaged(`${t.name}: ${raw.length} bytes, ${t.bytes} stored`);
    let bytes, fits;
    try { bytes = await inflate(raw); } catch { throw damaged(`${t.name} does not inflate`); }
    try { fits = B.readFits(bytes, parseCards); } catch (e) { throw damaged(`${t.name}: ${e.message}`); }
    tiles.push({ name: t.name, stored_bytes: raw.length, etag: t.etag ?? null, fits_sha256: await hex(bytes), stored_sha256: await hex(raw), source: t.source, fits });
  }
  const inputs = tiles.map(t => ({ file: t.name, sha256: t.fits_sha256, digest: 'sha256 of the whole FITS file, inflated', stored_sha256: t.stored_sha256, stored_digest: 'sha256 of the bytes as stored, as IRSA sent them (gzip or not)', stored_etag: t.etag, source: t.source }));
  if (survey === 'allwise') {
    const int = tiles.find(t => t.name.endsWith('_int.fits')), cov = tiles.find(t => t.name.endsWith('_cov.fits'));
    if (!int || !cov) throw new Unavailable('comparison-unavailable', 'The AllWISE coverage map is missing');
    return { kind: 'wise', int: int.fits, cov: cov.fits, inputs, release: man.release };
  }
  return { kind: '2mass', tiles: tiles.map(t => ({ name: t.name, fits: t.fits })), inputs, release: man.release };
}

// ---------- SPHEREx: every exposure touching the field, on the band's detectors ----------
const lists = new Map();
async function exposures(base, det, ra, dec, signal) {
  const k = `${det} ${ra} ${dec}`;
  if (!lists.has(k)) lists.set(k, (async () => {
    // every exposure coming within the field's half diagonal of its centre (a region search, conservative); which of
    // them truly overlap the field is decided from each one's own header (readExposure)
    const seen = new Map(), R = +(HALF * Math.SQRT2 + 0.001).toFixed(4);
    const res = await api(() => retry(async () => {
      const r = await fetch(`${base}/api/images?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&det=${det}&r=${R}&v=2`, { signal });
      if (!r.ok) throw new Error(`images HTTP ${r.status}`);
      return r.json();
    }, 2).catch(e => { if (e.name === 'AbortError') throw e; throw new Unavailable('spherex-unavailable', 'The SPHEREx image search is not answering'); }));
    for (const x of res.images) if (!seen.has(x.obs)) seen.set(x.obs, { ...x, det });
    return [...seen.values()].sort((a, b) => a.t - b.t);
  })().catch(e => { lists.delete(k); throw e; }));
  return lists.get(k);
}
// one exposure: header, the grid's map onto it, and (when any of the field is on the detector, in band) its rows
async function readExposure(e, grid, bins, wave, signal, stopped = () => null) {
  if (stopped()) return null;
  const h = await s3(async () => (stopped() ? null : retry(() => imageHeader(e.key, signal))));
  if (!h) return null;
  const map = B.spherexMap(h, grid);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < map.px.length; k++) { const x = map.px[k], y = map.py[k]; if (x > -1 && x < SIZE && y > -1 && y < SIZE) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (!(x1 >= x0)) return null;
  // in band anywhere? the wavelength runs smoothly across the field, so its extremes are at the field's corners
  const N = B.N, cl = v => Math.min(SIZE - 1, Math.max(0, v)), lams = [0, N - 1, (N - 1) * N, N * N - 1, (N * N - 1) / 2].map(k => B.lamAt(wave, cl(map.px[k]), cl(map.py[k])));
  if (Math.max(...lams) < bins.loS * 0.99 || Math.min(...lams) > bins.hiS * 1.01) return null;
  x0 = Math.max(0, Math.floor(x0) - 1); x1 = Math.min(SIZE - 1, Math.ceil(x1) + 1); y0 = Math.max(0, Math.floor(y0) - 1); y1 = Math.min(SIZE - 1, Math.ceil(y1) + 1);
  if (stopped()) return null;
  const [px, fl] = await s3(() => retry(() => Promise.all([imageRows(e.key, h, y0, y1, signal), flagsHeader(e.key, h, signal).then(f => flagRows(e.key, f, y0, y1, signal))])));
  const w = x1 - x0 + 1, ht = y1 - y0 + 1, img = new Float32Array(w * ht), flg = new Int32Array(w * ht);
  for (let y = 0; y < ht; y++) { img.set(px.subarray(y * SIZE + x0, y * SIZE + x1 + 1), y * w); flg.set(fl.subarray(y * SIZE + x0, y * SIZE + x1 + 1), y * w); }
  return { det: e.det, t: e.t, key: e.key, sha256: await B.cutoutDigest({ key: e.key, head: h, x0, y0, w, h: ht, img, flg }), img, flg, w, h: ht, x0, y0, map };
}

// ---------- one band, start to end ----------
export async function buildBand(band, { base, ra, dec, grid, curves, waves, signal, progress = () => {} }) {
  // the older survey and SPHEREx at once; if either fails the band stops there (queued S3 reads are skipped)
  let failed = null;
  const oldP = oldSky(base, band, ra, dec, signal, progress);
  const { dets } = B.PAIRS[band], acc = B.synthStart(curves[band], dets);
  const spxP = (async () => {
    const all = (await Promise.all(dets.map(d => exposures(base, d, ra, dec, signal)))).flat();
    if (!all.length) throw new Unavailable('comparison-unavailable', 'SPHEREx has no pictures of this spot in this band');
    let done = 0;
    progress(`Reading ${all.length} SPHEREx exposures`);
    await Promise.all(all.map(async e => {
      if (failed) return;
      let x;
      try { x = await readExposure(e, grid, acc.bins, waves[e.det], signal, () => failed); }
      catch (err) { if (err.name === 'AbortError' || failed) throw err; throw new Unavailable('spherex-unavailable', 'NASA\'s SPHEREx archive (S3) is not answering'); }
      if (x) B.synthAdd(acc, x, waves[e.det]);
      progress(`Reading SPHEREx exposures: ${++done} of ${all.length}`);
    }));
  })();
  let o;
  try { [o] = await Promise.all([oldP, spxP]); }
  catch (e) { failed = e; oldP.catch(() => {}); spxP.catch(() => {}); throw e; }
  const sp = B.synthEnd(acc, band);
  progress('Matching and measuring');
  const old = o.kind === 'wise' ? B.oldWise(o.int, o.cov, grid, o.inputs) : B.old2mass(o.tiles, grid, o.inputs);
  return B.pair(band, old, sp);
}
// what a band's report becomes on the page: its state, and the frames only when the comparison is good
export function bandMessage(band, rep) {
  const { state, failed } = B.stateOf(rep), { frames, info, ...report } = rep;
  const reason = state === 'ok' ? '' : reasonOf(failed, rep);
  return { type: 'band', band, state, reason, report, ...(state === 'ok' ? { frames, info } : {}) };
}
const WHY = { band_match: 'the pictures are not of the same band', spectral_coverage_at_lead: 'SPHEREx does not cover enough of this band at the star',
  spherex_footprint: 'SPHEREx does not cover enough of the field in this band', old_footprint: 'the older picture does not cover enough of the field',
  qualified_stars: 'too few clean comparison stars', field_scatter_cap: 'nearby stars scatter too much', validation_median: 'the test stars do not come out unchanged',
  finite: 'a measurement is missing', psf_fwhm_match: 'the two pictures could not be matched in sharpness', psf_profile_match: 'star profiles differ between the pictures',
  alignment: 'the pictures do not line up', lead_same_place: 'nothing sits at the same spot in both pictures',
  display_frames_differ: 'the frames are identical', display_no_hidden_gaps: 'a gap would be hidden', display_lead_ratio: 'the drawn frames do not reproduce the measurement',
  display_field_ratio: 'the drawn frames do not reproduce the stars', display_background_match: 'the backgrounds could not be matched' };
const ORDER = Object.keys(WHY);   // the most telling reason first: coverage, then the stars, then the rest
function reasonOf(failed, rep) {
  failed = [...failed].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const w = failed.map(k => WHY[k] ?? k);
  if (failed.includes('qualified_stars')) w[failed.indexOf('qualified_stars')] = `${rep.qualified_stars} clean comparison stars, 20 needed`;
  if (failed.includes('field_scatter_cap')) w[failed.indexOf('field_scatter_cap')] = `nearby stars scatter by ${rep.field_scatter_robust_sigma}, over 0.10`;
  return w.slice(0, 2).join('; ');
}

// the baked blink: result.json and frames.bin (bake/blink_bake.mjs)
async function baked(base, ra, dec, signal) {
  const r = await fetch(`${base}/api/blink?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`, { signal });
  if (r.status !== 200) return null;
  const res = await r.json(), bin = await (await fetch(`${base}/${res.frames_path}`, { signal })).arrayBuffer();
  for (const m of Object.values(res.bands)) if (m.frames) m.frames = Object.fromEntries(Object.entries(m.frames).map(([k, [off, n]]) => [k, new Float32Array(bin.slice(off, off + 4 * n))]));
  return res;
}

// ---------- the Web Worker ----------
let cur = null, stop = null;
async function run({ id, ra, dec, api: base = '', bands = ['W2', 'W1', 'Ks'], live = false }, post) {
  const signal = (stop = new AbortController()).signal;
  if (!live) {
    let b = null;
    try { b = await baked(base, ra, dec, signal); } catch (e) { if (e.name === 'AbortError') return; }
    if (b) { for (const band of bands) if (b.bands[band]) post({ ...b.bands[band], band, type: 'band', baked: true, context: b.context ?? null }); post({ type: 'done', source: 'baked' }); return; }
  }
  const here = new URL('../data/', import.meta.url);
  const [curves, waves] = await Promise.all(['bands.json', 'wavemaps.json'].map(f => fetch(new URL(f, here)).then(r => r.json())));
  const grid = B.makeGrid(ra, dec);
  // every band at once: their old-survey fetches and S3 reads overlap; the first band's reads are queued first
  await Promise.all(bands.map(async band => {
    try {
      const rep = await buildBand(band, { base, ra, dec, grid, curves, waves, signal, progress: text => post({ type: 'progress', band, text }) });
      const m = bandMessage(band, rep);
      post(m, m.frames ? [m.frames.ow.buffer, m.frames.sw.buffer] : []);
    } catch (e) {
      if (e.name === 'AbortError') return;
      post({ type: 'band', band, state: e.state ?? 'spherex-unavailable', reason: e.state ? e.message : String(e.message || e) });
    }
  }));
  if (signal.aborted) return;
  post({ type: 'done', source: 'live' });
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined' && typeof process === 'undefined') {
  self.onmessage = ({ data }) => {
    stop?.abort(); cur = data.id;
    run(data, (m, transfer = []) => { if (cur === data.id) self.postMessage({ ...m, id: data.id }, transfer); });
  };
}
