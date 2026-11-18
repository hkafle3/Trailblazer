// Results for the page tests (E6 drawn equals computed, E7 inconclusive states), each made by the method itself from real
// fixture measurements with one input changed: fewer passes, a brighter star, D6 dropped, no star measurements, too few
// comparisons, a poor fit, a temperature on the grid's edge, W1 mode (no clean 2MASS Ks) and a saturated star (C-0175).
//   node web/tests/colors_states.mjs <fixtures_dir> <out_dir>
import fs from 'node:fs';
import path from 'node:path';
import { parity } from '../live/colors.js';
import { measure } from './colors_inject.mjs';

const [fx, out] = process.argv.slice(2), save = (n, r) => { fs.writeFileSync(path.join(out, `${n}.json`), JSON.stringify(r)); console.log(n.padEnd(12), r.state, JSON.stringify(Object.fromEntries(Object.entries(r.fingerprints ?? {}).map(([k, v]) => [k, v.verdict + (v.reason ? ': ' + v.reason : '')])))); };
fs.mkdirSync(out, { recursive: true });
const L1 = path.join(fx, 'L1'), [ra, dec] = [84.0181, -6.577];
const { ctx, rows, used, result } = measure(L1, ra, dec), T = ctx.T, again = rr => parity.clean(parity.spectrumResult(ctx, rr, used));
save('three_pass', result);
const passOf = t => result.passes_mjd.reduce((b, p, k) => (Math.abs(t - p) < Math.abs(t - result.passes_mjd[b]) ? k : b), 0);
save('one_pass', again(rows.filter(r => passOf(r[4]) === 0)));
save('two_pass', again(rows.filter(r => passOf(r[4]) <= 1)));
save('bright', again(rows.map(r => (r[0] === T ? [r[0], r[1], r[2] * 1.3, r[3] * 1.3, r[4]] : r))));   // past the mockup's 12 mJy axis
save('d6_dropped', again(rows.filter(r => r[1] <= 4.42)));
save('empty', again(rows.filter(r => r[0] !== T)));
const keep = new Set(result.comparisons.names.slice(0, 9).map(n => ctx.K.name.indexOf(n)));
save('under12', again(rows.filter(r => r[0] === T || keep.has(r[0]))));
save('poor_fit', again(rows.map(r => (r[0] === T ? [r[0], r[1], r[2] * (1 + 0.25 * Math.sin(r[1] * 60)), r[3], r[4]] : r))));
const bnu = (l, t) => 1 / (l ** 3 * Math.expm1(Math.min(14387.77 / (l * t), 700)));
// the quiet star (SPOT2) with 200 K dust at a fifth of the star at 4.6 um: a rise whose temperature sits on the grid's edge
// (brighter cold dust jumps across the 4.42 um seam and is read as a possible calibration jump, plan deviation 2)
const Q = measure(path.join(fx, 'SPOT2'), 206.52297618247366, 11.640239417061798), b46 = Q.result.bare.mjy[Q.result.bare.lam.findIndex(l => l > 4.6)];
save('grid_edge', parity.clean(parity.spectrumResult(Q.ctx, Q.rows.map(r => (r[0] === Q.ctx.T ? [r[0], r[1], r[2] + 0.2 * b46 * bnu(r[1], 200) / bnu(4.6, 200), r[3], r[4]] : r)), Q.used)));
save('quiet', Q.result);
const w1 = measure(L1, ra, dec, cats => ({ ...cats, twomass: cats.twomass.map(r => (Math.abs(+r.ra - 84.018124) < 1e-4 && Math.abs(+r.dec + 6.577501) < 1e-4 ? { ...r, ph_qual: 'ABA' } : r)) }));
save('w1_mode', w1.result);
save('saturated', measure(path.join(fx, 'C0175'), 76.9563, 30.4013).result);
