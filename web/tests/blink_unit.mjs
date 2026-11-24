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
  assert.doesNotMatch(both.reason, /this area/, both.reason);
  assert.match(both.reason, /too bright/, both.reason);
  assert.match(both.reason, /saturates SPHEREx in 312 of 335 shots/, both.reason);
  assert.match(both.reason, /older survey has too few good shots of this exact spot/, both.reason);
  // a missing measurement follows from the coverage: not given as a second reason (Ks at C-0175)
  assert.doesNotMatch(bandMessage('Ks', rep({ spectral_coverage_at_lead: false, finite: false })).reason, /measurement is missing/);
  // the field itself short: still said as the field
  assert.match(bandMessage('W2', rep({ old_footprint: false }, { valid_fraction: 0.9 })).reason, /older survey's picture of this area has gaps/);
  // SPHEREx short at the star without saturation: the coverage, as before
  assert.match(bandMessage('W2', rep({ spectral_coverage_at_lead: false }, {}, { exposures_saturated_at_lead: 0 })).reason, /SPHEREx has not yet seen enough of this wavelength at this spot/);
  // 2MASS has no coverage map: the star's pixels are unusable
  assert.match(bandMessage('Ks', rep({ old_footprint: false }, { survey: '2MASS All-Sky Atlas', coverage_frames_at_lead: undefined })).reason, /older picture has no usable data at this exact spot/);
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
  assert.doesNotMatch(r, /too bright|saturated/, r); assert.match(r, /SPHEREx's pixels at this spot are unusable in 15 of 15 shots/, r);
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

// C-0177 (2026-11-24, RA 331.0957, Dec -56.8004): "the older picture does not cover enough of the field" in W2 and W1.
// The spot is 1 arcmin from the edge of its nearest AllWISE tile, and the page used that tile alone: its cutout held 58%
// of the field (0.98 needed), though the star has 30 frames. The real tile geometry: web/tests/fixtures/allwise_c0177_w2.json
// (bake/allwise_footprint_fixture.mjs). Every tile touching the field together covers it.
test('C-0177 W2: the AllWISE picture is every tile touching the field, and together they cover it', async () => {
  const { readFileSync } = await import('node:fs'), { touchesField } = await import('../../worker/src/oldsky.js');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/allwise_c0177_w2.json', import.meta.url)));
  const r3 = v => Math.round(v * 1000) / 1000, grid = B.makeGrid(r3(fx.ra), r3(fx.dec)), c = Math.round(B.C0) * B.N + Math.round(B.C0);
  // which tiles the Worker asks IRSA for: those whose corners overlap the field
  assert.deepEqual(fx.tiles.map(t => [t.obs_id, touchesField(t.s_region, r3(fx.ra), r3(fx.dec))]), fx.tiles.map(t => [t.obs_id, t.touches]));
  const tile = t => { const v = B.unpackBits(t.valid, t.w * t.ht), fits = data => ({ h: t.h, w: t.w, ht: t.ht, data });
    return { name: t.obs_id, int: fits(Float64Array.from(v, x => (x ? 1 : NaN))), cov: fits(Float64Array.from(v, x => (x ? 30 : 0))) }; };
  const touching = fx.tiles.filter(t => t.touches).map(tile);
  assert.equal(touching.length, 3);
  // the old rule, the nearest tile alone: the field is not covered, as the page said
  const nearest = B.oldWise([touching.find(t => t.name === '3306m561_ac51')], grid, []);
  assert.ok(nearest.meta.valid_fraction < B.T.FOOTPRINT, `nearest alone ${nearest.meta.valid_fraction}`);
  // every touching tile: covered, the star included, so the footprint check passes
  const all = B.oldWise(touching, grid, []);
  assert.ok(all.meta.valid_fraction >= B.T.FOOTPRINT, `all tiles ${all.meta.valid_fraction}`);
  assert.equal(all.m[c], 1);
  assert.equal(all.meta.tiles.length, 3);
});

test('AllWISE tiles are levelled where they overlap: no step at the seam; one tile is the one-tile answer', () => {
  const grid = B.makeGrid(100, 20), w = 600, ht = 600, N = B.N;
  // two tiles of one flat sky at different levels (5 and 9), each holding part of the field
  const tile = (name, crval1, level) => {
    const h = { CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN', CRVAL1: crval1, CRVAL2: 20, CRPIX1: 300.5, CRPIX2: 300.5, CDELT1: -1.375 / 3600, CDELT2: 1.375 / 3600, CROTA2: 0, BAND: 2,
      DATEOBS1: '2010-01-07T00:00:00', DATEOBS2: '2010-07-31T00:00:00', MIDOBS: '2010-04-01T00:00:00' };
    const data = new Float64Array(w * ht), cov = new Float64Array(w * ht);
    data.fill(level); cov.fill(20);
    return { name, int: { h, w, ht, data }, cov: { h, w, ht, data: cov } };
  };
  // the field is 0.2 degree wide; tiles 0.23 degree wide, offset east and west so they share a strip through the middle
  const a = tile('a', 100 + 0.06 / Math.cos(20 * Math.PI / 180), 5), b = tile('b', 100 - 0.06 / Math.cos(20 * Math.PI / 180), 9);
  const one = B.oldWise([a], grid, []), both = B.oldWise([a, b], grid, []);
  assert.ok(one.meta.valid_fraction < 0.9 && both.meta.valid_fraction === 1, `${one.meta.valid_fraction} ${both.meta.valid_fraction}`);
  // levelled, the mosaic is flat; unlevelled it would step from 5 to 7 (the overlap) to 9
  let lo = Infinity, hi = -Infinity; for (const v of both.img) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(hi - lo < 1e-9, `step across the seam ${hi - lo}`);
  // one tile: its own pixels less their median, as before
  const ref = B.toGrid(a.int.data, new Uint8Array(w * ht).fill(1), w, ht, B.sinMap(a.int.h, grid)).g, med = B.nanmedian(ref);
  for (let k = 0; k < N * N; k += 997) assert.ok(Object.is(one.img[k], ref[k] - med) || Math.abs(one.img[k] - (ref[k] - med)) < 1e-12);
  assert.deepEqual(both.meta.dates, ['2010-01-07', '2010-07-31']);
});

// C-0177 W2 once the field is covered (2026-11-24): calibrated on 35 stars, but nothing star-shaped at the spot in 2010,
// so the ratio is over nothing and the drawn-frame checks fail with it. The page says what is missing, once.
test('a spot with no dot in one picture is said plainly, without the display checks that follow from it', async () => {
  const { bandMessage } = await import('../live/blinkworker.js');
  const ok = Object.fromEntries(['finite', 'band_match', 'old_footprint', 'spherex_footprint', 'spectral_coverage_at_lead', 'qualified_stars', 'display_field_ratio'].map(k => [k, true]));
  const rep = found => ({ checks: { ...ok, lead_same_place: false, display_lead_ratio: false }, lead_found: found, old: {}, spherex: {} });
  const m = bandMessage('W2', rep({ old: false, spherex: true }));
  assert.equal(m.state, 'inconclusive'); assert.equal(m.reason, 'the older picture shows no clear dot at this spot');
  assert.equal(bandMessage('W2', rep({ old: true, spherex: false })).reason, 'SPHEREx shows no clear dot at this spot now');
  assert.equal(bandMessage('W2', rep({ old: true, spherex: true })).reason, 'nothing sits at the same spot in both pictures');
  assert.equal(bandMessage('W2', rep(undefined)).reason, 'nothing sits at the same spot in both pictures', 'a report from before lead_found');
});
