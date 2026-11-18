// E5 port parity for "Then and now" (web/live/blink.js against comet-hunt-work/phase2-plan/scripts/build_v3.py) and E3
// (the five mutations must fail). Not science validation: it catches porting bugs. Both run on identical inputs, the
// reference's own: the SPHEREx cutouts of lead-check/cache/L1 and the old-survey tiles of phase2-plan/raw_v2, exported by
// comet-hunt-work/phase2-build/scripts/dump_ref.py (with the reference's arrays and astropy's pixel positions).
//   - WCS: every input, 100 grid pixels, within 0.05" of astropy (SPHEREx: the interpolated map the pipeline uses)
//   - the synthesized SPHEREx image: rms difference within 2% of the reference image's p1-p99 range, masks the same
//   - the numbers within 5% of build_v3.py, every check the same, and each mutation FAILS
// Fixtures: bake/blink_ref/make_fixtures.py makes them from scratch (IRSA, S3, SVO, then build_v3.py), or exports them from
// inputs already on disk. Missing fixtures FAIL this test: it is the gate for the port, never skipped.
// Run: node web/tests/blink_parity.mjs [fixtures dir]   (or BLINK_FIXTURES=<dir>; default: Ed's phase2-build folder)
import { readFileSync, existsSync } from 'node:fs';
import * as B from '../live/blink.js';
import { parseCards } from '../live/fits.js';

const DIR = process.argv[2] || process.env.BLINK_FIXTURES || '/Users/edkiboma/Projects/comet-hunt-work/phase2-build';
const RAW = process.env.BLINK_RAW || (existsSync(`${DIR}/fixtures/source.json`) ? JSON.parse(readFileSync(`${DIR}/fixtures/source.json`)).raw : '/Users/edkiboma/Projects/comet-hunt-work/phase2-plan/raw_v2');
const need = [`${DIR}/fixtures/spx/index.json`, `${DIR}/fixtures/wcs.json`, `${DIR}/ref/checks.json`, `${DIR}/ref/mutations.json`, `${DIR}/ref/W2/synth.f64`, `${RAW}/allwise_W2_int.fits`];
const missing = need.filter(f => !existsSync(f));
if (missing.length) {
  console.log(`FAIL blink_parity: fixtures missing (${missing.join(', ')}). Make them with bake/blink_ref/make_fixtures.py --out <dir>, then BLINK_FIXTURES=<dir>.`);
  process.exit(1);
}
const RA = 84.01808, DEC = -6.5775;
const HERE = new URL('..', import.meta.url).pathname;
const bands = JSON.parse(readFileSync(`${HERE}data/bands.json`)), waves = JSON.parse(readFileSync(`${HERE}data/wavemaps.json`));
const enc = new TextEncoder();
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const f64 = p => new Float64Array(readFileSync(p).buffer.slice(0));

const grid = B.makeGrid(RA, DEC);
const idx = JSON.parse(readFileSync(`${DIR}/fixtures/spx/index.json`));
const exps = idx.map(e => {
  const buf = readFileSync(`${DIR}/fixtures/spx/${e.name}.bin`), n = e.w * e.h;
  return { ...e, head: parseCards(enc.encode(e.hdr)).h, img: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 4 * n)), flg: new Int32Array(buf.buffer.slice(buf.byteOffset + 4 * n, buf.byteOffset + 8 * n)) };
});
const fitsOf = f => B.readFits(new Uint8Array(readFileSync(`${RAW}/${f}`)), parseCards);

// ---------- WCS against astropy ----------
const W = JSON.parse(readFileSync(`${DIR}/fixtures/wcs.json`));
const N = B.N, sample = (map, k) => [map.px[k], map.py[k]];
const ks = W.ra.map((ra, i) => { let best = 0, bd = Infinity; for (let k = 0; k < N * N; k++) { const d = (grid.ra[k] - ra) ** 2 + (grid.dec[k] - W.dec[i]) ** 2; if (d < bd) { bd = d; best = k; } } return best; });
let worst = { arcsec: 0 };
for (const [name, ref] of Object.entries(W.files)) {
  const spx = exps.find(e => e.name === name);
  const h = spx ? spx.head : parseCards(new Uint8Array(readFileSync(`${RAW}/${name}`))).h;
  const map = spx ? B.spherexMap(h, grid) : B.sinMap(h, grid);
  const scale = spx ? 6.15 : Math.abs(h.CDELT1) * 3600;
  ks.forEach((k, i) => {
    const [x, y] = sample(map, k), d = Math.hypot(x - ref.px[i], y - ref.py[i]) * scale;
    if (!(d <= worst.arcsec)) worst = { arcsec: d, name, i };
  });
}
ok(worst.arcsec <= 0.05, `WCS: ${Object.keys(W.files).length} inputs x 100 pixels, worst ${worst.arcsec.toExponential(2)}" from astropy (${worst.name})`);

// ---------- the pipeline on the reference's inputs ----------
function synth(band, dets) {
  const acc = B.synthStart(bands[band], dets);
  for (const e of exps) if (dets.includes(e.det)) B.synthAdd(acc, { det: e.det, t: e.t, key: e.key, sha256: null, img: e.img, flg: e.flg, w: e.w, h: e.h, x0: e.x0, y0: e.y0, map: B.spherexMap(e.head, grid) }, waves[e.det]);
  return B.synthEnd(acc, band);
}
const wise = band => B.oldWise(fitsOf(`allwise_${band}_int.fits`), fitsOf(`allwise_${band}_cov.fits`), grid, []);
const twomass = only => B.old2mass(['2mass_Ks_001126_ki1020021.fits', '2mass_Ks_001126_ki1020033.fits', '2mass_Ks_001126_ki1030244.fits', '2mass_Ks_001126_ki1030256.fits',
  '2mass_Ks_001126_ki1040021.fits', '2mass_Ks_001126_ki1040033.fits'].filter(f => !only || f.includes(only)).map(f => ({ name: f, fits: fitsOf(f) })), grid, []);

const REF = JSON.parse(readFileSync(`${DIR}/ref/checks.json`)), MUT = JSON.parse(readFileSync(`${DIR}/ref/mutations.json`));
const t0 = Date.now(), sp = {}, olds = { Ks: twomass(), W1: wise('W1'), W2: wise('W2') };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);
const out = {};
for (const band of ['Ks', 'W1', 'W2']) {
  const t1 = Date.now();
  sp[band] = synth(band, B.PAIRS[band].dets);
  // the synthesized image against the reference's
  const ref = f64(`${DIR}/ref/${band}/synth.f64`), rm = f64(`${DIR}/ref/${band}/synth_m.f64`), s = sp[band];
  let diff2 = 0, n = 0, maskSame = 0; const vals = [];
  for (let k = 0; k < N * N; k++) { maskSame += (!!s.m[k]) === (rm[k] > 0); if (s.m[k] && rm[k] > 0) { diff2 += (s.img[k] - ref[k]) ** 2; n++; vals.push(ref[k]); } }
  const rng = B.percentile(vals, 99) - B.percentile(vals, 1), rms = Math.sqrt(diff2 / n) / rng;
  ok(rms <= 0.02 && maskSame === N * N, `${band} synthesized image: rms ${(100 * rms).toExponential(2)}% of the range, masks agree on ${maskSame}/${N * N}`);
  const ro = f64(`${DIR}/ref/${band}/old.f64`); let od = 0, on = 0; const ov = [];
  for (let k = 0; k < N * N; k++) if (Number.isFinite(ro[k]) && Number.isFinite(olds[band].img[k])) { od += (olds[band].img[k] - ro[k]) ** 2; on++; ov.push(ro[k]); }
  const orms = Math.sqrt(od / on) / (B.percentile(ov, 99) - B.percentile(ov, 1));
  ok(orms <= 0.02, `${band} old survey on the grid: rms ${(100 * orms).toExponential(2)}% of the range`);
  const r = out[band] = B.pair(band, olds[band], sp[band]), R = REF[band];
  console.log(`   ${band}: ${((Date.now() - t1) / 1000).toFixed(1)} s, ratio ${r.lead_ratio} (ref ${R.lead_ratio}), z ${r.lead_z_vs_field} (${R.lead_z_vs_field}), stars ${r.qualified_stars} (${R.qualified_stars}), scatter ${r.field_scatter_robust_sigma} (${R.field_scatter_robust_sigma}), bg ${r.background.method}`);
  const nums = [['lead_ratio', r.lead_ratio, R.lead_ratio], ['scale', r.scale, R.scale], ['validation_median', r.validation_median, R.validation_median],
    ['field_scatter', r.field_scatter_robust_sigma, R.field_scatter_robust_sigma, 0.10], ['z', r.lead_z_vs_field, R.lead_z_vs_field, 0.10],
    ['qualified_stars', r.qualified_stars, R.qualified_stars, 0.10], ['fwhm old matched', r.fwhm_arcsec.old_matched, R.fwhm_arcsec.old_matched],
    ['fwhm spherex matched', r.fwhm_arcsec.spherex_matched, R.fwhm_arcsec.spherex_matched], ['stretch hi', r.display.stretch.hi, R.display.stretch.hi],
    ['lead ratio from display', r.display.lead_ratio_from_png, R.display.lead_ratio_from_png], ['spherex valid fraction', r.spherex.valid_fraction, R.spherex.valid_fraction],
    ['covered weight at lead', r.spherex.covered_weight_at_lead, R.spherex.covered_weight_at_lead], ['old valid fraction', r.old.valid_fraction, R.old.valid_fraction]];
  for (const [k, a, b, tol = 0.05] of nums) ok(near(a, b, tol), `${band} ${k} ${a} vs ${b}${tol !== 0.05 ? ` (within ${100 * tol}%: a count or a scatter of a few stars)` : ''}`);
  ok(r.spherex.exposures_used === R.spherex.exposures_used && r.spherex.exposures_at_lead === R.spherex.exposures_at_lead && JSON.stringify(r.spherex.dates_at_lead) === JSON.stringify(R.spherex.dates_at_lead),
    `${band} SPHEREx exposures ${r.spherex.exposures_used}/${r.spherex.exposures_at_lead} at the star, ${r.spherex.dates_at_lead}`);
  const want = { ...R.checks }, got = { ...r.checks, lead_expectation: r.expectation };
  const differ = Object.keys(want).filter(k => want[k] !== got[k]);
  ok(!differ.length && r.passed === R.passed, `${band} every check as the reference (${r.passed ? 'PASS' : 'FAIL'})${differ.length ? `, differs: ${differ}` : ''}`);
  ok(r.background.method === R.background.method && r.background.grain_rule_applied === R.background.grain_rule_applied, `${band} background: ${r.background.method}, after ${JSON.stringify(r.background.after)} (ref ${JSON.stringify(R.background.after)})`);
}

// ---------- E3: the mutations must FAIL ----------
const muts = {
  'swapped_bands (AllWISE W1 shown as the W2 pair)': () => B.pair('W2', olds.W1, sp.W2),
  'W2 without D6': () => B.pair('W2', olds.W2, synth('W2', ['D5'])),
  'display scale x1.15': () => B.pair('W2', olds.W2, sp.W2, { displayScale: 1.15 }),
  'unmatched background (display)': () => B.pair('W2', olds.W2, sp.W2, { matchBg: false }),
  'clipped 2MASS coverage (one tile, no mosaic)': () => B.pair('Ks', twomass('ki1030244'), sp.Ks),
};
const mutOut = {};
for (const [name, run] of Object.entries(muts)) {
  const r = run(), failed = [...Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k), ...(r.expectation === false ? ['lead_expectation'] : [])];
  mutOut[name] = { evaluator: r.passed ? 'PASS' : 'FAIL', failed_checks: failed };
  const refFailed = MUT[name].failed_checks;
  ok(!r.passed, `mutation "${name}" FAILS (${failed.join(', ')}; reference: ${refFailed.join(', ')})`);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (process.env.BLINK_PARITY_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.BLINK_PARITY_OUT, JSON.stringify({ checks: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ...v, frames: undefined, info: undefined }])), mutations: mutOut }, null, 1));
}
if (fails) { console.log(`${fails} failed`); process.exit(1); }
