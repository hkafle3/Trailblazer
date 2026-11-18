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
