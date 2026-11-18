// E5, computed never hard-coded: injections into the quiet star's real measurements (SPOT2 fixture), each of which must flip
// only its own verdict, and an exactly photospheric spectrum (every fingerprint not seen). Thresholds are plan.md's.
//   node web/tests/colors_inject.mjs <fixture_dir> <ra> <dec>      (the quiet star: colors-build/ref2/eval.json)
import fs from 'node:fs';
import path from 'node:path';
import { parseCards } from '../live/fits.js';
import { parseCsv, parseVsx, catalogueStep, starOn, prepExposure, parity } from '../live/colors.js';

export function loadFixture(dir) {
  const cats = {};
  for (const n of ['twomass', 'catwise', 'allwise', 'gaia', 'simbad', 'vsx']) {
    const t = fs.readFileSync(path.join(dir, n + (n === 'vsx' ? '.tsv' : '.csv')), 'utf8');
    cats[n] = n === 'vsx' ? parseVsx(t) : parseCsv(t);
  }
  const typed = (f, T) => { const b = fs.readFileSync(f); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const exposures = JSON.parse(fs.readFileSync(path.join(dir, 'exposures.json'), 'utf8')).map(e => ({ ...e, hdr: parseCards(Buffer.from(e.hdr, 'latin1')).h,
    img: typed(path.join(dir, e.file + '.img'), Float32Array), flg: typed(path.join(dir, e.file + '.flg'), Int32Array) }));
  return { cats, exposures, field: JSON.parse(fs.readFileSync(path.join(dir, 'field.json'), 'utf8')) };
}
// the star's measurements once: catalogue step, exposures with the star, prep, PSF fits
// edit (optional): changes the catalogues before the catalogue step (the W1-mode state of colors_states.mjs)
export function measure(dir, ra, dec, edit = c => c) {
  const { cats, exposures } = loadFixture(dir), ctx = catalogueStep(edit(cats), ra, dec);
  if (ctx.result) throw new Error(ctx.result.reason);
  const SAT = 1 << 1 | 1 << 15, on = [], saturated = [];
  for (const e of exposures) {
    const s = starOn(ctx, e);
    if (!s) continue;
    let hit = false;
    for (let y = s.yi - 1; y <= s.yi + 1; y++) for (let x = s.xi - 1; x <= s.xi + 1; x++) hit ||= (e.flg[y * e.w + x] & SAT) !== 0;
    on.push(e); saturated.push(hit);
  }
  const d = parity.finishDetails(ctx, on.map(e => prepExposure(ctx, e)), { exposures_listed: exposures.length, saturated });
  return { ctx, ...d };
}
const bnu = (l, T) => 1 / (l ** 3 * Math.expm1(Math.min(14387.77 / (l * T), 700)));
const interp = (x, xs, ys) => { let i = 0; while (i < xs.length - 2 && xs[i + 1] < x) i++; return ys[i] + (x - xs[i]) / (xs[i + 1] - xs[i]) * (ys[i + 1] - ys[i]); };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, ra, dec, save] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];   // save: a directory for the injected results (E6 draws them)
  const { ctx, rows, used, result: base } = measure(dir, ra, dec), T = ctx.T;
  const verdicts = r => Object.fromEntries(Object.entries(r.fingerprints).map(([k, v]) => [k, v.verdict]));
  const all = base.passes.find(p => p.key === 'all'), sigAt = l0 => { const i = all.lam.reduce((b, l, k) => (Math.abs(Math.log(l / l0)) < Math.abs(Math.log(all.lam[b] / l0)) ? k : b), 0); return [all.lam[i], all.sigma[i]]; };
  const EDGES = parity.EDGES, binOf = l => { let k = 0; while (k < EDGES.length - 1 && l >= EDGES[k + 1]) k++; return k; };
  const inject = f => parity.clean(parity.spectrumResult(ctx, rows.map(r => (r[0] === T ? [r[0], r[1], f(r[1], r[2]), r[3], r[4]] : r)), used));
  const line = (l0, k) => { const [lb, s] = sigAt(l0), b = binOf(lb); return (l, f) => (binOf(l) === b ? f + k * s : f); };
  const bare46 = interp(4.6, base.bare.lam, base.bare.mjy);
  const cases = [
    ['+5 sigma at 4.05 um', line(4.05, 5), { spike: 'seen' }],
    ['-5 sigma at 3.0 um', line(3.0, -5), { dip: 'seen' }],
    ['10% step at 4.42 um', (l, f) => (l > 4.42 ? f * 1.10 : f), { seam: 'seen' }],
    ['700 K dust at half the star at 4.6 um', (l, f) => f + 0.5 * bare46 * bnu(l, 700) / bnu(4.6, 700), { rise: 'seen', temperature: 'seen' }],
    ['exactly photospheric', (l) => interp(l, base.bare.lam, base.bare.mjy), {}],
  ];
  const quiet = { rise: 'not seen', temperature: 'not seen', spike: 'not seen', dip: 'not seen', seam: 'not seen' };
  let fail = 0;
  const b0 = verdicts(base), okBase = JSON.stringify(b0) === JSON.stringify(quiet);
  console.log(`${okBase ? 'PASS' : 'FAIL'} quiet star as measured: ${JSON.stringify(b0)}`); fail += !okBase;
  for (const [name, f, flips] of cases) {
    const r = inject(f), v = verdicts(r), want = { ...quiet, ...flips };
    let ok = JSON.stringify(v) === JSON.stringify(want);
    // plan deviation 2 (Ed): a step that does not flip the seam is acceptable only when the star's shown sensitivity says it
    // cannot be ruled out (sensitivity over the step) and the rise is not falsely seen
    const sens = r.fingerprints.seam.sensitivity;
    if (name.startsWith('10% step') && !ok && JSON.stringify(v) === JSON.stringify(quiet) && sens > 0.10) { ok = true; console.log(`  (not flipped: this star's seam sensitivity is ${(100 * sens).toFixed(1)}%, shown as "jumps under about ${Math.round(100 * sens)}% can't be ruled out"; the rise stays not seen)`); }
    if (save) { fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, `inject_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`), JSON.stringify(r)); }
    const extra = name.startsWith('700') ? ` T ${r.fits.all.T} K` : '';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(v)}${extra}`); fail += !ok;
    if (name === 'exactly photospheric' && r.fingerprints.temperature.reason !== 'no dust to measure') { console.log('FAIL photospheric temperature reason'); fail++; }
  }
  console.log(fail ? `E5: ${fail} failed` : 'E5: PASS');
  process.exit(fail ? 1 : 0);
}
