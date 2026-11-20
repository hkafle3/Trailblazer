// "Colors", fetched and built: a Web Worker for the page (web/colors.js), also run in Node by the bake (bake/colors_bake.mjs).
// It reads the spot's six catalogues (GET /api/cat), lists the SPHEREx exposures (GET /api/images), reads each one's header
// and, when the star is on it, the IMAGE and FLAGS rows of the reference footprint from NASA's S3 copy, and runs
// web/live/colors.js (the port of bake/colors_ref.py). A baked result (GET /api/colors, the showcase) is used when there is one.
// in:  { id, ra, dec, api, mode: 'baked' | 'estimate' | 'live' }
// out: { id, type: 'baked', result } | { id, type: 'none' } (no bake) | { id, type: 'estimate', exposures, bytes }
//      | { id, type: 'progress', text, done, total, bytes } | { id, type: 'result', result, source: 'live' }
import { imagesOf } from './images.js';
import { imageHeader, imageRows, flagsHeader, flagRows, epsfRow, worldToPix } from './fits.js';
import { parseCsv, parseVsx, checkColumns, catalogueStep, footprint, starOn, prepExposure, finish, Refused, parity } from './colors.js';
import { calibrate, calibrators, neowiseVisits, neoQuery } from './brightness.js';

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
const s3 = limiter(24), api = limiter(6);   // s3: four host names of six connections each (fits.js hostOf)
async function retry(fn, n = 3, signal) { let last; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; if (e instanceof Unavailable || (e.name === 'AbortError' && signal?.aborted)) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** i)); } } throw last; }
const deg = v => v.toFixed(5);
// every request has a deadline, so a stalled archive ends as "not answering" rather than a page that waits for ever;
// a superseded build is still cancelled silently (its own AbortError)
const DEADLINE = 90000, within = signal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE)]) : AbortSignal.timeout(DEADLINE));

// the six catalogues: parsed and checked here (the Worker stores them unread); a damaged one makes the result inconclusive
// an IPAC table (IRSA Gator, outfmt 1): the |name| line, then whitespace-separated rows; "null" is empty
const ipacHead = text => (text.split('\n').find(l => l.startsWith('|')) ?? '').split('|').map(c => c.trim()).filter(Boolean).join(',');
export function parseIpac(text) {
  const names = ipacHead(text).split(','), out = [];
  for (const l of text.split('\n')) {
    if (!l.trim() || l[0] === '\\' || l[0] === '|') continue;
    const v = l.trim().split(/\s+/), r = {};
    names.forEach((n, i) => { r[n] = v[i] === 'null' || v[i] == null ? '' : v[i]; });
    out.push(r);
  }
  return out;
}
// cats: which of them (the Brightness card asks for three)
export async function catalogues(base, ra, dec, signal, cats = CATS) {
  const out = {};
  await Promise.all(cats.map(c => api(async () => {
    let r;
    let text;
    try { r = await retry(async () => { const x = await fetch(`${base}/api/cat?cat=${API_CAT[c] ?? c}&ra=${deg(ra)}&dec=${deg(dec)}`, { signal: within(signal) }); if (x.ok) text = await x.text(); return x; }, 2, signal); }
    catch (e) { if (e.name === 'AbortError' && signal?.aborted) throw e; r = null; }
    const who = c === 'simbad' ? 'SIMBAD' : c === 'vsx' ? 'VSX (AAVSO, through VizieR)' : 'NASA\'s catalogue service (IRSA)';
    if (r?.status === 429) throw new Unavailable('unavailable', 'Too many new spots at once. Try again in a minute');
    if (!r?.ok) throw new Unavailable('unavailable', `${who} is not answering`);
    try {
      // a whole field from IRSA's Gator comes as its IPAC table (worker/src/cat.js); Gaia's is not cut at G 20 there
      const ipac = text.startsWith('\\'), rows = c === 'vsx' ? parseVsx(text) : ipac ? parseIpac(text) : parseCsv(text);
      if (c !== 'vsx') checkColumns(c, rows, ipac ? ipacHead(text) : text.split(/\r?\n/)[0]);
      out[c] = c === 'gaia' && ipac ? rows.filter(r => Number(r.phot_g_mean_mag) < 20 && r.pmra !== '') : rows;
    }
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

// ---------- Brightness change (timelapse.html): the star's W1 and W2 now, against WISE and NEOWISE ----------
// Built to show something at once and finish in seconds:
// 1. the star's own CatWISE rows (a 10" cone) and its NEOWISE exposures: the table's WISE column and the history
//    (a 'partial' result), while the whole field's catalogues, the image list and the pictures' headers come in;
// 2. per SPHEREx exposure that sees the star inside (or within 0.15 um of) W1 or W2, only the rows about the star
//    (+-STRIP_H) across the catalogue cone (+-STRIP_X columns), its FLAGS rows and its own ePSF (the file's PSF model
//    for that part of the detector, fits.js epsfRow): about 0.5 MB, where Colors' 1200" square was 1.9 MB;
// 3. forced PSF photometry of the star and its calibration stars in that strip (colors.js prepExposure and stampFit,
//    with the ePSF in place of a field PSF built from 20 stars), the decade WISE-band synthesis per pass, and offset-only
//    calibration on the calibration stars (live/brightness.js); each pass is posted as it completes, the visit on
//    screen's first.
// SIMBAD and VSX only screen the calibration stars for variables: the build does not wait for them past its photometry.
const BRIGHT_DETS = ['D4', 'D5', 'D6'], MJD_NEO = 58665, MJD_CW = 57170, STRIP_H = 15, STRIP_X = 165, CAP = 0;   // CAP: pictures per synthesis bin and pass (0: all)
const inBand = (lam, b) => { const [lo, hi] = parity.bandLimits(b); return lam >= lo - 0.15 && lam <= hi + 0.15; };
const num = v => (v === '' || v == null ? NaN : Number(v));
// the ePSF as colors.js stampFit wants a PSF: 15 x 15 native pixels (every 5th oversampled point about the centre),
// summing to 1, spline-filtered as psfs() leaves its own
function nativePsf(e) {
  const p = new Float64Array(225);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) p[(dy + 7) * 15 + dx + 7] = Math.max(0, e[(16 + 5 * dy) * 33 + 16 + 5 * dx]);
  const t = p.reduce((a, v) => a + v, 0);
  for (let k = 0; k < 225; k++) p[k] /= t;
  return parity.splineFilter(p, 15, 15);
}
// the star from its own CatWISE rows: nearest the spot where it was at MJD at, within 3"; blended (as colors.js
// components) with every CatWISE source within 6" of it
function starOf(rows, ra, dec, at) {
  const D = Math.PI / 180, place = r => { const dt = (at - MJD_CW) / 365.25, pm = [num(r.pmra), num(r.pmdec)], ok = Math.hypot(pm[0] / num(r.sigpmra), pm[1] / num(r.sigpmdec)) > 3;
    const d0 = num(r.dec_pm); return ok ? [num(r.ra_pm) + pm[0] * dt / 3600 / Math.cos(d0 * D), d0 + pm[1] * dt / 3600, pm] : [num(r.ra_pm), d0, [0, 0]]; };
  const near = rows.filter(r => num(r.w1mpro_pm) < 16.5 || num(r.w2mpro_pm) < 16).map(r => [r, place(r)]).map(([r, p]) => [r, p, parity.sep(p[0], p[1], ra, dec)]).sort((a, b) => a[2] - b[2]);
  if (!near.length || near[0][2] > 3) return null;
  const [r0, p0] = near[0], group = near.filter(([, p]) => parity.sep(p[0], p[1], p0[0], p0[1]) <= 6), f = m => (Number.isFinite(m) ? 10 ** (-0.4 * m) : 0);
  const sum = (m, e) => { const F = group.reduce((a, [r]) => a + f(num(r[m])), 0); return F > 0 ? [-2.5 * Math.log10(F), Math.sqrt(group.reduce((a, [r]) => a + (f(num(r[m])) * num(r[e])) ** 2, 0)) / F] : [NaN, NaN]; };
  return { name: r0.source_name, ra: p0[0], dec: p0[1], pm: p0[2], blend: group.length, ref: 'CatWISE2020', ref_mag: { W1: sum('w1mpro_pm', 'w1sigmpro_pm'), W2: sum('w2mpro_pm', 'w2sigmpro_pm') } };
}
export async function buildBright({ base, ra, dec, at = 61100, signal: outer, progress: report = () => {}, partial: post = () => {}, stripH = STRIP_H, cap = CAP }) {
  const t0 = performance.now(), timing = {}, mark = k => { timing[k] ??= +((performance.now() - t0) / 1000).toFixed(2); };
  // the build's own stop: when it returns, early or not, reads still on their way are dropped and say nothing more
  const stop = new AbortController(), signal = outer ? AbortSignal.any([outer, stop.signal]) : stop.signal;
  let over = false;
  const progress = p => { if (!over) report(p); }, partial = r => { if (!over) post(r); };
  try {
    progress({ text: 'Finding the star in WISE' });
    const getCat = async (q, opt) => {   // one catalogue answer -> rows, or null (optional ones: one 20 s try)
      const x = await retry(() => fetch(`${base}/api/cat?${q}`, { signal: opt ? AbortSignal.any([within(signal), AbortSignal.timeout(20000)]) : within(signal) }), opt ? 1 : 2, signal).catch(e => { if (e.name === 'AbortError' && signal?.aborted) throw e; return null; });
      if (x?.status === 429) throw new Unavailable('unavailable', 'Too many new spots at once. Try again in a minute');
      if (!x?.ok) return null;
      const t = await x.text();
      return q.startsWith('cat=vsx') ? parseVsx(t) : t.startsWith('\\') ? parseIpac(t) : parseCsv(t);   // VSX: VizieR's tab-separated text
    };
    // everything that needs no star starts now: the field's catalogues, the screening lists, the image list
    const field = catalogues(base, ra, dec, signal, ['catwise', 'allwise', 'gaia']).finally(() => mark('field catalogues'));
    const screened = {};   // SIMBAD and VSX as they answer; the build reads whichever are in when its photometry is done
    for (const c of ['simbad', 'vsx']) getCat(`cat=${c}&ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`, true).then(r => { screened[c] = r; }, () => { screened[c] = null; });
    const listP = exposureList(base, ra, dec, signal, BRIGHT_DETS).finally(() => mark('image list'));
    field.catch(() => {}); listP.catch(() => {});   // awaited below; a build stopped early must not leave them unhandled
    // 1. the star itself, and NEOWISE: the first numbers on the card. NEOWISE is asked at once, 8" about the spot (the
    //    star is within 3" of it); a star moving fast enough to leave that cone is asked again where it was
    const q4 = v => (Math.round(v * 1e4) / 1e4).toFixed(4);
    const neoSpot = getCat(neoQuery(ra, dec, 8)).then(r => (r ? { rows: r } : { status: 0 }), e => { if (e.name === 'AbortError' && signal?.aborted) throw e; return { status: 0 }; });
    neoSpot.catch(() => {});
    const mine = await getCat(`cat=catwise&ra=${q4(ra)}&dec=${q4(dec)}&r=10`);
    const star0 = mine && starOf(mine, ra, dec, at);
    const pos0 = mjd => { const dt = (mjd - at) / 365.25; return [star0.ra + star0.pm[0] * dt / 3600 / Math.cos(star0.dec * Math.PI / 180), star0.dec + star0.pm[1] * dt / 3600]; };
    const neoAsked = {};
    const neoFor = async (s, posAt, pm) => {   // the visits of star s: the spot's cone when it holds the whole track, else a cone of its own
      if (s.blend > 1) return null;
      if (P.sep(...posAt(MJD_NEO), ra, dec) + Math.hypot(...pm) * 5.6 + 2.5 <= 8) return neoSpot;
      const [a0, d0] = posAt(MJD_NEO), q = neoQuery(a0, d0, Math.min(30, Math.ceil(3 + Math.hypot(...pm) * 5.6)));
      return (neoAsked[q] ??= getCat(q).then(rows => (rows ? { rows } : { status: 0 }), () => ({ status: 0 })));   // one request per cone
    };
    const P = parity;
    // the card's partial view: the star, NEOWISE once it is in ('loading' until then), the passes measured so far
    const view = { star: star0, neowise: { state: 'loading', W1: [], W2: [] }, spherex: null };
    const show = () => partial({ v: 1, state: 'partial', ...view, spherex: view.spherex && JSON.parse(JSON.stringify(view.spherex)) });
    let neoP = null;
    if (star0) {
      mark('first content');
      show();
      progress({ text: 'Reading the SPHEREx pictures' });   // the WISE column is up: the line says what is still coming
      neoP = neoFor(star0, pos0, star0.pm).then(n => { if (view.star === star0) { view.neowise = neoOut(n, star0, pos0); mark('neowise'); show(); } return n; });
      neoP.catch(() => {});
    }
    // 2. the pictures, read while the field's catalogues come in: headers, then each in-band picture's strip, FLAGS rows
    //    and ePSF, cropped to the catalogue cone's columns (positions from the star's own rows; from the field when the
    //    star is not in CatWISE)
    let ctxP = null;
    const fieldStep = () => (ctxP ??= field.then(cats => {
      cats.twomass = []; cats.simbad = []; cats.vsx = [];
      if (!cats.catwise.length && !cats.allwise.some(r => Number(r.w1mpro) < 10)) return null;
      const c = catalogueStep(cats, ra, dec, at, 3);
      return c.result ? null : { ctx: c, cats };
    }));
    const where = star0 ? pos0 : await fieldStep().then(f => f && (mjd => P.skyPos(f.ctx.K, mjd, f.ctx.T)));
    if (!where) return { v: 1, state: 'no-star', reason: 'No WISE source within 3 arcsec of the middle of the photo' };
    const list = await listP;
    let bytes = 0;
    progress({ text: `Reading the SPHEREx pictures (${list.length} listed)` });
    const heads = (await Promise.all(list.map(x => s3(() => retry(() => imageHeader(x.key, within(signal)), 5, signal)).then(h => { bytes += 32768; return { x, h }; })
      .catch(e => { if (e.name === 'AbortError' && signal?.aborted) throw e; throw new Unavailable('unavailable', 'NASA\'s SPHEREx archive (S3) is not answering', `${x.obs}: ${e.message}`); }))));
    mark('headers');
    const todo = [];
    for (const { x, h } of heads) {
      const t = h['MJD-AVG'], q = worldToPix(h, ...where(t));
      if (!q || !(q[0] >= 2 && q[1] >= 2 && q[0] <= 2037 && q[1] <= 2037)) continue;
      const lam = P.wave(x.det, q[1], q[0]);
      if (inBand(lam, 'W1') || inBand(lam, 'W2')) todo.push({ x, h, t, q, lam });
    }
    const g = P.passGroups(todo.map(e => e.t)), passes = [...new Set(g)].sort((a, b) => a - b).map(k => {
      const v = todo.filter((_, i) => g[i] === k);
      if (!cap) return v;
      const bins = new Map();   // the synthesis's lambda/45 bins from 2.6 um (colors.js DEDGES): at most cap pictures each
      for (const e of v) { const b = Math.floor(Math.log(e.lam / 2.6) / Math.log(1 + 1 / 45)); bins.set(b, [...(bins.get(b) ?? []), e]); }
      return [...bins.values()].flatMap(es => es.slice(0, cap));
    });
    const mids = passes.map(v => v.reduce((a, e) => a + e.t, 0) / v.length), order = mids.map((_, k) => k).sort((a, b) => Math.abs(mids[a] - at) - Math.abs(mids[b] - at));
    let got = 0;
    const total = passes.reduce((a, v) => a + v.length, 0);
    const read = async e => {   // one picture's strip (rows +-stripH, columns +-STRIP_X), FLAGS rows and ePSF row
      const h = e.h, W = h.NAXIS1, x0 = Math.max(0, Math.round(e.q[0]) - STRIP_X), x1 = Math.min(W, Math.round(e.q[0]) + STRIP_X + 1), y0 = Math.max(0, Math.round(e.q[1]) - stripH), y1 = Math.min(h.NAXIS2, Math.round(e.q[1]) + stripH + 1);
      let px, fl, ep;
      try {
        [px, [fl, ep]] = await s3(() => retry(() => { const sig = within(signal);   // the rows need only the header: asked with FLAGS's header
          return Promise.all([imageRows(e.x.key, h, y0, y1 - 1, sig), flagsHeader(e.x.key, h, sig).then(f => Promise.all([flagRows(e.x.key, f, y0, y1 - 1, sig), epsfRow(e.x.key, h, f, e.q[0], e.q[1], sig)]))]); }, 5, signal));
      } catch (err) { if (err.name === 'AbortError' && signal?.aborted) throw err; throw new Unavailable('unavailable', 'NASA\'s SPHEREx archive (S3) is not answering', `${e.x.obs}: ${err.message}`); }
      bytes += px.length * 4 + 40000 + 8752;
      const w = x1 - x0, ht = y1 - y0, img = new Float32Array(w * ht), flg = new Int32Array(w * ht);
      for (let y = 0; y < ht; y++) { img.set(px.subarray(y * W + x0, y * W + x1), y * w); flg.set(fl.subarray(y * W + x0, y * W + x1), y * w); }
      const xi = Math.round(e.q[0]) - x0, yi = Math.round(e.q[1]) - y0;
      let sat = false;
      for (let y = yi - 1; y <= yi + 1; y++) for (let k = xi - 1; k <= xi + 1; k++) sat ||= (flg[y * w + k] & SAT) !== 0;
      progress({ text: `Reading SPHEREx pictures: ${++got} of ${total}`, done: got, total, bytes });   // (bytes: image rows and headers only; FLAGS is compressed)
      return { e, x0, x1, y0, y1, w, ht, img, flg, ep, sat };
    };
    // every picture is queued now, the visit on screen's pass first (the S3 limiter is first come, first served)
    const reads = order.map(k => passes[k].map(e => read(e)));
    reads.flat().forEach(r => r.catch(() => {}));
    // 3. the field: the star as Colors' components see it (the authority from here on), its calibration stars, NEOWISE
    const F = await fieldStep();
    if (!F) return { v: 1, state: 'no-star', reason: 'No WISE source within 3 arcsec of the middle of the photo' };
    const { ctx, cats } = F, { K, T } = ctx, blend = K.nmem[T];
    const star = { name: K.name[T], ra: K.ra[T], dec: K.dec[T], blend, ref: K.src[T] === 'cw' ? 'CatWISE2020' : 'AllWISE', ref_mag: { W1: [K.w1[T], K.e1[T]], W2: [K.w2[T], K.e2[T]] } };
    const pos = mjd => P.skyPos(K, mjd, T);
    if (!star0) { mark('first content'); view.star = star; show(); progress({ text: 'Reading the SPHEREx pictures' }); }
    // NEOWISE of the star as the field sees it (the early answer when it is the same cone), without holding up the pictures
    const neoFinal = neoFor(star, pos, [K.pme[T], K.pmn[T]]).then(n => { const o = neoOut(n, star, pos); view.star = star; view.neowise = o; mark('neowise'); show(); return o; });
    neoFinal.catch(() => {});
    if (!list.length) return { v: 1, state: 'no-coverage', reason: 'SPHEREx has no pictures of this spot at 2.4 to 5 µm', star, neowise: await neoFinal };
    if (!todo.length) return { v: 1, state: 'no-coverage', reason: 'SPHEREx has no pictures of this star at 3 to 5 µm', star, neowise: await neoFinal };
    const gaiaVars = cats.gaia.filter(r => r.phot_variable_flag === 'VARIABLE').map(r => [num(r.ra), num(r.dec)]);
    // every calibration-star candidate in the field: each strip fits those that fall in it; SIMBAD and VSX take some out
    // later, if they answer
    const pool = calibrators(K, T, gaiaVars, Infinity);
    const rows = [], sats = passes.map(() => []), spherex = { W1: mids.map(mjd => ({ mjd, pending: true })), W2: mids.map(mjd => ({ mjd, pending: true })) };
    const fit = (d, k) => {   // one picture's strip (of pass k) -> the star's and its calibration stars' fluxes
      const { e, x0, x1, y0, y1, w, ht, img, flg, ep } = d, h = e.h;
      const a = prepExposure(ctx, { obs: e.x.obs, det: e.x.det, key: e.x.key, t: e.t, x0, y0, w, h: ht, hdr: h, img, flg });
      // only the components near the strip go to stampFit (it places every component it is given in every picture):
      // their pixels from the picture's local linear map about the star, a box 20 pixels wider than the strip
      const c0 = worldToPix(h, K.ra[T], K.dec[T]), cE = worldToPix(h, K.ra[T] + 0.01 / Math.cos(K.dec[T] * Math.PI / 180), K.dec[T]), cN = worldToPix(h, K.ra[T], K.dec[T] + 0.01);
      const near = [];
      for (let i = 0; i < K.ra.length; i++) {
        const dE = ((K.ra[i] - K.ra[T] + 540) % 360 - 180) * Math.cos(K.dec[T] * Math.PI / 180) / 0.01, dN = (K.dec[i] - K.dec[T]) / 0.01;
        const px = c0[0] + dE * (cE[0] - c0[0]) + dN * (cN[0] - c0[0]), py = c0[1] + dE * (cE[1] - c0[1]) + dN * (cN[1] - c0[1]);
        if (px > x0 - 20 && px < x1 + 20 && py > y0 - 20 && py < y1 + 20) near.push(i);
      }
      const sub = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, near.map(i => v[i])])), idx = new Map(near.map((i, j) => [i, j]));
      const meas = [T, ...pool].filter(i => idx.has(i)).map(i => idx.get(i));
      for (const r of P.stampFit(a, sub, nativePsf(ep), meas)) rows.push([near[r[0]], ...r.slice(1, 5), k]);
    };
    const raw = (i, k) => rows.filter(r => r[0] === i && r[5] === k).map(r => r.slice(1, 5));   // by the pass each picture was put in
    const finishPass = (k, vars) => {
      for (const b of ['W1', 'W2']) {
        const here = sats[k].filter(s => inBand(s.lam, b)), n = here.filter(s => s.sat).length;
        if (here.length && 2 * n >= here.length) { spherex[b][k] = { mjd: mids[k], why: `too bright: SPHEREx saturates on it in ${n} of ${here.length} pictures` }; continue; }
        const cal = pool.filter(i => !vars.some(([a, d]) => P.sep(a, d, K.ra[i], K.dec[i]) < 5));
        spherex[b][k] = { mjd: mids[k], ...calibrate(P.wisePass(raw(T, k), b, true), cal.map(i => ({ p: P.wisePass(raw(i, k), b), m: b === 'W1' ? K.w1[i] : K.w2[i] })), b) };
      }
    };
    let posted = 0;
    for (const [n, k] of order.entries()) {   // a pass at a time, the visit on screen's first; its pictures fitted as they come
      for (const r of reads[n]) { const d = await r; fit(d, k); sats[k].push({ sat: d.sat, lam: d.e.lam }); }
      finishPass(k, gaiaVars);
      mark(`pass ${++posted}`);
      view.star = star; view.spherex = spherex; show();
    }
    mark('photometry');   // (NEOWISE, if still out, gets 15 s more: the result does not wait on it longer)
    // SIMBAD and VSX, if they have answered by now: their variables leave the calibration stars, and every pass is redone
    const sim = screened.simbad, vsx = screened.vsx, missing = [sim ? '' : 'SIMBAD', vsx ? '' : 'VSX'].filter(Boolean);
    const vars = [...gaiaVars, ...(sim ?? []).filter(r => P.VAR_OTYPE.test(r.otype || '')).map(r => [num(r.ra), num(r.dec)]), ...(vsx ?? []).map(r => [num(r.RAJ2000), num(r.DEJ2000)])].filter(([a, d]) => Number.isFinite(a) && Number.isFinite(d));
    if (vars.length > gaiaVars.length) passes.forEach((_, k) => finishPass(k, vars));
    const sat = sats.flat().filter(s => s.sat).length, allBright = ['W1', 'W2'].every(b => spherex[b].every(p => /^too bright/.test(p.why ?? '')));
    mark('done');
    return { v: 1, state: allBright ? 'too-bright' : 'ok', reason: allBright ? `SPHEREx saturates on this star in ${sat} of ${total} pictures: it is too bright to measure cleanly. Fainter stars work.` : '',
      star, spherex, calibrators: pool.length, screened: missing.length ? `${missing.join(' and ')} did not answer, so calibration stars were screened for variables by Gaia only` : '',
      neowise: await Promise.race([neoFinal, new Promise(ok => setTimeout(() => ok({ state: 'unavailable', W1: [], W2: [] }), 15000))]), download: { exposures: total, listed: list.length, bytes }, timing };
  } catch (e) {
    if ((e.name === 'AbortError' && outer?.aborted) || !(e instanceof Unavailable)) throw e;
    return { v: 1, state: e.state === 'inconclusive' ? 'unavailable' : e.state, reason: e.message, input_failure: true };
  } finally { over = true; stop.abort(); }
}
// NEOWISE's visits in both bands, or why there are none to show ('few': under 3 visits in the band charted, judged by the card)
function neoOut(n, star, pos) {
  if (star.blend > 1) return { state: 'blend', W1: [], W2: [] };
  if (!n?.rows) return { state: n?.status === 429 ? 'busy' : 'unavailable', W1: [], W2: [] };
  return { state: 'ok', W1: neowiseVisits(n.rows, 'W1', pos), W2: neowiseVisits(n.rows, 'W2', pos) };
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
    if (mode === 'bright') { post({ type: 'result', result: await buildBright({ base, ra, dec, at, signal, progress: p => post({ type: 'progress', ...p }), partial: r => post({ type: 'partial', result: r }) }) }); return; }
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
