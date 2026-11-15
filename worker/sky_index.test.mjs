// node --test worker/sky_index.test.mjs
// The fixture index holds the 60 D1 images IRSA's SIA gave for Barnard's Star (barnard_d1.json, the live site's saved
// /api/images answer) plus one of them copied under qr3/, to check the DR1-first rule. d1_b.bin is the same without
// image 2025W35_1A_0658_1, standing in for a rebuilt file. Both built with bake/sky_index.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { skyImages, skyImagesJson, skyHead, cellAt, eclipticLat } from './src/sky_index.js';

const dir = new URL('./fixtures/sky/', import.meta.url);
const A = readFileSync(new URL('d1.bin', dir)), B = readFileSync(new URL('d1_b.bin', dir));
const saved = JSON.parse(readFileSync(new URL('barnard_d1.json', dir)));
const DROPPED = '2025W35_1A_0658_1';
const md5 = bytes => createHash('md5').update(bytes).digest('hex');   // R2's etag for a single-part upload

// The stored d1.bin (etag: its MD5, as R2 gives) and the pinned etag the Worker was deployed with (SKY_ETAG_D1).
// use() swaps the object in the bucket; deploy() also pins it, as a refresh does.
let file = { bytes: A, etag: md5(A) }, pin = md5(A);
const reads = [];
const read = async (name, off, len) => {
  reads.push([name, off, len]);
  if (name !== 'd1.bin') throw new Error(`no ${name}`);
  const { bytes, etag } = file;
  return { buf: bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + Math.min(off + len, bytes.length)), etag, size: bytes.length };
};
const use = bytes => { file = { bytes, etag: md5(bytes) }; };
const deploy = bytes => { use(bytes); pin = md5(bytes); };
const ask = (ra, dec, r = read, det = 1) => skyImages(r, ra, dec, det, pin);
const json = async (ra, dec) => JSON.stringify({ ra, dec, det: 'D1', ...(await ask(ra, dec)), source: 'index' });

test("Barnard's Star: the same images, times and keys as IRSA's answer", async () => {
  deploy(A);
  const r = await ask(saved.ra, saved.dec);
  assert.deepEqual(r.images, saved.images);
  // the qr3 copy is counted in its collection but its row is the DR1 one
  assert.deepEqual(r.collections, { spherex_dr1: saved.collections.spherex_dr1, spherex_qr3: saved.collections.spherex_qr3 + 1 });
});

test("the JSON writer gives JSON.stringify's bytes, here and where nothing matches", async () => {
  deploy(A);
  for (const [ra, dec] of [[saved.ra, saved.dec], [10, 10], [270, 66.560708]]) assert.equal(await skyImagesJson(read, ra, dec, 1, pin), await json(ra, dec));
});

test('the head is read once per file, then one read per answer', async () => {
  deploy(A);
  await ask(saved.ra, saved.dec);
  reads.length = 0;
  await ask(saved.ra, saved.dec);
  assert.equal(reads.length, 1);
});

test('a file replaced under requests that hold the old head: refused until its etag is pinned, then answered from it', async () => {
  deploy(A);
  await skyHead(read, 1, pin);   // both requests below start with A's head
  use(B);   // the object changes, the Worker's pin does not: both refuse (the Worker asks IRSA)
  const both = await Promise.allSettled([ask(saved.ra, saved.dec), ask(saved.ra, saved.dec)]);
  assert.deepEqual(both.map(r => r.status), ['rejected', 'rejected']);
  pin = md5(B);   // deployed with B pinned; this instance still holds A's head
  const want = saved.images.filter(i => i.obs !== DROPPED);
  const [one, two] = await Promise.all([ask(saved.ra, saved.dec), ask(saved.ra, saved.dec)]);
  assert.deepEqual(one.images, want);
  assert.deepEqual(two.images, want);
  deploy(A);
  assert.deepEqual((await ask(saved.ra, saved.dec)).images, saved.images);
});

test('a file replaced between the reads of one request is read again, not mixed', async () => {
  deploy(A);
  await skyHead(read, 1, pin);
  const r0 = read;
  let swapped = false;
  const sneaky = async (name, off, len) => { const r = await r0(name, off, len); if (!swapped) { swapped = true; use(B); } return r; };
  // the first read (the cell's rows, with A's head) still returns A, then the object becomes B: the answer is A's
  // whole or B's whole, never A's head over B's rows
  // with A pinned, the answer is A's whole (the swap came after the last read) or a refusal, never A's head over B's rows
  const got = await skyImages(sneaky, saved.ra, saved.dec, 1, pin).then(r => r.images, () => 'refused');
  assert.ok(got === 'refused' || JSON.stringify(got) === JSON.stringify(saved.images));
  deploy(A);
});

test('a truncated file, a short read and corrupt values throw (the Worker then asks IRSA), never a short answer', async () => {
  deploy(A.subarray(0, A.length - 64));   // one row short, even pinned: the size no longer fits the head
  await assert.rejects(ask(saved.ra, saved.dec), /bytes, its head says/);
  deploy(A);
  await skyHead(read, 1, pin);
  const short = async (name, off, len) => { const r = await read(name, off, len); return off ? { ...r, buf: r.buf.slice(0, len - 64) } : r; };
  await assert.rejects(ask(saved.ra, saved.dec, short), /wanted \d+ bytes/);
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
    use(bytes);   // not the pinned file: refused at once
    await assert.rejects(ask(saved.ra, saved.dec), /etag|replaced|another version/, label);
    deploy(bytes);   // even pinned, the per-row checks refuse it
    await assert.rejects(ask(saved.ra, saved.dec), /row \d+ has/, label);
    await assert.rejects(skyImagesJson(read, saved.ra, saved.dec, 1, pin), /row \d+ has/, label);
  }
  deploy(A);
});

// A's layout, and a copy of A with `edit(view, rowOffset)` applied to every row of one cell
const layout = (() => {
  const v = new DataView(A.buffer, A.byteOffset), cells = v.getUint32(12, true), size = 24 + 4 * (cells + 1) + v.getUint32(20, true);
  return { cells, rowsAt: size + (-size & 7), first: c => v.getUint32(24 + 4 * c, true) };
})();
const editCell = (ra, dec, edit) => {
  const c = Buffer.from(A), w = new DataView(c.buffer, c.byteOffset), cell = cellAt(ra, dec);
  for (let i = layout.first(cell); i < layout.first(cell + 1); i++) edit(w, layout.rowsAt + i * 64, i - layout.first(cell));
  return c;
};

test('broken footprints throw even where the row would not match: zero normals, and NaN behind a failing edge', async () => {
  // all normals zero: every n . p is 0, which passed the old edge test, so every row "matched"
  deploy(editCell(268, 5.5, (w, o) => { for (let k = 0; k < 12; k++) w.setFloat32(o + 8 + 4 * k, 0, true); }));   // pinned, to reach the row checks
  await assert.rejects(ask(268, 5.5), /row \d+ has/);
  // one row: its first edge faces away from Barnard's Star (so the old loop stopped there) and its last normal is NaN
  const r = saved.ra * Math.PI / 180, d = saved.dec * Math.PI / 180, p = [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
  deploy(editCell(saved.ra, saved.dec, (w, o, k) => {
    if (k) return;
    p.forEach((x, m) => w.setFloat32(o + 8 + 4 * m, -x, true));
    w.setFloat32(o + 8 + 36, NaN, true);
  }));
  await assert.rejects(ask(saved.ra, saved.dec), /row \d+ has/);
  deploy(A);
});

test('an empty cell is checked against the file too: replaced by a full one, or deleted', async () => {
  // E: A's head with no rows at all, a valid empty index
  const E = Buffer.from(A.subarray(0, layout.rowsAt)), w = new DataView(E.buffer, E.byteOffset);
  w.setUint32(16, 0, true);
  for (let c = 0; c <= layout.cells; c++) w.setUint32(24 + 4 * c, 0, true);
  deploy(E);
  assert.deepEqual((await ask(saved.ra, saved.dec)).images, []);
  use(A);   // replaced under the same pin: the empty answer must not stand (refused; the Worker asks IRSA)
  await assert.rejects(ask(saved.ra, saved.dec));
  deploy(E);
  await ask(saved.ra, saved.dec);
  file = { bytes: null, etag: null };   // deleted: every read fails, so the Worker asks IRSA
  const gone = async (name, off, len) => { if (!file.bytes) throw new Error(`${name} is not in the sky index bucket`); return read(name, off, len); };
  await assert.rejects(ask(saved.ra, saved.dec, gone), /not in the sky index bucket/);
  deploy(A);
});

test("Codex's round 3 corruptions get past the per-row checks, so the pinned etag refuses them", async () => {
  const p = (ra, dec) => { const r = ra * Math.PI / 180, d = dec * Math.PI / 180; return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]; };
  const normal = (w, o, k) => [0, 1, 2].map(m => w.getFloat32(o + 8 + 12 * k + 4 * m, true));
  const setNormal = (w, o, k, v) => v.forEach((x, m) => w.setFloat32(o + 8 + 12 * k + 4 * m, x, true));
  const cases = {
    // a matching row with one normal flipped: the point fails that edge, the row is skipped before any shape check
    'flipped normal': editCell(saved.ra, saved.dec, (w, o, k) => { if (k === 5) setNormal(w, o, 2, normal(w, o, 2).map(x => -x)); }),
    // a collapsed footprint: edge 2 exactly opposite edge 0 (zero width, yet opposite edges "face each other")
    'collapsed footprint': editCell(268, 5.5, (w, o, k) => { if (!k) setNormal(w, o, 2, normal(w, o, 0).map(x => -x)); }),
    // t not on 6 decimals (the answer's bytes would differ from IRSA's), and two rows out of time order
    't not canonical': editCell(saved.ra, saved.dec, (w, o, k) => { if (!k) w.setFloat64(o, w.getFloat64(o, true) + 1e-7, true); }),
    't out of order': editCell(saved.ra, saved.dec, (w, o, k) => { if (k < 2) w.setFloat64(o, w.getFloat64(o, true) + (k ? -1 : 1) * 0.5, true); }),
  };
  deploy(A);
  for (const [label, bytes] of Object.entries(cases)) {
    use(bytes);
    await assert.rejects(ask(saved.ra, saved.dec), undefined, label);
    await assert.rejects(ask(268, 5.5), undefined, label);
  }
  // the reason the pin is needed: pinned, the flipped normal would quietly drop an image
  deploy(cases['flipped normal']);
  assert.equal((await ask(saved.ra, saved.dec)).images.length, saved.images.length - 1);
  deploy(A);
});

test("off a corner, SIA's 3.6 arcsec circle is round: 2.5 arcsec counts, 4.3 arcsec does not (both 1.8 and 3.0 from the edges)", async () => {
  deploy(A);
  const has = async (ra, dec) => (await ask(ra, dec)).images.some(i => i.obs === '2025W35_1A_0432_4');
  // eval/cornerpts.py: along the outward diagonal of the (2040.5, 2040.5) corner; IRSA's SIA lists the first, not the second
  assert.equal(await has(270.281382, 4.65094), true);
  assert.equal(await has(270.281742, 4.650592), false);
  assert.equal(await has(270.2732387544, 8.1362673785), false);   // Codex's probe, 4.32 arcsec from another corner
});

test('a spot no fixture image covers answers no images, and errors pass through', async () => {
  deploy(A);
  assert.deepEqual((await ask(10, 10)).images, []);
  await assert.rejects(ask(10, 10, read, 2), /no d2.bin/);
});

test('deep collections are searched only within 15 degrees of the ecliptic poles', async () => {
  deploy(A);
  assert.ok(Math.abs(eclipticLat(270, 66.560708) - 90) < 1e-3);
  assert.deepEqual(Object.keys((await ask(270, 52.0607)).collections), ['spherex_dr1', 'spherex_qr3', 'spherex_dr1_deep', 'spherex_qr3_deep']);
  assert.deepEqual(Object.keys((await ask(270, 51.0607)).collections), ['spherex_dr1', 'spherex_qr3']);
});

test('the poles and RA near 360 stay inside the grid', () => {
  assert.equal(cellAt(0, 90), 0);
  assert.equal(cellAt(359.999, -90), cellAt(0, -89.9) + Math.floor(359.999 / 360 * 3));
});
