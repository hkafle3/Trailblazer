// Web Worker: builds a time-lapse for any RA/Dec in the browser, the same way bake/flipbook.py does in Python.
// in:  {id, ra, dec, det, api}     out: {id, type:'progress'|'frame'|'done'|'empty'|'error', ...}
// The worker stays alive between builds. A new message replaces the build in flight (one with no ra only stops it), and
// a build for a spot the listed images still cover reuses the list, their headers and the rows already read.
// Each visit becomes one frame: exposures at one matched wavelength, reprojected north up, median combined.
import { imageHeader, imageRows, worldToPix, wavelengthAt } from './fits.js';

// 3 sigma: the user typed the spot, so this is detection at a known position. At 5 sigma WISE 0855 kept only
// 2 of 4 visits and its fitted motion went to 18 "/yr; at 3 it keeps 4 and measures 6.45 (published 8.1).
const SNR_MIN = Number(new URLSearchParams(self.location.search).get('snr') || 3);
const GRID = 144, PIX = 5.0, PER_VISIT = 3, MAX_PER_VISIT = 30, SIZE = 2040, D2R = Math.PI / 180;

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

// Rows y0..y1 of one exposure, kept between builds: a re-centre a little way off reads only the strip it lacks.
// A block that would pass 600 rows (5 MB) starts again from the rows asked for. At most ROWS_KEPT exposures are kept,
// the least recently used dropped first (a re-centre can pick other exposures of a visit, at the new wavelength).
const rowCache = new Map(), ROWS_KEPT = 48;
async function rows(e, y0, y1, signal) {
  const read = (a, b) => imageRows(e.key, e.h, a, b, signal);
  const join = (a, b) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  let c = rowCache.get(e.key);
  if (!c || y0 > c.y1 + 1 || y1 < c.y0 - 1 || Math.max(y1, c.y1) - Math.min(y0, c.y0) > 600) c = { y0, y1, px: await read(y0, y1) };
  else {
    if (y0 < c.y0) c = { y0, y1: c.y1, px: join(await read(y0, c.y0 - 1), c.px) };
    if (y1 > c.y1) c = { y0: c.y0, y1, px: join(c.px, await read(c.y1 + 1, y1)) };
  }
  rowCache.delete(e.key); rowCache.set(e.key, c);   // Map order is use order
  if (rowCache.size > ROWS_KEPT) rowCache.delete(rowCache.keys().next().value);
  return c;
}

// one exposure -> GRID x GRID normalized frame (FITS row order, bottom row first), bilinear like reproject_interp
async function reproject(e, ra, dec, signal) {
  const map = [];
  for (let iy = 0; iy < GRID; iy++) for (let ix = 0; ix < GRID; ix++) map.push(worldToPix(e.h, ...gridWorld(ra, dec, ix, iy)));
  const ys = map.filter(Boolean).map(p => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys)) + 1);
  if (y0 > y1) return null;
  const c = await rows(e, y0, y1, signal);
  const at = (x, y) => (x < 0 || y < c.y0 || x >= SIZE || y > c.y1) ? NaN : c.px[(y - c.y0) * SIZE + x];
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
// the distinct moments in a visit: exposures less than 0.05 day (1.2 h) apart count as one, for the catalog check
// (a visit spans days, and a known asteroid crosses the patch in hours, so one time per visit would miss it)
const epochs = ts => {
  const g = [];
  for (const t of [...ts].sort((a, b) => a - b)) (g.length && t - g.at(-1).at(-1) < 0.05) ? g.at(-1).push(t) : g.push([t]);
  return g.map(x => +(x.reduce((a, b) => a + b, 0) / x.length).toFixed(4));
};

// kept between builds: the latest request, the last image list (visits of images with their headers), the wavelength
// maps, and the Gaia stars around the last spot asked
let cur, stop = null, list = null, mapsP = null, gaiaAt = null;

self.onmessage = async ({ data: { id, ra, dec, det, api } }) => {
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
    let usable = list?.det === det ? list.visits.map(here).filter(v => v.length) : [];
    if (!usable.length) {
      // v=2: a browser may still hold a failed search that the old Worker let it cache for a day (2026-11-14)
      const res = await fetch(`${api}/api/images?ra=${ra}&dec=${dec}&det=${det}&v=2`, { signal });
      const found = await res.json();
      alive();
      if (!res.ok) return post({ type: 'error', error: found.error || `HTTP ${res.status}` });
      if (!found.images.length) return post({ type: 'empty' });
      const vs = visits(found.images).map(v => v.slice(0, MAX_PER_VISIT));
      post({ type: 'progress', text: `${found.images.length} images in ${vs.length} visits; reading where the target falls in each`, ms: performance.now() - t0 });
      const had = new Map((list?.visits.flat() || []).map(e => [e.key, e.h]));   // headers the last list already read
      let done = 0;
      await pool(vs.flat(), 8, async e => {
        e.h = had.get(e.key) ?? await imageHeader(e.key, signal);
        alive();
        if (++done % 10 === 0) post({ type: 'progress', text: `read ${done} of ${vs.flat().length} image headers` });
      });
      usable = vs.map(here);
      list = { det, visits: vs.filter((_, k) => usable[k].length) };
      usable = usable.filter(v => v.length);
      const keep = new Set(vs.flat().map(e => e.key));
      for (const k of rowCache.keys()) if (!keep.has(k)) rowCache.delete(k);
    }
    if (!usable.length) return post({ type: 'empty' });
    const { lam0, tol, picked } = match(usable);

    // Gaia: the star at this spot, propagated from 2016.0 to the target epoch (2026.0).
    // The Worker answers with every 2016 position within 144" of the spot asked. A re-centre within 100" of the last
    // spot tries those stars first and waits for its own answer (1.5 s, or 20 s on a slow IRSA day) only when none
    // fits: a fast star's 2016 position can sit 100" from where it is now (Barnard's Star), outside the old cone.
    // The request still starts now, beside the frames, and its answer is dropped when the cached stars fit: waiting to
    // ask until they fail cost re-centres about 2 s (the Worker caches /api/gaia for a day, so the extra ask is cheap).
    const cached = gaiaAt && Math.hypot((gaiaAt.ra - ra) * Math.cos(dec * D2R), gaiaAt.dec - dec) * 3600 <= 100 ? gaiaAt.stars : [];
    const gaiaP = fetch(`${api}/api/gaia?ra=${ra}&dec=${dec}&v=3`, { signal })   // v=3: Gaia from IRSA; drops answers cached before the switch
     .then(r => r.ok ? r.json() : null).catch(() => null).then(g => { if (g?.stars) gaiaAt = { ra, dec, stars: g.stars }; return g?.stars || []; });

    const frames = [];
    for (const [n, v] of picked.entries()) {
      const arrs = (await pool(v, 3, e => reproject(e, ra, dec, signal))).filter(Boolean);
      alive();
      const stack = new Float32Array(GRID * GRID).map((_, k) => median(arrs.map(a => a[k])));
      const ts = v.map(e => e.t), mjd = ts.reduce((a, b) => a + b, 0) / ts.length;
      frames.push({ px: stack, start: date(Math.min(...ts)), end: date(Math.max(...ts)), mjd, epochs: epochs(ts), year: year(mjd), exposures: arrs.length,
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
    post({ type: 'error', error: String(err.message || err) });   // not sent for a build that was replaced
  }
};
