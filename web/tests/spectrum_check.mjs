// The Spectrum card's measuring rules (live/cutout.js starMeasure, live/spectrum.js csv), on made-up pixels:
// a clean star measures what was put in, a flagged pixel near the circle makes it doubtful (hollow) at the same flux,
// a mostly flagged circle is a gap (never a zero), an edge is doubtful, and the CSV has one row per point.
// --live also measures one real exposure from NASA's S3 copy and compares it with astropy (bake/spectrum_golden.py,
// web/tests/spectrum_golden.json): within 2%.
// Run: node web/tests/spectrum_check.mjs [--live]
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { starMeasure, starLight, mask, pool, R_AP } from '../live/cutout.js';
import { csv } from '../live/spectrum.js';
import { imagesOf } from '../live/images.js';
import { imageHeader } from '../live/fits.js';

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); fail += !ok; };
const W = 31, cx = 15.3, cy = 14.8;   // cutout.js's window (R_OUT + 1 each side of the centre pixel), star a little off it
const window_ = (fn) => { const t = new Float64Array(W * W), flag = new Array(W * W).fill(0), v = new Array(W * W).fill(1);
  for (let k = 0; k < W * W; k++) t[k] = 10 + (Math.hypot(k % W - cx, Math.floor(k / W) - cy) <= R_AP ? 2 : 0);
  fn?.(t, flag, v); return [t, { flag, var: v }]; };
const inCircle = Array.from({ length: W * W }, (_, k) => k).filter(k => Math.hypot(k % W - cx, Math.floor(k / W) - cy) <= R_AP);

const clean = starMeasure(...window_(), cx, cy);
check(!clean.gap && !clean.doubt && Math.abs(clean.flux - 2 * inCircle.length) < 1e-9 && Math.abs(clean.noise - Math.sqrt(inCircle.length)) < 1e-9,
  `clean star: flux ${clean.flux} (put in ${2 * inCircle.length}), noise ${clean.noise.toFixed(3)}, not doubtful`);
const two = starMeasure(...window_((t, flag) => { for (const k of inCircle.slice(0, 2)) { t[k] = NaN; flag[k] = 1 << 1; } }), cx, cy);
check(!two.gap && /2 flagged pixels.*overflow/.test(two.doubt) && Math.abs(two.flux - clean.flux) < 1e-9,
  `2 saturated pixels in the circle: same flux, doubtful (hollow): "${two.doubt}"`);
const most = starMeasure(...window_((t, flag) => { for (const k of inCircle.slice(0, 10)) { t[k] = NaN; flag[k] = 1 << 1; } }), cx, cy);
check(most.gap && most.flux === undefined, `10 of ${inCircle.length} unusable: a gap with a reason, no flux: "${most.gap}"`);
for (const [bit, name] of [[25, 'streak'], [27, 'snowball'], [28, 'halo'], [29, 'saturated halo']]) {
  const flagged = n => starMeasure(...window_((t, flag) => {
    for (const k of inCircle.slice(0, n)) { flag[k] = 1 << bit; t[k] = mask(t[k], flag[k]); }
  }), cx, cy);
  const few = flagged(2), all = flagged(inCircle.length);
  check(!few.gap && few.doubt.includes(name) && Math.abs(few.flux - clean.flux) < 1e-9 && all.gap?.includes(name) && all.flux === undefined,
    `${name}: two flagged pixels name the doubt; a fully flagged aperture is a gap`);
}
for (const bit of [19, 21]) check(mask(12, 1 << bit) === 12, `bit ${bit} keeps source light`);
const edge = starMeasure(...window_((t, flag) => { for (let k = 0; k < W * W; k++) if (k % W > 27) { t[k] = NaN; flag[k] = -1; } }), cx, cy);
check(!edge.gap && /edge/.test(edge.doubt) && Math.abs(edge.flux - clean.flux) < 1e-9, `ring partly off the detector: doubtful, "${edge.doubt}"`);

const pts = [clean, two].map((m, n) => ({ lam: 1 + n, bw: 0.02, det: 'D2', ch: 18 + n, flux: m.flux, err: m.noise, doubt: m.doubt, obs: 'x', t: 60900, x: 1, y: 2 }));
const rows = csv(pts).trim().split('\n');
check(rows.length === pts.length + 1 && rows[2].includes(',doubtful,"2 flagged'), `CSV: a header and ${pts.length} rows, the doubtful one says why`);

// Exercise the channel retry loop offline with download errors, measurement gaps and a usable exposure.
const spectrumSource = readFileSync(new URL('../live/spectrum.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
for (const [results, attempts, measured] of [
  [['error', 'error', 'good'], 3, true], [['gap', 'error', 'good'], 3, true],
  [['gap', 'error', 'gap', 'good'], 3, false], [['error', 'error', 'error', 'good'], 4, true],
  [['error', 'error', 'error', 'error', 'good'], 4, false],
]) {
  let tried = 0;
  const measure = runInNewContext(`${spectrumSource}\nspectrum`, {
    pool, imagesOf, CHANNELS: [{ n: 0, detector: 'D1', lo: 1, hi: 2, um: 1.5 }],
    fetch: async u => ({ ok: true, json: async () => ({ images: u.includes('det=D1&') ? results.map((_, k) => ({ key: `${k}`, t: k })) : [] }) }),
    imageHeader: async () => ({}), worldToPix: () => [100, 100], wavelengthAt: () => [1.5, 0.02],
    starLight: async e => {
      tried++;
      if (results[+e.key] === 'error') throw new Error('download failed');
      return results[+e.key] === 'gap' ? { gap: 'flagged aperture' } : { flux: 10, noise: 1 };
    },
  });
  const r = await measure(0, 0, { maps: {} });
  check(tried === attempts && r.points.length === +measured && r.gaps.length === +!measured,
    `channel retries ${results.join(', ')}: ${tried} attempts, ${r.points.length} measurement(s)`);
}

if (process.argv.includes('--live')) {
  const gold = JSON.parse(readFileSync(new URL('spectrum_golden.json', import.meta.url)));
  const h = await imageHeader(gold.key);
  for (const s of gold.stars) {
    const m = await starLight({ key: gold.key, h }, s.ra, s.dec);
    const df = Math.abs(m.flux / s.flux - 1), dn = Math.abs(m.noise / s.noise - 1);
    check(df < 0.02 && dn < 0.02 && Math.hypot(m.x - s.x, m.y - s.y) < 0.01,
      `${s.name}: browser ${m.flux.toFixed(3)} ± ${m.noise.toFixed(4)}, astropy ${s.flux.toFixed(3)} ± ${s.noise.toFixed(4)} (flux ${(100 * df).toFixed(3)}%, noise ${(100 * dn).toFixed(3)}% apart; pixel ${m.x.toFixed(3)},${m.y.toFixed(3)} vs ${s.x.toFixed(3)},${s.y.toFixed(3)})`);
  }
}
if (fail) { console.log(`${fail} failed`); process.exit(1); }
