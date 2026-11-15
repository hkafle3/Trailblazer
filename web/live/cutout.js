// One SPHEREx exposure cut out around a sky position, north up, plus the light measured at that position.
// For a known comet's page (comet.js): each visit's photo centred on where JPL says the comet was, so the comet stays in
// the middle and the stars slide past. The picture is drawn the way bake/comet_spectrum.py photo() draws a measured
// comet's (96 pixels of 6.15 arcsec, bilinear like reproject_interp); the light is measured on the raw pixels.
import { imageHeader, imageRows, worldToPix, wavelengthAt } from './fits.js';

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

// Circle minus ring at full-frame pixel (x, y) of rows y0.. (px, full width): { flux, noise, snr } in image units, or
// null when under 80% of the circle or 50 ring pixels are usable (an edge, saturation). The noise is the ring's own
// scatter (1.4826 x MAD, so a star in the ring does not inflate it) over the circle, plus the error of the sky level.
export function photometry(px, y0, x, y) {
  const at = (i, j) => (i < 0 || i >= SIZE || j < y0 || (j - y0) * SIZE + i >= px.length) ? NaN : px[(j - y0) * SIZE + i];
  const ap = [], ring = [];
  let full = 0;
  for (let j = Math.floor(y - R_OUT); j <= Math.ceil(y + R_OUT); j++) for (let i = Math.floor(x - R_OUT); i <= Math.ceil(x + R_OUT); i++) {
    const r = Math.hypot(i - x, j - y), v = at(i, j);
    if (r <= R_AP) { full++; if (Number.isFinite(v)) ap.push(v); }
    else if (r >= R_IN && r <= R_OUT && Number.isFinite(v)) ring.push(v);
  }
  if (ap.length < 0.8 * full || ring.length < 50) return null;
  const sky = median(ring), sig = 1.4826 * median(ring.map(v => Math.abs(v - sky)));
  const flux = ap.reduce((s, v) => s + v - sky, 0) * full / ap.length;
  const noise = sig * Math.sqrt(full + full * full * Math.PI / 2 / ring.length);
  return { flux, noise, snr: noise > 0 ? flux / noise : 0 };
}

// rows of one exposure that hold the photometry window around (ra, dec), and that window measured
export async function measureAt(key, ra, dec, signal, h) {
  h ??= await imageHeader(key, signal);
  const p = worldToPix(h, ra, dec);
  if (!p || p[0] < 0 || p[1] < 0 || p[0] > SIZE - 1 || p[1] > SIZE - 1) return null;
  const y0 = Math.max(0, Math.floor(p[1]) - R_OUT - 1), y1 = Math.min(SIZE - 1, Math.ceil(p[1]) + R_OUT + 1);
  return photometry(await imageRows(key, h, y0, y1, signal), y0, p[0], p[1]);
}

// The exposure cut to grid x grid pixels of pix arcsec about (ra, dec), north up (row 0 is north, column 0 east),
// with the light at (ra, dec) measured on the exposure's own pixels.
export async function cutout(key, ra, dec, { grid = 96, pix = 6.15, signal } = {}) {
  const h = await imageHeader(key, signal), map = [];
  for (let iy = 0; iy < grid; iy++) for (let ix = 0; ix < grid; ix++) map.push(worldToPix(h, ...gridWorld(ra, dec, ix, iy, grid, pix)));
  const p = worldToPix(h, ra, dec);
  const ys = map.filter(Boolean).map(q => q[1]).concat(p ? [p[1] - R_OUT - 1, p[1] + R_OUT + 1] : []);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  if (!p || y0 > y1) return null;
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
  const inside = p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1;
  return { px, grid, h, m: inside ? photometry(rows, y0, p[0], p[1]) : null };
}

// grey levels as bake/comet_spectrum.py photo(): 20th percentile black, asinh stretch; white at the frame's 99.5th
// percentile rather than the comet's own peak, so a comet that is not there is not drawn as one
export function paint(canvas, { px, grid }) {
  const v = Array.from(px).filter(Number.isFinite).sort((a, b) => a - b);
  const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))], lo = q(0.2), hi = q(0.995), A = Math.asinh(8);
  canvas.width = canvas.height = grid;
  const g = canvas.getContext('2d'), img = g.createImageData(grid, grid);
  for (let k = 0; k < grid * grid; k++) {
    const s = Number.isFinite(px[k]) ? Math.min(1, Math.asinh(Math.max(0, (px[k] - lo) / (hi - lo)) * 8) / A) : 0;
    img.data.set([255 * s, 255 * s, 255 * s, 255], 4 * k);
  }
  g.putImageData(img, 0, 0);
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
// 5 days earlier or later (the comet elsewhere), at the nearest wavelengths (a star's brightness changes with it):
// of up to REF_LOOK of those photos, the REF_USE nearest in wavelength, their median.
// verdict: 'seen' (that difference at SNR 5 or more), 'faint' (under 5), 'unmeasured' (an edge, saturation, or no
// other photo of the spot to compare with).
const REF_LOOK = 8, REF_USE = 3;
let mapsP = null;
const wavemap = () => (mapsP ??= fetch(new URL('../data/wavemaps.json', import.meta.url)).then(r => r.json()).then(m => m.D1).catch(e => { mapsP = null; throw e; }));
export async function pool(items, n, fn) {   // fn over items, at most n at a time
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
export async function knownPhoto(s, { api = '', signal, maps } = {}) {
  let r;   // a 503 is IRSA busy behind the Worker (when the sky index cannot answer): two more tries, 3 s apart
  for (let k = 0; ; k++) {
    r = await fetch(`${api}/api/images?ra=${s.ra.toFixed(4)}&dec=${s.dec.toFixed(4)}&det=D1&v=2`, { signal });
    if (r.status !== 503 || k === 2) break;
    await new Promise(ok => setTimeout(ok, 3000));
  }
  if (!r.ok) throw new Error(`image search: HTTP ${r.status}`);
  const { images } = await r.json(), img = images.find(i => i.obs === s.obs);
  if (!img) throw new Error(`${s.obs} is not in the image search`);
  const [c, map] = await Promise.all([cutout(img.key, s.ra, s.dec, { signal }), maps ?? wavemap()]);
  if (!c) throw new Error(`${s.obs} does not cover the comet`);
  const lamAt = h => { const p = worldToPix(h, s.ra, s.dec); return p && p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1 ? wavelengthAt(map, p[0], p[1])[0] : NaN; };
  const lam = lamAt(c.h), away = images.filter(i => Math.abs(i.t - img.t) > 5);
  const look = away.length <= REF_LOOK ? away : Array.from({ length: REF_LOOK }, (_, k) => away[Math.round(k * (away.length - 1) / (REF_LOOK - 1))]);
  const hs = await pool(look, 4, i => imageHeader(i.key, signal));
  const near = look.map((i, k) => ({ ...i, h: hs[k], lam: lamAt(hs[k]) })).filter(i => Number.isFinite(i.lam))
    .sort((a, b) => Math.abs(a.lam - lam) - Math.abs(b.lam - lam)).slice(0, REF_USE);
  const refs = (await pool(near, 3, i => measureAt(i.key, s.ra, s.dec, signal, i.h))).filter(Boolean);
  let snr = null;
  if (c.m && refs.length) {
    const ref = median(refs.map(x => x.flux)), refNoise = median(refs.map(x => x.noise)) * 1.25 / Math.sqrt(refs.length);   // a median's error: 1.25 sigma / sqrt(n)
    snr = (c.m.flux - ref) / Math.hypot(c.m.noise, refNoise);
  }
  const verdict = snr == null ? 'unmeasured' : snr >= SNR_SEEN ? 'seen' : 'faint';
  return { ...c, t: img.t, key: img.key, lam, snr, verdict, refs: refs.length, refLam: near.map(i => i.lam) };
}
