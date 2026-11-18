// Click a star, get its spectrum (timelapse.html, the Spectrum card). SPHEREx's filters change wavelength across each
// detector, so one spot on the sky is seen at a different wavelength in every exposure that covers it, and on six
// detectors at once (0.75 to 5 µm). The spot's light in enough exposures is its spectrum: here, the exposure nearest
// the middle of each of the 102 channels (live/spectral.js), measured by cutout.js starLight.
import { imagesOf } from './images.js';
import { imageHeader, worldToPix, wavelengthAt } from './fits.js';
import { pool, starLight } from './cutout.js';
import { CHANNELS } from './spectral.js';

export const DETS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const SIZE = 2040, EDGE = 16;   // a spot nearer the edge than this (R_OUT + 2 pixels) has part of its sky ring off the detector
const HEADERS = 80;   // per detector at most, spread over the list: a deep field has thousands of exposures of a spot
export const MJY = (6.15 / 206265) ** 2 * 1e9;   // MJy/sr over one 6.15 arcsec pixel -> mJy

async function images(api, ra, dec, det, signal) {   // a 503 is IRSA busy behind the Worker: two more tries, 3 s apart
  for (let k = 0; ; k++) {
    const r = await fetch(`${api}/api/images?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&det=${det}&fmt=2&v=2`, { signal });
    if (r.ok) return imagesOf(await r.json());
    if (r.status !== 503 || k === 2) throw new Error(`image search ${det}: HTTP ${r.status}`);
    await new Promise(ok => setTimeout(ok, 3000));
  }
}
const spread = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, k) => a[Math.round(k * (a.length - 1) / (n - 1))]);

// (ra, dec): degrees. at(t): where the star is at MJD t (a Gaia star's motion), else it stays at (ra, dec).
// progress(text, 0..1). Returns { points, gaps, found, covering }: points are measured (flux, noise in mJy; doubt says
// why one may be off), gaps are channels with no usable exposure (never a zero).
export async function spectrum(ra, dec, { api = '', maps, signal, progress = () => {}, at = () => [ra, dec] }) {
  const lists = await Promise.all(DETS.map(d => images(api, ra, dec, d, signal).then(im => spread(im, HEADERS).map(i => ({ ...i, det: d })))));
  const all = lists.flat();
  let done = 0;
  progress(`Reading ${all.length} exposures on 6 detectors`, 0);
  const seen = (await pool(all, 8, async e => {
    const h = await imageHeader(e.key, signal).catch(err => { if (signal?.aborted) throw err; return null; });
    progress(`Reading ${++done} of ${all.length} exposure headers`, 0.4 * done / all.length);
    const p = h && worldToPix(h, ...at(e.t));
    if (!p || !(p[0] >= 0 && p[1] >= 0 && p[0] <= SIZE - 1 && p[1] <= SIZE - 1)) return null;
    const [lam, bw] = wavelengthAt(maps[e.det], p[0], p[1]);
    return { ...e, h, lam, bw, edge: Math.min(p[0], p[1], SIZE - 1 - p[0], SIZE - 1 - p[1]) >= EDGE };
  })).filter(Boolean);
  // each channel's exposures, best first: away from the edge, then nearest the channel's middle
  const chans = CHANNELS.map(c => ({ c, todo: seen.filter(e => e.det === c.detector && e.lam >= c.lo && e.lam < c.hi)
    .sort((a, b) => b.edge - a.edge || Math.abs(a.lam - c.um) - Math.abs(b.lam - c.um)) }));
  const points = [], gaps = [];
  done = 0;
  const want = chans.filter(x => x.todo.length).length;
  await pool(chans, 6, async ({ c, todo }) => {
    let why = 'no exposure at this wavelength here', gapsTried = 0;
    for (const e of todo.slice(0, 4)) {   // at most two measurement gaps; download errors only count toward the four attempts
      let m;
      try { m = await starLight(e, ...at(e.t), signal); }
      catch (err) { if (signal?.aborted) throw err; why = `could not read the exposure (${err.message})`; continue; }
      if (m.gap) { why = m.gap; if (++gapsTried === 2) break; continue; }
      points.push({ lam: e.lam, bw: e.bw, det: e.det, ch: c.n + 1, flux: m.flux * MJY, err: m.noise * MJY, doubt: m.doubt, obs: e.obs, t: e.t, x: m.x, y: m.y });
      why = null; break;
    }
    if (why) gaps.push({ lam: c.um, det: c.detector, ch: c.n + 1, why });
    if (todo.length) progress(`Measuring ${++done} of ${want} channels`, 0.4 + 0.6 * done / want);
  });
  points.sort((a, b) => a.lam - b.lam); gaps.sort((a, b) => a.lam - b.lam);
  return { points, gaps, found: all.length, covering: seen.length };
}

// one row per point, the header first
export function csv(points) {
  const rows = points.map(p => [p.lam.toFixed(4), p.bw.toFixed(4), p.det, p.ch, p.flux.toPrecision(5), p.err.toPrecision(3), p.doubt ? 'doubtful' : 'good',
    `"${(p.doubt || '').replace(/"/g, "'")}"`, p.obs, p.t.toFixed(5), p.x.toFixed(2), p.y.toFixed(2)].join(','));
  return ['wavelength_um,bandwidth_um,detector,channel,flux_mJy,error_mJy,quality,note,exposure,mjd,x_pix,y_pix', ...rows].join('\n') + '\n';
}
