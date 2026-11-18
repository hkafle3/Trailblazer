// The first `limit` bytes a gzip holds, inflated in plain JavaScript (RFC 1951/1952), stopping at the limit or where the
// input ends. For reading a FITS header from the start of a gzip in the Worker: bounded by construction (it never makes
// more than `limit` bytes, however compressible the rest is), and a cut-short input simply yields what it holds, which
// workerd's DecompressionStream does not (it drops the output when the input ends early). Throws on input that is not
// a gzip or not valid deflate before the limit.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
class End extends Error {}
// canonical Huffman table from code lengths: counts per length and symbols in code order
function table(lengths) {
  const count = new Uint16Array(16), sym = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  lengths.forEach((l, s) => { if (l) sym[offs[l]++] = s; });
  return { count, sym };
}
// until(out, o): asked at each 2880-byte boundary of the output; true stops there (the FITS header's END card is in)
export function inflateStart(input, limit, until = null) {
  let p = 0, bit = 0, nb = 0;
  const out = new Uint8Array(limit); let o = 0;
  const need = () => { if (p >= input.length) throw new End(); };
  const bits = n => { while (nb < n) { need(); bit |= input[p++] << nb; nb += 8; } const v = bit & ((1 << n) - 1); bit >>>= n; nb -= n; return v; };
  const decode = t => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      if (!nb) { need(); bit = input[p++]; nb = 8; }
      code |= bit & 1; bit >>>= 1; nb--;
      const c = t.count[len]; if (code - c < first) return t.sym[index + (code - first)]; index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('bad Huffman code');
  };
  // gzip header
  if (input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) throw new Error('not a gzip');
  const flg = input[3]; p = 10;
  try {
    if (flg & 4) { need(); const xl = input[p] | (input[p + 1] << 8); p += 2 + xl; }
    if (flg & 8) { while (need(), input[p++] !== 0); }
    if (flg & 16) { while (need(), input[p++] !== 0); }
    if (flg & 2) p += 2;
    const fixedLit = table([...Array(144).fill(8), ...Array(112).fill(9), ...Array(24).fill(7), ...Array(8).fill(8)]), fixedDist = table(Array(30).fill(5));
    let stop = false;
    for (let last = 0; !last && o < limit && !stop;) {
      last = bits(1); const type = bits(2);
      if (type === 0) {   // stored
        bit = 0; nb = 0; need(); const len = input[p] | (input[p + 1] << 8); p += 4;
        for (let i = 0; i < len && o < limit; i++) { need(); out[o++] = input[p++]; if (o % 2880 === 0 && until?.(out, o)) { stop = true; break; } }
        continue;
      }
      let lit = fixedLit, dist = fixedDist;
      if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
        const clt = table(cl), lens = [];
        while (lens.length < hlit + hdist) {
          const s = decode(clt);
          if (s < 16) lens.push(s);
          else if (s === 16) { const prev = lens[lens.length - 1]; for (let k = 3 + bits(2); k; k--) lens.push(prev); }
          else if (s === 17) for (let k = 3 + bits(3); k; k--) lens.push(0);
          else for (let k = 11 + bits(7); k; k--) lens.push(0);
        }
        lit = table(lens.slice(0, hlit)); dist = table(lens.slice(hlit));
      } else if (type !== 1) throw new Error('bad deflate block');
      for (;;) {
        const s = decode(lit);
        if (s < 256) { out[o++] = s; if (o >= limit || (o % 2880 === 0 && until?.(out, o))) { stop = true; break; } continue; }
        if (s === 256) break;
        const li = s - 257, len = LEN_BASE[li] + bits(LEN_EXTRA[li]), di = decode(dist), d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > o) throw new Error('deflate distance past the start');
        for (let k = 0; k < len && o < limit; k++, o++) { out[o] = out[o - d]; if ((o + 1) % 2880 === 0 && until?.(out, o + 1)) { o++; stop = true; break; } }
        if (stop || o >= limit) { stop = true; break; }
      }
    }
  } catch (e) { if (!(e instanceof End)) throw e; }
  return out.subarray(0, o);
}
