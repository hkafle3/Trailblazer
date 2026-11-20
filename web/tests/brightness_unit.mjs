// The Brightness change card's arithmetic, offline (live/brightness.js and colors.js wisePass): the synthesis error against
// a Monte Carlo of the same measurements (W2's tail reuses bins, so the errors are correlated), the calibration, the
// words, the visit on screen, the NEOWISE visit rule and the choice of calibration stars.
// Run: node --test web/tests/brightness_unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parity, mulberry32 } from '../live/colors.js';
import { calibrate, calibrators, change, magText, nearestPass, neowiseVisits, ZP, PRIOR } from '../live/brightness.js';

const { wisePass } = parity;
// one measurement per lambda/45 bin from 2.62 um to 5 um, flux f(lam), error e
const lams = Array.from({ length: 30 }, (_, i) => 2.62 * (1 + 1 / 45) ** i + 0.01).filter(l => l < 5);
const rowsOf = (f, e) => lams.map(l => [l, f(l), e, 61000]);
function gauss(rand) { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); }

test('synthesis of a flat spectrum is that flux in both bands, all of the band covered', () => {
  for (const b of ['W1', 'W2']) { const p = wisePass(rowsOf(() => 2, 0.1), b, true); assert.ok(p.ok); assert.ok(Math.abs(p.f - 2) < 1e-9, b); assert.ok(p.sys < 1e-9, b); }
});
test('the synthesis error matches a Monte Carlo of the bins (W2 tail included: correlated)', () => {
  const rand = mulberry32(7), f = l => 3 + 0.4 * (l - 3.5);
  for (const b of ['W1', 'W2']) {
    const want = wisePass(rowsOf(f, 0.2), b, true).err, got = [];
    for (let k = 0; k < 4000; k++) got.push(wisePass(lams.map(l => [l, f(l) + 0.2 * gauss(rand), 0.2, 61000]), b).f);
    const m = got.reduce((s, v) => s + v, 0) / got.length, sd = Math.sqrt(got.reduce((s, v) => s + (v - m) ** 2, 0) / (got.length - 1));
    assert.ok(Math.abs(sd / want - 1) < 0.05, `${b}: Monte Carlo ${sd.toFixed(4)} vs propagated ${want.toFixed(4)}`);
  }
});
test('W2 past 5 um: a sloped spectrum gives a tail systematic, half the flat - straight-line difference', () => {
  const p = wisePass(rowsOf(l => 1 + (l - 4.4), 0.05), 'W2', true);
  assert.ok(p.sys > 0.005, String(p.sys));
  assert.equal(wisePass(rowsOf(l => 1 + (l - 4.4), 0.05), 'W1', true).sys, 0);
});
test('a gap in the band is refused', () => {
  const p = wisePass(lams.filter(l => l < 3.0 || l > 3.5).map(l => [l, 1, 0.1, 61000]), 'W1', true);
  assert.equal(p.ok, false);
});

const cal = (m, f, ok = true) => ({ m, p: { f, ok } });
test('calibration: many calibration stars set the scale; a prior from elsewhere barely moves it', () => {
  const k = 1.1, comps = [10, 11, 12, 12.5, 13, 9.5].map(m => cal(m, k * ZP.W1 * 10 ** (-0.4 * m)));
  const t = { f: k * ZP.W1 * 10 ** (-0.4 * 14.2), err: 0, sys: 0, ok: true }, r = calibrate(t, comps, 'W1');
  assert.ok(Math.abs(r.m - 14.2) < 1e-3, String(r.m)); assert.equal(r.n, 6); assert.ok(r.e < 0.002);
  // a scatter of 5% among them becomes the floor; the median's error and the prior's combine
  const noisy = comps.map((c, i) => cal(c.m, c.p.f * (1 + 0.05 * [1, -1, 1, -1, 0.5, -0.5][i])));
  const r2 = calibrate({ ...t, err: 0.01 * t.f }, noisy, 'W1');
  assert.ok(r2.e > 0.05 && r2.e < 0.1, String(r2.e));
  assert.ok(r2.k < 1.1 && r2.k > PRIOR.W1, 'between the prior and the field, nearer the field');
});
test('calibration with too few stars: the prior scale, its error and the floor', () => {
  const comps = [10, 11, 12, 13].map(m => cal(m, 1.3 * ZP.W1 * 10 ** (-0.4 * m)));   // 4: not used
  const t = { f: PRIOR.W1 * ZP.W1 * 10 ** (-0.4 * 12), err: 0, sys: 0, ok: true }, r = calibrate(t, comps, 'W1');
  assert.ok(Math.abs(r.m - 12) < 1e-9); assert.equal(r.n, 4); assert.equal(r.k, PRIOR.W1);
  assert.ok(Math.abs(r.e - 2.5 / Math.LN10 * Math.hypot(PRIOR.floor, PRIOR.rel)) < 1e-9);
});
test('calibration refusals: a pass not covered, not detected (under 3 sigma: a limit)', () => {
  const unit = { W1: 1, W2: 1, rel: 0.016, floor: 0.04 }, comps = [];
  assert.match(calibrate({ f: 1, ok: false }, comps, 'W1').why, /not enough of the band/);
  assert.match(calibrate(null, comps, 'W1').why, /too few wavelengths/);
  const nd = calibrate({ f: -0.1, err: 0.2, ok: true }, comps, 'W1', unit);
  assert.match(nd.why, /not detected/); assert.ok(Math.abs(nd.limit - -2.5 * Math.log10(0.6 / ZP.W1)) < 1e-9);   // 3 sigma
  assert.match(calibrate({ f: 0.5, err: 0.2, ok: true }, comps, 'W1', unit).why, /not detected/);   // 2.5 sigma
  assert.ok(calibrate({ f: 0.7, err: 0.2, ok: true }, comps, 'W1', unit).m > 0);
});
test('the change in words and in magnitudes', () => {
  assert.equal(change(12.30, 0.05, 13.65, 0.03).words, '3.5× brighter');
  assert.equal(magText(change(12.30, 0.05, 13.65, 0.03).d, 0.06), '−1.35 ± 0.06 mag');
  assert.equal(change(11, 0.05, 10.2, 0.03).words, '2.1× dimmer');
  assert.equal(change(10.75, 0.03, 10.5, 0.02).words, '1.26× dimmer');
  assert.equal(change(10.05, 0.03, 10, 0.02).words, 'about the same');   // under 2 sigma
  assert.equal(magText(0.04, 0.03), '+0.04 ± 0.03 mag');
  const u = change(10.05, 0.03, 10, NaN);   // a catalogue value without an error: the change's error is unknown, never zero
  assert.ok(Number.isNaN(u.e)); assert.equal(u.words, '1.05× dimmer'); assert.equal(magText(u.d, u.e), '+0.05 mag');
});
test('the visit on screen picks the pass within 60 days, else none', () => {
  assert.equal(nearestPass([60930, 61110, 61297], 61100), 1);
  assert.equal(nearestPass([60930, 61110, 61297], 61340), 2);
  assert.equal(nearestPass([60930, 61110, 61297], 61400), -1);
});

// NEOWISE rows as the CSV parser gives them (strings)
const row = (mjd, w1, o = {}) => ({ ra: '10', dec: '20', mjd: String(mjd), w1mpro: String(w1), w1sigmpro: '0.03', w1snr: '30', w2mpro: '12', w2sigmpro: '0.04', w2snr: '20', qual_frame: '10', qi_fact: '1.0', saa_sep: '90', moon_masked: '00', cc_flags: '0000', ...o });
const here = () => [10, 20];
test('NEOWISE visits: 30-day gaps, 5 good exposures, median, 1.253 std / sqrt(n) with a 0.02 floor', () => {
  const v1 = [12.0, 12.1, 12.2, 12.3, 12.4].map((m, i) => row(57000 + i, m)), v2 = [13, 13, 13, 13].map((m, i) => row(57100 + i, m));
  const v3 = [13, 13, 13, 13, 13, 13].map((m, i) => row(57120 + 7 * i, m));   // 7 days apart: one visit, joined to v2 (gaps under 30)
  const V = neowiseVisits([...v1, ...v2, ...v3], 'W1', here);
  assert.equal(V.length, 2);
  assert.equal(V[0].m, 12.2); assert.equal(V[0].n, 5);
  assert.ok(Math.abs(V[0].e - 1.253 * Math.sqrt(0.025) / Math.sqrt(5)) < 1e-9);
  assert.equal(V[1].n, 10); assert.equal(V[1].e, 0.02);
});
test('NEOWISE quality cuts, per band, and the 2.5 arcsec match', () => {
  const ok = [0, 1, 2, 3].map(i => row(57000 + i, 12));
  for (const bad of [{ w1snr: '4.9' }, { w1sigmpro: '' }, { qual_frame: '0' }, { qi_fact: '0' }, { saa_sep: '5' }, { moon_masked: '10' }, { cc_flags: 'd000' }, { w1mpro: '7.9' }, { dec: String(20 + 3 / 3600) }])
    assert.equal(neowiseVisits([...ok, row(57004, 12, bad)], 'W1', here).length, 0, JSON.stringify(bad));
  for (const fine of [{ moon_masked: '01' }, { cc_flags: '0h00' }, { dec: String(20 + 2 / 3600) }])
    assert.equal(neowiseVisits([...ok, row(57004, 12, fine)], 'W1', here).length, 1, JSON.stringify(fine));
});

test('calibration stars across RA 0: a variable 1.4" away on the other side of 0 h still excludes its star', () => {
  const K = { ra: [359.9999, 0.0001, 0.01], dec: [0, 0, 0], w1: [17, 12, 12], w2: [16.6, 11.6, 11.6], nmem: [1, 1, 1], src: ['cw', 'cw', 'cw'], ab: ['00', '00', '00'], cc: ['00', '00', '00'], nb: [1, 1, 1] };
  assert.deepEqual(calibrators(K, 0, [[0.0005, 0]]), [2]);
  assert.deepEqual(calibrators(K, 0, []), [1, 2]);   // nearest first, across 0 h
});
test('calibration stars: single, clean, bright, isolated, not variable, colour-matched first', () => {
  const at = (dx, dy) => [10 + dx / 3600 / Math.cos(20 * Math.PI / 180), 20 + dy / 3600];
  const K = { ra: [], dec: [], w1: [], w2: [], nmem: [], src: [], ab: [], cc: [], nb: [] };
  const put = (dx, dy, w1, w2, o = {}) => { const [r, d] = at(dx, dy); K.ra.push(r); K.dec.push(d); K.w1.push(w1); K.w2.push(w2); K.nmem.push(o.nmem ?? 1); K.src.push(o.src ?? 'cw'); K.ab.push(o.ab ?? '00'); K.cc.push(o.cc ?? '00'); K.nb.push(o.nb ?? 1); return K.ra.length - 1; };
  const T = put(0, 0, 15, 14.5);
  const good = [put(100, 0, 12, 11.6), put(200, 0, 11, 10.5)];
  put(300, 0, 15.5, 15);                     // too faint
  put(400, 0, 8.5, 8);                       // too bright
  put(500, 0, 12, 11.5, { nmem: 2 });        // a blend
  put(600, 0, 12, 11.5, { cc: '0d' });       // flagged
  const crowd = put(700, 0, 12, 11.5); put(710, 0, 13, 12.5);   // a neighbour 10" away, not 2.5 mag fainter
  const vary = put(800, 0, 12, 11.5);
  const red = put(900, 0, 12, 10);           // colour 2.0, the star's 0.5: only once the tolerance has widened to 1.6
  const got = calibrators(K, T, [at(800, 3)]);
  assert.deepEqual(got, [...good, red]);     // nearest first; fewer than 20, so the tolerance widened to the end
  assert.ok(!got.includes(crowd) && !got.includes(vary));
});
