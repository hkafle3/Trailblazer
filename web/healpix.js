// HEALPix (nested) geometry and the SPHEREx HiPS tile address, with no other imports: shared by the 3D sky (sky.js)
// and Explore's dive into a time-lapse (explore-dive.js).
export const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const tileUrl = (order, k) => `${HIPS}/Norder${order}/Dir${Math.floor(k / 10000) * 10000}/Npix${k}.png`;

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
function compress(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> (2 * i)) & 1) << i; return r; }
export function nest2xyf(order, ipix) {
  const npf = 1 << (2 * order), face = Math.floor(ipix / npf), ipf = ipix - face * npf;
  return [compress(ipf), compress(ipf >>> 1), face];
}
// continuous face coords x,y in [0,1] -> (ra, dec) radians (HEALPix xyf2loc)
export function xyf2radec(x, y, face) {
  const jr = JRLL[face] - x - y; let nr, z;
  if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; } else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; } else { nr = 1; z = (2 - jr) * 2 / 3; }
  let t = JPLL[face] * nr + x - y; if (t < 0) t += 8; if (t >= 8) t -= 8;
  const phi = nr < 1e-15 ? 0 : (Math.PI / 4) * t / nr;
  return [phi, Math.asin(Math.max(-1, Math.min(1, z)))];
}
// (ra, dec) radians -> continuous face coords x, y in [0,1] and face: the inverse of xyf2radec (HEALPix loc2pix
// without rounding to a pixel). tests/skymap.html checks the round trip.
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
function spread(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> i) & 1) << (2 * i); return r >>> 0; }
// nested tile index at `order` plus the position inside that tile
export function radec2tile(order, ra, dec) {
  const n = 1 << order, [x, y, f] = radec2xyf(ra, dec);
  const ix = Math.min(n - 1, Math.floor(x * n)), iy = Math.min(n - 1, Math.floor(y * n));
  return { k: f * n * n + spread(ix) + 2 * spread(iy), u: x * n - ix, v: y * n - iy };
}
// tile-local face coords (u along ix, v along iy) -> image coords (c column, r row from top) in [0,1].
// Checked against real tiles by bake/check_orientation.py (orientation 6).
export const tileUV = (u, v) => [v, u];
