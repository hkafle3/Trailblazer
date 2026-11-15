// Our own index of SPHEREx level-2 images, built by bake/sky_index.py from the image headers on NASA's S3 bucket.
// It answers what IRSA's SIA search answered for /api/images: which images of one detector cover a sky position.
// One file per detector (d1.bin .. d6.bin). Its head lists, per sky cell, where that cell's rows start; a request reads
// the head (once per Worker instance) and one cell's rows. `read(name, offset, length)` returns an ArrayBuffer, so the
// storage (R2, static files, a test's local file) is the caller's choice.
//
// A row is one image in one cell: its start time, its footprint as four great-circle edges (unit normals, the image
// is where every n . p >= 0) and the pieces of its obs_id and S3 key. The footprint is IRSA's own s_region (the outer
// pixel edges' corners); SIA counts an image when its 0.001 degree search circle touches that polygon, and so do we.

const ROW = 64, COLLS = ['spherex_dr1', 'spherex_qr3', 'spherex_dr1_deep', 'spherex_qr3_deep'];
const COLL_END = COLLS.map(c => `","coll":"${c}"}`);   // the end of a row's JSON text
const RAD = Math.PI / 180, TOL = -Math.sin(0.001 * RAD);   // SIA's search circle: within 0.001 deg of every edge

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

async function head(read, name) {
  const fixed = new DataView(await read(name, 0, 24));
  if (fixed.getUint32(0, true) !== 0x49594b53 || fixed.getUint32(4, true) !== 2) throw new Error(`${name} is not a version 2 sky index`);
  const det = fixed.getUint32(8, true), cells = fixed.getUint32(12, true), fbytes = fixed.getUint32(20, true);
  if (cells !== GRID[BANDS - 1][0] + GRID[BANDS - 1][1]) throw new Error(`${name} uses another cell grid`);
  const size = 24 + 4 * (cells + 1) + fbytes, buf = await read(name, 0, size);
  const first = new Uint32Array(buf.slice(24, 24 + 4 * (cells + 1)));
  const periods = new Map();
  const folders = new TextDecoder().decode(new Uint8Array(buf, 24 + 4 * (cells + 1), fbytes)).split('\n').map(f => {
    if (!/^[\w.\/-]+$/.test(f)) throw new Error(`${name} has a folder that would need JSON escaping`);
    const [, , period, version] = f.split('/');
    if (!periods.has(period)) periods.set(period, periods.size);
    const pre = `${f}/${det}/level2_${period}_`, post = `D${det}_spx_${version}.fits`;
    // a, b: the constant text around a row's "rest" (seq_sub) in the JSON writer
    return { pre, post, period, p: periods.get(period), a: `,"key":"${pre}`, b: `${post}","obs":"${period}_` };
  });
  return { det, first, folders, rowsAt: size + (-size & 7) };
}

// The file's head is parsed once per Worker instance. When the file is replaced, the caller's read notices (R2's etag
// changes) and calls skyForget, so the next answer reads the new head.
export const skyForget = det => heads.delete(`d${det}.bin`);

// The parsed head of one detector's file, read once per Worker instance (a failed read is retried next time)
export function skyHead(read, det) {
  const name = `d${det}.bin`;
  if (!heads.has(name)) heads.set(name, head(read, name).catch(e => { heads.delete(name); throw e; }));
  return heads.get(name);
}

// Which rows of (ra, dec)'s cell are the answer: row numbers in answer order, one per obs_id, and the number of matching
// images per collection searched. Rows are stored in time order, so the answer comes out sorted. An obs_id seen again
// in a lower (earlier listed) collection takes the place of the first one, as /api/images keeps DR1 first; only then is
// a re-sort needed. Plain numbers only: the two writers below turn the rows into objects or straight into JSON text.
async function pick(read, ra, dec, det) {
  const name = `d${det}.bin`, h = await skyHead(read, det), c = cellAt(ra, dec), n = h.first[c + 1] - h.first[c];
  const deep = Math.abs(eclipticLat(ra, dec)) > 75;
  const collections = Object.fromEntries((deep ? COLLS : COLLS.slice(0, 2)).map(k => [k, 0]));
  if (!n) return { h, rows: [], collections };
  const buf = await read(name, h.rowsAt + h.first[c] * ROW, n * ROW);
  const f64 = new Float64Array(buf), f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const x = Math.cos(dec * RAD) * Math.cos(ra * RAD), y = Math.cos(dec * RAD) * Math.sin(ra * RAD), z = Math.sin(dec * RAD);
  const rows = [], at = new Map();   // at: obs number -> place in rows
  let resort = false;
  for (let i = 0; i < n; i++) {
    const coll = u8[i * ROW + 61];
    if (coll >= 2 && !deep) continue;
    let j = i * 16 + 2, ok = true;
    for (let e = 0; e < 4 && ok; e++, j += 3) ok = f32[j] * x + f32[j + 1] * y + f32[j + 2] * z >= TOL;
    if (!ok) continue;
    collections[COLLS[coll]]++;
    const id = (h.folders[u16[i * 32 + 28]].p * 10000 + u16[i * 32 + 29]) * 10 + u8[i * ROW + 60], had = at.get(id);
    if (had === undefined) { at.set(id, rows.length); rows.push(i); }
    else if (coll < u8[rows[had] * ROW + 61]) { rows[had] = i; resort = true; }
  }
  if (resort) rows.sort((a, b) => f64[a * 8] - f64[b * 8]);
  return { h, rows, collections, f64, u16, u8 };
}

// one row's fields; t is MJD-BEG to 6 decimals, the way SIA writes t_min. The file already holds it rounded (version
// 2); toFixed here keeps this reference path right on its own, and the JSON writer prints the stored value directly.
function fields(p, i) {
  const fo = p.h.folders[p.u16[i * 32 + 28]], rest = `${String(p.u16[i * 32 + 29]).padStart(4, '0')}_${p.u8[i * ROW + 60]}`;
  return [Number(p.f64[i * 8].toFixed(6)), fo.pre + rest + fo.post, `${fo.period}_${rest}`, COLLS[p.u8[i * ROW + 61]]];
}

// The images of one detector covering (ra, dec): { images: [{ t, key, obs, coll }] sorted by t, collections }
export async function skyImages(read, ra, dec, det) {
  const p = await pick(read, ra, dec, det);
  return { images: p.rows.map(i => { const [t, key, obs, coll] = fields(p, i); return { t, key, obs, coll }; }), collections: p.collections };
}

// The whole /api/images answer as JSON text, written straight from the rows: the same bytes as JSON.stringify of
// { ra, dec, det: 'D<det>', ...skyImages(), source: 'index' } (worker/sky_index.test.mjs checks it), without building
// thousands of objects first. A deep-field answer is about 1 MB and that building took most of a request's CPU.
// Numbers print as JSON.stringify prints them; keys, obs and collections need no escaping (head() checks the folders).
export async function skyImagesJson(read, ra, dec, det) {
  const p = await pick(read, ra, dec, det);
  let s = `{"ra":${JSON.stringify(ra)},"dec":${JSON.stringify(dec)},"det":"D${det}","images":[`;
  for (let k = 0; k < p.rows.length; k++) {   // fields() inlined, with the constant text cut once per folder
    const i = p.rows[k], fo = p.h.folders[p.u16[i * 32 + 28]], rest = String(p.u16[i * 32 + 29]).padStart(4, '0') + '_' + p.u8[i * ROW + 60];
    s += (k ? ',{"t":' : '{"t":') + p.f64[i * 8] + fo.a + rest + fo.b + rest + COLL_END[p.u8[i * ROW + 61]];
  }
  return `${s}],"collections":${JSON.stringify(p.collections)},"source":"index"}`;
}
