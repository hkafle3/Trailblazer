// node --test worker/saved.test.mjs: which /api/images answers are saved to D1 (worker/src/saved.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { worthSaving, SAVE_MAX_BYTES } from './src/saved.js';
const res = n => new Response('x', { headers: n === null ? {} : { 'X-Answer-Bytes': String(n) } });
test('answers over 64 KB are not saved; ordinary ones and IRSA answers (no size header) are', () => {
  assert.equal(SAVE_MAX_BYTES, 65536);
  assert.equal(worthSaving(res(10883)), true, 'the showcase spot, 10.9 KB');
  assert.equal(worthSaving(res(65536)), true);
  assert.equal(worthSaving(res(65537)), false);
  assert.equal(worthSaving(res(884873)), false, 'the north ecliptic pole on D5, 880 KB');
  assert.equal(worthSaving(res(null)), true, 'an answer from IRSA: saved as before');
});
