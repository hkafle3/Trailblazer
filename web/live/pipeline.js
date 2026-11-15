// Web Worker: builds a time-lapse for any RA/Dec in the browser, the same way bake/flipbook.py does in Python.
// in:  {ra, dec, det, api}     out: {type:'progress'|'frame'|'done'|'empty'|'error', ...}
// Each visit becomes one frame: exposures at one matched wavelength, reprojected north up, median combined.
import { imageHeader, imageRows, worldToPix, wavelengthAt } from './fits.js';

// 3 sigma: the user typed the spot, so this is detection at a known position. At 5 sigma WISE 0855 kept only
// 2 of 4 visits and its fitted motion went to 18 "/yr; at 3 it keeps 4 and measures 6.45 (published 8.1).
const SNR_MIN = Number(new URLSearchParams(self.location.search).get('snr') || 3);
const GRID = 144, PIX = 5.0, PER_VISIT = 3, MAX_PER_VISIT = 30, SIZE = 2040, D2R = Math.PI / 180;
const post = (m, transfer) => self.postMessage(m, transfer || []);

async function pool(items, n, fn) {   // run fn over items, at most n at a time (polite to S3)
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// A visit is a run of images with no gap over `gap` days. The deep fields (ecliptic poles) are photographed every few
// days all year, so a visit also ends after `span` days, and only `most` visits, spread over the whole record, are kept.
function visits(imgs, gap = 20, span = 14, most = 8) {
  const out = [];
  for (const x of imgs) (out.length && x.t - out.at(-1).at(-1).t <= gap && x.t - out.at(-1)[0].t <= span) ? out.at(-1).push(x) : out.push([x]);
  return out.length <= most ? out : Array.from({ length: most }, (_, k) => out[Math.round(k * (out.length - 1) / (most - 1))]);
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

// one exposure -> GRID x GRID normalized frame (FITS row order, bottom row first), bilinear like reproject_interp
async function reproject(e, ra, dec) {
  const map = [];
  for (let iy = 0; iy < GRID; iy++) for (let ix = 0; ix < GRID; ix++) map.push(worldToPix(e.h, ...gridWorld(ra, dec, ix, iy)));
  const ys = map.filter(Boolean).map(p => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  if (y0 > y1) return null;
  const rows = await imageRows(e.key, e.h, y0, y1);
  const at = (x, y) => (x < 0 || y < y0 || x >= SIZE || y > y1) ? NaN : rows[(y - y0) * SIZE + x];
  const out = new Float32Array(GRID * GRID);
  map.forEach((p, k) => {
    if (!p) { out[k] = NaN; return; }
    const [x, y] = p, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const v = (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy;
    out[k] = Number.isFinite(v) ? v : NaN;   // any NaN neighbour (saturated, off the edge) stays NaN
  });
  const med = median(Array.from(out)), mad = median(Array.from(out, v => Math.abs(v - med))) * 1.4826 || 1;
  return out.map(v => (v - med) / mad);
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

self.onmessage = async ({ data: { ra, dec, det, api } }) => {
  try {
    const t0 = performance.now();
    const res = await fetch(`${api}/api/images?ra=${ra}&dec=${dec}&det=${det}`);
    const found = await res.json();
    if (!res.ok) return post({ type: 'error', error: found.error || `HTTP ${res.status}` });
    if (!found.images.length) return post({ type: 'empty' });
    const maps = await fetch(new URL('../data/wavemaps.json', import.meta.url)).then(r => r.json());
    if (!maps[det]) return post({ type: 'error', error: `no wavelength map for ${det} yet` });
    const vs = visits(found.images).map(v => v.slice(0, MAX_PER_VISIT));
    post({ type: 'progress', text: `${found.images.length} images in ${vs.length} visits; reading where the target falls in each`, ms: performance.now() - t0 });

    let done = 0;
    await pool(vs.flat(), 8, async e => {
      e.h = await imageHeader(e.key);
      const p = worldToPix(e.h, ra, dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1) [e.lam, e.bw] = wavelengthAt(maps[det], p[0], p[1]);
      if (++done % 10 === 0) post({ type: 'progress', text: `read ${done} of ${vs.flat().length} image headers` });
    });
    const usable = vs.map(v => v.filter(e => e.lam != null)).filter(v => v.length);
    if (!usable.length) return post({ type: 'empty' });
    const { lam0, tol, picked } = match(usable);

    // Gaia, fetched while frames build: the star at this spot, propagated from 2016.0 to the target epoch (2026.0)
    const gaiaP = fetch(`${api}/api/gaia?ra=${ra}&dec=${dec}`).then(r => r.ok ? r.json() : null).catch(() => null).then(g => g?.stars || []);

    const frames = [];
    for (const [n, v] of picked.entries()) {
      const arrs = (await pool(v, 3, e => reproject(e, ra, dec))).filter(Boolean);
      const stack = new Float32Array(GRID * GRID).map((_, k) => median(arrs.map(a => a[k])));
      const ts = v.map(e => e.t), mjd = ts.reduce((a, b) => a + b, 0) / ts.length;
      frames.push({ px: stack, start: date(Math.min(...ts)), end: date(Math.max(...ts)), mjd, year: year(mjd), exposures: arrs.length,
        lam: v.reduce((s, e) => s + e.lam, 0) / v.length, lam_spread: Math.max(...v.map(e => Math.abs(e.lam - lam0))),
        matched: Math.max(...v.map(e => Math.abs(e.lam - lam0))) <= tol, bw: v.reduce((s, e) => s + e.bw, 0) / v.length });
      post({ type: 'frame', n, of: picked.length, ms: performance.now() - t0 });
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
    let gaia = null, bestOff = Infinity;
    for (const s of seen.length ? await gaiaP : []) {
      const off = seen.reduce((a, f) => { const [e, n] = pred(s, f); return a + Math.hypot(e - f.east, n - f.north); }, 0) / seen.length;
      if (off < bestOff) { bestOff = off; gaia = s; }
    }
    if (gaia && bestOff <= slack) frames.forEach(f => { [f.pred_east, f.pred_north] = pred(gaia, f); });
    else gaia = null;
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
      grid: GRID, arcsec_per_pixel: PIX, lam0, lam_tol: tol, stretch: { lo: q(0.05), hi: q(0.997) }, motion,
      gaia: gaia ? { pmra: gaia.pmra, pmdec: gaia.pmdec, g: gaia.g, total: Math.hypot(gaia.pmra, gaia.pmdec) / 1000 } : null,
      frames } });
  } catch (err) {
    post({ type: 'error', error: String(err.message || err) });
  }
};
