// HEALPix (nested) tile geometry with no dependencies, for the Explore map's deep zoom (explore-deep.js).
// ponytail: the same maths as the top of sky.js, which imports three.js; sky.js can import these from here when it is next touched.
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
const compress = v => { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> (2 * i)) & 1) << i; return r; };
const spread = v => { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> i) & 1) << (2 * i); return r >>> 0; };
// tile number -> [ix, iy, face]
export function nest2xyf(order, ipix) {
  const npf = 4 ** order, face = Math.floor(ipix / npf), ipf = ipix - face * npf;
  return [compress(ipf), compress(ipf >>> 1), face];
}
// face coords x, y in 0..1 -> [ra, dec] in radians
export function xyf2radec(x, y, face) {
  const jr = JRLL[face] - x - y; let nr, z;
  if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; } else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; } else { nr = 1; z = (2 - jr) * 2 / 3; }
  let t = JPLL[face] * nr + x - y; if (t < 0) t += 8; if (t >= 8) t -= 8;
  return [nr < 1e-15 ? 0 : (Math.PI / 4) * t / nr, Math.asin(Math.max(-1, Math.min(1, z)))];
}
// [ra, dec] in radians -> face coords [x, y, face]
export function radec2xyf(ra, dec) {
  const z = Math.sin(dec), za = Math.abs(z);
  let tt = (ra / (Math.PI / 2)) % 4; if (tt < 0) tt += 4;
  if (za <= 2 / 3) {
    const jp = 0.5 + tt - z * 0.75, jm = 0.5 + tt + z * 0.75, ifp = Math.floor(jp), ifm = Math.floor(jm);
    const face = ifp === ifm ? (ifp % 4) | 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
    return [jm - ifm, 1 - (jp - ifp), face];
  }
  const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = Math.sqrt(3 * (1 - za));
  const jp = tp * tmp, jm = (1 - tp) * tmp;
  return z > 0 ? [1 - jm, 1 - jp, ntt] : [jp, jm, ntt + 8];
}
// [ra, dec] in radians -> the nested tile number at `order`
export function radec2tile(order, ra, dec) {
  const n = 1 << order, [x, y, f] = radec2xyf(ra, dec);
  return f * n * n + spread(Math.min(n - 1, Math.floor(x * n))) + 2 * spread(Math.min(n - 1, Math.floor(y * n)));
}

// ---- for Explore's dive (explore-dive.js), which samples tile pictures pixel by pixel ----
export const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const tileUrl = (order, k) => `${HIPS}/Norder${order}/Dir${Math.floor(k / 10000) * 10000}/Npix${k}.png`;
// [ra, dec] in radians -> the tile number k at `order` and the place in its picture: column c and row r, 0..1 from the
// top left (the picture's column runs along iy and its row along ix, as sky.js tileUV and explore-deep.js have it)
export function tilePos(order, ra, dec) {
  const n = 1 << order, [x, y, f] = radec2xyf(ra, dec), ix = Math.min(n - 1, Math.floor(x * n)), iy = Math.min(n - 1, Math.floor(y * n));
  return { k: f * n * n + spread(ix) + 2 * spread(iy), c: y * n - iy, r: x * n - ix };
}
