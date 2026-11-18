// Small checks of web/live/blink.js that need no fixtures (the port parity test, blink_parity.mjs, needs them):
// 2MASS dates in both centuries, and the SPHEREx input digest covering header, crop geometry and pixels.
// Run: node web/tests/blink_unit.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as B from '../live/blink.js';

test('2MASS ORDATE: 1997-1999 stay in the 1900s, 2000-2001 in the 2000s', () => {
  assert.equal(B.twomassDate('971004'), '1997-10-04');
  assert.equal(B.twomassDate('981126'), '1998-11-26');
  assert.equal(B.twomassDate('991231'), '1999-12-31');
  assert.equal(B.twomassDate('001126'), '2000-11-26');
  assert.equal(B.twomassDate('010215 '), '2001-02-15');
  assert.throws(() => B.twomassDate('xx1126'));
});

test('old2mass reports a 1998 tile as 1998, not 2098', () => {
  const grid = B.makeGrid(84.01808, -6.5775), w = 900, h = 900;
  const tile = date => ({ name: `2mass_Ks_${date}_ki0000001.fits`, fits: { w, ht: h, data: new Float64Array(w * h).fill(1),
    h: { CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN', CRVAL1: 84.01808, CRVAL2: -6.5775, CRPIX1: 450.5, CRPIX2: 450.5, CDELT1: -1 / 3600, CDELT2: 1 / 3600, CROTA2: 0, MAGZP: 20, ORDATE: date } } });
  assert.deepEqual(B.old2mass([tile('981126')], grid, []).meta.dates, ['1998-11-26']);
  assert.deepEqual(B.old2mass([tile('001126'), tile('981127')], grid, []).meta.dates, ['1998-11-27', '2000-11-26']);
});

test('the SPHEREx input digest covers the header, the crop origin and size, and the pixels', async () => {
  const e = { key: 'dr1/level2/x.fits', x0: 100, y0: 200, w: 2, h: 2, head: { CRVAL1: 84, CRVAL2: -6.5, CTYPE1: 'RA---TAN-SIP', _dataOffset: 5 },
    img: Float32Array.from([1, 2, 3, 4]), flg: Int32Array.from([0, 0, 1, 0]) };
  const d0 = await B.cutoutDigest(e);
  assert.match(d0, /^[0-9a-f]{64}$/);
  assert.equal(await B.cutoutDigest({ ...e }), d0, 'reproducible');
  for (const [what, x] of [['header (WCS)', { ...e, head: { ...e.head, CRVAL1: 84.001 } }], ['crop origin', { ...e, x0: 101 }], ['crop size', { ...e, w: 4, h: 1 }],
    ['pixels', { ...e, img: Float32Array.from([1, 2, 3, 5]) }], ['flags', { ...e, flg: Int32Array.from([0, 0, 0, 0]) }], ['key', { ...e, key: 'dr1/level2/y.fits' }]])
    assert.notEqual(await B.cutoutDigest(x), d0, `${what} changes the digest`);
  assert.equal(await B.cutoutDigest({ ...e, head: { ...e.head, _dataOffset: 9 } }), d0, 'where the reader found the data is not part of the input');
  assert.match(B.CUTOUT_DIGEST, /header.*crop.*pixels/i);
});

test('a damaged stored old-survey tile makes the band inconclusive, not unavailable, and says why', async () => {
  const { oldSky } = await import('../live/blinkworker.js');
  const card = (k, v) => (k.padEnd(8) + (v === undefined ? '' : '= ' + String(v).padStart(20))).padEnd(80);
  let h = [card('SIMPLE', 'T'), card('BITPIX', -32), card('NAXIS', 2), card('NAXIS1', 40), card('NAXIS2', 40), card('BAND', 2), card('END')].join('');
  h = h.padEnd(2880, ' '); const good = new Uint8Array(2880 + 6400 + (2880 - 6400 % 2880)); good.set(new TextEncoder().encode(h));
  const gz = new Uint8Array(await new Response(new Blob([good]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const badCrc = gz.slice(); badCrc[badCrc.length - 6] ^= 0xff;
  const run = async (tile, bytes = tile.length) => {
    const man = { tiles: [{ name: 'allwise_W2_int.fits', path: 'api/x/int', bytes }, { name: 'allwise_W2_cov.fits', path: 'api/x/cov', bytes: good.length }] };
    const real = globalThis.fetch;
    globalThis.fetch = async u => (String(u).includes('/api/oldsky?') ? new Response(JSON.stringify(man)) : new Response(String(u).endsWith('int') ? tile : good));
    try { return await oldSky('', 'W2', 84, -6.5, undefined, () => {}); } catch (e) { return e; } finally { globalThis.fetch = real; }
  };
  assert.equal((await run(gz)).kind, 'wise', 'a good gzip tile reads');
  for (const [what, r] of [['a gzip failing its checksum', await run(badCrc)], ['a gzip cut short', await run(gz.subarray(0, gz.length - 30))],
    ['a header-only FITS', await run(good.subarray(0, 2880))], ['fewer bytes than stored', await run(gz, gz.length + 10)]]) {
    assert.equal(r.state, 'inconclusive', what); assert.match(r.message, /stored picture of this spot is damaged/, what);
  }
});

test('an old-survey tile that cannot be downloaded is the old survey\'s failure, never SPHEREx\'s', async () => {
  const { oldSky } = await import('../live/blinkworker.js');
  const man = { tiles: [{ name: 'allwise_W2_int.fits', path: 'api/x/int', bytes: 10 }, { name: 'allwise_W2_cov.fits', path: 'api/x/cov', bytes: 10 }] };
  const run = async tile => {
    const real = globalThis.fetch;
    globalThis.fetch = async u => { if (String(u).includes('/api/oldsky?')) return new Response(JSON.stringify(man)); return tile(); };
    try { return await oldSky('', 'W2', 84, -6.5, undefined, () => {}); } catch (e) { return e; } finally { globalThis.fetch = real; }
  };
  const missing = await run(() => new Response('{"error":"not found"}', { status: 404 }));
  assert.equal(missing.state, 'inconclusive'); assert.match(missing.message, /stored picture of this spot is damaged/);
  for (const [what, f] of [['HTTP 503', () => new Response('busy', { status: 503 })], ['HTTP 500', () => new Response('', { status: 500 })], ['the network', () => { throw new TypeError('fetch failed'); }]]) {
    const e = await run(f);
    assert.equal(e.state, 'old-unavailable', `${what}: ${e.state} ${e.message}`);
  }
});

// C-0175 (live, 2026-11-18): the field is covered in both pictures, but the star itself (W1 6.2, W2 5.2) is saturated in
// SPHEREx and has under 5 good AllWISE frames. The page said "the older picture does not cover enough of the field".
test('a star masked at its own position is said so, not blamed on the field', async () => {
  const { bandMessage } = await import('../live/blinkworker.js');
  const checks = Object.fromEntries(['finite', 'band_match', 'old_footprint', 'spherex_footprint', 'spectral_coverage_at_lead', 'qualified_stars'].map(k => [k, true]));
  const rep = (over, old, spx) => ({ checks: { ...checks, ...over }, old: { survey: 'AllWISE Atlas', valid_fraction: 0.9999, coverage_frames_at_lead: 3.7, ...old },
    spherex: { valid_fraction: 0.9994, covered_weight_at_lead: 0.081, exposures_seeing_lead: 335, exposures_saturated_at_lead: 312, ...spx }, qualified_stars: 72 });
  const both = bandMessage('W2', rep({ old_footprint: false, spectral_coverage_at_lead: false }));
  assert.equal(both.state, 'comparison-unavailable');
  assert.doesNotMatch(both.reason, /of the field/, both.reason);
  assert.match(both.reason, /too bright/, both.reason);
  assert.match(both.reason, /saturated .*312 of 335/, both.reason);
  assert.match(both.reason, /3\.7 good AllWISE frames at the star, 5 needed/, both.reason);
  // a missing measurement follows from the coverage: not given as a second reason (Ks at C-0175)
  assert.doesNotMatch(bandMessage('Ks', rep({ spectral_coverage_at_lead: false, finite: false })).reason, /measurement is missing/);
  // the field itself short: still said as the field
  assert.match(bandMessage('W2', rep({ old_footprint: false }, { valid_fraction: 0.9 })).reason, /older picture does not cover enough of the field/);
  // SPHEREx short at the star without saturation: the coverage, as before
  assert.match(bandMessage('W2', rep({ spectral_coverage_at_lead: false }, {}, { exposures_saturated_at_lead: 0 })).reason, /SPHEREx does not cover enough of this band at the star/);
  // 2MASS has no coverage map: the star's pixels are unusable
  assert.match(bandMessage('Ks', rep({ old_footprint: false }, { survey: '2MASS All-Sky Atlas', coverage_frames_at_lead: undefined })).reason, /older picture has no usable pixels at the star/);
});

test('SPHEREx exposures saturated at the star are counted', async () => {
  const { readFileSync } = await import('node:fs');
  const curves = JSON.parse(readFileSync(new URL('../data/bands.json', import.meta.url))), waves = JSON.parse(readFileSync(new URL('../data/wavemaps.json', import.meta.url)));
  const N = B.N, w = N + 20, px = new Float64Array(N * N), py = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) { px[k] = 1000 + (k % N); py[k] = 1000 + Math.floor(k / N); }
  const exp = sat => { const img = new Float32Array(w * w).fill(1), flg = new Int32Array(w * w), c = 190 * w + 190; if (sat) flg[c] = flg[c + 1] = 1 << 1; return { det: 'D6', t: 61000, key: 'k', sha256: 's', img, flg, w, h: w, x0: 990, y0: 990, map: { px, py } }; };
  const acc = B.synthStart(curves.W2, ['D6']);
  B.synthAdd(acc, exp(true), waves.D6); B.synthAdd(acc, exp(false), waves.D6);
  const { meta } = B.synthEnd(acc, 'W2');
  assert.equal(meta.exposures_seeing_lead, 2); assert.equal(meta.exposures_saturated_at_lead, 1);
});

// Codex review 5: bit 2 (SUR_ERROR, an onboard processing error) is not saturation; and saturation in any pixel the
// grid's bilinear draws on counts, not only the rounded one
test('SPHEREx saturation at the star: OVERFLOW or NONLINEAR in any contributing pixel; SUR_ERROR is only unusable', async () => {
  const { readFileSync } = await import('node:fs');
  const curves = JSON.parse(readFileSync(new URL('../data/bands.json', import.meta.url))), waves = JSON.parse(readFileSync(new URL('../data/wavemaps.json', import.meta.url)));
  const N = B.N, w = N + 20;
  const exp = (dx, at, bit) => {
    const px = new Float64Array(N * N), py = new Float64Array(N * N);
    for (let k = 0; k < N * N; k++) { px[k] = 1000 + (k % N) + dx; py[k] = 1000 + Math.floor(k / N); }
    const img = new Float32Array(w * w).fill(1), flg = new Int32Array(w * w); flg[190 * w + at] = 1 << bit;
    return { det: 'D6', t: 61000, key: 'k', sha256: 's', img, flg, w, h: w, x0: 990, y0: 990, map: { px, py } };
  };
  const meta = list => { const acc = B.synthStart(curves.W2, ['D6']); for (const e of list) B.synthAdd(acc, e, waves.D6); return B.synthEnd(acc, 'W2').meta; };
  const sur = meta([exp(0, 190, 2)]);
  assert.equal(sur.exposures_masked_at_lead, 1); assert.equal(sur.exposures_saturated_at_lead, 0, 'SUR_ERROR alone is not saturation');
  const side = meta([exp(0.4, 191, 1)]);   // the star at x 190.4: pixel 191 carries 0.4 of its weight and is OVERFLOW
  assert.equal(side.exposures_masked_at_lead, 1); assert.equal(side.exposures_saturated_at_lead, 1, 'a saturated contributing neighbour counts');
  assert.equal(meta([exp(0, 190, 15)]).exposures_saturated_at_lead, 1, 'NONLINEAR counts as saturation');
  const { bandMessage } = await import('../live/blinkworker.js');
  const checks = Object.fromEntries(['finite', 'band_match', 'old_footprint', 'spherex_footprint', 'qualified_stars'].map(k => [k, true]));
  const r = bandMessage('W2', { checks: { ...checks, spectral_coverage_at_lead: false }, old: { valid_fraction: 1 },
    spherex: { valid_fraction: 1, covered_weight_at_lead: 0, exposures_seeing_lead: 15, exposures_masked_at_lead: 15, exposures_saturated_at_lead: 0 } }).reason;
  assert.doesNotMatch(r, /too bright|saturated/, r); assert.match(r, /SPHEREx has unusable pixels at the star in 15 of 15 exposures/, r);
});

// Codex review 6: several saturated contributors each under 0.001 of the weight can mask the star together
test('saturated contributors too small alone but masking the star together are counted', async () => {
  const { readFileSync } = await import('node:fs');
  const curves = JSON.parse(readFileSync(new URL('../data/bands.json', import.meta.url))), waves = JSON.parse(readFileSync(new URL('../data/wavemaps.json', import.meta.url)));
  const N = B.N, w = N + 20, px = new Float64Array(N * N), py = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) { px[k] = 1000.0006 + (k % N); py[k] = 1000.0006 + Math.floor(k / N); }   // the star at (190.0006, 190.0006)
  const img = new Float32Array(w * w).fill(1), flg = new Int32Array(w * w);
  for (const k of [190 * w + 191, 191 * w + 190, 191 * w + 191]) flg[k] = 1 << 1;   // weights about 0.0006, 0.0006, 0.0000004
  const acc = B.synthStart(curves.W2, ['D6']);
  B.synthAdd(acc, { det: 'D6', t: 61000, key: 'k', sha256: 's', img, flg, w, h: w, x0: 990, y0: 990, map: { px, py } }, waves.D6);
  const { meta } = B.synthEnd(acc, 'W2');
  assert.equal(meta.exposures_masked_at_lead, 1); assert.equal(meta.exposures_saturated_at_lead, 1);
});
