// node --test worker/sky_index.test.mjs
// The fixture index holds the 60 D1 images IRSA's SIA gave for Barnard's Star (barnard_d1.json, the live site's saved
// /api/images answer) plus one of them copied under qr3/, to check the DR1-first rule. d1_b.bin is the same without
// image 2025W35_1A_0658_1, standing in for a rebuilt file. Both built with bake/sky_index.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skyImages, skyImagesJson, skyHead, cellAt, eclipticLat } from './src/sky_index.js';

const dir = new URL('./fixtures/sky/', import.meta.url);
const A = readFileSync(new URL('d1.bin', dir)), B = readFileSync(new URL('d1_b.bin', dir));
const saved = JSON.parse(readFileSync(new URL('barnard_d1.json', dir)));
const DROPPED = '2025W35_1A_0658_1';

// a stored d1.bin: its bytes and etag, and every read logged; `file` can be swapped to stand for a replaced object
let file = { bytes: A, etag: 'A' };
const reads = [];
const read = async (name, off, len) => {
  reads.push([name, off, len]);
  if (name !== 'd1.bin') throw new Error(`no ${name}`);
  const { bytes, etag } = file;
  return { buf: bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + Math.min(off + len, bytes.length)), etag, size: bytes.length };
};
const use = (bytes, etag) => { file = { bytes, etag }; };
const json = async (ra, dec) => JSON.stringify({ ra, dec, det: 'D1', ...(await skyImages(read, ra, dec, 1)), source: 'index' });

test("Barnard's Star: the same images, times and keys as IRSA's answer", async () => {
  use(A, 'A');
  const r = await skyImages(read, saved.ra, saved.dec, 1);
  assert.deepEqual(r.images, saved.images);
  // the qr3 copy is counted in its collection but its row is the DR1 one
  assert.deepEqual(r.collections, { spherex_dr1: saved.collections.spherex_dr1, spherex_qr3: saved.collections.spherex_qr3 + 1 });
});

test("the JSON writer gives JSON.stringify's bytes, here and where nothing matches", async () => {
  use(A, 'A');
  for (const [ra, dec] of [[saved.ra, saved.dec], [10, 10], [270, 66.560708]]) assert.equal(await skyImagesJson(read, ra, dec, 1), await json(ra, dec));
});

test('the head is read once per file, then one read per answer', async () => {
  use(A, 'A');
  await skyImages(read, saved.ra, saved.dec, 1);
  reads.length = 0;
  await skyImages(read, saved.ra, saved.dec, 1);
  assert.equal(reads.length, 1);
});

test('a file replaced under requests that hold the old head: every answer comes from the new file', async () => {
  use(A, 'A');
  await skyHead(read, 1);   // both requests below start with A's head
  use(B, 'B');
  const [one, two] = await Promise.all([skyImages(read, saved.ra, saved.dec, 1), skyImages(read, saved.ra, saved.dec, 1)]);
  const want = saved.images.filter(i => i.obs !== DROPPED);
  assert.deepEqual(one.images, want);
  assert.deepEqual(two.images, want);
  assert.deepEqual((await skyImages(read, saved.ra, saved.dec, 1)).images, want);
  use(A, 'A');
  assert.deepEqual((await skyImages(read, saved.ra, saved.dec, 1)).images, saved.images);
});

test('a file replaced between the reads of one request is read again, not mixed', async () => {
  use(A, 'A');
  await skyHead(read, 1);
  const r0 = read;
  let swapped = false;
  const sneaky = async (name, off, len) => { const r = await r0(name, off, len); if (!swapped) { swapped = true; use(B, 'B'); } return r; };
  // the first read (the cell's rows, with A's head) still returns A, then the object becomes B: the answer is A's
  // whole or B's whole, never A's head over B's rows
  const got = (await skyImages(sneaky, saved.ra, saved.dec, 1)).images;
  assert.ok([JSON.stringify(saved.images), JSON.stringify(saved.images.filter(i => i.obs !== DROPPED))].includes(JSON.stringify(got)));
  use(A, 'A');
});

test('a truncated file, a short read and corrupt values throw (the Worker then asks IRSA), never a short answer', async () => {
  use(A.subarray(0, A.length - 64), 'cut');   // one row short: the size no longer fits the head
  await assert.rejects(skyImages(read, saved.ra, saved.dec, 1), /bytes, its head says/);
  use(A, 'A');
  await skyHead(read, 1);
  const short = async (name, off, len) => { const r = await read(name, off, len); return off ? { ...r, buf: r.buf.slice(0, len - 64) } : r; };
  await assert.rejects(skyImages(short, saved.ra, saved.dec, 1), /wanted \d+ bytes/);
  // corrupt one field of every row of the cell at once, in a copy
  const cell = cellAt(saved.ra, saved.dec), v = new DataView(A.buffer, A.byteOffset);
  const cells = v.getUint32(12, true), fbytes = v.getUint32(20, true), size = 24 + 4 * (cells + 1) + fbytes, rowsAt = size + (-size & 7);
  const first = v.getUint32(24 + 4 * cell, true), last = v.getUint32(24 + 4 * (cell + 1), true);
  const corrupt = (field, label, value) => {
    const c = Buffer.from(A), w = new DataView(c.buffer, c.byteOffset);
    for (let i = first; i < last; i++) field(w, rowsAt + i * 64, value);
    return [c, label];
  };
  for (const [bytes, label] of [
    corrupt((w, o, x) => w.setFloat64(o, x, true), 't', NaN),
    corrupt((w, o, x) => w.setFloat64(o, x, true), 't', 1e9),
    corrupt((w, o, x) => w.setFloat32(o + 8, x, true), 'normal', NaN),
    corrupt((w, o, x) => w.setUint8(o + 61, x), 'collection', 7),
    corrupt((w, o, x) => w.setUint16(o + 56, x, true), 'folder', 60000),
  ]) {
    use(bytes, label);
    await assert.rejects(skyImages(read, saved.ra, saved.dec, 1), /row \d+ has/, label);
    await assert.rejects(skyImagesJson(read, saved.ra, saved.dec, 1), /row \d+ has/, label);
  }
  use(A, 'A');
});

test("off a corner, SIA's 3.6 arcsec circle is round: 2.5 arcsec counts, 4.3 arcsec does not (both 1.8 and 3.0 from the edges)", async () => {
  use(A, 'A');
  const has = async (ra, dec) => (await skyImages(read, ra, dec, 1)).images.some(i => i.obs === '2025W35_1A_0432_4');
  // eval/cornerpts.py: along the outward diagonal of the (2040.5, 2040.5) corner; IRSA's SIA lists the first, not the second
  assert.equal(await has(270.281382, 4.65094), true);
  assert.equal(await has(270.281742, 4.650592), false);
  assert.equal(await has(270.2732387544, 8.1362673785), false);   // Codex's probe, 4.32 arcsec from another corner
});

test('a spot no fixture image covers answers no images, and errors pass through', async () => {
  use(A, 'A');
  assert.deepEqual((await skyImages(read, 10, 10, 1)).images, []);
  await assert.rejects(skyImages(read, 10, 10, 2), /no d2.bin/);
});

test('deep collections are searched only within 15 degrees of the ecliptic poles', async () => {
  use(A, 'A');
  assert.ok(Math.abs(eclipticLat(270, 66.560708) - 90) < 1e-3);
  assert.deepEqual(Object.keys((await skyImages(read, 270, 52.0607, 1)).collections), ['spherex_dr1', 'spherex_qr3', 'spherex_dr1_deep', 'spherex_qr3_deep']);
  assert.deepEqual(Object.keys((await skyImages(read, 270, 51.0607, 1)).collections), ['spherex_dr1', 'spherex_qr3']);
});

test('the poles and RA near 360 stay inside the grid', () => {
  assert.equal(cellAt(0, 90), 0);
  assert.equal(cellAt(359.999, -90), cellAt(0, -89.9) + Math.floor(359.999 / 360 * 3));
});
