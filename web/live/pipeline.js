// Web Worker: builds a time-lapse for any RA/Dec in the browser, the same way bake/flipbook.py does in Python.
// in:  {id, ra, dec, det, api, band?}     out: {id, type:'progress'|'frame'|'done'|'empty'|'error', ...}
// The worker stays alive between builds. A new message replaces the build in flight (one with no ra only stops it), and
// a build for a spot the listed images still cover reuses the list, their headers and the rows already read.
// Each visit becomes one frame: exposures at one matched wavelength, reprojected north up, combined (combine below).
import { imagesOf } from './images.js';
import { imageHeader, imageRows, worldToPix, wavelengthAt, flagsHeader, flagRows } from './fits.js';
import { BAD } from './cutout.js';

// 3 sigma: the user typed the spot, so this is detection at a known position. At 5 sigma WISE 0855 kept only
// 2 of 4 visits and its fitted motion went to 18 "/yr; at 3 it keeps 4 and measures 6.45 (published 8.1).
const SNR_MIN = Number(new URLSearchParams(self.location.search).get('snr') || 3);
const GRID = 144, PIX = 5.0, PER_VISIT = 3, MAX_PER_VISIT = 30, SIZE = 2040, D2R = Math.PI / 180;

async function pool(items, n, fn) {   // run fn over items, at most n at a time (polite to S3)
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
// limit(fn) runs fn when fewer than n run, and resolves as fn does
function limiter(n) {
  let busy = 0; const wait = [];
  const next = () => { if (busy >= n || !wait.length) return; busy++; const [fn, ok, no] = wait.shift(); fn().then(ok, no).finally(() => { busy--; next(); }); };
  return fn => new Promise((ok, no) => { wait.push([fn, ok, no]); next(); });
}

// A visit is a run of images with no gap over `gap` days. The deep fields (ecliptic poles) are photographed every few
// days all year, so a visit also ends after `span` days, and only `most` visits, spread over the whole record, are kept.
// A time t (MJD, a known comet's page asking for one exposure) keeps the visit that holds it.
const atT = (e, t) => t != null && Math.abs(e.t - t) < 0.01;
function visits(imgs, t, gap = 20, span = 14, most = 8) {
  const out = [];
  for (const x of imgs) (out.length && x.t - out.at(-1).at(-1).t <= gap && x.t - out.at(-1)[0].t <= span) ? out.at(-1).push(x) : out.push([x]);
  if (out.length <= most) return out;
  const keep = Array.from({ length: most }, (_, k) => Math.round(k * (out.length - 1) / (most - 1)));
  const k = out.findIndex(v => v.some(e => atT(e, t)));
  if (k >= 0 && !keep.includes(k)) keep[keep.reduce((b, x, n) => (Math.abs(x - k) < Math.abs(keep[b] - k) ? n : b), 0)] = k;
  return [...new Set(keep)].sort((a, b) => a - b).map(n => out[n]);
}

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

// the same rule as bake/flipbook.py match(): the wavelength the most visits have, within one filter width
function match(vs) {
  const all = vs.flat(), tol = median(all.map(e => e.bw));
  const near = (v, l0) => v.filter(e => Math.abs(e.lam - l0) <= tol);
  const score = l0 => [vs.filter(v => near(v, l0).length).length, -vs.reduce((s, v) => s + Math.min(...v.map(e => Math.abs(e.lam - l0))), 0)];
  let lam0 = all[0].lam, best = score(lam0);
  for (const e of all) { const s = score(e.lam); if (s[0] > best[0] || (s[0] === best[0] && s[1] > best[1])) { best = s; lam0 = e.lam; } }
  const picked = vs.map(v => near(v, lam0).sort((a, b) => Math.abs(a.lam - lam0) - Math.abs(b.lam - lam0)).slice(0, PER_VISIT));
  return { lam0, tol, picked: picked.map((p, n) => p.length ? p : [vs[n].reduce((a, b) => Math.abs(a.lam - lam0) < Math.abs(b.lam - lam0) ? a : b)]) };
}
// One spectral channel instead (band = [lo, hi, centre] in µm, live/spectral.js): per visit, the exposures whose
// wavelength at the spot is inside the channel, nearest its centre first. A visit with none is left out.
function inBand(vs, [lo, hi, c]) {
  const picked = vs.map(v => v.filter(e => e.lam >= lo && e.lam < hi).sort((a, b) => Math.abs(a.lam - c) - Math.abs(b.lam - c)).slice(0, PER_VISIT));
  return { lam0: c, tol: Math.max(c - lo, hi - c), picked: picked.filter(p => p.length) };
}

// north-up output grid about the target (bake/flipbook.py target_wcs): 0-based pixel -> [ra, dec]
function gridWorld(ra0, dec0, ix, iy) {
  const c = (GRID + 1) / 2, x = -(ix + 1 - c) * PIX / 3600 * D2R, y = (iy + 1 - c) * PIX / 3600 * D2R;
  const a0 = ra0 * D2R, d0 = dec0 * D2R, rho = Math.hypot(x, y);
  if (!rho) return [ra0, dec0];
  const cc = Math.atan(rho), s = Math.sin(cc), co = Math.cos(cc);
  const dec = Math.asin(co * Math.sin(d0) + y * s * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(x * s, rho * Math.cos(d0) * co - y * Math.sin(d0) * s);
  return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
}

// Rows y0..y1 of one exposure, its IMAGE (px) and FLAGS (fl, the quality bits), kept between
// builds: a re-centre a little way off reads only the strip it lacks.
// A block that would pass 600 rows (5 MB) starts again from the rows asked for. At most ROWS_KEPT exposures are kept,
// the least recently used dropped first (a re-centre can pick other exposures of a visit, at the new wavelength).
const rowCache = new Map(), ROWS_KEPT = 48;
// FLAGS headers, asked for as soon as a build knows its exposures (flagsFor), so reading rows waits on one request.
// Not aborted with the build: a newer build may be waiting on the same header (28 KB). A failed read is forgotten.
const fheads = new Map();
const flagsFor = e => fheads.get(e.key) ?? fheads.set(e.key, flagsHeader(e.key, e.h).catch(err => { fheads.delete(e.key); throw err; })).get(e.key);
async function rows(e, y0, y1, signal) {
  let c = rowCache.get(e.key);
  const read = (a, b) => Promise.all([imageRows(e.key, e.h, a, b, signal), flagsFor(e).then(f => flagRows(e.key, f, a, b, signal))]);
  const join = (a, b) => { const o = new a.constructor(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  if (!c || y0 > c.y1 + 1 || y1 < c.y0 - 1 || Math.max(y1, c.y1) - Math.min(y0, c.y0) > 600) { const [px, fl] = await read(y0, y1); c = { y0, y1, px, fl }; }
  else {
    if (y0 < c.y0) { const [px, fl] = await read(y0, c.y0 - 1); c = { y0, y1: c.y1, px: join(px, c.px), fl: join(fl, c.fl) }; }
    if (y1 > c.y1) { const [px, fl] = await read(c.y1 + 1, y1); c = { y0: c.y0, y1, px: join(c.px, px), fl: join(c.fl, fl) }; }
  }
  rowCache.delete(e.key); rowCache.set(e.key, c);   // Map order is use order
  if (rowCache.size > ROWS_KEPT) rowCache.delete(rowCache.keys().next().value);
  return c;
}

// one exposure -> GRID x GRID normalized frame (FITS row order, bottom row first), bilinear like reproject_interp:
// raw, and clean, where a pixel that counts (any of the four with weight, as cutout.js readCells) has a MASK bit is NaN.
// MASK is cutout.js BAD: 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 6 NONFUNC, 9 MISSING_DATA,
// 10 HOT, 11 COLD, 15 NONLINEAR, 17 PERSIST, plus artefacts that look like sources: 25 STREAK, 27 SNOWBALL, 28 HALO,
// 29 SAT_HALO (names from the MSKN cards of the FLAGS header). Never 19 OUTLIER (a new comet is one) or 21 SOURCE.
const MASK = BAD;
async function reproject(e, ra, dec, signal) {
  signal.throwIfAborted();   // a replaced build's queued exposures stop here, before their 20736 sky positions
  const map = [];
  for (let iy = 0; iy < GRID; iy++) for (let ix = 0; ix < GRID; ix++) map.push(worldToPix(e.h, ...gridWorld(ra, dec, ix, iy)));
  const ys = map.filter(Boolean).map(p => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  if (y0 > y1) return null;
  const c = await rows(e, y0, y1, signal);
  const off = (x, y) => x < 0 || y < c.y0 || x >= SIZE || y > c.y1;
  const at = (x, y) => off(x, y) ? NaN : c.px[(y - c.y0) * SIZE + x];
  const atClean = (x, y) => off(x, y) || c.fl[(y - c.y0) * SIZE + x] & MASK ? NaN : c.px[(y - c.y0) * SIZE + x];
  const raw = new Float32Array(GRID * GRID), clean = new Float32Array(GRID * GRID);
  const bilinear = (at, xi, yi, fx, fy) => (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy;
  const weighted = (at, xi, yi, fx, fy) => [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]
    .reduce((v, [dx, dy, w]) => w > 1e-9 ? v + w * at(xi + dx, yi + dy) : v, 0);   // a flagged neighbour of no weight does not count
  map.forEach((p, k) => {
    if (!p) { raw[k] = clean[k] = NaN; return; }
    const [x, y] = p, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    raw[k] = bilinear(at, xi, yi, fx, fy);   // any NaN neighbour (saturated, off the edge) stays NaN
    clean[k] = weighted(atClean, xi, yi, fx, fy);
  });
  const med = median(Array.from(raw)), mad = median(Array.from(raw, v => Math.abs(v - med))) * 1.4826 || 1;
  return { raw: raw.map(v => (v - med) / mad), clean: clean.map(v => (v - med) / mad), t: e.t };
}

// A visit's frame from its exposures (normalized: the sky's noise is about 1), pixel by pixel.
// A flash in one exposure (2026W01_2A_0524_3 at RA 7.6335, Dec +15.7080: 170 times the sky, every cell of it flagged
// TRANSIENT and SUR_ERROR) must not survive, and a moving object must not be erased:
// - the values whose quality bits are clean when any are, else all of them: a bright star is flagged TRANSIENT and
//   SUR_ERROR across its whole image in every exposure (Barnard's Star), so a flag alone cannot mean "gap";
// - 3 or more: their median. A flash in one is the top value and drops out. Known limit, as before this rule: a mover
//   in only one of them drops out too.
// - 2: their mean, or the lower of the two where the higher is over twice the lower plus CLIP (the lower counted as 0
//   when below 0) and either the two were taken within SAME of each other or the higher one's cell is flagged.
//   A median of two is their mean and showed the flash at half strength. On empty sky the test is a difference over
//   CLIP = 4: the mean's noise is 1/sqrt(2), so what the mean lets through is under 4 / 2 / 0.71 = 2.8 sigma, below
//   SNR_MIN. On a star the allowance grows with it: a star's peak differs by 40% between exposures that sample it at
//   different places within a pixel (100 and 60), and both are the star. A visit's exposures are often hours or days
//   apart (5000 minutes at Ed's spot), and a main-belt asteroid moves 6 to 13 cells in that time: an unflagged
//   difference then keeps the mean, so a mover shows as two faint dots, as before. Within SAME (10 minutes) a real
//   source cannot be in one and not the other. The mean elsewhere keeps faint sources' noise and the sky level the same
//   as in visits of 3, so Color Difference and Hide Stationary do not change between visits.
// - 1: as it is. A visit of one exposure keeps a flash (its flags look like a bright star's, and there is nothing to
//   compare with): the page marks those frames.
const CLIP = 4, SAME = 10 / 1440;
function stackOf(arrs) {
  return new Float32Array(GRID * GRID).map((_, k) => {
    const c = arrs.filter(a => Number.isFinite(a.clean[k])), use = c.length ? c : arrs.filter(a => Number.isFinite(a.raw[k]));
    const val = a => use === c ? a.clean[k] : a.raw[k];
    if (use.length !== 2) return median(use.map(val));
    const [lo, hi] = val(use[0]) <= val(use[1]) ? use : [use[1], use[0]];
    const odd = val(hi) > 2 * Math.max(0, val(lo)) + CLIP, flagged = !Number.isFinite(hi.clean[k]);
    return odd && (Math.abs(hi.t - lo.t) <= SAME || flagged) ? val(lo) : (val(lo) + val(hi)) / 2;
  });
}

// Position of the source near guess (0-based FITS x, y), the same rule as bake/flipbook.py centroid() with two
// additions: a detection check against this frame's own noise, and re-centring. A flux-weighted centre over a
// fixed window is pulled toward the window's middle on a faint source (WISE 0855 read 2.45 instead of ~8 "/yr),
// so the window re-centres on its own result a few times.
function centroid(a, guess, r = 3) {
  // noise from the central 36 x 36 px only: the 144 px frame adds bright neighbours, and a wider sample moved a
  // faint target (WISE 0855, one exposure) from SNR 3.0 to 2.99 and lost it
  const fin = [], q = (GRID - 36) / 2;
  for (let y = q; y < q + 36; y++) for (let x = q; x < q + 36; x++) if (Number.isFinite(a[y * GRID + x])) fin.push(a[y * GRID + x]);
  const m0 = median(fin), noise = 1.4826 * median(fin.map(v => Math.abs(v - m0))) || 1;
  const inWin = (c, rr) => { const o = []; for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if ((x - c[0]) ** 2 + (y - c[1]) ** 2 <= rr * rr) o.push([x, y, a[y * GRID + x]]); return o; };
  const win = inWin(guess, r), sat = win.filter(p => Number.isNaN(p[2])).length;
  if (sat > 0.5 * win.length) {   // saturated core: its centre is the centre of the saturated blob
    const blob = inWin(guess, 2 * r).filter(p => Number.isNaN(p[2]));
    return { pos: [blob.reduce((s, p) => s + p[0], 0) / blob.length, blob.reduce((s, p) => s + p[1], 0) / blob.length], sat: blob.length, snr: Infinity, blob: true };
  }
  const peak = Math.max(...win.map(p => p[2]).filter(Number.isFinite)), snr = (peak - m0) / noise;
  if (!(snr > SNR_MIN)) return { pos: null, sat, snr };
  let c = guess;
  for (let it = 0; it < 4; it++) {
    const w = inWin(c, it ? 2 : r), base = m0;
    let sx = 0, sy = 0, sw = 0;
    for (const [x, y, v] of w) { const wt = Math.max(0, (Number.isNaN(v) ? peak : v) - base); sx += x * wt; sy += y * wt; sw += wt; }
    if (!(sw > 0)) break;
    c = [sx / sw, sy / sw];
  }
  // a core this saturated (Alcyone: tens of pixels) only pins the position to a few pixels; Barnard's Star
  // saturates about 4 and its bright ring still centres it, so 12 saturated pixels nearby is the line
  const satNear = inWin(c, 6).filter(p => Number.isNaN(p[2])).length;
  return { pos: c, sat, snr, blob: satNear > 12 };
}

const year = mjd => 2000 + (mjd - 51544.5) / 365.25;
const date = mjd => new Date((mjd - 40587) * 864e5).toISOString().slice(0, 10);
// the visit's exposure times, each its own timestamp, for the catalog check: SkyBoT is asked at each, and a known
// object can be the dot only where SkyBoT puts it at one of them (live/identity.js), never at an average of several
// (a visit spans days and a known asteroid crosses the patch in hours). At most PER_VISIT a visit, so a few asks.
const epochs = ts => [...new Set(ts)].sort((a, b) => a - b);

// kept between builds: the latest request, the last image list of each detector (visits of images with their headers;
// the Spectral card's layers can mix detectors), the wavelength maps, and the Gaia stars around the last spot asked
let cur, stop = null, mapsP = null, gaiaAt = null;
const lists = new Map();

self.onmessage = async ({ data: { id, ra, dec, det, api, band, t } }) => {
  cur = id; stop?.abort();
  if (ra == null) return;
  const signal = (stop = new AbortController()).signal;
  const post = m => { if (id === cur) self.postMessage({ ...m, id }); };
  const alive = () => { if (id !== cur) throw new Error('replaced by a newer build'); };
  try {
    const t0 = performance.now();
    // a failed download is forgotten, so the next build tries again (the worker outlives errors)
    const maps = await (mapsP ??= fetch(new URL('../data/wavemaps.json', import.meta.url))
      .then(r => { if (!r.ok) throw new Error(`wavelength maps: HTTP ${r.status}`); return r.json(); })
      .catch(e => { mapsP = null; throw e; }));
    alive();
    if (!maps[det]) return post({ type: 'error', error: `no wavelength map for ${det} yet` });
    // the images of a visit that cover this spot, each with the wavelength it has there (copies: a build never
    // changes the list)
    const here = v => v.flatMap(e => {
      const p = worldToPix(e.h, ra, dec);
      if (!(p && p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1)) return [];
      const [lam, bw] = wavelengthAt(maps[det], p[0], p[1]);
      return [{ ...e, lam, bw }];
    });
    // Re-centre: the list is reused while any of its images covers the new spot. Visits with no image there are left
    // out of this build (the list keeps them, so moving back brings them back); IRSA is asked again (20 to 30 s on a
    // slow day) only when no listed image covers the spot.
    // ponytail: an image that covers the new spot but not the searched one is not in the list, so a re-centre can
    // have fewer visits or exposures than a fresh search of the same spot; a region search in the Worker would close that.
    let usable = lists.has(det) ? lists.get(det).map(here).filter(v => v.length) : [];
    if (!usable.length) {
      // v=2: a browser may still hold a failed search that the old Worker let it cache for a day (2026-11-14)
      const res = await fetch(`${api}/api/images?ra=${ra}&dec=${dec}&det=${det}&fmt=2&v=2`, { signal });
      const found = await res.json();
      if (res.ok) found.images = imagesOf(found);
      alive();
      if (!res.ok) return post({ type: 'error', error: found.error || `HTTP ${res.status}` });
      if (!found.images.length) return post({ type: 'empty' });
      const vs = visits(found.images, t).map(v => v.slice(0, MAX_PER_VISIT).concat(v.slice(MAX_PER_VISIT).filter(e => atT(e, t))));
      post({ type: 'progress', text: `${found.images.length} images in ${vs.length} visits; reading where the target falls in each`, ms: performance.now() - t0 });
      const had = new Map((lists.get(det) || []).flat().map(e => [e.key, e.h]));   // headers the last list already read
      let done = 0;
      await pool(vs.flat(), 8, async e => {
        e.h = had.get(e.key) ?? await imageHeader(e.key, signal);
        alive();
        if (++done % 10 === 0) post({ type: 'progress', text: `read ${done} of ${vs.flat().length} image headers` });
      });
      usable = vs.map(here);
      lists.set(det, vs.filter((_, k) => usable[k].length));
      usable = usable.filter(v => v.length);
      const keep = new Set([...lists.values()].flat(2).map(e => e.key));
      for (const m of [rowCache, fheads]) for (const k of m.keys()) if (!keep.has(k)) m.delete(k);
    }
    if (!usable.length) return post({ type: 'empty' });
    const { lam0, tol, picked } = band ? inBand(usable, band) : match(usable);
    // t: that visit's frame is the exposure taken at t (and any within 15 minutes), not the visit's matched wavelength,
    // so a moving comet is where its page says it was; the frame says so (at_t) and the page rings the centre
    const tVisit = band ? -1 : usable.findIndex(v => v.some(e => atT(e, t)));
    if (tVisit >= 0) picked[tVisit] = usable[tVisit].filter(e => atT(e, t));
    if (!picked.length) return post({ type: 'empty', of: usable.length });   // no visit has this channel here

    // Gaia: the star at this spot, propagated from 2016.0 to the target epoch (2026.0).
    // The Worker answers with every 2016 position within 144" of the spot asked. A re-centre within 100" of the last
    // spot tries those stars first and waits for its own answer (1.5 s, or 20 s on a slow IRSA day) only when none
    // fits: a fast star's 2016 position can sit 100" from where it is now (Barnard's Star), outside the old cone.
    // The request still starts now, beside the frames, and its answer is dropped when the cached stars fit: waiting to
    // ask until they fail cost re-centres about 2 s (the Worker caches /api/gaia for a day, so the extra ask is cheap).
    const cached = gaiaAt && Math.hypot((gaiaAt.ra - ra) * Math.cos(dec * D2R), gaiaAt.dec - dec) * 3600 <= 100 ? gaiaAt.stars : [];
    const gaiaP = fetch(`${api}/api/gaia?ra=${ra}&dec=${dec}&v=3`, { signal })   // v=3: Gaia from IRSA; drops answers cached before the switch
     .then(r => r.ok ? r.json() : null).catch(() => null).then(g => { if (g?.stars) gaiaAt = { ra, dec, stars: g.stars }; return g?.stars || []; });

    // every exposure is read 3 at a time from the start, not visit by visit, so the next visit's rows arrive while this
    // one is combined (this paid for reading FLAGS beside each IMAGE); frames are still sent in visit order
    picked.flat().forEach(e => flagsFor(e).catch(() => {}));   // read when its rows are (rows)
    const limit = limiter(3), jobs = picked.map(v => v.map(e => limit(() => reproject(e, ra, dec, signal))));
    jobs.flat().forEach(j => j.catch(() => {}));   // a failure is thrown below, by the visit that waits on it
    const frames = [];
    for (const [n, v] of picked.entries()) {
      const arrs = (await Promise.all(jobs[n])).filter(Boolean);
      alive();
      const stack = stackOf(arrs);
      const ts = v.map(e => e.t), mjd = ts.reduce((a, b) => a + b, 0) / ts.length;
      frames.push({ ...(n === tVisit ? { at_t: true } : {}), px: stack, start: date(Math.min(...ts)), end: date(Math.max(...ts)), mjd, epochs: epochs(ts), year: year(mjd), exposures: arrs.length,
        lam: v.reduce((s, e) => s + e.lam, 0) / v.length, lam_spread: Math.max(...v.map(e => Math.abs(e.lam - lam0))),
        matched: Math.max(...v.map(e => Math.abs(e.lam - lam0))) <= tol, bw: v.reduce((s, e) => s + e.bw, 0) / v.length });
      post({ type: 'frame', n, of: picked.length, ms: performance.now() - t0, px: stack });   // px (a copy): the page can show it at once
    }

    // measure first, starting at the typed spot and following the source frame to frame
    const c0 = (GRID - 1) / 2;
    let guess = [c0, c0];
    for (const f of frames) {
      const { pos, sat, snr, blob } = centroid(f.px, guess);
      f.saturated_px = sat; f.snr = snr; f.blob = !!blob;
      if (pos) { guess = pos; [f.x, f.y] = pos; f.east = -(pos[0] - c0) * PIX; f.north = (pos[1] - c0) * PIX; }
    }
    // then trust a Gaia star only if its predicted path lies on what SPHEREx sees (within 4 arcsec on average);
    // a faint background star near a brown dwarf Gaia cannot see (WISE 0855) must not become "the target"
    // A click can land 20" off a star, so match Gaia to where SPHEREx sees the source, not to the click:
    // of all Gaia stars in the cone, keep the one whose predicted path lies closest to the measured positions,
    // and only if that is within 4" on average (a background star must not pose as the target, see WISE 0855).
    // A saturated star's blob is only good to a few pixels, so it gets 2 pixels of slack.
    const seen = frames.filter(f => f.east != null), slack = seen.some(f => f.blob) ? 2 * PIX : 4;
    const pred = (s, f) => { const dt = f.year - 2016; return [(s.ra - ra) * 3600 * Math.cos(s.dec * D2R) + s.pmra / 1000 * dt, (s.dec - dec) * 3600 + s.pmdec / 1000 * dt]; };
    const fit = stars => {
      let star = null, best = Infinity;
      for (const s of stars) {
        const off = seen.reduce((a, f) => { const [e, n] = pred(s, f); return a + Math.hypot(e - f.east, n - f.north); }, 0) / seen.length;
        if (off < best) { best = off; star = s; }
      }
      return [star, best];
    };
    let [gaia, bestOff] = fit(seen.length ? cached : []);
    if (seen.length && !(bestOff <= slack)) [gaia, bestOff] = fit(await Promise.race([gaiaP, new Promise(r => setTimeout(() => r([]), 8000))]));   // Gaia late: show the frames without it
    if (gaia && bestOff <= slack) frames.forEach(f => { [f.pred_east, f.pred_north] = pred(gaia, f); });
    else gaia = null;
    if (tVisit >= 0) { frames[tVisit].pred_east = 0; frames[tVisit].pred_north = 0; }   // the predicted spot: the centre
    // straight-line motion fit from detected positions: at least 3 visits spanning half a year, with the
    // slope's standard error so a faint target reads as uncertain
    const ok = frames.filter(f => f.east != null && !f.blob);   // a saturated blob's outline jitters by pixels: not a motion
    let motion = null;
    if (ok.length >= 3 && ok.at(-1).year - ok[0].year >= 0.5) {
      const xs = ok.map(f => f.year), mx = xs.reduce((a, b) => a + b) / xs.length, sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      const fit = k => { const ys = ok.map(f => f[k]), my = ys.reduce((a, b) => a + b) / ys.length;
        const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx, res = ys.map((y, i) => y - my - b * (xs[i] - mx));
        return [b, Math.sqrt(res.reduce((s, r) => s + r * r, 0) / (ok.length - 2) / sxx)]; };
      const [e, se] = fit('east'), [n, sn] = fit('north');
      motion = { east: e, north: n, years: ok.at(-1).year - ok[0].year, total: Math.hypot(e, n) };
      motion.err = Math.hypot(e * se, n * sn) / (motion.total || 1);
    }
    // flip rows so row 0 is north, like the baked manifests' pixel data
    for (const f of frames) { const flipped = new Float32Array(GRID * GRID); for (let r = 0; r < GRID; r++) flipped.set(f.px.subarray((GRID - 1 - r) * GRID, (GRID - r) * GRID), r * GRID); f.px = flipped; }
    const all = frames.flatMap(f => Array.from(f.px).filter(Number.isFinite)).sort((a, b) => a - b);
    const q = p => all[Math.min(all.length - 1, Math.floor(p * all.length))];
    post({ type: 'done', ms: performance.now() - t0, manifest: {
      key: `live-${ra.toFixed(4)}-${dec.toFixed(4)}-${det}`, name: `RA ${ra.toFixed(4)}, Dec ${dec.toFixed(4)}`, ra, dec, detector: det,
      grid: GRID, arcsec_per_pixel: PIX, lam0, lam_tol: tol, visits_all: usable.length, stretch: { lo: q(0.05), hi: q(0.997) }, motion,
      gaia: gaia ? { id: gaia.id, pmra: gaia.pmra, pmdec: gaia.pmdec, g: gaia.g, total: Math.hypot(gaia.pmra, gaia.pmdec) / 1000 } : null,
      frames } });
  } catch (err) {
    post({ type: 'error', error: String(err.message || err) });   // not sent for a build that was replaced
  }
};
