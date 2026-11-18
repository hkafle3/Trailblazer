// "Colors", fetched and built: a Web Worker for the page (web/colors.js), also run in Node by the bake (bake/colors_bake.mjs).
// It reads the spot's six catalogues (GET /api/cat), lists the SPHEREx exposures (GET /api/images), reads each one's header
// and, when the star is on it, the IMAGE and FLAGS rows of the reference footprint from NASA's S3 copy, and runs
// web/live/colors.js (the port of bake/colors_ref.py). A baked result (GET /api/colors, the showcase) is used when there is one.
// in:  { id, ra, dec, api, mode: 'baked' | 'estimate' | 'live' }
// out: { id, type: 'baked', result } | { id, type: 'none' } (no bake) | { id, type: 'estimate', exposures, bytes }
//      | { id, type: 'progress', text, done, total, bytes } | { id, type: 'result', result, source: 'live' }
import { imagesOf } from './images.js';
import { imageHeader, imageRows, flagsHeader, flagRows } from './fits.js';
import { parseCsv, parseVsx, checkColumns, catalogueStep, footprint, starOn, prepExposure, finish, Refused } from './colors.js';

export class Unavailable extends Error { constructor(state, reason, detail = null) { super(reason); this.state = state; this.detail = detail; } }
const CATS = ['twomass', 'catwise', 'allwise', 'gaia', 'simbad', 'vsx'], API_CAT = { twomass: '2mass' };
// only exposures with the star on them are used (colors_ref.build), so the search is a small circle about the star: every
// exposure that holds the star overlaps it (the reference listed the whole field, then kept the same exposures)
const DETS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'], R_LIST = 0.01;
const SAT = (1 << 1) | (1 << 15), PER_EXPOSURE = 2.1e6;              // bytes an exposure costs at most: rows of IMAGE, FLAGS, header
function limiter(n) {
  let busy = 0; const wait = [];
  const next = () => { if (busy >= n || !wait.length) return; busy++; const [fn, ok, no] = wait.shift(); Promise.resolve().then(fn).then(ok, no).finally(() => { busy--; next(); }); };
  return fn => new Promise((ok, no) => { wait.push([fn, ok, no]); next(); });
}
const s3 = limiter(12), api = limiter(4);
async function retry(fn, n = 3, signal) { let last; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; if (e instanceof Unavailable || (e.name === 'AbortError' && signal?.aborted)) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** i)); } } throw last; }
const deg = v => v.toFixed(5);
// every request has a deadline, so a stalled archive ends as "not answering" rather than a page that waits for ever;
// a superseded build is still cancelled silently (its own AbortError)
const DEADLINE = 90000, within = signal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE)]) : AbortSignal.timeout(DEADLINE));

// the six catalogues: parsed and checked here (the Worker stores them unread); a damaged one makes the result inconclusive
export async function catalogues(base, ra, dec, signal) {
  const out = {};
  await Promise.all(CATS.map(c => api(async () => {
    let r;
    let text;
    try { r = await retry(async () => { const x = await fetch(`${base}/api/cat?cat=${API_CAT[c] ?? c}&ra=${deg(ra)}&dec=${deg(dec)}`, { signal: within(signal) }); if (x.ok) text = await x.text(); return x; }, 2, signal); }
    catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; r = null; }
    const who = c === 'simbad' ? 'SIMBAD' : c === 'vsx' ? 'VSX (AAVSO, through VizieR)' : 'NASA\'s catalogue service (IRSA)';
    if (r?.status === 429) throw new Unavailable('unavailable', 'Too many new spots at once. Try again in a minute');
    if (!r?.ok) throw new Unavailable('unavailable', `${who} is not answering`);
    try { out[c] = c === 'vsx' ? parseVsx(text) : parseCsv(text); if (c !== 'vsx') checkColumns(c, out[c], text.split(/\r?\n/)[0]); }
    catch (e) { if (e instanceof Refused) throw new Unavailable('inconclusive', `the stored catalogue of this spot is damaged (${e.message})`); throw new Unavailable('inconclusive', `the stored ${c} catalogue of this spot is damaged`); }
  })));
  return out;
}
// every exposure the reference's search would list, per detector, oldest first
export async function exposureList(base, ra, dec, signal) {
  const all = await Promise.all(DETS.map(det => api(() => retry(async () => {
    const sig = within(signal), r = await fetch(`${base}/api/images?ra=${deg(ra)}&dec=${deg(dec)}&det=${det}&r=${R_LIST}&fmt=2&v=2`, { signal: sig });
    if (!r.ok) throw new Error(`images HTTP ${r.status}`);
    const seen = new Map();
    for (const x of imagesOf(await r.json())) if (!seen.has(x.obs)) seen.set(x.obs, { ...x, det });
    return [...seen.values()];
  }, 2, signal)).catch(e => { if (e.name === 'AbortError' && signal?.aborted) throw e; throw new Unavailable('unavailable', 'The SPHEREx image search is not answering'); })));
  return all.flat().sort((a, b) => a.t - b.t);
}
// one exposure: its header, the reference footprint, and its rows when the star is on it -> prepared, or null
async function readExposure(ctx, x, ra, dec, signal, count) {   // ra, dec: the footprint's centre
  const h = await s3(() => retry(() => imageHeader(x.key, within(signal)), 5, signal));
  count(32768);
  const fp = footprint(h, ra, dec);
  if (!fp) return null;
  const w = fp.x1 - fp.x0, ht = fp.y1 - fp.y0, e = { obs: x.obs, det: x.det, key: x.key, t: h['MJD-AVG'], x0: fp.x0, y0: fp.y0, w, h: ht, hdr: h };
  const on = starOn(ctx, e);
  if (!on) return null;
  const [px, fl] = await s3(() => retry(() => { const sig = within(signal); return Promise.all([imageRows(x.key, h, fp.y0, fp.y1 - 1, sig), flagsHeader(x.key, h, sig).then(f => flagRows(x.key, f, fp.y0, fp.y1 - 1, sig))]); }, 5, signal));   // S3 drops a socket now and then under 12 reads at once
  count(px.length * 4 + fl.length / 8);
  const W = h.NAXIS1, img = new Float32Array(w * ht), flg = new Int32Array(w * ht);
  for (let y = 0; y < ht; y++) { img.set(px.subarray(y * W + fp.x0, y * W + fp.x1), y * w); flg.set(fl.subarray(y * W + fp.x0, y * W + fp.x1), y * w); }
  let sat = false;
  for (let y = on.yi - 1; y <= on.yi + 1; y++) for (let k = on.xi - 1; k <= on.xi + 1; k++) sat ||= (flg[y * w + k] & SAT) !== 0;
  return { prepared: prepExposure(ctx, { ...e, img, flg }), sat };
}

// the whole build, live: -> the result (an inconclusive one when an input is unavailable or damaged)
// field (tests only): the footprint's centre when it is not the star's spot (the reference fixtures' field centres)
export async function buildLive({ base, ra, dec, field = null, signal, progress = () => {} }) {
  try {
    progress({ text: 'Fetching the star catalogues' });
    const [cats, list] = await Promise.all([catalogues(base, ra, dec, signal), exposureList(base, ra, dec, signal)]);
    const ctx = catalogueStep(cats, ra, dec);
    if (ctx.result) return ctx.result;
    if (!list.length) return { v: 1, method: 'colors-v1', state: 'no-coverage', reason: 'SPHEREx has no pictures of this star' };
    let bytes = 0, done = 0;
    const total = list.length, count = n => { bytes += n; };
    const out = await Promise.all(list.map(async x => {
      let r;
      try { r = await readExposure(ctx, x, field?.ra ?? ra, field?.dec ?? dec, signal, count); }
      catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; throw new Unavailable('unavailable', 'NASA\'s SPHEREx archive (S3) is not answering', `${x.obs}: ${e.name}: ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ""}`); }
      done++;
      progress({ text: `Reading SPHEREx pictures: ${done} of ${total}`, done, total, bytes });
      return r;
    }));
    const kept = out.filter(Boolean);
    progress({ text: 'Measuring the star and its comparison stars', done: total, total, bytes });
    return finish(ctx, kept.map(k => k.prepared), { exposures_listed: total, saturated: kept.map(k => k.sat) });
  } catch (e) {
    if ((e.name === 'AbortError' && signal?.aborted) || !(e instanceof Unavailable)) throw e;
    // input_failure: an archive down or a stored input damaged, never a finding about the star (the bake refuses these)
    return { v: 1, method: 'colors-v1', state: e.state, reason: e.message, input_failure: true, ...(e.detail ? { detail: e.detail } : {}) };
  }
}
// the baked result (bake/colors_bake.mjs), only when its own star is within 2 arcsec of this spot
export async function baked(base, ra, dec, signal) {
  const r = await fetch(`${base}/api/colors?ra=${deg(ra)}&dec=${deg(dec)}`, { signal });
  if (r.status !== 200) return null;
  const res = await r.json(), D = Math.PI / 180;
  if (!(Math.acos(Math.min(1, Math.sin(dec * D) * Math.sin(res.dec * D) + Math.cos(dec * D) * Math.cos(res.dec * D) * Math.cos((ra - res.ra) * D))) / D * 3600 <= 2)) return null;
  return res;
}
// what a live build will download, said before it starts: every listed exposure's header and, at most, its rows
export async function estimate(base, ra, dec, signal) {
  const list = await exposureList(base, ra, dec, signal);
  return { exposures: list.length, bytes: list.length * PER_EXPOSURE };
}

let stop = null;
async function run({ id, ra, dec, api: base = '', mode }, post) {
  const ac = new AbortController(), signal = ac.signal;
  if (mode === 'live') stop = ac;
  try {
    if (mode === 'baked') { const b = await baked(base, ra, dec, signal).catch(e => { if (e.name === 'AbortError') throw e; return null; }); post(b ? { type: 'baked', result: b } : { type: 'none' }); return; }
    if (mode === 'estimate') { try { post({ type: 'estimate', ...(await estimate(base, ra, dec, signal)) }); } catch (e) { if (e.name === 'AbortError') return; post({ type: 'result', source: 'live', result: { v: 1, state: e.state ?? 'unavailable', reason: e.message } }); } return; }
    const result = await buildLive({ base, ra, dec, signal, progress: p => post({ type: 'progress', ...p }) });
    post({ type: 'result', result, source: 'live' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    post({ type: 'result', source: 'live', result: { v: 1, state: 'unavailable', reason: `the build stopped: ${e.message || e}` } });
  }
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined' && typeof process === 'undefined') {
  // a new live build stops the one before; the page drops answers for any id but its current one
  self.onmessage = ({ data }) => {
    if (data.mode === 'live') stop?.abort();
    run(data, m => self.postMessage({ ...m, id: data.id }));
  };
}
