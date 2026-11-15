// Read SPHEREx images straight from NASA's public S3 copy with HTTP range requests, and do the WCS math
// astropy does: sky position -> full-frame pixel (TAN projection plus SIP distortion), pixel -> wavelength.
// Checked against astropy by web/tests/golden.html (bake/golden.py writes the reference answers).

export const S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
const D2R = Math.PI / 180;

async function range(key, start, end, signal) {
  const r = await fetch(S3 + key, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (r.status !== 206) throw new Error(`S3 range ${start}-${end} of ${key}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// FITS header: 80-character cards in 2880-byte blocks, ending at the END card
function parseCards(bytes) {
  const h = {};
  for (let i = 0; i + 80 <= bytes.length; i += 80) {
    const card = String.fromCharCode(...bytes.subarray(i, i + 80));
    const key = card.slice(0, 8).trim();
    if (key === 'END') return { h, end: i + 80 };
    if (card[8] !== '=') continue;
    let v = card.slice(10).trim();
    if (v.startsWith("'")) v = v.slice(1, v.indexOf("'", 1)).trim();
    else { v = v.split('/')[0].trim(); v = v === 'T' ? true : v === 'F' ? false : Number(v); }
    h[key] = v;
  }
  return { h, end: -1 };
}

// Header of the IMAGE extension (HDU 1). One 32 KB read usually holds the primary header and the whole
// IMAGE header (about 26 KB in DR1); the loop reads more only when a header runs past what it has.
export async function imageHeader(key, signal) {
  let buf = await range(key, 0, 32767, signal), off = 0;
  const grow = async () => {
    const more = await range(key, buf.length, buf.length + 32767, signal);
    const all = new Uint8Array(buf.length + more.length); all.set(buf); all.set(more, buf.length); buf = all;
  };
  for (let hdu = 0; ; hdu++) {
    let parsed;
    while ((parsed = parseCards(buf.subarray(off))).end < 0) {
      if (buf.length - off > 400000) throw new Error(`no END card in HDU ${hdu} of ${key}`);
      await grow();
    }
    const h = parsed.h, hdrLen = Math.ceil(parsed.end / 2880) * 2880;
    if (hdu === 1) { h._dataOffset = off + hdrLen; return h; }
    let n = h.NAXIS ? 1 : 0;
    for (let a = 1; a <= (h.NAXIS || 0); a++) n *= h[`NAXIS${a}`];
    off += hdrLen + Math.ceil((Math.abs(h.BITPIX) / 8 * n + (h.PCOUNT || 0)) / 2880) * 2880;
    while (buf.length < off + 2880) await grow();
  }
}

// ---------- TAN + SIP ----------
function sip(h, P, u, v) {
  const n = h[`${P}_ORDER`] || 0;
  let s = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
    const c = h[`${P}_${i}_${j}`];
    if (c) s += c * u ** i * v ** j;
  }
  return s;
}
function linear(h) {   // PC (or CD) times CDELT, degrees per pixel
  const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
  return h.CD1_1 != null ? [h.CD1_1, h.CD1_2 || 0, h.CD2_1 || 0, h.CD2_2]
    : [(h.PC1_1 ?? 1) * c1, (h.PC1_2 || 0) * c1, (h.PC2_1 || 0) * c2, (h.PC2_2 ?? 1) * c2];
}
// gnomonic projection about CRVAL (LONPOLE 180, the TAN default): sky -> intermediate world coords, degrees
function tanProject(h, ra, dec) {
  const a = ra * D2R, d = dec * D2R, a0 = h.CRVAL1 * D2R, d0 = h.CRVAL2 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0) return null;   // more than 90 degrees from the image centre
  const x = Math.cos(d) * Math.sin(a - a0) / cosc;
  const y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [x / D2R, y / D2R];
}
export function tanDeproject(h, x, y) {
  const X = x * D2R, Y = y * D2R, a0 = h.CRVAL1 * D2R, d0 = h.CRVAL2 * D2R, rho = Math.hypot(X, Y);
  if (rho === 0) return [h.CRVAL1, h.CRVAL2];
  const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
  const dec = Math.asin(cc * Math.sin(d0) + Y * sc * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(X * sc, rho * Math.cos(d0) * cc - Y * Math.sin(d0) * sc);
  return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
}

// 0-based full-frame pixel (like astropy world_to_pixel_values) -> [ra, dec] degrees
export function pixToWorld(h, px, py) {
  const u = px + 1 - h.CRPIX1, v = py + 1 - h.CRPIX2;
  const U = u + sip(h, 'A', u, v), V = v + sip(h, 'B', u, v), [a, b, c, d] = linear(h);
  return tanDeproject(h, a * U + b * V, c * U + d * V);
}

// [ra, dec] degrees -> 0-based full-frame pixel. AP/BP give a first guess; Newton steps on the forward SIP
// polish it, since AP/BP are only an approximate inverse.
export function worldToPix(h, ra, dec) {
  const t = tanProject(h, ra, dec);
  if (!t) return null;
  const [a, b, c, d] = linear(h), det = a * d - b * c;
  const U = (d * t[0] - b * t[1]) / det, V = (-c * t[0] + a * t[1]) / det;
  let u = U + sip(h, 'AP', U, V), v = V + sip(h, 'BP', U, V);
  for (let k = 0; k < 20; k++) {
    const fu = u + sip(h, 'A', u, v) - U, fv = v + sip(h, 'B', u, v) - V;
    if (Math.abs(fu) < 1e-9 && Math.abs(fv) < 1e-9) break;
    const e = 1e-3;
    const juu = 1 + (sip(h, 'A', u + e, v) - sip(h, 'A', u - e, v)) / (2 * e), juv = (sip(h, 'A', u, v + e) - sip(h, 'A', u, v - e)) / (2 * e);
    const jvu = (sip(h, 'B', u + e, v) - sip(h, 'B', u - e, v)) / (2 * e), jvv = 1 + (sip(h, 'B', u, v + e) - sip(h, 'B', u, v - e)) / (2 * e);
    const dj = juu * jvv - juv * jvu;
    u -= (fu * jvv - fv * juv) / dj; v -= (fv * juu - fu * jvu) / dj;
  }
  return [u + h.CRPIX1 - 1, v + h.CRPIX2 - 1];
}

// ---------- wavelength: the detector's WCS-WAVE table, SIP off (IRSA's rule), bilinear in 1-based pixels ----------
function axisIndex(grid, p) {
  if (p <= grid[0]) return [0, 0];
  for (let i = 0; i < grid.length - 1; i++) if (p <= grid[i + 1]) return [i, (p - grid[i]) / (grid[i + 1] - grid[i])];
  return [grid.length - 2, 1];
}
export function wavelengthAt(map, px, py) {
  const [i, fx] = axisIndex(map.x, px + 1), [j, fy] = axisIndex(map.y, py + 1);
  const at = (A) => (A[j][i] * (1 - fx) + A[j][i + 1] * fx) * (1 - fy) + (A[j + 1][i] * (1 - fx) + A[j + 1][i + 1] * fx) * fy;
  return [at(map.lam), at(map.bw)];
}

// Rows y0..y1 (0-based, inclusive) of the IMAGE, big-endian float32 -> Float32Array (NaN kept)
export async function imageRows(key, h, y0, y1, signal) {
  const w = h.NAXIS1, bytes = await range(key, h._dataOffset + y0 * w * 4, h._dataOffset + (y1 + 1) * w * 4 - 1, signal);
  const dv = new DataView(bytes.buffer), out = new Float32Array(bytes.length / 4), bs = h.BSCALE ?? 1, bz = h.BZERO ?? 0;
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(4 * i, false) * bs + bz;
  return out;
}

// ---------- FLAGS: the quality bits of each pixel (the HDU after the IMAGE), a RICE_1 tile-compressed image ----------
// SPHEREx L2 stores it as a binary table with one compressed tile per row (ZTILE1 = NAXIS1, ZTILE2 = 1), so a range
// of rows is: their 8-byte descriptors (length, heap offset), then their bytes in the heap, each row decoded alone.
// The first read also takes the descriptor table that follows the header (17280 bytes of header in DR1, then 16 KB of
// descriptors for 2040 rows), so reading rows later is one request (the heap) rather than two.
export async function flagsHeader(key, h, signal) {
  const off = h._dataOffset + Math.ceil(Math.abs(h.BITPIX) / 8 * h.NAXIS1 * h.NAXIS2 / 2880) * 2880;
  let buf = await range(key, off, off + 20159 + 8 * h.NAXIS2, signal), p;
  while ((p = parseCards(buf)).end < 0) {
    if (buf.length > 200000) throw new Error(`no END card in the FLAGS header of ${key}`);
    const more = await range(key, off + buf.length, off + buf.length + 11519, signal), all = new Uint8Array(buf.length + more.length);
    all.set(buf); all.set(more, buf.length); buf = all;
  }
  const f = p.h;
  if (f.EXTNAME !== 'FLAGS' || !f.ZIMAGE || f.ZCMPTYPE !== 'RICE_1' || f.ZTILE2 !== 1 || f.ZTILE1 !== f.ZNAXIS1 || f.NAXIS1 !== 8)
    throw new Error(`FLAGS of ${key} is not stored as expected (${f.EXTNAME}, ${f.ZCMPTYPE})`);
  f._dataOffset = off + Math.ceil(p.end / 2880) * 2880;
  f._heap = f._dataOffset + (f.THEAP ?? f.NAXIS1 * f.NAXIS2);
  const d = f._dataOffset - off;
  if (buf.length >= d + 8 * f.NAXIS2) f._desc = new DataView(buf.buffer, buf.byteOffset + d, 8 * f.NAXIS2);
  return f;
}

// VARIANCE (the HDU after FLAGS): a plain float32 image like IMAGE, so imageRows reads it with this header
export async function varianceHeader(key, f, signal) {
  const off = f._dataOffset + Math.ceil((f.NAXIS1 * f.NAXIS2 + (f.PCOUNT || 0)) / 2880) * 2880;
  const p = parseCards(await range(key, off, off + 14399, signal));   // 119 cards in DR1: 4 blocks
  if (p.end < 0 || p.h.EXTNAME !== 'VARIANCE' || p.h.BITPIX !== -32) throw new Error(`no VARIANCE after FLAGS in ${key}`);
  p.h._dataOffset = off + Math.ceil(p.end / 2880) * 2880;
  return p.h;
}

// cfitsio's fits_rdecomp for 4-byte pixels: per block of `nblock` pixels a 5-bit code (fs + 1), then the pixel
// differences, zigzag mapped: Rice codes (a run of zeros, a 1, fs low bits), or raw 32-bit values when fs is 25.
// As cfitsio, b holds the nbits bits read but not yet used (under 32), so a run of zeros is found a byte at a time.
export function riceDecode(bytes, n, nblock = 32) {
  const out = new Int32Array(n);
  let last = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3], p = 4, b = bytes[p++], nbits = 8;
  const take = k => { nbits -= k; while (nbits < 0) { b = (b << 8) | bytes[p++]; nbits += 8; } const v = b >>> nbits; b &= (1 << nbits) - 1; return v; };
  for (let i = 0; i < n;) {
    const fs = take(5) - 1, end = Math.min(n, i + nblock);
    if (fs < 0) { for (; i < end; i++) out[i] = last; continue; }
    for (; i < end; i++) {
      let d;
      if (fs === 25) d = take(8) * 2 ** 24 + take(8) * 2 ** 16 + take(8) * 256 + take(8);
      else {
        while (b === 0) { nbits += 8; b = bytes[p++]; }
        const top = 31 - Math.clz32(b), z = nbits - 1 - top;   // z zeros, then the 1 at bit `top`
        nbits = top; b ^= 1 << top;
        d = z * 2 ** fs + take(fs);
      }
      d = d % 2 ? -Math.floor(d / 2) - 1 : d / 2;   // zigzag back to a signed difference
      out[i] = last = (last + d) | 0;
    }
  }
  return out;
}

// rows y0..y1 (0-based, inclusive) of FLAGS -> Int32Array, full width
export async function flagRows(key, f, y0, y1, signal) {
  const desc = f._desc ?? new DataView((await range(key, f._dataOffset + 8 * y0, f._dataOffset + 8 * (y1 + 1) - 1, signal)).buffer), d0 = f._desc ? y0 : 0;
  const rows = Array.from({ length: y1 - y0 + 1 }, (_, k) => [desc.getInt32(8 * (d0 + k), false), desc.getInt32(8 * (d0 + k) + 4, false)]);
  const a = Math.min(...rows.map(r => r[1])), b = Math.max(...rows.map(r => r[1] + r[0]));
  const heap = await range(key, f._heap + a, f._heap + b - 1, signal), w = f.ZNAXIS1, out = new Int32Array(rows.length * w);
  rows.forEach(([len, o], k) => out.set(riceDecode(heap.subarray(o - a, o - a + len), w, f.ZVAL1 ?? 32), k * w));
  return out;
}
