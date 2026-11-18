// node --test worker/sky_index_region.test.mjs
// A region search of the sky index (Codex review 4): every image whose footprint comes within r of a point, read from
// every cell the region can touch. The case it exists for: an image whose corner pokes into the middle of the 12 arcmin
// field's east edge, holding none of the field's centre and corners (the five points the blink used to search at).
// The index here is built in the test, in the format bake/sky_index.py writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { skyImages, cellAt } from './src/sky_index.js';

const RAD = Math.PI / 180, RA0 = 84.018, DEC0 = -6.5775, H = 0.1003;   // the field: centre, half width (degrees)
const vec = (ra, dec) => [Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD)];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
// tangent-plane offset (east, north degrees) about the field centre -> ra, dec
function sky(e, n) {
  const x = e * RAD, y = n * RAD, d0 = DEC0 * RAD, rho = Math.hypot(x, y); if (!rho) return [RA0, DEC0];
  const c = Math.atan(rho), dec = Math.asin(Math.cos(c) * Math.sin(d0) + y * Math.sin(c) * Math.cos(d0) / rho);
  return [RA0 + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c)) / RAD, dec / RAD];
}
// a 3.5 degree square image, corners given as tangent-plane offsets, as four inward unit normals
function footprint(corners) {
  const v = corners.map(([e, n]) => vec(...sky(e, n))), mid = unit(v.reduce((s, x) => s.map((c, i) => c + x[i]), [0, 0, 0]));
  return [0, 1, 2, 3].map(k => { const n = unit(cross(v[k], v[(k + 1) % 4])); return dot(n, mid) < 0 ? n.map(c => -c) : n; });
}
const D = 3.5, S2 = Math.SQRT2;
const square = (e0, n0, rot) => [0, 1, 2, 3].map(k => { const a = rot + k * Math.PI / 2; return [e0 + D / S2 * Math.cos(a), n0 + D / S2 * Math.sin(a)]; });
// A: rotated 45 degrees, its west corner 0.03 degree inside the field's east edge, at the edge's middle
const tipE = H - 0.03, A = [[tipE, 0], [tipE + D / S2, D / S2], [tipE + D * S2, 0], [tipE + D / S2, -D / S2]];
const IMAGES = [
  { name: 'A', seq: 1, corners: A },
  { name: 'centre', seq: 2, corners: square(0.5, 0.4, 0.3) },   // covers the field's centre
  { name: 'far', seq: 3, corners: square(6, 0, 0.2) },          // nowhere near
];

function build(det = 1) {
  const folder = 'dr1/level2/2025W38_1A/l2b-v27-2026-237', fb = new TextEncoder().encode(folder);
  let cells = 0; for (let i = 0, d = 180 / 51; i < 51; i++) cells += Math.max(1, Math.round(360 * Math.cos((90 - (i + .5) * d) * RAD) / 3.5));
  // each image in the cells its corners and the field's corners fall in (what the builder's padded box gives here)
  const by = Array.from({ length: cells }, () => []);
  for (const im of IMAGES) {
    const cs = new Set([...im.corners, [H, H], [-H, H], [H, -H], [-H, -H], [0, 0]].map(([e, n]) => cellAt(...(([r, d]) => [(r + 360) % 360, d])(sky(e, n)))));
    for (const c of cs) by[c].push(im);
  }
  const rows = by.flat(), size = 24 + 4 * (cells + 1) + fb.length, rowsAt = size + (-size & 7), buf = new ArrayBuffer(rowsAt + 64 * rows.length), v = new DataView(buf);
  [0x49594b53, 2, det, cells, rows.length, fb.length].forEach((x, i) => v.setUint32(4 * i, x, true));
  let k = 0; for (let c = 0; c <= cells; c++) { v.setUint32(24 + 4 * c, k, true); if (c < cells) k += by[c].length; }
  new Uint8Array(buf).set(fb, 24 + 4 * (cells + 1));
  rows.forEach((im, i) => {
    const o = rowsAt + 64 * i; v.setFloat64(o, 60930 + im.seq / 10, true);
    footprint(im.corners).flat().forEach((x, j) => v.setFloat32(o + 8 + 4 * j, x, true));
    v.setUint16(o + 56, 0, true); v.setUint16(o + 58, im.seq, true); v.setUint8(o + 60, 1); v.setUint8(o + 61, 0);
  });
  return new Uint8Array(buf);
}
const bytes = build(), etag = createHash('md5').update(bytes).digest('hex');
const read = async (name, off, len) => ({ buf: bytes.buffer.slice(off, Math.min(off + len, bytes.length)), etag, size: bytes.length });
const names = r => r.images.map(x => x.obs.split('_').at(-2)).map(s => ({ '0001': 'A', '0002': 'centre', '0003': 'far' }[s])).sort();

test('the five old points miss an image that pokes into the middle of the field edge', async () => {
  const seen = new Set();
  for (const [e, n] of [[0, 0], [H, H], [-H, H], [H, -H], [-H, -H]]) for (const x of names(await skyImages(read, ...sky(e, n), 1, etag))) seen.add(x);
  assert.deepEqual([...seen].sort(), ['centre']);
  assert.deepEqual(names(await skyImages(read, ...sky(H - 0.01, 0), 1, etag)), ['A', 'centre'], 'A does cover the field, inside its east edge');
});

test('a region search over the whole field finds it, and not the far image', async () => {
  const r = await skyImages(read, RA0, DEC0, 1, etag, H * Math.SQRT2 + 0.001);
  assert.deepEqual(names(r), ['A', 'centre']);
  assert.deepEqual(r.collections, { spherex_dr1: 2, spherex_qr3: 0 });
  assert.deepEqual(names(await skyImages(read, RA0, DEC0, 1, etag)), ['centre'], 'without r: the point search as before');
});
