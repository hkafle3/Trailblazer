// Offline check of a known comet's light measurement (web/live/cutout.js) on made-up photos: a hot pixel and a star
// whose brightness changes with wavelength must never read as "Seen"; a real faint source must. node web/tests/cutout_check.mjs
import assert from 'node:assert/strict';
import { diffMeasure, nearRefs, verdictOf, mask, BAD, R_OUT, REF_USE } from '../live/cutout.js';

const W = 2 * (R_OUT + 1) + 1, c = (W - 1) / 2;
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
// sky of 10 with unit noise, plus point sources [x, y, total light] spread as a 1-pixel Gaussian
function photo(sources) {
  return Float64Array.from({ length: W * W }, (_, k) => {
    const x = k % W, y = Math.floor(k / W);
    return 10 + gauss() + sources.reduce((s, [sx, sy, f]) => s + f / (2 * Math.PI) * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 2), 0);
  });
}
const ringStars = [[c + 11, c + 2, 400], [c - 3, c - 11, 300], [c - 10, c + 6, 250]];
const judge = (t, refs) => verdictOf(diffMeasure(t, refs, c, c), refs.length, refs.length);

// 1. a hot pixel at the spot: its quality bit (9, hot) leaves it out; unflagged, one pixel holding the light is a glitch
const hot = photo(ringStars), flags = new Int32Array(W * W), refs = [photo(ringStars), photo(ringStars), photo(ringStars)];
hot[c * W + c] += 5000; flags[c * W + c] = 1 << 9;
assert.ok(BAD & (1 << 9));
const masked = hot.map((v, k) => mask(v, flags[k]));
assert.notEqual(judge(masked, refs).verdict, 'seen', 'a flagged hot pixel read as Seen');
assert.equal(judge(hot, refs).verdict, 'unmeasured', 'an unflagged hot pixel was not caught as a glitch');

// 2. a star at the spot, 100 in the target's channel and 30 three channels away: only same-channel photos are used
const lam = 0.80, bw = 0.02, star = [c, c, 100];
const cands = [{ lam: lam + 0.06, px: photo([...ringStars, [c, c, 30]]) }, { lam: lam - 0.07, px: photo([...ringStars, [c, c, 30]]) },
  { lam: lam + 0.008, px: photo([...ringStars, [c, c, 97]]) }, { lam: lam - 0.012, px: photo([...ringStars, [c, c, 103]]) }];
const target = photo([...ringStars, star]);
assert.equal(judge(target, cands.slice(0, 2).map(x => x.px)).verdict, 'seen', 'the test star should fool far-channel references');
const near = nearRefs(cands, lam, bw);
assert.deepEqual(near.map(x => x.lam), [lam + 0.008, lam - 0.012]);
assert.notEqual(judge(target, near.map(x => x.px)).verdict, 'seen', 'a star that changes with wavelength read as Seen');
assert.equal(verdictOf(null, nearRefs(cands.slice(0, 2), lam, bw).length, 0).verdict, 'unmeasured', 'no same-channel photo must be unmeasured');
// the same, with the references 20% fainter overall (another part of the filter): the ring's stars scale them back
assert.notEqual(judge(target, near.map(() => photo([...ringStars.map(([x, y, f]) => [x, y, 0.8 * f]), [c, c, 80]]))).verdict, 'seen', 'unscaled references made a star read as Seen');

// 3. a faint comet (light 60, about SNR 8 against unit noise) on an empty spot is Seen; with one reference it is less sure
const comet = photo([...ringStars, [c + 0.3, c - 0.2, 60]]), j = judge(comet, refs);
assert.equal(j.verdict, 'seen', `a faint comet was missed (SNR ${j.snr})`);
assert.ok(judge(comet, refs.slice(0, 1)).few && REF_USE === 3);
console.log(`PASS cutout check: flagged and unflagged hot pixels, a colour-changing star (same-channel refs, ring scaling) never Seen; a faint comet Seen at SNR ${j.snr.toFixed(1)}`);
