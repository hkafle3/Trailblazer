// One SPHEREx exposure cut out around a sky position, north up, plus the light measured at that position.
// For a known comet's page (comet.js): each visit's photo centred on where JPL says the comet was, so the comet stays in
// the middle and the stars slide past. The picture is drawn the way bake/comet_spectrum.py photo() draws a measured
// comet's (96 pixels of 6.15 arcsec, bilinear like reproject_interp); the light is measured on the raw pixels.
import { imageHeader, imageRows, worldToPix, pixToWorld, wavelengthAt, flagsHeader, flagRows, varianceHeader } from './fits.js';

const D2R = Math.PI / 180, SIZE = 2040;
export const R_AP = 3, R_IN = 9, R_OUT = 14;   // aperture and sky ring radii, SPHEREx pixels (6.15 arcsec)

// north-up grid about (ra0, dec0): 0-based pixel -> [ra, dec] (pipeline.js gridWorld, any size)
function gridWorld(ra0, dec0, ix, iy, grid, pix) {
  const c = (grid + 1) / 2, x = -(ix + 1 - c) * pix / 3600 * D2R, y = (iy + 1 - c) * pix / 3600 * D2R;
  const a0 = ra0 * D2R, d0 = dec0 * D2R, rho = Math.hypot(x, y);
  if (!rho) return [ra0, dec0];
  const cc = Math.atan(rho), s = Math.sin(cc), co = Math.cos(cc);
  const dec = Math.asin(co * Math.sin(d0) + y * s * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(x * s, rho * Math.cos(d0) * co - y * Math.sin(d0) * s);
  return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
}

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

// ---------- measuring: the spot's light now minus the same spot's light when the comet was elsewhere ----------
// Pixels whose quality bits say not to trust them are left out everywhere: the circle, the sky ring and the reference
// photos. The bits are bake/comet_spectrum.py's BAD (transient, overflow, saturated, nonlinear, hot, cold, nonfunctional,
// persistence, missing data and the like), plus streak, snowball, halo and saturated halo artifacts.
export const BAD = [0, 1, 2, 6, 9, 10, 11, 15, 17, 25, 27, 28, 29].reduce((m, b) => m | (1 << b), 0);
export const mask = (v, flag) => (flag & BAD ? NaN : v);
const HALF = R_OUT + 1, W = 2 * HALF + 1;   // the measuring window: W x W of the photo's own pixels about the spot

// value at each of `cells` ([x, y] pixels of this exposure, 0-based) from its IMAGE, bilinear, NaN where a pixel that
// counts is flagged, missing or off the image
// more (a star's spectrum, starLight): also fills more.flag and more.var with each cell's raw FLAGS bits and VARIANCE
// (cells on whole pixels; -1 and NaN off the image)
async function readCells(key, h, cells, signal, more = null) {
  const ys = cells.filter(Boolean).map(c => c[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  const out = new Float64Array(cells.length).fill(NaN);
  if (!ys.length || y0 > y1) return out;
  const fh = flagsHeader(key, h, signal);
  const [px, fl, vr] = await Promise.all([imageRows(key, h, y0, y1, signal), fh.then(f => flagRows(key, f, y0, y1, signal)),
    more && fh.then(f => varianceHeader(key, f, signal)).then(v => imageRows(key, v, y0, y1, signal))]);
  const off = (x, y) => x < 0 || y < y0 || x >= SIZE || y > y1;
  const at = (x, y) => off(x, y) ? NaN : mask(px[(y - y0) * SIZE + x], fl[(y - y0) * SIZE + x]);
  if (more) {
    more.flag = cells.map(([x, y]) => off(x, y) ? -1 : fl[(y - y0) * SIZE + x]);
    more.var = cells.map(([x, y]) => off(x, y) ? NaN : vr[(y - y0) * SIZE + x]);
  }
  cells.forEach((c, k) => {
    if (!c) return;
    const xi = Math.floor(c[0]), yi = Math.floor(c[1]), fx = c[0] - xi, fy = c[1] - yi;
    let v = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) if (w > 1e-9) v += w * at(xi + dx, yi + dy);
    out[k] = v;
  });
  return out;
}

// The target photo's window about its pixel p, and where the spot falls in it
const targetCells = p => { const X = Math.round(p[0]) - HALF, Y = Math.round(p[1]) - HALF; return { X, Y, cx: p[0] - X, cy: p[1] - Y, cells: Array.from({ length: W * W }, (_, k) => [X + k % W, Y + Math.floor(k / W)]) }; };

// Circle minus ring on the difference "target - reference", all windows W x W on the target's pixels, spot at (cx, cy).
// Each reference is first scaled to the target by the stars in the sky ring (light through another part of the filter
// differs a little), then the scaled references' median is taken away. { flux, noise, snr, scales, peak } in image
// units, or null when under 80% of the circle or 50 ring pixels are usable. The noise is the difference's own scatter in
// the ring (1.4826 x MAD, so star residuals there do not inflate it) over the circle, plus the error of its sky level.
// peak: the share of the circle's light in its brightest pixel.
export function diffMeasure(t, refs, cx, cy) {
  const ap = [], ring = [];
  for (let k = 0; k < W * W; k++) { const r = Math.hypot(k % W - cx, Math.floor(k / W) - cy); if (r <= R_AP) ap.push(k); else if (r >= R_IN && r <= R_OUT) ring.push(k); }
  const sky = a => { const m = median(ring.map(k => a[k])); return Array.from(a, v => v - m); };
  const T = sky(t), scales = [];
  const R = refs.map(sky).map(r => {
    // the stars: ring pixels bright in either photo (summed light, which resampling the reference does not change)
    const sr = 1.4826 * median(ring.map(k => Math.abs(r[k]))), st = 1.4826 * median(ring.map(k => Math.abs(T[k])));
    const stars = ring.filter(k => Number.isFinite(T[k]) && Number.isFinite(r[k]) && (r[k] > 5 * sr || T[k] > 5 * st));
    const num = stars.reduce((s, k) => s + T[k], 0), den = stars.reduce((s, k) => s + r[k], 0);
    const f = stars.length >= 3 && num > 0 && den > 0 ? num / den : 1;   // no stars in the ring to go by: as it is
    scales.push(f);
    return r.map(v => v * f);
  });
  const M = T.map((_, k) => median(R.map(r => r[k]))), D = T.map((v, k) => v - M[k]);
  const a = ap.map(k => D[k]).filter(Number.isFinite), g = ring.map(k => D[k]).filter(Number.isFinite);
  if (!R.length || a.length < 0.8 * ap.length || g.length < 50) return { usable: a.length / ap.length, ring: g.length, scales, snr: null };
  const s0 = median(g), sig = 1.4826 * median(g.map(v => Math.abs(v - s0)));
  const flux = a.reduce((s, v) => s + v - s0, 0) * ap.length / a.length;
  // a star at the spot never cancels exactly (its image differs a little from photo to photo): MISMATCH of its light
  // is added to the noise, so a star's leftover does not read as a comet
  const star = Math.max(0, ap.reduce((s, k) => s + (Number.isFinite(M[k]) ? M[k] : 0), 0));
  const noise = Math.hypot(sig * Math.sqrt(ap.length + ap.length ** 2 * Math.PI / 2 / g.length), MISMATCH * star);
  return { flux, noise, snr: noise > 0 ? flux / noise : 0, scales, usable: a.length / ap.length, peak: flux > 0 ? Math.max(...a.map(v => v - s0)) / flux : 0 };
}

// ---------- a star's light in one exposure (the time-lapse's Spectrum card, live/spectrum.js) ----------
// Circle minus ring on the exposure alone, as bake/comet_spectrum.py photometry() does it: the sky is the ring's median,
// flagged or missing pixels in the circle count as the circle's average, and the noise is the VARIANCE of the circle's
// pixels plus the error of the sky level. Returns { flux, noise } in image units (MJy/sr summed over pixels), or
// { gap } with the reason when the circle or the ring is too damaged to measure. doubt: why the value may be off.
const BIT_NAMES = { 0: 'transient', 1: 'overflow (saturated)', 2: 'onboard processing error', 6: 'dead', 9: 'missing data', 10: 'hot', 11: 'cold', 15: 'nonlinear', 17: 'persistence', 25: 'streak', 27: 'snowball', 28: 'halo', 29: 'saturated halo' };
const bitsOf = f => Object.keys(BIT_NAMES).filter(b => f & (1 << b)).map(b => BIT_NAMES[b]);
export function starMeasure(t, { flag, var: vr }, cx, cy) {
  const ap = [], ring = [], near = [];
  for (let k = 0; k < W * W; k++) {
    const r = Math.hypot(k % W - cx, Math.floor(k / W) - cy);
    if (r <= R_AP) ap.push(k); else if (r >= R_IN && r <= R_OUT) ring.push(k);
    if (r <= R_AP + 1) near.push(k);
  }
  const a = ap.filter(k => Number.isFinite(t[k])), g = ring.map(k => t[k]).filter(Number.isFinite);
  const bad = near.filter(k => !Number.isFinite(t[k])), bits = [...new Set(bad.flatMap(k => flag[k] < 0 ? ['off the detector'] : bitsOf(flag[k])))];
  const what = bits.length ? ` (${bits.join(', ')})` : '';
  if (a.length < 0.8 * ap.length) return { gap: `${ap.length - a.length} of ${ap.length} pixels in the circle unusable${what}` };
  if (g.length < 50) return { gap: 'the sky ring around it is off the detector or flagged' };
  const sky = median(g), mean = g.reduce((s, v) => s + v, 0) / g.length;
  const skyErr = 1.2533 * Math.sqrt(g.reduce((s, v) => s + (v - mean) ** 2, 0) / g.length) / Math.sqrt(g.length);
  const fill = ap.length / a.length, vsum = a.reduce((s, k) => s + (Number.isFinite(vr[k]) ? vr[k] : 0), 0);
  const doubt = [bad.length ? `${bad.length} flagged pixel${bad.length > 1 ? 's' : ''} in or next to the circle${what}` : '',
    ring.some(k => flag[k] < 0) ? 'at the edge of the detector' : ''].filter(Boolean).join('; ');
  return { flux: a.reduce((s, k) => s + t[k] - sky, 0) * fill, noise: Math.sqrt(vsum * fill ** 2 + (ap.length * skyErr) ** 2), sky, doubt };
}
// exposure e ({ key, h }) at (ra, dec): starMeasure plus where it fell, 0-based pixels
export async function starLight(e, ra, dec, signal) {
  const p = worldToPix(e.h, ra, dec);
  if (!inImage(p)) return { gap: 'not on this exposure' };
  const win = targetCells(p), more = {};
  const t = await readCells(e.key, e.h, win.cells, signal, more);
  return { ...starMeasure(t, more, win.cx, win.cy), x: p[0], y: p[1] };
}

// Which other photos to compare with: only those whose wavelength at the spot is within one channel width (bw, the
// filter's width there, about 2.5% of the wavelength) of the target's, so a star whose brightness changes with
// wavelength looks nearly the same in both; the nearest in wavelength first, at most REF_USE
export const REF_USE = 3, MISMATCH = 0.1;   // MISMATCH: see diffMeasure
export const nearRefs = (cands, lam, bw) => cands.filter(c => Math.abs(c.lam - lam) <= bw).sort((a, b) => Math.abs(a.lam - lam) - Math.abs(b.lam - lam)).slice(0, REF_USE);

// The exposure cut to grid x grid pixels of pix arcsec about (ra, dec), north up (row 0 is north, column 0 east),
export async function cutout(key, ra, dec, { grid = 96, pix = 6.15, signal, h } = {}) {
  h ??= await imageHeader(key, signal);
  const map = [];
  for (let iy = 0; iy < grid; iy++) for (let ix = 0; ix < grid; ix++) map.push(worldToPix(h, ...gridWorld(ra, dec, ix, iy, grid, pix)));
  const ys = map.filter(Boolean).map(q => q[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  if (!ys.length || y0 > y1) return null;
  const rows = await imageRows(key, h, y0, y1, signal);
  const at = (x, y) => (x < 0 || y < y0 || x >= SIZE || y > y1) ? NaN : rows[(y - y0) * SIZE + x];
  const px = new Float32Array(grid * grid);
  map.forEach((q, k) => {
    const r = grid - 1 - Math.floor(k / grid), o = r * grid + k % grid;   // FITS rows run bottom up: flip, north first
    if (!q) { px[o] = NaN; return; }
    const [x, y] = q, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const v = (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy;
    px[o] = Number.isFinite(v) ? v : NaN;
  });
  return { px, grid, h };
}

// grey levels as bake/comet_spectrum.py photo(): 20th percentile black, asinh stretch; white at the frame's 99.5th
// percentile rather than the comet's own peak, so a comet that is not there is not drawn as one.
// A bright star's core that saturated the detector has no value (NaN): drawn black it looks like a hole, so it is drawn
// at the star's peak (fillCores). Only the picture changes: the light is measured on the raw pixels (readCells).
// Returns how many pixels were filled.
export function paint(canvas, { px, grid }) {
  const v = Array.from(px).filter(Number.isFinite).sort((a, b) => a - b);
  const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))], lo = q(0.2), hi = q(0.995), A = Math.asinh(8);
  const filled = fillCores(px, grid, hi);
  px = filled.px;
  canvas.width = canvas.height = grid;
  const g = canvas.getContext('2d'), img = g.createImageData(grid, grid);
  for (let k = 0; k < grid * grid; k++) {
    const s = Number.isFinite(px[k]) ? Math.min(1, Math.asinh(Math.max(0, (px[k] - lo) / (hi - lo)) * 8) / A) : 0;
    img.data.set([255 * s, 255 * s, 255 * s, 255], 4 * k);
  }
  g.putImageData(img, 0, 0);
  return filled.n;
}

// A copy of px with each saturated star core filled: a patch of NaN pixels that does not touch the crop's edge (the edge
// is off the image), is at most CORE_MAX pixels, and sits next to light at or above `bright`, takes its brightest
// neighbour's value. Other NaN stays NaN.
const CORE_MAX = 64;
export function fillCores(px, grid, bright) {
  const out = Float32Array.from(px), seen = new Uint8Array(px.length);
  let n = 0;
  for (let k0 = 0; k0 < px.length; k0++) {
    if (seen[k0] || Number.isFinite(px[k0])) continue;
    const patch = [k0], ring = new Set();
    let edge = false;
    seen[k0] = 1;
    for (let i = 0; i < patch.length; i++) {
      const k = patch[i], x = k % grid, y = (k - x) / grid;
      if (x === 0 || y === 0 || x === grid - 1 || y === grid - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, j = Y * grid + X;
        if ((!dx && !dy) || X < 0 || Y < 0 || X >= grid || Y >= grid) continue;
        if (Number.isFinite(px[j])) ring.add(j);
        else if (!seen[j]) { seen[j] = 1; patch.push(j); }
      }
    }
    const peak = Math.max(...[...ring].map(j => px[j]));
    if (edge || patch.length > CORE_MAX || !(peak >= bright)) continue;
    for (const k of patch) out[k] = peak;
    n += patch.length;
  }
  return { px: out, n };
}

export const SNR_SEEN = 5;
// One photo per visit (photos less than 5 days after the previous one are one visit, as on the comet page): the
// visit's middle exposure, so its date is the visit's.
export function visitShots(shots) {
  const vs = [];
  shots.forEach((s, i) => { if (i === 0 || s.day - shots[i - 1].day >= 5) vs.push([]); vs.at(-1).push(s); });
  return vs.map(v => v[(v.length - 1) >> 1]);
}

// One exposure s ({ obs, ra, dec } of bake/known_comets.py: the comet's JPL position at that moment) cut out and
// measured. Its S3 key comes from /api/images at that spot (the sky index), which also lists the spot's other photos.
// Light at the spot alone says little: away from the comet, half of all spots in a Milky Way field hold a star brighter
// than SNR 5 in the circle. So the comet's light is the spot's light now minus its light in photos taken more than
// 5 days earlier or later (the comet elsewhere), at the same wavelength (nearRefs), scaled and median combined
// (diffMeasure). Of up to REF_LOOK such photos (their headers say the wavelength at the spot), up to REF_USE are used;
// a reference that fails to load is left out, and fewer than REF_USE makes the result less sure (few: true).
// verdict: 'seen' (SNR 5 or more), 'faint' (under 5), 'unmeasured' (an edge, flagged pixels, no other photo of the spot
// at this wavelength, or one pixel holding most of the light, which is a glitch the flags missed, not a comet).
const REF_LOOK = 32, PEAK_MAX = 0.6;   // 32 headers of 32 KB: enough to find same-wavelength photos of most spots
let mapsP = null;
const wavemaps = () => (mapsP ??= fetch(new URL('../data/wavemaps.json', import.meta.url)).then(r => r.json()).catch(e => { mapsP = null; throw e; }));
export async function pool(items, n, fn) {   // fn over items, at most n at a time
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const inImage = p => p && p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1;
// s.det: the detector (D1 when not given: bake/known_comets.py lists D1 exposures); maps: wavemaps.json's maps by detector
export async function knownPhoto(s, { api = '', signal, maps } = {}) {
  const det = s.det ?? 'D1';
  let r;   // a 503 is IRSA busy behind the Worker (when the sky index cannot answer): two more tries, 3 s apart
  for (let k = 0; ; k++) {
    r = await fetch(`${api}/api/images?ra=${s.ra.toFixed(4)}&dec=${s.dec.toFixed(4)}&det=${det}&v=2`, { signal });
    if (r.status !== 503 || k === 2) break;
    await new Promise(ok => setTimeout(ok, 3000));
  }
  if (!r.ok) throw new Error(`image search: HTTP ${r.status}`);
  const { images } = await r.json(), img = images.find(i => i.obs === s.obs);
  if (!img) throw new Error(`${s.obs} is not in the image search`);
  const [h, map] = await Promise.all([imageHeader(img.key, signal), (maps ? Promise.resolve(maps) : wavemaps()).then(m => m[det])]);
  const p = worldToPix(h, s.ra, s.dec);
  if (!inImage(p)) throw new Error(`${s.obs} does not cover the comet`);
  const win = targetCells(p), [lam, bw] = wavelengthAt(map, p[0], p[1]);
  const away = images.filter(i => Math.abs(i.t - img.t) > 5);
  const look = away.length <= REF_LOOK ? away : Array.from({ length: REF_LOOK }, (_, k) => away[Math.round(k * (away.length - 1) / (REF_LOOK - 1))]);
  const [c, t, hs] = await Promise.all([cutout(img.key, s.ra, s.dec, { signal, h }), readCells(img.key, h, win.cells, signal),
    pool(look, 6, i => imageHeader(i.key, signal).catch(() => null))]);
  const cands = look.flatMap((i, k) => { const q = hs[k] && worldToPix(hs[k], s.ra, s.dec); return inImage(q) ? [{ ...i, h: hs[k], lam: wavelengthAt(map, q[0], q[1])[0] }] : []; });
  const near = nearRefs(cands, lam, bw);
  const refs = (await pool(near, 3, i => readCells(i.key, i.h, win.cells.map(([X, Y]) => worldToPix(i.h, ...pixToWorld(h, X, Y))), signal).catch(() => null))).filter(Boolean);
  const m = refs.length ? diffMeasure(t, refs, win.cx, win.cy) : null;
  return { ...c, ...verdictOf(m, near.length, refs.length), t: img.t, key: img.key, lam, bw, m, refLam: near.map(i => i.lam) };
}

export function verdictOf(m, near, refs) {
  const glitch = m?.snr >= SNR_SEEN && m.peak > PEAK_MAX, bad = m?.snr == null;
  const why = !near ? 'no other photo of this spot at this wavelength' : !refs ? 'the photos to compare with did not load'
    : bad ? 'too many unusable pixels at the spot' : glitch ? 'one pixel holds most of the light, a glitch rather than a comet' : '';
  return { verdict: why ? 'unmeasured' : m.snr >= SNR_SEEN ? 'seen' : 'faint', why, snr: why ? null : m.snr, refs, few: refs > 0 && refs < REF_USE };
}
