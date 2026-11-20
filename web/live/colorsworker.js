// "Colors", fetched and built: a Web Worker for the page (web/colors.js), also run in Node by the bake (bake/colors_bake.mjs).
// It reads the spot's six catalogues (GET /api/cat), lists the SPHEREx exposures (GET /api/images), reads each one's header
// and, when the star is on it, the IMAGE and FLAGS rows of the reference footprint from NASA's S3 copy, and runs
// web/live/colors.js (the port of bake/colors_ref.py). A baked result (GET /api/colors, the showcase) is used when there is one.
// in:  { id, ra, dec, api, mode: 'baked' | 'estimate' | 'live' }
// out: { id, type: 'baked', result } | { id, type: 'none' } (no bake) | { id, type: 'estimate', exposures, bytes }
//      | { id, type: 'progress', text, done, total, bytes } | { id, type: 'result', result, source: 'live' }
import { imagesOf } from './images.js';
import { imageHeader, imageRows, flagsHeader, flagRows } from './fits.js';
import { parseCsv, parseVsx, checkColumns, catalogueStep, footprint, starOn, prepExposure, finish, Refused, parity } from './colors.js';
import { calibrate, calibrators, neowiseVisits } from './brightness.js';

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
// optional: catalogues that may be missing (an empty list then, and their names in out.missing)
export async function catalogues(base, ra, dec, signal, optional = [], cats = CATS) {
  const out = { missing: [] };
  await Promise.all(cats.map(c => api(async () => {
    let r;
    let text;
    // an optional list gets one try of 20 s: a stored one answers at once, and a down archive (CDS) must not hold the build
    const opt = optional.includes(c), sig = () => (opt ? AbortSignal.any([within(signal), AbortSignal.timeout(20000)]) : within(signal));
    try { r = await retry(async () => { const x = await fetch(`${base}/api/cat?cat=${API_CAT[c] ?? c}&ra=${deg(ra)}&dec=${deg(dec)}`, { signal: sig() }); if (x.ok) text = await x.text(); return x; }, opt ? 1 : 2, signal); }
    catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; r = null; }
    const who = c === 'simbad' ? 'SIMBAD' : c === 'vsx' ? 'VSX (AAVSO, through VizieR)' : 'NASA\'s catalogue service (IRSA)';
    if (r?.status === 429) throw new Unavailable('unavailable', 'Too many new spots at once. Try again in a minute');
    if (!r?.ok && opt) { out[c] = []; out.missing.push(c); return; }
    if (!r?.ok) throw new Unavailable('unavailable', `${who} is not answering`);
    try { out[c] = c === 'vsx' ? parseVsx(text) : parseCsv(text); if (c !== 'vsx') checkColumns(c, out[c], text.split(/\r?\n/)[0]); }
    catch (e) { if (e instanceof Refused) throw new Unavailable('inconclusive', `the stored catalogue of this spot is damaged (${e.message})`); throw new Unavailable('inconclusive', `the stored ${c} catalogue of this spot is damaged`); }
  })));
  return out;
}
// every exposure the reference's search would list, per detector, oldest first
export async function exposureList(base, ra, dec, signal, dets = DETS) {
  const all = await Promise.all(dets.map(det => api(() => retry(async () => {
    const sig = within(signal), r = await fetch(`${base}/api/images?ra=${deg(ra)}&dec=${deg(dec)}&det=${det}&r=${R_LIST}&fmt=2&v=2`, { signal: sig });
    if (!r.ok) throw new Error(`images HTTP ${r.status}`);
    const seen = new Map();
    for (const x of imagesOf(await r.json())) if (!seen.has(x.obs)) seen.set(x.obs, { ...x, det });
    return [...seen.values()];
  }, 2, signal)).catch(e => { if (e.name === 'AbortError' && signal?.aborted) throw e; throw new Unavailable('unavailable', 'The SPHEREx image search is not answering'); })));
  return all.flat().sort((a, b) => a.t - b.t);
}
// one exposure: its header, the reference footprint, and its rows when the star is on it -> prepared, or null
// want(e, on): whether to read its rows, once the header says where the star is (the Brightness card's band filter)
async function readExposure(ctx, x, ra, dec, signal, count, want = () => true) {   // ra, dec: the footprint's centre
  const h = await s3(() => retry(() => imageHeader(x.key, within(signal)), 5, signal));
  count(32768);
  const fp = footprint(h, ra, dec);
  if (!fp) return null;
  const w = fp.x1 - fp.x0, ht = fp.y1 - fp.y0, e = { obs: x.obs, det: x.det, key: x.key, t: h['MJD-AVG'], x0: fp.x0, y0: fp.y0, w, h: ht, hdr: h };
  const on = starOn(ctx, e);
  if (!on || !want(e, on)) return null;
  const [px, fl] = await s3(() => retry(() => { const sig = within(signal); return Promise.all([imageRows(x.key, h, fp.y0, fp.y1 - 1, sig), flagsHeader(x.key, h, sig).then(f => flagRows(x.key, f, fp.y0, fp.y1 - 1, sig))]); }, 5, signal));   // S3 drops a socket now and then under 12 reads at once
  count(px.length * 4 + fl.length / 8);
  const W = h.NAXIS1, img = new Float32Array(w * ht), flg = new Int32Array(w * ht);
  for (let y = 0; y < ht; y++) { img.set(px.subarray(y * W + fp.x0, y * W + fp.x1), y * w); flg.set(fl.subarray(y * W + fp.x0, y * W + fp.x1), y * w); }
  let sat = false;
  for (let y = on.yi - 1; y <= on.yi + 1; y++) for (let k = on.xi - 1; k <= on.xi + 1; k++) sat ||= (flg[y * w + k] & SAT) !== 0;
  return { prepared: prepExposure(ctx, { ...e, img, flg }), sat };
}

// ---------- Brightness change (timelapse.html): the star's W1 and W2 now, against WISE and NEOWISE ----------
// Colors' measurement on D4 to D6 only, and only exposures that see the star inside (or within 0.15 um of) W1 or W2;
// then per SPHEREx pass the WISE-band synthesis of the star and of its calibration stars, calibrated offset-only on them
// (live/brightness.js). NEOWISE single exposures come from GET /api/cat?cat=neowise. SIMBAD and VSX only screen the
// calibration stars for variables: when they do not answer, the build goes on without them and says so.
const BRIGHT_DETS = ['D4', 'D5', 'D6'], MJD_NEO = 58665;
const inBand = (lam, b) => { const [lo, hi] = parity.bandLimits(b); return lam >= lo - 0.15 && lam <= hi + 0.15; };
export async function buildBright({ base, ra, dec, at = null, signal, progress = () => {} }) {
  try {
    progress({ text: 'Fetching the star catalogues' });
    const [cats, list] = await Promise.all([catalogues(base, ra, dec, signal, ['simbad', 'vsx']), exposureList(base, ra, dec, signal, BRIGHT_DETS)]);
    if (!cats.catwise.length && !cats.allwise.some(r => Number(r.w1mpro) < 10)) return { v: 1, state: 'no-star', reason: 'No WISE source within 3 arcsec of the middle of the photo' };
    const ctx = catalogueStep(cats, ra, dec, at, 3);
    if (ctx.result) return { v: 1, state: 'no-star', reason: 'No WISE source within 3 arcsec of the middle of the photo' };
    const { K, T } = ctx, P = parity, blend = K.nmem[T], src = K.src[T];
    const star = { name: K.name[T], ra: K.ra[T], dec: K.dec[T], blend, ref: src === 'cw' ? 'CatWISE2020' : 'AllWISE', ref_mag: { W1: [K.w1[T], K.e1[T]], W2: [K.w2[T], K.e2[T]] } };
    const pos = mjd => P.skyPos(K, mjd, T), pm = Math.hypot(K.pme[T], K.pmn[T]);
    // NEOWISE: a cone about the star's CatWISE-epoch place wide enough for its motion over 2014 to 2024
    const neo = blend > 1 ? Promise.resolve(null) : api(() => retry(async () => {
      // ponytail: one cone, centred mid-NEOWISE (2019.5), reaches 2013.9 and 2024.6 for motions up to 4.8"/yr; faster
      // stars lose their earliest and latest visits (split the cone if that ever matters: they are few, and bright)
      const [a0, d0] = pos(MJD_NEO), r0 = (Math.round(a0 * 1e5) / 1e5 % 360 + 360) % 360, r = Math.min(30, Math.ceil(3 + pm * 5.6));   // RA past 360 after the motion: wrapped
      const x = await fetch(`${base}/api/cat?cat=neowise&ra=${r0.toFixed(5)}&dec=${d0.toFixed(5)}&r=${r}`, { signal: within(signal) });
      if (x.status === 429 || x.status >= 500) return { status: x.status };
      if (!x.ok) throw new Error(`neowise HTTP ${x.status}`);
      return { rows: parseCsv(await x.text()) };
    }, 2, signal)).catch(e => { if (e.name === 'AbortError' && signal?.aborted) throw e; return { status: 0 }; });
    if (!list.length) return { v: 1, state: 'no-coverage', reason: 'SPHEREx has no pictures of this spot at 2.4 to 5 µm', star, neowise: neoOut(await neo, star, pos) };
    let bytes = 0, done = 0;
    const total = list.length, count = n => { bytes += n; };
    const want = (e, on) => { const l = P.wave(e.det, on.yi + e.y0, on.xi + e.x0); e.lam = l; return inBand(l, 'W1') || inBand(l, 'W2'); };
    const out = await Promise.all(list.map(async x => {
      let r;
      try { r = await readExposure(ctx, x, ra, dec, signal, count, want); }
      catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; throw new Unavailable('unavailable', 'NASA\'s SPHEREx archive (S3) is not answering', `${x.obs}: ${e.message}`); }
      done++;
      progress({ text: `Reading SPHEREx pictures: ${done} of ${total}, ${Math.round(bytes / 1e6)} MB`, done, total, bytes });
      return r;
    }));
    const kept = out.filter(Boolean);
    if (!kept.length) return { v: 1, state: 'no-coverage', reason: 'SPHEREx has no pictures of this star at 3 to 5 µm', star, neowise: neoOut(await neo, star, pos) };
    progress({ text: 'Measuring the star and its calibration stars', done: total, total, bytes });
    const num = v => (v === '' || v == null ? NaN : Number(v));
    const vars = [...cats.gaia.filter(r => r.phot_variable_flag === 'VARIABLE'), ...cats.simbad.filter(r => P.VAR_OTYPE.test(r.otype || '')), ...cats.vsx.map(r => ({ ra: r.RAJ2000, dec: r.DEJ2000 }))]
      .map(r => [num(r.ra), num(r.dec)]).filter(([a, d]) => Number.isFinite(a) && Number.isFinite(d));
    const cal = calibrators(K, T, vars), X = kept.map(k => k.prepared), psf = P.psfs(X, K), rows = [];
    for (const a of X) if (psf[a.det]) rows.push(...P.stampFit(a, K, psf[a.det], [T, ...cal]));
    // passes: the star's exposure times split at 60 days, shared by every star (as colors.js perSource does)
    const times = [...new Set(X.map(a => a.t))].sort((a, b) => a - b), g = P.passGroups(times), passes = [...new Set(g)].map(k => times.filter((_, i) => g[i] === k)).map(v => v.reduce((s, t) => s + t, 0) / v.length);
    const passOf = t => passes.reduce((b, p, k) => (Math.abs(t - p) < Math.abs(t - passes[b]) ? k : b), 0);
    const raw = i => rows.filter(r => r[0] === i).map(r => r.slice(1));
    const spherex = {};
    for (const b of ['W1', 'W2']) {
      const mine = raw(T), cm = cal.map(i => ({ i, rows: raw(i), m: b === 'W1' ? K.w1[i] : K.w2[i] })), dets = b === 'W1' ? ['D4'] : ['D5', 'D6'];
      spherex[b] = passes.map((mjd, k) => {
        const inPass = rs => rs.filter(r => passOf(r[3]) === k), here = kept.filter(x => passOf(x.prepared.t) === k && inBand(x.prepared.lam, b));
        const sat = here.filter(x => x.sat).length;
        if (here.length && 2 * sat >= here.length) return { mjd, why: `too bright: SPHEREx saturates on it in ${sat} of ${here.length} pictures` };
        if (dets.some(d => !psf[d] && X.some(a => a.det === d))) return { mjd, why: 'too few stars here to model SPHEREx\'s image' };
        const c = calibrate(P.wisePass(inPass(mine), b, true), cm.map(x => ({ p: P.wisePass(inPass(x.rows), b), m: x.m })), b);
        return { mjd, ...c };
      });
    }
    const sat = kept.filter(x => x.sat).length, allBright = ['W1', 'W2'].every(b => spherex[b].every(p => /^too bright/.test(p.why ?? '')));
    return { v: 1, state: allBright ? 'too-bright' : 'ok', reason: allBright ? `SPHEREx saturates on this star in ${sat} of ${kept.length} pictures: it is too bright to measure cleanly. Fainter stars work.` : '',
      star, spherex, calibrators: cal.length, screened: cats.missing.length ? `${cats.missing.map(c => c === 'vsx' ? 'VSX' : 'SIMBAD').join(' and ')} did not answer, so calibration stars were screened for variables by Gaia only` : '',
      neowise: neoOut(await neo, star, pos), download: { exposures: kept.length, listed: total, bytes } };
  } catch (e) {
    if ((e.name === 'AbortError' && signal?.aborted) || !(e instanceof Unavailable)) throw e;
    return { v: 1, state: e.state === 'inconclusive' ? 'unavailable' : e.state, reason: e.message, input_failure: true };
  }
}
// NEOWISE's W1 visits, or why there are none to show
function neoOut(n, star, pos) {
  if (star.blend > 1) return { state: 'blend', W1: [] };
  if (!n?.rows) return { state: n?.status === 429 ? 'busy' : 'unavailable', W1: [] };
  const W1 = neowiseVisits(n.rows, 'W1', pos);
  return { state: W1.length >= 3 ? 'ok' : 'few', W1 };
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
  const r = await fetch(`${base}/api/colors?ra=${deg(ra)}&dec=${deg(dec)}`, { signal: within(signal) });   // the deadline covers the body too
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

let stop = null, stopBright = null;
async function run({ id, ra, dec, at, api: base = '', mode }, post) {
  const ac = new AbortController(), signal = ac.signal;
  if (mode === 'live') stop = ac;
  if (mode === 'bright') stopBright = ac;
  try {
    if (mode === 'bright') { post({ type: 'result', result: await buildBright({ base, ra, dec, at, signal, progress: p => post({ type: 'progress', ...p }) }) }); return; }
    if (mode === 'baked') { const b = await baked(base, ra, dec, signal).catch(e => { if (e.name === 'AbortError' && signal.aborted) throw e; return null; }); post(b ? { type: 'baked', result: b } : { type: 'none' }); return; }
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
    if (data.mode === 'bright' || data.mode === 'stop-bright') { stopBright?.abort(); if (data.mode === 'stop-bright') return; }
    run(data, m => self.postMessage({ ...m, id: data.id }));
  };
}
