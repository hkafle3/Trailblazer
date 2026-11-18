// "Then and now": the blink of an older survey (2MASS Ks, AllWISE W1, W2) against SPHEREx synthesized through the same
// band, calibrated on nearby stars and checked. A port of comet-hunt-work/phase2-plan/scripts/build_v3.py (the reference;
// web/tests/blink_parity.mjs holds this file to it). Pure math, no fetching and no DOM: it runs in the page's Web Worker
// (live/blinkworker.js), in Node for the tests and the showcase bake (bake/blink_bake.mjs).
// New code, by design: it does not reuse live/pipeline.js stacking (its noise normalisation and the restoring of flagged
// pixels would change the flux weights). It keeps calibrated MJy/sr and strict masks.
// Arrays are N x N, row iy (south to north), column ix (east to west), index iy * N + ix; NaN where there is no data.
import { worldToPix } from './fits.js';
import { BAD } from './cutout.js';
const SAT = (1 << 1) | (1 << 2);   // SPHEREx flags OVERFLOW and SATURATED (cutout.js BAD's bits 1 and 2)

export const N = 361, PIX = 2.0, CROP = 91, C0 = (N - 1) / 2;   // 2" grid: 12.03 arcmin calibration field, 3.03 arcmin crop
export const SPX_RANGE = [0.75, 5.0];
// pre-registered thresholds (build_v2.py / build_v3.py, set before their first runs)
export const T = { MIN_COVERED: 0.70, MIN_STARS: 20, SCATTER_CAP: 0.10, VAL_MED_TOL: 0.05, FWHM_TOL: 0.10, EE_TOL: 0.05, ALIGN_MED: 1.5,
  ALIGN_P90: 5.0, LEAD_SHIFT: 1.5, FOOTPRINT: 0.98, DISPLAY_TOL: 0.10, BG_MED: 0.05, BG_RMS: 0.10, GRAIN_RATIO: 2.0 };
const AP = 1.0, AN = [2.0, 3.0], BG_BLOCK = 15;
// the showcase's expectations (J053604.34-063439.0): only the evaluator reads these, never the page's state
export const EXPECT = { W2: { min_ratio: 1.5, min_z: 5.0 }, W1: { min_ratio: 1.2, min_z: 3.0 }, Ks: { max_dev: 0.15, max_z: 3.0 } };
// which SPHEREx detectors and which survey each band compares
export const PAIRS = { Ks: { dets: ['D3'], survey: '2mass' }, W1: { dets: ['D4'], survey: 'allwise' }, W2: { dets: ['D5', 'D6'], survey: 'allwise' } };
export const MASK_RGB = [20, 40, 110];
const D2R = Math.PI / 180, NN = N * N;

// ---------------- small statistics, numpy's rules ----------------
const finite = Number.isFinite;
function sortedFinite(a) { const s = []; for (const v of a) if (finite(v)) s.push(v); return Float64Array.from(s).sort(); }
// np.median: NaN if any value is NaN (np.nanmedian drops them: nanmedian below)
export function median(a) { for (const v of a) if (Number.isNaN(v)) return NaN; return nanmedian(a); }
export function nanmedian(a) { const s = sortedFinite(a), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; }
// np.percentile, linear interpolation, over the finite values (np.nanpercentile)
export function percentile(a, p) {
  const s = sortedFinite(a), n = s.length; if (!n) return NaN;
  const x = p / 100 * (n - 1), i = Math.floor(x), f = x - i;
  return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * f : s[i];
}
const mad = (a, m = nanmedian(a)) => 1.4826 * nanmedian(Array.from(a, v => Math.abs(v - m)));
function noise(img) { const v = []; for (const x of img) if (finite(x)) v.push(x); return mad(v); }
const refl = (i, n) => { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };   // scipy mode 'reflect'

// ---------------- the grid: north-up gnomonic about the target (build_v3 grid_world) ----------------
export function makeGrid(ra0, dec0) {
  const ra = new Float64Array(NN), dec = new Float64Array(NN), a0 = ra0 * D2R, d0 = dec0 * D2R;
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const x = -(ix - C0) * PIX / 3600 * D2R, y = (iy - C0) * PIX / 3600 * D2R;
    let rho = Math.hypot(x, y); if (rho === 0) rho = 1e-12;
    const c = Math.atan(rho), s = Math.sin(c), co = Math.cos(c), k = iy * N + ix;
    dec[k] = Math.asin(co * Math.sin(d0) + y * s * Math.cos(d0) / rho) / D2R;
    ra[k] = (a0 + Math.atan2(x * s, rho * Math.cos(d0) * co - y * Math.sin(d0) * s)) / D2R;
  }
  return { ra0, dec0, ra, dec };
}

// ---------------- WCS: world -> 0-based pixel for every grid pixel ----------------
// SPHEREx (TAN + SIP, fits.js worldToPix, held to astropy by web/tests/golden.html): exact on a node every STEP grid
// pixels, bilinear between. The distortion is smooth over 24" and this is 0.001" from exact (blink_parity.mjs checks
// it against astropy). Exact everywhere would cost about 5 s per exposure.
const STEP = 12;
export function spherexMap(h, grid) {
  const nn = Math.ceil((N - 1) / STEP) + 1, nx = new Float64Array(nn * nn), ny = new Float64Array(nn * nn);
  const at = i => Math.min(i * STEP, N - 1);
  for (let j = 0; j < nn; j++) for (let i = 0; i < nn; i++) {
    const k = at(j) * N + at(i), p = worldToPix(h, grid.ra[k], grid.dec[k]);
    nx[j * nn + i] = p ? p[0] : NaN; ny[j * nn + i] = p ? p[1] : NaN;
  }
  const px = new Float64Array(NN), py = new Float64Array(NN);
  for (let iy = 0; iy < N; iy++) {
    const j = Math.min(Math.floor(iy / STEP), nn - 2), fy = (iy - at(j)) / (at(j + 1) - at(j));
    for (let ix = 0; ix < N; ix++) {
      const i = Math.min(Math.floor(ix / STEP), nn - 2), fx = (ix - at(i)) / (at(i + 1) - at(i)), k = iy * N + ix;
      const b = (A) => (A[j * nn + i] * (1 - fx) + A[j * nn + i + 1] * fx) * (1 - fy) + (A[(j + 1) * nn + i] * (1 - fx) + A[(j + 1) * nn + i + 1] * fx) * fy;
      px[k] = b(nx); py[k] = b(ny);
    }
  }
  return { px, py };
}
// 2MASS and AllWISE atlas images: SIN (orthographic) with CDELT and CROTA2, LONPOLE 180, as astropy reads them
export function sinW2P(h, ra, dec) {
  const rho = (h.CROTA2 || 0) * D2R, c1 = h.CDELT1, c2 = h.CDELT2;
  const pc = [Math.cos(rho), -Math.sin(rho) * c2 / c1, Math.sin(rho) * c1 / c2, Math.cos(rho)];
  const a = ra * D2R, d = dec * D2R, a0 = h.CRVAL1 * D2R, d0 = h.CRVAL2 * D2R;
  const x = Math.cos(d) * Math.sin(a - a0) / D2R, y = (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(a - a0)) / D2R;
  const X = x / c1, Y = y / c2, det = pc[0] * pc[3] - pc[1] * pc[2];   // solve PC (u, v) = (X, Y)
  return [(pc[3] * X - pc[1] * Y) / det + h.CRPIX1 - 1, (-pc[2] * X + pc[0] * Y) / det + h.CRPIX2 - 1];
}
export function sinMap(h, grid) {
  if (!/SIN$/.test(h.CTYPE1 || '') || !/SIN$/.test(h.CTYPE2 || '')) throw new Error(`expected a SIN projection, got ${h.CTYPE1}`);
  const px = new Float64Array(NN), py = new Float64Array(NN);
  for (let k = 0; k < NN; k++) { const p = sinW2P(h, grid.ra[k], grid.dec[k]); px[k] = p[0]; py[k] = p[1]; }
  return { px, py };
}

// bilinear at (x, y) of a w x h image, scipy map_coordinates(order=1, mode='constant', cval=0): 0 outside [0, n-1]
function bilin(a, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return 0;
  const xi = Math.min(Math.floor(x), w - 1), yi = Math.min(Math.floor(y), h - 1), fx = x - xi, fy = y - yi;
  const v = (i, j) => (i < w && j < h ? a[j * w + i] : 0);
  return (v(xi, yi) * (1 - fx) + v(xi + 1, yi) * fx) * (1 - fy) + (v(xi, yi + 1) * (1 - fx) + v(xi + 1, yi + 1) * fx) * fy;
}
// build_v3 to_grid: bilinear resample of img and its validity mask; a grid pixel is valid only if all its weight is
export function toGrid(img, valid, w, h, map, x0 = 0, y0 = 0) {
  const z = new Float64Array(w * h), vf = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) if (valid[k]) { z[k] = img[k]; vf[k] = 1; }
  const g = new Float64Array(NN), m = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) {
    const x = map.px[k] - x0, y = map.py[k] - y0;
    m[k] = bilin(vf, w, h, x, y) > 0.999 ? 1 : 0;
    g[k] = m[k] ? bilin(z, w, h, x, y) : NaN;
  }
  return { g, m };
}

// ---------------- filters, scipy.ndimage with mode 'reflect' ----------------
function gaussKernel(sigma) {
  const r = Math.floor(4 * sigma + 0.5), k = new Float64Array(2 * r + 1);
  let s = 0; for (let i = -r; i <= r; i++) s += (k[i + r] = Math.exp(-0.5 * i * i / (sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { r, k };
}
export function gaussian(a, w, h, sigma) {
  const { r, k } = gaussKernel(sigma), t = new Float64Array(w * h), o = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * a[refl(y + i, h) * w + x]; t[y * w + x] = s; }   // axis 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * t[y * w + refl(x + i, w)]; o[y * w + x] = s; }   // axis 1
  return o;
}
// build_v3 msmooth: normalised convolution; a pixel stays valid if its kernel saw at least 99% valid weight
export function msmooth(img, m, w, h, sigma) {
  if (!(sigma > 0)) return { img, m };
  const mf = new Float64Array(w * h), z = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) if (m[k]) { mf[k] = 1; z[k] = img[k]; }
  const ws = gaussian(mf, w, h, sigma), s = gaussian(z, w, h, sigma), out = new Float64Array(w * h), ok = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) { ok[k] = ws[k] > 0.99 ? 1 : 0; out[k] = ok[k] ? s[k] / ws[k] : NaN; }
  return { img: out, m: ok };
}
// median_filter(size) on an N x N image (no NaN), the element of rank size^2 // 2
function select(a, n, kth) {   // quickselect, in place
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const p = a[(lo + hi) >> 1]; let i = lo, j = hi;
    while (i <= j) { while (a[i] < p) i++; while (a[j] > p) j--; if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
    if (kth <= j) hi = j; else if (kth >= i) lo = i; else break;
  }
  return a[kth];
}
function medianFilter(a, size) {
  const r = size >> 1, buf = new Float64Array(size * size), o = new Float64Array(NN), kth = (size * size) >> 1;
  const rows = Array.from({ length: N + 2 * r }, (_, i) => refl(i - r, N)), cols = rows;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let n = 0;
    for (let j = 0; j < size; j++) { const row = rows[y + j] * N; for (let i = 0; i < size; i++) buf[n++] = a[row + cols[x + i]]; }
    o[y * N + x] = select(buf, n, kth);
  }
  return o;
}
function maxFilter(a, size) {
  const r = size >> 1, t = new Float64Array(NN), o = new Float64Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let m = -Infinity; for (let i = -r; i <= r; i++) m = Math.max(m, a[y * N + refl(x + i, N)]); t[y * N + x] = m; }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let m = -Infinity; for (let i = -r; i <= r; i++) m = Math.max(m, t[refl(y + i, N) * N + x]); o[y * N + x] = m; }
  return o;
}

// ---------------- stars ----------------
// the image minus a 30" median (the nebula), cached per array: peaks() asks for it at 10 and at 5 sigma
const highpass = new WeakMap();
function hpOf(img) {
  let c = highpass.get(img);
  if (!c) {
    const fill = nanmedian(img), z = Float64Array.from(img, v => (finite(v) ? v : fill)), mf = medianFilter(z, 15);
    const hp = Float64Array.from(img, (v, k) => v - mf[k]);
    const zz = Float64Array.from(img, (v, k) => (finite(v) ? hp[k] : -Infinity));
    c = { hp, zz, mx: maxFilter(zz, 7), noise: noise(hp) };
    highpass.set(img, c);
  }
  return c;
}
// local maxima above nsig times the high-passed image's noise, brightest (in img) first: [[iy, ix], ...]
export function peaks(img, nsig = 20) {
  const { zz, mx, noise: nz } = hpOf(img), out = [];
  for (let k = 0; k < NN; k++) if (zz[k] === mx[k] && zz[k] > nsig * nz) out.push([Math.floor(k / N), k % N]);
  return out.sort((a, b) => img[b[0] * N + b[1]] - img[a[0] * N + a[1]]);
}

// least squares: a Gaussian on a plane-free 13 x 13 box (build_v3 fit; scipy curve_fit is Levenberg-Marquardt too)
function solve(A, b, n) {   // Gaussian elimination with partial pivoting, n x n
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
function lmGauss(xx, yy, d, p0) {
  const n = d.length;
  let p = p0.slice(), lam = 1e-3, cost = Infinity, evals = 0;
  const resid = q => { let s = 0; const r = new Float64Array(n); for (let k = 0; k < n; k++) { const e = Math.exp(-((xx[k] - q[1]) ** 2 + (yy[k] - q[2]) ** 2) / (2 * q[3] * q[3])); r[k] = q[0] * e + q[4] - d[k]; s += r[k] * r[k]; } evals++; return [r, s]; };
  let [r, c] = resid(p); cost = c;
  for (let it = 0; it < 400 && evals < 4000; it++) {
    const J = new Array(n);
    for (let k = 0; k < n; k++) {
      const dx = xx[k] - p[1], dy = yy[k] - p[2], s2 = p[3] * p[3], e = Math.exp(-(dx * dx + dy * dy) / (2 * s2));
      J[k] = [e, p[0] * e * dx / s2, p[0] * e * dy / s2, p[0] * e * (dx * dx + dy * dy) / (s2 * p[3]), 1];
    }
    const A = Array.from({ length: 5 }, () => new Array(5).fill(0)), g = new Array(5).fill(0);
    for (let k = 0; k < n; k++) for (let i = 0; i < 5; i++) { g[i] += J[k][i] * r[k]; for (let j = 0; j < 5; j++) A[i][j] += J[k][i] * J[k][j]; }
    if (Math.max(...g.map(Math.abs)) < 1e-14 * Math.max(1, cost)) break;
    let better = false;
    for (let tries = 0; tries < 30; tries++) {
      const B = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lam) + 1e-300 : v)));
      const dp = solve(B, g.map(v => -v), 5);
      if (!dp) { lam *= 10; continue; }
      const q = p.map((v, i) => v + dp[i]), [r2, c2] = resid(q);
      if (finite(c2) && c2 < cost) {
        const rel = (cost - c2) / Math.max(cost, 1e-300), step = Math.max(...dp.map((v, i) => Math.abs(v) / (Math.abs(p[i]) + 1e-8)));
        p = q; r = r2; cost = c2; lam = Math.max(lam / 10, 1e-12); better = true;
        if (rel < 1.49012e-8 && step < 1.49012e-8) it = 1e9;
        break;
      }
      lam *= 10;
    }
    if (!better) break;
  }
  return p;
}
export function fit(img, iy, ix, r = 6) {
  iy = Math.round(iy); ix = Math.round(ix);
  if (iy - r < 0 || ix - r < 0 || iy + r >= N || ix + r >= N) return null;
  const n = 2 * r + 1, sl = new Float64Array(n * n), xx = new Float64Array(n * n), yy = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const v = img[(iy - r + j) * N + ix - r + i]; if (!finite(v)) return null; sl[j * n + i] = v; xx[j * n + i] = i - r; yy[j * n + i] = j - r; }
  // remove a plane fitted to the box edge (the nebula's gradient)
  const E = [], eb = [];
  for (let k = 0; k < n * n; k++) if (Math.abs(yy[k]) === r || Math.abs(xx[k]) === r) { E.push([1, xx[k], yy[k]]); eb.push(sl[k]); }
  const AtA = [0, 1, 2].map(i => [0, 1, 2].map(j => E.reduce((s, e) => s + e[i] * e[j], 0))), Atb = [0, 1, 2].map(i => E.reduce((s, e, k) => s + e[i] * eb[k], 0));
  const c = solve(AtA, Atb, 3);
  for (let k = 0; k < n * n; k++) sl[k] -= c[0] + c[1] * xx[k] + c[2] * yy[k];
  const p = lmGauss(xx, yy, sl, [sl[r * n + r], 0, 0, 2, 0]);
  if (!(p[0] > 0) || !(Math.abs(p[3]) > 0.5 && Math.abs(p[3]) < 8) || Math.abs(p[1]) > 2 || Math.abs(p[2]) > 2 || !p.every(finite)) return null;
  return { fwhm: 2.355 * Math.abs(p[3]) * PIX, x: ix + p[1], y: iy + p[2] };
}
function fwhmOf(img, pk) {
  const fs = []; for (const [iy, ix] of pk.slice(0, 40)) { const f = fit(img, iy, ix); if (f) fs.push(f.fwhm); }
  return fs.length ? nanmedian(fs) : NaN;
}

// aperture 1 FWHM radius, sky annulus 2-3 FWHM (median); null unless every pixel used is valid (build_v3 phot)
function disc(y, x, rr, fn) {
  const y0 = Math.max(0, Math.floor(y - rr) - 1), y1 = Math.min(N - 1, Math.ceil(y + rr) + 1), x0 = Math.max(0, Math.floor(x - rr) - 1), x1 = Math.min(N - 1, Math.ceil(x + rr) + 1);
  for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) fn(Math.hypot(iy - y, ix - x), iy * N + ix);
}
export function phot(img, m, y, x, F) {
  const r = AP * F / PIX, ri = AN[0] * F / PIX, ro = AN[1] * F / PIX;
  if (ro > Math.min(x, y, N - 1 - x, N - 1 - y)) return null;
  const ap = [], an = []; let ok = true;
  disc(y, x, ro, (d, k) => { if (d < r) { ap.push(k); if (!m[k]) ok = false; } else if (d >= ri && d < ro) { an.push(k); if (!m[k]) ok = false; } });
  if (!ok) return null;
  const av = an.map(k => img[k]), sky = median(av), sd = 1.4826 * median(av.map(v => Math.abs(v - sky)));
  let f = 0; for (const k of ap) f += img[k] - sky;
  return { flux: f, snr: sd > 0 ? f / (sd * Math.sqrt(ap.length)) : Infinity };
}
function ee(img, y, x, F) {
  const an = [], a = [], b = [];
  disc(y, x, AN[1] * F / PIX, (d, k) => { if (d >= AN[0] * F / PIX && d < AN[1] * F / PIX) an.push(img[k]); if (d < 0.6 * F / PIX) a.push(img[k]); if (d < 1.5 * F / PIX) b.push(img[k]); });
  const sky = median(an);
  return a.reduce((s, v) => s + v - sky, 0) / b.reduce((s, v) => s + v - sky, 0);
}

// ---------------- band synthesis (build_v3 synth) ----------------
function trapz(y, x) { let s = 0; for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2; return s; }
function interp(x, xp, fp) {   // np.interp, xp increasing
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let lo = 0, hi = xp.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
  return fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / (xp[hi] - xp[lo]);
}
const searchsorted = (a, v) => { let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
// the band's bins and weights from its response curve (bands.json): mean f_nu, energy counters r/lam^2, photons r/lam
export function bandBins(curve) {
  const lam = curve.lam, w = curve.r.map((r, i) => Math.max(r, 0) / lam[i] ** (curve.det === 1 ? 1 : 2));
  const wmax = Math.max(...w), above = lam.filter((_, i) => w[i] > 0.01 * wmax), lo = above[0], hi = above[above.length - 1];
  const loS = Math.max(lo, SPX_RANGE[0]), hiS = Math.min(hi, SPX_RANGE[1]);
  const inS = lam.map((l, i) => [l, w[i]]).filter(([l]) => l >= loS && l <= hiS);
  const outFrac = 1 - trapz(inS.map(p => p[1]), inS.map(p => p[0])) / trapz(w, lam);
  const res = hiS < 3.82 ? 40 : 60, edges = [loS];
  while (edges[edges.length - 1] < hiS) edges.push(edges[edges.length - 1] * (1 + 1 / res));
  edges[edges.length - 1] = hiS;
  const nb = edges.length - 1, fine = Array.from({ length: 4000 }, (_, i) => loS + (hiS - loS) * i / 3999), wf = fine.map(x => interp(x, lam, w));
  const wb = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { const sel = fine.map((f, k) => k).filter(k => fine[k] >= edges[i] && fine[k] <= edges[i + 1]); wb[i] = trapz(sel.map(k => wf[k]), sel.map(k => fine[k])); }
  const tot = wb.reduce((s, v) => s + v, 0); for (let i = 0; i < nb; i++) wb[i] /= tot;
  return { edges, wb, nb, lo, hi, loS, hiS, outFrac, det: curve.det, svo: curve.svo };
}
// wavelength at a detector pixel (0-based): wavemaps.json, linear between its nodes (RegularGridInterpolator, extrapolating)
export function lamAt(map, x, y) {
  const seg = (g, p) => { let i = 0; while (i < g.length - 2 && p > g[i + 1] - 1) i++; return [i, (p - (g[i] - 1)) / (g[i + 1] - g[i])]; };
  const [i, fx] = seg(map.x, x), [j, fy] = seg(map.y, y), L = map.lam;
  return (L[j][i] * (1 - fx) + L[j][i + 1] * fx) * (1 - fy) + (L[j + 1][i] * (1 - fx) + L[j + 1][i + 1] * fx) * fy;
}
// SPHEREx in the survey band: start, add each exposure (its cutout, flags, header and grid map), end
export function synthStart(curve, dets) {
  const bins = bandBins(curve);
  return { bins, dets, S: new Float64Array(bins.nb * NN), Cn: new Uint16Array(bins.nb * NN), used: [], seeLead: 0, satLead: 0 };
}
const isoDate = mjd => new Date((mjd - 40587) * 864e5).toISOString().slice(0, 10);
// e: { det, t (MJD), key, sha256, img Float32Array, flg Int32Array, w, h, x0, y0, map: {px, py} on the full detector }
export function synthAdd(acc, e, wavemap) {
  if (!acc.dets.includes(e.det)) return false;
  const valid = new Uint8Array(e.w * e.h);
  for (let k = 0; k < valid.length; k++) valid[k] = finite(e.img[k]) && (e.flg[k] & BAD) === 0 ? 1 : 0;
  const { g, m } = toGrid(e.img, valid, e.w, e.h, e.map, e.x0, e.y0);
  let cnt = 0; for (let k = 0; k < NN; k++) cnt += m[k];
  if (cnt < 50) return false;
  const { edges, nb } = acc.bins, b = new Int16Array(NN).fill(-1);
  let any = false;
  for (let k = 0; k < NN; k++) if (m[k]) { const i = searchsorted(edges, lamAt(wavemap, e.map.px[k], e.map.py[k])) - 1; if (i >= 0 && i < nb) { b[k] = i; any = true; } }
  if (!any) return false;
  const med = nanmedian(g);   // the exposure's own background (zodiacal light)
  for (let k = 0; k < NN; k++) if (b[k] >= 0) { acc.S[b[k] * NN + k] += g[k] - med; acc.Cn[b[k] * NN + k]++; }
  const c = Math.round(C0) * N + Math.round(C0), lc = m[c] ? searchsorted(edges, lamAt(wavemap, e.map.px[c], e.map.py[c])) - 1 : -1;
  // the star's own pixel: exposures that see it in band, and those saturated there (a star too bright), for the page's reason
  const lx = Math.round(e.map.px[c] - e.x0), ly = Math.round(e.map.py[c] - e.y0), li = searchsorted(edges, lamAt(wavemap, e.map.px[c], e.map.py[c])) - 1;
  if (lx >= 0 && ly >= 0 && lx < e.w && ly < e.h && li >= 0 && li < nb) { acc.seeLead++; if (e.flg[ly * e.w + lx] & SAT) acc.satLead++; }
  acc.used.push({ key: e.key, det: e.det, mjd: e.t, sha256: e.sha256, digest: CUTOUT_DIGEST, bg_median: med, grid_fraction: cnt / NN, at_lead: !!m[c] && lc >= 0 && lc < nb });
  return true;
}
export function synthEnd(acc, band) {
  const { nb, wb } = acc.bins, mean = new Float64Array(nb * NN).fill(NaN), covered = new Float64Array(NN);
  for (let i = 0; i < nb; i++) for (let k = 0; k < NN; k++) if (acc.Cn[i * NN + k]) { mean[i * NN + k] = acc.S[i * NN + k] / acc.Cn[i * NN + k]; covered[k] += wb[i]; }
  const has = (i, k) => acc.Cn[i * NN + k] > 0, filled = Float64Array.from(mean);
  for (let i = 0; i < nb; i++) for (let k = 0; k < NN; k++) {   // bounded fill: one-bin interior gaps, one bin at either end
    if (has(i, k)) continue;
    if (i > 0 && i < nb - 1) { if (has(i - 1, k) && has(i + 1, k)) filled[i * NN + k] = (mean[(i - 1) * NN + k] + mean[(i + 1) * NN + k]) / 2; }
    else if (i === 0) { if (nb > 1 && has(1, k)) filled[k] = mean[NN + k]; }
    else if (has(nb - 2, k)) filled[i * NN + k] = mean[(nb - 2) * NN + k];
  }
  const img = new Float64Array(NN), m = new Uint8Array(NN);
  let nv = 0;
  for (let k = 0; k < NN; k++) {
    let all = true, s = 0;
    for (let i = 0; i < nb; i++) { const v = filled[i * NN + k]; if (!finite(v)) { all = false; break; } s += wb[i] * v; }
    m[k] = all && covered[k] >= T.MIN_COVERED ? 1 : 0; img[k] = m[k] ? s : NaN; nv += m[k];
  }
  const lead = acc.used.filter(u => u.at_lead), c = Math.round(C0) * N + Math.round(C0), B = acc.bins;
  const meta = { band_label: band, detectors: acc.dets, response: `SVO ${B.svo} (DetectorType ${B.det})`, band_um: [+B.lo.toFixed(3), +B.hi.toFixed(3)],
    synth_range_um: [+B.loS.toFixed(3), +B.hiS.toFixed(3)], response_weight_outside_spherex: +B.outFrac.toFixed(3), bins: nb,
    covered_weight_at_lead: +covered[c].toFixed(3), exposures_used: acc.used.length, exposures_at_lead: lead.length,
    exposures_seeing_lead: acc.seeLead, exposures_saturated_at_lead: acc.satLead,
    dates_at_lead: lead.length ? [isoDate(Math.min(...lead.map(u => u.mjd))), isoDate(Math.max(...lead.map(u => u.mjd)))] : null,
    valid_fraction: +(nv / NN).toFixed(4), inputs: acc.used };
  return { img, m, meta };
}

// ---------------- old surveys ----------------
// FITS primary HDU of an atlas image: { h, data (Float64Array, BSCALE/BZERO applied, blanks NaN), w, h }
export function readFits(bytes, parseCards) {
  let off = 0, h = null;
  for (;;) { const p = parseCards(bytes.subarray(off)); if (p.end >= 0) { h = p.h; off += Math.ceil(p.end / 2880) * 2880; break; } throw new Error('no END card in the primary header'); }
  if (h.SIMPLE !== true || h.NAXIS !== 2) throw new Error('not a 2-D FITS image');
  const w = h.NAXIS1, ht = h.NAXIS2, bp = h.BITPIX, nb = Math.abs(bp) / 8, dv = new DataView(bytes.buffer, bytes.byteOffset + off);
  if (bytes.length < off + w * ht * nb) throw new Error('FITS data is short');
  const bs = h.BSCALE ?? 1, bz = h.BZERO ?? 0, data = new Float64Array(w * ht);
  const get = { '-32': i => dv.getFloat32(4 * i), '-64': i => dv.getFloat64(8 * i), 16: i => dv.getInt16(2 * i), 32: i => dv.getInt32(4 * i), 8: i => dv.getUint8(i) }[bp];
  if (!get) throw new Error(`BITPIX ${bp} not supported`);
  for (let i = 0; i < w * ht; i++) { const v = get(i); data[i] = bp > 0 && h.BLANK !== undefined && v === h.BLANK ? NaN : v * bs + bz; }
  return { h, data, w, ht };
}
// AllWISE intensity tile with its coverage map: valid where finite and at least 5 frames
export function oldWise(int, cov, grid, inputs) {
  const valid = new Uint8Array(int.w * int.ht);
  for (let k = 0; k < valid.length; k++) valid[k] = finite(int.data[k]) && cov.data[k] >= 5 ? 1 : 0;
  const map = sinMap(int.h, grid), { g, m } = toGrid(int.data, valid, int.w, int.ht, map);
  const med = nanmedian(g); for (let k = 0; k < NN; k++) g[k] -= med;
  const c = Math.round(C0) * N + Math.round(C0), cl = bilin(cov.data, cov.w, cov.ht, map.px[c], map.py[c]);
  let nv = 0; for (const v of m) nv += v;
  const hd = int.h;
  return { img: g, m, meta: { survey: 'AllWISE Atlas', band_header: `BAND ${hd.BAND}`, band: `W${hd.BAND}`, dates: [hd.DATEOBS1.slice(0, 10), hd.DATEOBS2.slice(0, 10)],
    mid: hd.MIDOBS.slice(0, 10), coverage_frames_at_lead: +cl.toFixed(1), valid_fraction: +(nv / NN).toFixed(4), release: 'AllWISE p3am_cdd', inputs } };
}
// 2MASS Ks: every atlas tile that touches the field, one zero point, anti-aliased, each tile's own sky taken away,
// averaged where they overlap. tiles: [{ name, fits }], sorted by name (the first sets the zero point, as the reference)
export function old2mass(tiles, grid, inputs) {
  tiles = [...tiles].sort((a, b) => (a.name < b.name ? -1 : 1));
  let ZREF = null; const S = new Float64Array(NN), Cn = new Float64Array(NN), dates = new Set(), atLead = [], c = Math.round(C0) * N + Math.round(C0);
  for (const t of tiles) {
    const hd = t.fits.h; ZREF ??= hd.MAGZP;
    const f = 10 ** (0.4 * (ZREF - hd.MAGZP)), img = Float64Array.from(t.fits.data, v => v * f), valid = Uint8Array.from(img, v => (finite(v) ? 1 : 0));
    const sm = msmooth(img, valid, t.fits.w, t.fits.ht, 0.85);
    const { g, m } = toGrid(sm.img, sm.m, t.fits.w, t.fits.ht, sinMap(hd, grid));
    const med = nanmedian(g);
    for (let k = 0; k < NN; k++) if (m[k]) { S[k] += g[k] - med; Cn[k]++; }
    dates.add(twomassDate(hd.ORDATE));
    if (m[c]) atLead.push(t.name);
  }
  const img = new Float64Array(NN), m = new Uint8Array(NN); let nv = 0;
  for (let k = 0; k < NN; k++) { m[k] = Cn[k] > 0 ? 1 : 0; img[k] = m[k] ? S[k] / Cn[k] : NaN; nv += m[k]; }
  return { img, m, meta: { survey: '2MASS All-Sky Atlas', band_header: 'FILTER k', band: 'Ks', dates: [...dates].sort(), tiles: tiles.map(t => t.name),
    tiles_at_lead: atLead, valid_fraction: +(nv / NN).toFixed(4), release: '2MASS All-Sky Release', inputs } };
}

// 2MASS ORDATE (yymmdd) -> ISO date. The survey ran 1997 to 2001, so 97-99 are the 1900s, 00-01 the 2000s.
export function twomassDate(ordate) {
  const od = String(ordate).trim();
  if (!/^\d{6}$/.test(od)) throw new Error(`ORDATE ${ordate} is not yymmdd`);
  return `${+od.slice(0, 2) >= 90 ? '19' : '20'}${od.slice(0, 2)}-${od.slice(2, 4)}-${od.slice(4, 6)}`;
}

// The digest of one SPHEREx input as the pipeline used it: the IMAGE header's cards, which exposure (its S3 key), the
// crop's origin and size on the detector, and the IMAGE and FLAGS pixels. Not a checksum of the source file on S3 (that
// is 50 MB and never read whole): a change of WCS, crop or pixels changes it; where the reader found the data does not.
export const CUTOUT_DIGEST = 'sha256 of the canonical cutout: S3 key, IMAGE header cards, crop origin and size on the detector, then IMAGE (float32) and FLAGS (int32) pixels, little-endian; not a checksum of the source file';
export async function cutoutDigest(e) {
  const cards = Object.keys(e.head).filter(k => !k.startsWith('_')).sort().map(k => [k, e.head[k]]);
  const meta = new TextEncoder().encode(JSON.stringify({ key: e.key, x0: e.x0, y0: e.y0, w: e.w, h: e.h, header: cards }) + '\n');
  const img = new Uint8Array(Float32Array.from(e.img).buffer), flg = new Uint8Array(Int32Array.from(e.flg).buffer);
  const all = new Uint8Array(meta.length + img.length + flg.length); all.set(meta); all.set(img, meta.length); all.set(flg, meta.length + img.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ---------------- display background (build_v3 starmask, bgmodel, bgdiff) ----------------
function starmask(imgs, F) {
  const m = new Uint8Array(NN), set = (y, x, r) => disc(y, x, r, (d, k) => { if (d < r) m[k] = 1; });
  set(C0, C0, 4 * F / PIX);
  for (const im of imgs) for (const [iy, ix] of peaks(im, 5)) set(iy, ix, 2.5 * F / PIX);
  return m;
}
export function bgmodel(img, smask) {
  const nb = Math.floor(N / BG_BLOCK), blk = new Float64Array(nb * nb), buf = [];
  for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
    buf.length = 0;
    for (let y = by * BG_BLOCK; y < (by + 1) * BG_BLOCK; y++) for (let x = bx * BG_BLOCK; x < (bx + 1) * BG_BLOCK; x++) { const k = y * N + x, v = img[k]; if (!smask[k] && finite(v)) buf.push(v); }
    blk[by * nb + bx] = buf.length / (BG_BLOCK * BG_BLOCK) < 0.3 ? NaN : nanmedian(buf);
  }
  const w = Float64Array.from(blk, v => (finite(v) ? 1 : 0)), z = Float64Array.from(blk, v => (finite(v) ? v : 0));
  const gs = gaussian(z, nb, nb, 1), gw = gaussian(w, nb, nb, 1), sm = Float64Array.from(gs, (v, k) => v / Math.max(gw[k], 1e-6));
  const out = new Float64Array(NN), cc = Array.from({ length: N }, (_, i) => Math.min(Math.max((i + 0.5) / BG_BLOCK - 0.5, 0), nb - 1));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[y * N + x] = bilin(sm, nb, nb, cc[x], cc[y]);
  return { bg: out, blk };
}
const H0 = (N - CROP) / 2;   // the 3 arcmin crop: rows and columns H0 .. H0 + CROP - 1
const inCrop = k => { const y = Math.floor(k / N), x = k % N; return y >= H0 && y < H0 + CROP && x >= H0 && x < H0 + CROP; };
export function bgdiff(ow, sw, smask) {
  const bo = bgmodel(ow, smask).bg, bs = bgmodel(sw, smask).bg, d = [], b = [];
  for (let k = 0; k < NN; k++) if (inCrop(k)) { d.push(bs[k] - bo[k]); b.push(bs[k]); }
  const rng = percentile(b, 95) - percentile(b, 5);
  if (!d.every(finite) || !(rng > 0)) return { median_diff: null, rms_diff: null, range: null, pass: false };
  const md = median(d) / rng, rms = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length) / rng;
  return { median_diff: +md.toFixed(3), rms_diff: +rms.toFixed(3), range: +rng.toFixed(4), pass: Math.abs(md) <= T.BG_MED && rms <= T.BG_RMS, _md: md, _rms: rms };
}
function polyfit1(x, y) {
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const a = sxy / sxx; return [a, my - a * mx];
}
const corrcoef = (x, y) => { const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return a / Math.sqrt(b * c); };

// ---------------- display: one shared asinh stretch, the crop an exact sub-array of the wide frame ----------------
const ASINH10 = Math.asinh(10);
// grey 0-255 for each pixel; 'mask' where there is no data. Python's enc() before its flip.
export function encode(a, lo, hi) {
  const g = new Uint8Array(a.length), mask = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const v = finite(a[k]) ? a[k] : lo;
    g[k] = Math.round(255 * Math.min(1, Math.max(0, Math.asinh(Math.max(0, (v - lo) / (hi - lo)) * 10) / ASINH10)));
    mask[k] = finite(a[k]) ? 0 : 1;
  }
  return { g, mask };
}
export const decodeGrey = (g, lo, hi) => Math.sinh(g / 255 * ASINH10) / 10 * (hi - lo) + lo;
export function decode(e, lo, hi) { return Float64Array.from(e.g, (g, k) => (e.mask[k] ? NaN : decodeGrey(g, lo, hi))); }
export function crop(a, n = N) {   // the middle CROP x CROP of an n x n array
  const h0 = (n - CROP) / 2, o = new a.constructor(CROP * CROP);
  for (let y = 0; y < CROP; y++) for (let x = 0; x < CROP; x++) o[y * CROP + x] = a[(h0 + y) * n + h0 + x];
  return o;
}
// canvas order: north up, east left (row 0 is the grid's top row iy = N - 1; columns as the grid, east at ix = 0)
export function rgba(e, n) {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = (n - 1 - r) * n + c, j = 4 * (r * n + c);
    if (e.mask[k]) out.set([...MASK_RGB, 255], j); else { const g = e.g[k]; out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255; }
  }
  return out;
}
// and back: canvas RGBA -> { g, mask } in grid order (a grey pixel is data, anything else is the mask colour)
export function unrgba(px, n) {
  const g = new Uint8Array(n * n), mask = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const j = 4 * (r * n + c), k = (n - 1 - r) * n + c;
    if (px[j] === px[j + 1] && px[j + 1] === px[j + 2]) g[k] = px[j]; else mask[k] = 1;
  }
  return { g, mask };
}

// ---------------- E4: the displayed pixels, decoded with the page's stretch ----------------
// dw: { old, spherex } wide frames, dc: the crops, all decoded to MJy/sr (NaN for mask); info: the pair's quals, F,
// lead ratio, smask and what was drawn as mask. The same checks as build_v3 on its written PNGs.
function dphot(img, n, y, x, F) {
  const r = AP * F / PIX, ri = AN[0] * F / PIX, ro = AN[1] * F / PIX;
  if (ro > Math.min(x, y, n - 1 - x, n - 1 - y)) return null;
  const ring = []; let s = 0, na = 0, ok = true;
  for (let iy = Math.max(0, Math.floor(y - ro) - 1); iy <= Math.min(n - 1, Math.ceil(y + ro) + 1); iy++)
    for (let ix = Math.max(0, Math.floor(x - ro) - 1); ix <= Math.min(n - 1, Math.ceil(x + ro) + 1); ix++) {
      const d = Math.hypot(iy - y, ix - x), v = img[iy * n + ix];
      if (d < ro && !finite(v)) ok = false;
      if (d < r) { s += v; na++; } else if (d >= ri && d < ro) ring.push(v);
    }
  if (!ok) return null;
  return s - na * median(ring);
}
export function displayChecks(dw, dc, info) {
  const { F, quals, R, smask, hi, ow, sw } = info, cc = (CROP - 1) / 2;
  const Rd = dphot(dc.spherex, CROP, cc, cc, F) / dphot(dc.old, CROP, cc, cc, F);
  const box = (a, q) => { let m = -Infinity; for (let y = Math.floor(q.y) - 2; y <= Math.floor(q.y) + 2; y++) for (let x = Math.floor(q.x) - 2; x <= Math.floor(q.x) + 2; x++) { const v = a[y * N + x]; if (finite(v)) m = Math.max(m, v); } return m === -Infinity ? NaN : m; };
  const unclipped = quals.filter(q => Math.max(box(ow, q), box(sw, q)) < 0.9 * hi);
  const fr = [];
  for (const q of unclipped) { const a = dphot(dw.spherex, N, q.y, q.x, F), b = dphot(dw.old, N, q.y, q.x, F); if (a !== null && b) fr.push(a / b); }
  let diff = 0, nd = 0, mo = 0, ms = 0, gapsOk = true;
  for (let k = 0; k < CROP * CROP; k++) { if (finite(dc.old[k]) && finite(dc.spherex[k])) { diff += Math.abs(dc.old[k] - dc.spherex[k]); nd++; } mo += !finite(dc.old[k]); ms += !finite(dc.spherex[k]); }
  const cropOw = crop(ow), cropSw = crop(sw); let wantO = 0, wantS = 0;
  for (let k = 0; k < CROP * CROP; k++) { wantO += !finite(cropOw[k]); wantS += !finite(cropSw[k]); }
  disc(C0, C0, AN[1] * F / PIX, (d, k) => { if (d < AN[1] * F / PIX && (!finite(ow[k]) || !finite(sw[k]))) gapsOk = false; });
  // background match on what is displayed: the decoded frames' star-masked large-scale backgrounds over the crop
  const bgd = bgdiff(dw.old, dw.spherex, smask);
  const fieldMed = fr.length ? median(fr) : NaN;
  return {
    checks: {
      display_frames_differ: nd > 0 && diff / nd > 0,
      display_no_hidden_gaps: mo === wantO && ms === wantS && gapsOk,
      display_crop_is_subarray: info.subarray !== false,
      display_lead_ratio: Math.abs(Rd / R - 1) <= T.DISPLAY_TOL,
      display_field_ratio: fr.length >= 10 && Math.abs(fieldMed - 1) <= T.DISPLAY_TOL,
    },
    lead_ratio_from_display: +Rd.toFixed(3), masked_pixels_in_crop: { old: mo, spherex: ms }, field_stars_read_back: fr.length,
    field_ratio_from_display: fr.length ? +fieldMed.toFixed(3) : null, background_from_display: bgd,
  };
}

// ---------------- one pair (build_v3 pair) ----------------
// old, sp: { img, m, meta } from oldWise/old2mass and synthEnd. opts: displayScale (a mutation), matchBg (false: a mutation)
export function pair(name, old, sp, { displayScale = 1, matchBg = true } = {}) {
  let o = old.img, mo = old.m, s = sp.img, ms = sp.m;
  const metaO = old.meta, metaS = sp.meta, c0 = Math.round(C0);
  const pk = peaks(s, 10).filter(p => Math.min(...p) > 12 && Math.max(...p) < N - 13);
  const Fo = fwhmOf(o, pk), Fs = fwhmOf(s, pk), kk = Math.sqrt(Math.abs(Fo ** 2 - Fs ** 2)) / 2.355 / PIX;
  if (Fo < Fs) ({ img: o, m: mo } = msmooth(o, mo, N, N, kk)); else ({ img: s, m: ms } = msmooth(s, ms, N, N, kk));
  const Fo2 = fwhmOf(o, pk), Fs2 = fwhmOf(s, pk), F = Math.max(Fo2, Fs2);
  const allpk = peaks(s, 5), quals = [];
  for (const [iy, ix] of pk) {
    if (Math.hypot(iy - C0, ix - C0) < AN[1] * F / PIX) continue;
    const fo = fit(o, iy, ix), fs = fit(s, iy, ix);
    if (!fo || !fs || Math.abs(fo.fwhm / Fo2 - 1) > 0.25 || Math.abs(fs.fwhm / Fs2 - 1) > 0.25) continue;
    const po = phot(o, mo, fs.y, fs.x, F), ps = phot(s, ms, fs.y, fs.x, F);
    if (!po || !ps || po.snr < 30 || ps.snr < 30) continue;
    if (allpk.some(q => { const d = Math.hypot(q[0] - iy, q[1] - ix); return d > 0 && d < 2 * F / PIX && s[q[0] * N + q[1]] > 0.05 * s[iy * N + ix]; })) continue;
    quals.push({ y: fs.y, x: fs.x, po: po.flux, ps: ps.flux, off: Math.hypot(fs.x - fo.x, fs.y - fo.y) * PIX, ee_o: ee(o, fs.y, fs.x, F), ee_s: ee(s, fs.y, fs.x, F) });
  }
  quals.sort((a, b) => b.ps - a.ps);
  const cal = quals.filter((_, i) => i % 2 === 0), val = quals.filter((_, i) => i % 2 === 1);
  const scale = cal.length ? median(cal.map(q => q.ps / q.po)) : NaN;
  const rv = val.length ? val.map(q => q.ps / (q.po * scale)) : [NaN], rvm = median(rv), sig = 1.4826 * median(rv.map(v => Math.abs(v - rvm)));
  const flO = fit(o, c0, c0, 6), flS = fit(s, c0, c0, 6), loPh = phot(o, mo, C0, C0, F), lsPh = phot(s, ms, C0, C0, F);
  const R = loPh && lsPh ? lsPh.flux / (loPh.flux * scale) : NaN, z = sig > 0 ? (R - 1) / sig : NaN;
  const offs = quals.length ? quals.map(q => q.off) : [NaN], eeMed = quals.length ? median(quals.map(q => q.ee_o - q.ee_s)) : NaN;
  const checks = {
    finite: [R, z, scale, sig, F].every(finite),
    band_match: metaO.band === metaS.band_label,
    old_footprint: metaO.valid_fraction >= T.FOOTPRINT && !!mo[c0 * N + c0],
    spherex_footprint: metaS.valid_fraction >= T.FOOTPRINT,
    spectral_coverage_at_lead: metaS.covered_weight_at_lead >= T.MIN_COVERED,
    qualified_stars: quals.length >= T.MIN_STARS,
    validation_median: Math.abs(rvm - 1) <= T.VAL_MED_TOL,
    field_scatter_cap: sig <= T.SCATTER_CAP,
    psf_fwhm_match: Math.abs(Fo2 / Fs2 - 1) <= T.FWHM_TOL,
    psf_profile_match: Math.abs(quals.length ? eeMed : 1) <= T.EE_TOL,
    alignment: median(offs) <= T.ALIGN_MED && percentile(offs, 90) <= T.ALIGN_P90,
    lead_same_place: !!(flO && flS && Math.hypot(flO.x - flS.x, flO.y - flS.y) * PIX <= T.LEAD_SHIFT),
  };
  const ex = EXPECT[name];
  const expectation = ex ? ('min_ratio' in ex ? R >= ex.min_ratio && z >= ex.min_z : Math.abs(R - 1) <= ex.max_dev && Math.abs(z) < ex.max_z) : null;

  // display: the old frame on SPHEREx's scale; large-scale background matched for display only
  let ow = Float64Array.from(o, v => v * scale * displayScale);
  const sw = s, smask = starmask([o, s], F);
  const BO = bgmodel(ow, smask), BS = bgmodel(sw, smask), bo = BO.bg, bs = BS.bg;
  const xb = [], yb = []; for (let i = 0; i < BO.blk.length; i++) if (finite(BO.blk[i]) && finite(BS.blk[i])) { xb.push(BO.blk[i]); yb.push(BS.blk[i]); }
  let a = 1, cc = 0, corr = NaN;
  if (xb.length >= 10) {
    let keep = xb.map(() => true);
    for (let it = 0; it < 3; it++) {
      [a, cc] = polyfit1(xb.filter((_, i) => keep[i]), yb.filter((_, i) => keep[i]));
      const r = yb.map((y, i) => y - (a * xb[i] + cc)), rk = r.filter((_, i) => keep[i]), sd = mad(rk, median(rk));
      keep = r.map(v => Math.abs(v) < 3 * sd);
    }
    corr = corrcoef(xb, yb);
  }
  const before = bgdiff(ow, sw, smask), owUnmatched = ow;
  let lin = null, method = 'none';
  if (matchBg && xb.length >= 10) {
    const ow1 = Float64Array.from(ow, (v, k) => v + (a - 1) * bo[k] + cc); lin = bgdiff(ow1, sw, smask);
    if (lin.pass) { ow = ow1; method = 'linear fit of old background onto SPHEREx background'; }
    else {   // pre-declared fallback: one common large-scale background, converged in 3 passes
      ow = Float64Array.from(ow, (v, k) => v - bo[k] + bs[k]);
      for (let it = 0; it < 3; it++) { const d = bgmodel(ow, smask).bg; ow = Float64Array.from(ow, (v, k) => v - (d[k] - bs[k])); }
      method = 'common large-scale background (SPHEREx), fallback';
    }
  }
  const after = bgdiff(ow, sw, smask);
  const grain = im => { const b = bgmodel(im, smask).bg, v = []; for (let k = 0; k < NN; k++) if (inCrop(k) && !smask[k] && finite(im[k] - b[k])) v.push(im[k] - b[k]); return mad(v, median(v)); };
  const gO = grain(ow), gS = grain(sw), rng = after.range ?? NaN;
  const grainRule = Math.max(gO, gS) / Math.max(Math.min(gO, gS), 1e-12) > T.GRAIN_RATIO;
  const bsC = []; for (let k = 0; k < NN; k++) if (inCrop(k)) bsC.push(BS.bg[k]);
  const swC = []; for (let k = 0; k < NN; k++) if (inCrop(k)) swC.push(sw[k]);
  const lo = grainRule ? median(bsC) + 3 * Math.max(gO, gS) : percentile(swC, 5);
  let top = -Infinity; for (let y = c0 - 3; y <= c0 + 3; y++) for (let x = c0 - 3; x <= c0 + 3; x++) for (const A of [ow, sw]) if (finite(A[y * N + x])) top = Math.max(top, A[y * N + x]);
  const hi = 1.15 * top;
  // the displayed pixels, encoded and decoded as the page draws and reads them
  const eo = encode(ow, lo, hi), es = encode(sw, lo, hi);
  const dw = { old: decode(eo, lo, hi), spherex: decode(es, lo, hi) }, dc = { old: crop(dw.old), spherex: crop(dw.spherex) };
  const disp = displayChecks(dw, dc, { F, quals, R, smask, hi, ow, sw });
  Object.assign(checks, disp.checks, { display_background_match: after.pass });
  const grey = A => { const e = encode(A, lo, hi); return Float64Array.from(e.g, (g, k) => (finite(A[k]) ? g : NaN)); };
  const gdiff = A => { const ga = grey(A), gs = grey(sw), d = []; const b1 = bgmodel(ga, smask).bg, b2 = bgmodel(gs, smask).bg; for (let k = 0; k < NN; k++) if (inCrop(k)) d.push(b2[k] - b1[k]); return { median: +nanmedian(d).toFixed(1), rms: +Math.sqrt(d.filter(finite).reduce((s2, v) => s2 + v * v, 0) / d.filter(finite).length).toFixed(1) }; };
  const strip = b => b && { median_diff: b.median_diff, rms_diff: b.rms_diff, range: b.range, pass: b.pass };
  const r3 = v => +v.toFixed(3), r2 = v => +v.toFixed(2);
  return {
    pair: `${metaO.survey} ${metaO.band} vs SPHEREx`, passed: Object.values(checks).every(Boolean) && expectation !== false, science_passed: Object.values(checks).every(Boolean),
    checks, expectation, lead_ratio: r3(R), lead_mag_change: R > 0 ? r3(-2.5 * Math.log10(R)) : null, field_scatter_robust_sigma: r3(sig),
    lead_z_vs_field: +z.toFixed(1), qualified_stars: quals.length, calibration_stars: cal.length, validation_stars: val.length, validation_median: r3(rvm), scale,
    fwhm_arcsec: { old_native: r2(Fo), spherex_native: r2(Fs), old_matched: r2(Fo2), spherex_matched: r2(Fs2) },
    ee_median_diff: quals.length ? r3(eeMed) : null, align_offset_arcsec: { median: r2(median(offs)), p90: r2(percentile(offs, 90)) },
    lead_shift_arcsec: flO && flS ? r2(Math.hypot(flO.x - flS.x, flO.y - flS.y) * PIX) : null,
    display: { crop_arcmin: r2(CROP * PIX / 60), stretch: { kind: 'asinh10', lo, hi }, lead_ratio_from_png: disp.lead_ratio_from_display,
      masked_pixels_in_crop: disp.masked_pixels_in_crop, field_stars_read_back: disp.field_stars_read_back, field_ratio_from_png: disp.field_ratio_from_display },
    background: { method, fit_scale: r3(a), fit_offset: +cc.toFixed(4), block_corr: r3(corr), before: strip(before), after_linear: strip(lin), after: strip(after),
      grain_old: r3(gO / rng), grain_spherex: r3(gS / rng), grain_rule_applied: grainRule, grey_levels: { before: gdiff(owUnmatched), after: gdiff(ow) },
      threshold: { median_diff: T.BG_MED, rms_diff: T.BG_RMS, unit: 'fraction of the SPHEREx crop background range p5-p95' } },
    old: metaO, spherex: { ...metaS, inputs: undefined }, spherex_inputs: metaS.inputs,
    // for drawing and for the displayed-pixel checks (E4): not part of the science report
    frames: { ow: Float32Array.from(ow), sw: Float32Array.from(sw) },
    info: { F, quals: quals.map(q => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) })), smask: packBits(smask) },
  };
}

// a mask as base64 bits (for the page to hand the displayed-pixel test, and the bake)
export function packBits(m) {
  const b = new Uint8Array(Math.ceil(m.length / 8)); for (let k = 0; k < m.length; k++) if (m[k]) b[k >> 3] |= 1 << (k & 7);
  let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s);
}
export function unpackBits(s, n = NN) { const b = Uint8Array.from(atob(s), c => c.charCodeAt(0)), m = new Uint8Array(n); for (let k = 0; k < n; k++) m[k] = (b[k >> 3] >> (k & 7)) & 1; return m; }

// ---------------- what the page says: a state per band, from the checks ----------------
// ok, or why not: footprint and spectral coverage make the comparison unavailable; the science checks make it inconclusive.
// (The showcase's expectation is the evaluator's, never the page's.)
const UNAVAILABLE = ['old_footprint', 'spherex_footprint', 'spectral_coverage_at_lead', 'band_match'];
export function stateOf(rep) {
  const failed = Object.entries(rep.checks).filter(([, v]) => !v).map(([k]) => k);
  if (failed.some(k => UNAVAILABLE.includes(k))) return { state: 'comparison-unavailable', failed };
  if (failed.length) return { state: 'inconclusive', failed };
  return { state: 'ok', failed };
}
// IAU-style name from the position, rounded: J053604.34-063439.0
export function designation(ra, dec) {
  const cs = Math.round(((ra % 360) + 360) % 360 / 15 * 3600 * 100) % (24 * 3600 * 100), ds = Math.round(Math.abs(dec) * 3600 * 10);
  const p = (v, n) => String(v).padStart(n, '0');
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = cs % 6000;
  const d = Math.floor(ds / 36000), dm = Math.floor(ds / 600) % 60, dsec = ds % 600;
  return `J${p(h, 2)}${p(m, 2)}${p(Math.floor(s / 100), 2)}.${p(s % 100, 2)}${dec < 0 ? '-' : '+'}${p(d, 2)}${p(dm, 2)}${p(Math.floor(dsec / 10), 2)}.${dsec % 10}`;
}
