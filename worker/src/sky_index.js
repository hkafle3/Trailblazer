// Our own index of SPHEREx level-2 images, built by bake/sky_index.py from the image headers on NASA's S3 bucket.
// It answers what IRSA's SIA search answered for /api/images: which images of one detector cover a sky position.
// One file per detector (d1.bin .. d6.bin). Its head lists, per sky cell, where that cell's rows start; a request reads
// the head (once per Worker instance) and one cell's rows. The storage is the caller's choice: `read(name, offset,
// length)` resolves to { buf: ArrayBuffer, etag, size } (size: the whole file's), from R2 or a test's local file.
// `pin` is the etag of the one file version to accept (wrangler.toml SKY_ETAG_D1..D6: the MD5 of the file as built
// and checked by bake/sky_index.py); any other version, replaced, truncated or corrupted, throws.
//
// A row is one image in one cell: its start time, its footprint as four great-circle edges (unit normals, the image
// is where every n . p >= 0) and the pieces of its obs_id and S3 key. The footprint is IRSA's own s_region (the outer
// pixel edges' corners); SIA counts an image when its 0.001 degree search circle touches that polygon, and so do we.
//
// Anything wrong with what a read returns (a short read, a file replaced between reads, a value no index holds) throws:
// a wrong answer would be cached for a day and saved, so the caller falls back to IRSA instead.

const ROW = 64, COLLS = ['spherex_dr1', 'spherex_qr3', 'spherex_dr1_deep', 'spherex_qr3_deep'];
const COLL_END = COLLS.map(c => `","coll":"${c}"}`);   // the end of a row's JSON text
const RAD = Math.PI / 180, R = 0.001 * RAD;   // SIA's search circle, 0.001 deg
const TOL = -Math.sin(R), NEAR = Math.cos(R);   // within R of an edge's great circle; within R of a vertex

// Sky cells: 51 bands of Dec from the north pole, each cut into about 3.5 degree steps of RA (the heat map's grid,
// cellAt in index.js). bake/sky_index.py has the Python twin; both must agree.
const BANDS = 51, DEC_STEP = 180 / BANDS, GRID = [];
for (let i = 0, k = 0; i < BANDS; i++) {
  const n = Math.max(1, Math.round(360 * Math.cos((90 - (i + .5) * DEC_STEP) * RAD) / 3.5));
  GRID.push([k, n]); k += n;
}
export const cellAt = (ra, dec) => {
  const i = Math.min(BANDS - 1, Math.floor((90 - dec) / DEC_STEP)), [k, n] = GRID[i];
  return k + Math.min(n - 1, Math.floor(ra / 360 * n));
};

// The Deep Survey covers the ecliptic poles; /api/images only searches the deep collections where |beta| > 75
export const eclipticLat = (ra, dec) => {
  const e = 23.4393 * RAD, a = ra * RAD, d = dec * RAD;
  return Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a)) / RAD;
};

const heads = new Map();   // file name -> parsed head (a promise, so concurrent requests share one read)

// exactly `length` bytes of the file, from the same version of it (etag) when one is given
async function get(read, name, offset, length, etag) {
  const r = await read(name, offset, length);
  if (!(r?.buf instanceof ArrayBuffer) || r.buf.byteLength !== length) throw new Error(`${name}: wanted ${length} bytes at ${offset}, got ${r?.buf?.byteLength}`);
  if (etag !== undefined && r.etag !== etag) throw new Error(`${name} was replaced while it was being read`);
  return r;
}

async function head(read, name, det, pin) {
  // only the pinned version of the file is accepted: the one bake/sky_index.py built and checked, as uploaded
  if (!pin) throw new Error(`no pinned etag for ${name}`);
  const fixed = await get(read, name, 0, 24, pin), v = new DataView(fixed.buf), etag = fixed.etag;
  if (v.getUint32(0, true) !== 0x49594b53 || v.getUint32(4, true) !== 2) throw new Error(`${name} is not a version 2 sky index`);
  const cells = v.getUint32(12, true), rows = v.getUint32(16, true), fbytes = v.getUint32(20, true);
  if (v.getUint32(8, true) !== Number(det)) throw new Error(`${name} is for another detector`);
  if (cells !== GRID[BANDS - 1][0] + GRID[BANDS - 1][1]) throw new Error(`${name} uses another cell grid`);
  const size = 24 + 4 * (cells + 1) + fbytes, rowsAt = size + (-size & 7);
  if (fixed.size !== rowsAt + rows * ROW) throw new Error(`${name} is ${fixed.size} bytes, its head says ${rowsAt + rows * ROW}`);
  const buf = (await get(read, name, 0, size, etag)).buf;
  const first = new Uint32Array(buf.slice(24, 24 + 4 * (cells + 1)));
  if (first[0] !== 0 || first[cells] !== rows || first.some((f, c) => c && f < first[c - 1])) throw new Error(`${name} has a broken cell table`);
  const periods = new Map();
  const folders = new TextDecoder().decode(new Uint8Array(buf, 24 + 4 * (cells + 1), fbytes)).split('\n').map(f => {
    const [rel, l2, period, version, more] = f.split('/');
    // no character needs JSON escaping in a key, an obs_id or a collection
    if (!/^[\w.\/-]+$/.test(f) || !/^(dr1|qr3)$/.test(rel) || l2 !== 'level2' || !period || !version || more !== undefined) throw new Error(`${name} has a bad folder`);
    if (!periods.has(period)) periods.set(period, periods.size);
    const pre = `${f}/${det}/level2_${period}_`, post = `D${det}_spx_${version}.fits`;
    // a, b: the constant text around a row's "rest" (seq_sub) in the JSON writer
    return { pre, post, period, p: periods.get(period), a: `,"key":"${pre}`, b: `${post}","obs":"${period}_` };
  });
  return { etag, first, folders, rowsAt };
}

// The parsed head of one detector's file, read once per Worker instance (a failed read is retried next time)
export function skyHead(read, det, pin) {
  const name = `d${det}.bin`;
  if (!heads.has(name)) {
    const h = head(read, name, det, pin).catch(e => { if (heads.get(name) === h) heads.delete(name); throw e; });
    heads.set(name, h);
  }
  return heads.get(name);
}

// unit vector
const unit = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };

// Is p (x, y, z) within R of the polygon, though outside it (some edge's n . p < 0)? The nearest point of a convex
// polygon is a corner, or a point inside one edge's segment; widening each edge on its own (all n . p >= TOL) would
// also take points diagonally off a corner, up to R * sqrt(2) away. Corners come back as the crossing of neighbouring
// edges, the one on p's side. Only rows already within TOL of every edge get here.
function nearOutside(f32, j, x, y, z, d, near = NEAR) {
  const n = k => [f32[j + 3 * k], f32[j + 3 * k + 1], f32[j + 3 * k + 2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], p = [x, y, z];
  const corner = k => {   // where edge k - 1 meets edge k (edge k runs from corner k to corner k + 1)
    const v = unit(...cross(n((k + 3) % 4), n(k)));
    return dot(v, p) < 0 ? v.map(c => -c) : v;
  };
  const cs = [0, 1, 2, 3].map(corner);
  if (cs.some(v => dot(v, p) >= near)) return true;
  for (let k = 0; k < 4; k++) {
    if (d[k] >= 0) continue;
    const e = n(k), a = cs[k], b = cs[(k + 1) % 4];
    // p projects inside the segment a..b when it is between the planes through the edge normal and each end
    const ma = cross(e, a), mb = cross(e, b);
    if (dot(ma, p) * dot(ma, b) >= 0 && dot(mb, p) * dot(mb, a) >= 0) return true;   // and then its distance is asin(-d) <= r
  }
  return false;
}

// Which rows of (ra, dec)'s cell are the answer: row numbers in answer order, one per obs_id, and the number of matching
// images per collection searched. Rows are stored in time order, so the answer comes out sorted. An obs_id seen again
// in a lower (earlier listed) collection takes the place of the first one, as /api/images keeps DR1 first; only then is
// a re-sort needed. Plain numbers only: the two writers below turn the rows into objects or straight into JSON text.
// r (degrees): images within r of the point instead of SIA's 0.001; cell: which cell's rows to search (default the point's)
async function pickOnce(read, ra, dec, det, pin, r = 0.001, cell = null) {
  const tol = r === 0.001 ? TOL : -Math.sin(r * RAD), near = r === 0.001 ? NEAR : Math.cos(r * RAD);
  const name = `d${det}.bin`, hp = skyHead(read, det, pin), h = await hp;
  if (h.etag !== pin) { if (heads.get(name) === hp) heads.delete(name); throw new Error(`${name}: head from another version`); }
  try {
    const c = cell ?? cellAt(ra, dec), n = h.first[c + 1] - h.first[c];
    const deep = Math.abs(eclipticLat(ra, dec)) > 75;
    const collections = Object.fromEntries((deep ? COLLS : COLLS.slice(0, 2)).map(k => [k, 0]));
    // an empty cell is only an answer from the file the head came from: one small read checks it is still there, unchanged
    if (!n) { await get(read, name, 0, 24, h.etag); return { h, rows: [], collections }; }
    const buf = (await get(read, name, h.rowsAt + h.first[c] * ROW, n * ROW, h.etag)).buf;
    const f64 = new Float64Array(buf), f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
    const x = Math.cos(dec * RAD) * Math.cos(ra * RAD), y = Math.cos(dec * RAD) * Math.sin(ra * RAD), z = Math.sin(dec * RAD);
    const rows = [], at = new Map(), d = [0, 0, 0, 0];   // at: obs number -> place in rows; d: the row's n . p per edge
    let resort = false;
    const bad = i => { throw new Error(`${name}: row ${h.first[c] + i} has a value no index holds`); };
    for (let i = 0; i < n; i++) {
      // Every row of the cell is checked before it is used or skipped: its time, collection, folder, seq and sub in
      // range, and four unit normals (NaN, infinite and zero-length ones fail the length test). Written out inline:
      // this runs on every row, often before the code is warm, where a function call per row cost a millisecond.
      const t = f64[i * 8], coll = u8[i * ROW + 61], j = i * 16 + 2;
      if (!(t > 50000 && t < 80000) || coll > 3 || !h.folders[u16[i * 32 + 28]] || u16[i * 32 + 29] > 9999 || u8[i * ROW + 60] > 9) bad(i);
      const a0 = f32[j], a1 = f32[j + 1], a2 = f32[j + 2], b0 = f32[j + 3], b1 = f32[j + 4], b2 = f32[j + 5];
      const c0 = f32[j + 6], c1 = f32[j + 7], c2 = f32[j + 8], e0 = f32[j + 9], e1 = f32[j + 10], e2 = f32[j + 11];
      const ma = a0 * a0 + a1 * a1 + a2 * a2 - 1, mb = b0 * b0 + b1 * b1 + b2 * b2 - 1, mc = c0 * c0 + c1 * c1 + c2 * c2 - 1, me = e0 * e0 + e1 * e1 + e2 * e2 - 1;
      if (!(ma * ma + mb * mb + mc * mc + me * me < 1e-8)) bad(i);   // each |n|^2 within 1e-4 of 1; NaN fails too
      if (coll >= 2 && !deep) continue;
      d[0] = a0 * x + a1 * y + a2 * z; d[1] = b0 * x + b1 * y + b2 * z; d[2] = c0 * x + c1 * y + c2 * z; d[3] = e0 * x + e1 * y + e2 * z;
      if (d[0] < tol || d[1] < tol || d[2] < tol || d[3] < tol) continue;
      // within reach of the point: the footprint must be an image's before it is used or its corners worked out.
      // Opposite edges face each other (n . n' is -0.998 for a 3.5 degree square) and neighbours are far from parallel;
      // unit normals pointing anywhere else could cover half the sky. bake/sky_index.py checks the same at build time.
      if (!(a0 * c0 + a1 * c1 + a2 * c2 < -0.99 && b0 * e0 + b1 * e1 + b2 * e2 < -0.99 && Math.abs(a0 * b0 + a1 * b1 + a2 * b2) < 0.5 &&
        Math.abs(b0 * c0 + b1 * c1 + b2 * c2) < 0.5 && Math.abs(c0 * e0 + c1 * e1 + c2 * e2) < 0.5 && Math.abs(e0 * a0 + e1 * a1 + e2 * a2) < 0.5)) bad(i);
      if ((d[0] < 0 || d[1] < 0 || d[2] < 0 || d[3] < 0) && !nearOutside(f32, j, x, y, z, d, near)) continue;
      const fo = h.folders[u16[i * 32 + 28]], seq = u16[i * 32 + 29], sub = u8[i * ROW + 60];
      collections[COLLS[coll]]++;
      const id = (fo.p * 10000 + seq) * 10 + sub, had = at.get(id);
      if (had === undefined) { at.set(id, rows.length); rows.push(i); }
      else if (coll < u8[rows[had] * ROW + 61]) { rows[had] = i; resort = true; }
    }
    if (resort) rows.sort((a, b) => f64[a * 8] - f64[b * 8]);
    return { h, rows, collections, f64, u16, u8 };
  } catch (e) {
    if (heads.get(name) === hp) heads.delete(name);   // this head may be stale: the next try reads it again
    throw e;
  }
}

// A file replaced since this instance read its head shows as a different etag (or a range past its end): one more try
// with a fresh head. A second failure goes to the caller.
async function pick(read, ra, dec, det, pin, r, cell) {
  try { return await pickOnce(read, ra, dec, det, pin, r, cell); } catch { return await pickOnce(read, ra, dec, det, pin, r, cell); }
}
// A region (r over 0.001 degree): every cell the circle can touch. Cells are about 3.5 degrees, far larger than any r
// allowed (0.15), so a cell the circle's bounding box touches holds one of the box's corners; each image is stored in
// every cell its footprint touches, so the cell holding any point it shares with the circle is among these.
function regionCells(ra, dec, r) {
  const dr = Math.min(180, r / Math.max(Math.cos(Math.min(89.9, Math.abs(dec) + r) * RAD), 1e-6)), cs = new Set();
  for (const [a, d] of [[0, 0], [-dr, -r], [-dr, r], [dr, -r], [dr, r]]) cs.add(cellAt((((ra + a) % 360) + 360) % 360, Math.max(-90, Math.min(90, dec + d))));
  return [...cs];
}

// one row's fields; t is MJD-BEG to 6 decimals, the way SIA writes t_min. The file already holds it rounded (version
// 2); toFixed here keeps this reference path right on its own, and the JSON writer prints the stored value directly.
function fields(p, i) {
  const fo = p.h.folders[p.u16[i * 32 + 28]], rest = `${String(p.u16[i * 32 + 29]).padStart(4, '0')}_${p.u8[i * ROW + 60]}`;
  return [Number(p.f64[i * 8].toFixed(6)), fo.pre + rest + fo.post, `${fo.period}_${rest}`, COLLS[p.u8[i * ROW + 61]]];
}

// A region's rows as [pick, row] pairs (each pick holds its cell's buffers), one per obs_id with DR1 first, sorted by time,
// and the matching images per collection, each counted once. No strings or objects per row: the JSON writer below
// prints straight from the buffers, as the point search does (Codex re-review 1: building them cost 9x the point search).
async function pickRegion(read, ra, dec, det, pin, r) {
  // numbers only, no per-row objects: a row is (pick k, row i) packed as k * 2^21 + i; first[] keeps first-seen order,
  // which breaks ties in time as the stable sort of an insertion-ordered list did
  const picks = [], best = new Map(), mask = new Map(), first = new Map(); let collections = null, n = 0;
  for (const cell of regionCells(ra, dec, r)) {
    const p = await pick(read, ra, dec, det, pin, r, cell), k = picks.push(p) - 1;
    collections ??= Object.fromEntries(Object.keys(p.collections).map(c => [c, 0]));
    const u16 = p.u16, u8 = p.u8, folders = p.h.folders;
    for (let q = 0; q < p.rows.length; q++) {
      const i = p.rows[q], id = (folders[u16[i * 32 + 28]].p * 10000 + u16[i * 32 + 29]) * 10 + u8[i * ROW + 60], coll = u8[i * ROW + 61];
      const m = mask.get(id) ?? 0;
      if (!(m & (1 << coll))) { mask.set(id, m | (1 << coll)); collections[COLLS[coll]]++; }
      const had = best.get(id);
      if (had === undefined) { best.set(id, k * 2097152 + i); first.set(id, n++); }
      else if (coll < picks[Math.floor(had / 2097152)].u8[(had % 2097152) * ROW + 61]) best.set(id, k * 2097152 + i);
    }
  }
  const ids = [...best.keys()], ts = new Float64Array(ids.length), order = new Uint32Array(ids.length), firsts = new Float64Array(ids.length);
  for (let q = 0; q < ids.length; q++) { const v = best.get(ids[q]); ts[q] = picks[Math.floor(v / 2097152)].f64[(v % 2097152) * 8]; firsts[q] = first.get(ids[q]); order[q] = q; }
  order.sort((x, y) => ts[x] - ts[y] || firsts[x] - firsts[y]);
  const rows = new Array(ids.length);
  for (let q = 0; q < ids.length; q++) { const v = best.get(ids[order[q]]); rows[q] = [picks[Math.floor(v / 2097152)], v % 2097152]; }
  return { rows, collections: collections ?? {} };
}

// The images of one detector covering (ra, dec), or (r > 0.001) coming within r degrees of it:
// { images: [{ t, key, obs, coll }] sorted by t, collections }
export async function skyImages(read, ra, dec, det, pin, r = 0.001) {
  if (r !== 0.001) {
    const { rows, collections } = await pickRegion(read, ra, dec, det, pin, r);
    return { images: rows.map(([p, i]) => { const [t, key, obs, coll] = fields(p, i); return { t, key, obs, coll }; }), collections };
  }
  const p = await pick(read, ra, dec, det, pin);
  return { images: p.rows.map(i => { const [t, key, obs, coll] = fields(p, i); return { t, key, obs, coll }; }), collections: p.collections };
}

// The whole /api/images answer as JSON text, written straight from the rows: the same bytes as JSON.stringify of
// { ra, dec, det: 'D<det>', ...skyImages(), source: 'index' } (worker/sky_index.test.mjs checks it), without building
// thousands of objects first. A deep-field answer is about 1 MB and that building took most of a request's CPU.
// Numbers print as JSON.stringify prints them; keys, obs and collections need no escaping (head() checks the folders).
export async function skyImagesJson(read, ra, dec, det, pin, r = 0.001) {
  if (r !== 0.001) {
    const { rows, collections } = await pickRegion(read, ra, dec, det, pin, r);
    let s = `{"ra":${JSON.stringify(ra)},"dec":${JSON.stringify(dec)},"det":"D${det}","r":${JSON.stringify(r)},"images":[`;
    for (let k = 0; k < rows.length; k++) {
      const [p, i] = rows[k], fo = p.h.folders[p.u16[i * 32 + 28]], rest = String(p.u16[i * 32 + 29]).padStart(4, '0') + '_' + p.u8[i * ROW + 60];
      s += (k ? ',{"t":' : '{"t":') + p.f64[i * 8] + fo.a + rest + fo.b + rest + COLL_END[p.u8[i * ROW + 61]];
    }
    return `${s}],"collections":${JSON.stringify(collections)},"source":"index"}`;
  }
  const p = await pick(read, ra, dec, det, pin);
  let s = `{"ra":${JSON.stringify(ra)},"dec":${JSON.stringify(dec)},"det":"D${det}","images":[`;
  for (let k = 0; k < p.rows.length; k++) {   // fields() inlined, with the constant text cut once per folder
    const i = p.rows[k], fo = p.h.folders[p.u16[i * 32 + 28]], rest = String(p.u16[i * 32 + 29]).padStart(4, '0') + '_' + p.u8[i * ROW + 60];
    s += (k ? ',{"t":' : '{"t":') + p.f64[i * 8] + fo.a + rest + fo.b + rest + COLL_END[p.u8[i * ROW + 61]];
  }
  return `${s}],"collections":${JSON.stringify(p.collections)},"source":"index"}`;
}

// /api/images?fmt=2: the same images in the fields the browser reads, compactly: each image [t, folder, seq, sub] with
// its folder's key and obs text given once in folders ([pre, post, period]); the key is pre + seq (4 digits) + '_' + sub +
// post, the obs period + '_' + seq + '_' + sub (web/live/images.js turns it back). No per-image strings: at the north
// ecliptic pole (5,126 images) the answer is about a seventh of the full one and far cheaper to write.
export async function skyImagesCompact(read, ra, dec, det, pin, r = 0.001) {
  let rows, collections, one = null;
  if (r !== 0.001) ({ rows, collections } = await pickRegion(read, ra, dec, det, pin, r));
  else { one = await pick(read, ra, dec, det, pin); collections = one.collections; rows = one.rows; }
  const local = new Map(), folders = [];
  let s = '';
  for (let k = 0; k < rows.length; k++) {
    const p = one ?? rows[k][0], i = one ? rows[k] : rows[k][1], fo = p.h.folders[p.u16[i * 32 + 28]];
    let f = local.get(fo); if (f === undefined) { f = folders.length; local.set(fo, f); folders.push(fo); }
    s += (k ? ',[' : '[') + p.f64[i * 8] + ',' + f + ',' + p.u16[i * 32 + 29] + ',' + p.u8[i * ROW + 60] + ']';
  }
  return `{"ra":${JSON.stringify(ra)},"dec":${JSON.stringify(dec)},"det":"D${det}"${r !== 0.001 ? `,"r":${JSON.stringify(r)}` : ''},"fmt":2,"folders":${JSON.stringify(folders.map(fo => [fo.pre, fo.post, fo.period]))},"images":[${s}],"collections":${JSON.stringify(collections)},"source":"index"}`;
}
