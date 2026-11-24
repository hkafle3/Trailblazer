// The real AllWISE geometry at one spot, for web/tests/blink_unit.mjs: IRSA's tile search (each tile's corners), and each
// touching tile's cutout as the Worker asks for it, kept as its header and its validity mask (finite and at least 5
// coverage frames, packed bits). The pixels themselves are not kept: the footprint check reads only where data is.
// Run: node bake/allwise_footprint_fixture.mjs 331.0957 -56.8004 W2 web/tests/fixtures/allwise_c0177_w2.json
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as B from '../web/live/blink.js';
import { parseCards } from '../web/live/fits.js';
import { touchesField } from '../worker/src/oldsky.js';

const [ra, dec] = process.argv.slice(2, 4).map(Number), band = process.argv[4], out = process.argv[5];
if (!Number.isFinite(ra) || !Number.isFinite(dec) || !/^W[12]$/.test(band ?? '') || !out) throw new Error('usage: ra dec W1|W2 out.json');
const IRSA = 'https://irsa.ipac.caltech.edu';
const bytes = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); let b = Buffer.from(await r.arrayBuffer()); if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b); return new Uint8Array(b); };
const csv = new TextDecoder().decode(await bytes(`${IRSA}/SIA?COLLECTION=wise_allwise&POS=circle+${ra}+${dec}+0.15&RESPONSEFORMAT=CSV`)).trim().split('\n');
const head = csv[0].split(','), rows = csv.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
const sci = rows.filter(x => x.dataproduct_subtype === 'science' && x.energy_bandpassname === band);
const r3 = v => Math.round(v * 1000) / 1000, cut = `center=${r3(ra)},${r3(dec)}&size=780arcsec`;
const KEEP = ['CTYPE1', 'CTYPE2', 'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2', 'CDELT1', 'CDELT2', 'CROTA2', 'BAND', 'DATEOBS1', 'DATEOBS2', 'MIDOBS'];
const tiles = [];
for (const s of sci) {
  const touches = touchesField(s.s_region, r3(ra), r3(dec)), t = { obs_id: s.obs_id, s_ra: +s.s_ra, s_dec: +s.s_dec, s_region: s.s_region, touches };
  if (touches) {
    const int = B.readFits(await bytes(`${s.access_url}?${cut}`), parseCards), cov = B.readFits(await bytes(`${s.access_url.replace(/-int-3\.fits$/, '-cov-3.fits.gz')}?${cut}`), parseCards);
    if (cov.w !== int.w || cov.ht !== int.ht) throw new Error(`${s.obs_id}: coverage map and image differ in size`);
    Object.assign(t, { w: int.w, ht: int.ht, h: Object.fromEntries(KEEP.map(k => [k, int.h[k]])), valid: B.packBits(Uint8Array.from(int.data, (v, k) => (Number.isFinite(v) && cov.data[k] >= 5 ? 1 : 0))) });
  }
  tiles.push(t);
}
writeFileSync(out, JSON.stringify({ ra, dec, band, made: new Date().toISOString().slice(0, 10), source: 'IRSA SIA wise_allwise, AllWISE Atlas cutouts (780 arcsec)', tiles }) + '\n');
console.log(out, tiles.map(t => `${t.obs_id}${t.touches ? ` ${t.w}x${t.ht}` : ' (does not touch the field)'}`).join(', '));
