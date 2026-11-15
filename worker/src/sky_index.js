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
  if (fixed.getUint32(0, true) !== 0x49594b53 || fixed.getUint32(4, true) !== 1) throw new Error(`${name} is not a version 1 sky index`);
  const det = fixed.getUint32(8, true), cells = fixed.getUint32(12, true), fbytes = fixed.getUint32(20, true);
  if (cells !== GRID[BANDS - 1][0] + GRID[BANDS - 1][1]) throw new Error(`${name} uses another cell grid`);
  const size = 24 + 4 * (cells + 1) + fbytes, buf = await read(name, 0, size);
  const first = new Uint32Array(buf.slice(24, 24 + 4 * (cells + 1)));
  const periods = new Map();
  const folders = new TextDecoder().decode(new Uint8Array(buf, 24 + 4 * (cells + 1), fbytes)).split('\n').map(f => {
    const [, , period, version] = f.split('/');
    if (!periods.has(period)) periods.set(period, periods.size);
    return { pre: `${f}/${det}/level2_${period}_`, post: `D${det}_spx_${version}.fits`, period, p: periods.get(period) };
  });
  return { det, first, folders, rowsAt: size + (-size & 7) };
}

// The images of one detector covering (ra, dec): [{ t, key, obs, coll }] sorted by t, one per obs_id (DR1 first, as
// /api/images keeps it), and the number of matching images per collection searched. t is MJD-BEG to 6 decimals, the
// way SIA writes t_min (toFixed rounds the exact value, as SIA does; t * 1e6 rounding missed some by 1e-6).
export async function skyImages(read, ra, dec, det) {
  const name = `d${det}.bin`;
  if (!heads.has(name)) heads.set(name, head(read, name).catch(e => { heads.delete(name); throw e; }));
  const h = await heads.get(name), c = cellAt(ra, dec), n = h.first[c + 1] - h.first[c];
  const deep = Math.abs(eclipticLat(ra, dec)) > 75;
  const collections = Object.fromEntries((deep ? COLLS : COLLS.slice(0, 2)).map(k => [k, 0]));
  if (!n) return { images: [], collections };
  const buf = await read(name, h.rowsAt + h.first[c] * ROW, n * ROW);
  const f64 = new Float64Array(buf), f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const x = Math.cos(dec * RAD) * Math.cos(ra * RAD), y = Math.cos(dec * RAD) * Math.sin(ra * RAD), z = Math.sin(dec * RAD);
  // Rows are stored in time order, so the answer comes out sorted. An obs_id seen again in a lower (earlier listed)
  // collection takes the place of the first one, as /api/images keeps DR1 first; only then is a re-sort needed.
  const images = [], cs = [], at = new Map();   // cs: each answer row's collection number
  let resort = false;
  for (let i = 0; i < n; i++) {
    const coll = u8[i * ROW + 61];
    if (coll >= 2 && !deep) continue;
    let j = i * 16 + 2, ok = true;
    for (let e = 0; e < 4 && ok; e++, j += 3) ok = f32[j] * x + f32[j + 1] * y + f32[j + 2] * z >= TOL;
    if (!ok) continue;
    collections[COLLS[coll]]++;
    const fo = h.folders[u16[i * 32 + 28]], seq = u16[i * 32 + 29], sub = u8[i * ROW + 60];
    const id = (fo.p * 10000 + seq) * 10 + sub, had = at.get(id);
    if (had !== undefined && cs[had] <= coll) continue;
    const rest = `${String(seq).padStart(4, '0')}_${sub}`;
    const row = { t: Number(f64[i * 8].toFixed(6)), key: fo.pre + rest + fo.post, obs: `${fo.period}_${rest}`, coll: COLLS[coll] };
    if (had === undefined) { at.set(id, images.length); images.push(row); cs.push(coll); } else { images[had] = row; cs[had] = coll; resort = true; }
  }
  if (resort) images.sort((a, b) => a.t - b.t);
  return { images, collections };
}
