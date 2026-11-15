// node --test worker/sky_index.test.mjs
// The fixture index holds the 60 D1 images IRSA's SIA gave for Barnard's Star (barnard_d1.json, the live site's saved
// /api/images answer) plus one of them copied under qr3/, to check the DR1-first rule. Built with bake/sky_index.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skyImages, cellAt, eclipticLat } from './src/sky_index.js';

const dir = new URL('./fixtures/sky/', import.meta.url);
const file = readFileSync(new URL('d1.bin', dir));
const reads = [];
const read = async (name, off, len) => {
  reads.push([name, off, len]);
  if (name !== 'd1.bin') throw new Error(`no ${name}`);
  return file.buffer.slice(file.byteOffset + off, file.byteOffset + off + len);
};
const saved = JSON.parse(readFileSync(new URL('barnard_d1.json', dir)));

test("Barnard's Star: the same images, times and keys as IRSA's answer", async () => {
  const r = await skyImages(read, saved.ra, saved.dec, 1);
  assert.deepEqual(r.images, saved.images);
  // the qr3 copy is counted in its collection but its row is the DR1 one
  assert.deepEqual(r.collections, { spherex_dr1: saved.collections.spherex_dr1, spherex_qr3: saved.collections.spherex_qr3 + 1 });
});

test('the head is read once per file, then one read per answer', async () => {
  reads.length = 0;
  await skyImages(read, saved.ra, saved.dec, 1);
  assert.equal(reads.length, 1);
});

test('a spot no fixture image covers answers no images, and errors pass through', async () => {
  assert.deepEqual((await skyImages(read, 10, 10, 1)).images, []);
  await assert.rejects(skyImages(read, 10, 10, 2), /no d2.bin/);
});

test('deep collections are searched only within 15 degrees of the ecliptic poles', async () => {
  assert.ok(Math.abs(eclipticLat(270, 66.560708) - 90) < 1e-3);
  assert.deepEqual(Object.keys((await skyImages(read, 270, 52.0607, 1)).collections), ['spherex_dr1', 'spherex_qr3', 'spherex_dr1_deep', 'spherex_qr3_deep']);
  assert.deepEqual(Object.keys((await skyImages(read, 270, 51.0607, 1)).collections), ['spherex_dr1', 'spherex_qr3']);
});

test('the poles and RA near 360 stay inside the grid', () => {
  assert.equal(cellAt(0, 90), 0);
  assert.equal(cellAt(359.999, -90), cellAt(0, -89.9) + Math.floor(359.999 / 360 * 3));
});
