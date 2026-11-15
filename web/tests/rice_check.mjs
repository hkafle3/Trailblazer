// Offline check of the FLAGS decoder (web/live/fits.js riceDecode): rows encoded here the way cfitsio fits_rcomp does,
// one block per path (all equal, fs 0 to 24, raw 32-bit at fs 25) and big jumps between neighbours, decode exactly.
// node web/tests/rice_check.mjs
import assert from 'node:assert/strict';
import { riceDecode } from '../live/fits.js';

function encode(px, fsOf, nblock = 32) {   // fsOf(block) -> the fs to code it with (-1: all equal to the last pixel)
  const bits = [], put = (v, k) => { for (let i = k - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2); };
  put(px[0] >>> 0, 32);
  let last = px[0];
  for (let i = 0, blk = 0; i < px.length; i += nblock, blk++) {
    const fs = fsOf(blk); put(fs + 1, 5);
    for (let j = i; j < Math.min(px.length, i + nblock); j++) {
      const d = (px[j] - last) | 0, z = d < 0 ? -2 * d - 1 : 2 * d;   // zigzag, as an unsigned number
      last = px[j];
      if (fs < 0) continue;
      if (fs === 25) put(z, 32);
      else { for (let k = Math.floor(z / 2 ** fs); k > 0; k--) bits.push(0); bits.push(1); put(z % 2 ** fs, fs); }
    }
  }
  while (bits.length % 8) bits.push(0);
  return Uint8Array.from({ length: bits.length / 8 }, (_, k) => bits.slice(8 * k, 8 * k + 8).reduce((a, b) => 2 * a + b, 0));
}

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const n = 32 * 27, fsOf = blk => blk - 1;   // block 0 all equal (fs -1), then fs 0, 1, ... 25
// block 0 all equal; a block coded with fs = f jumps by up to 2^f (so its runs of zeros stay short); fs 25: any values,
// the flag bits SPHEREx sets among them (21 SOURCE, 28 HALO, 31)
const px = new Int32Array(n).fill(1 << 21);
for (let blk = 1; blk < 27; blk++) for (let k = 32 * blk; k < 32 * blk + 32; k++) {
  const fs = fsOf(blk);
  px[k] = fs === 25 ? [0, 1 << 21, 1 << 28, -1, 0x7fffffff, (1 << 31) | 5][Math.floor(rnd() * 6)] : (px[k - 1] + Math.floor((rnd() - 0.5) * 2 ** (fs + 1))) | 0;
}
assert.deepEqual(riceDecode(encode(px, fsOf), n), px);
console.log(`PASS rice check: ${n} pixels in 27 blocks (all equal, fs 0 to 24, raw at fs 25) decode exactly`);
