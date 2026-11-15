// Independent check of the Spectrum card's numbers: our SPHEREx points for isolated, unsaturated field stars against
// catalogue photometry of the same stars, 2MASS J, H, Ks and AllWISE W1, W2 (IRSA, CDS VizieR was down on 2026-11-15), converted to mJy with the
// published Vega zero points. Ours at each band is the median of the unflagged points within 4% of its wavelength.
// Neighbours: the 2MASS stars within 25" (our circle is 18.45" in radius) and the share of Ks light they add, printed
// beside each star, since they are in our circle and not in the catalogue's. Pass: every band of every isolated star (neighbours under 10%) within 30%, for 3 stars or more.
// Run with the app up: node web/tests/spectrum_catalog.mjs [base url]   (network: the image search, S3, VizieR)
import { readFileSync } from 'node:fs';
import { spectrum } from '../live/spectrum.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const maps = JSON.parse(readFileSync(new URL('../data/wavemaps.json', import.meta.url)));
// field stars near the challenge targets (Gaia DR3, G 12.9 to 14.5). The first five have little light from neighbours
// in Gaia; the last two near Barnard's Star are crowded on purpose, to show what neighbours do (printed, not judged).
const STARS = [
  ["near Barnard's Star, G 13.5", 269.42532, 4.79818], ["near Barnard's Star, G 13.9", 269.44989, 4.80669],
  ['near WISE 0855, G 13.3', 133.79701, -7.25786], ['near R Draconis, G 13.8', 248.2198, 66.72672], ['near R Draconis, G 14.2', 248.23839, 66.77694],
  ['near Epsilon Indi B, G 13.0', 331.12956, -56.77475],
  ["near Barnard's Star, G 13.6 (crowded)", 269.43868, 4.78653], ["near Barnard's Star, G 14.4 (crowded)", 269.42299, 4.75121],
];
// band, wavelength (µm), Vega zero point (Jy): Cohen et al. 2003 for 2MASS, Jarrett et al. 2011 for WISE
const BANDS = [['J', 1.235, 1594], ['H', 1.662, 1024], ['Ks', 2.159, 666.7], ['W1', 3.353, 309.54], ['W2', 4.603, 171.79]];
const ISO = 25;   // arcsec: 2MASS neighbours this close add light to our circle (18.45\" radius) through its edge

// IRSA's catalogue service (Gator, as the Worker's Gaia lookup): an IPAC table, columns by name ("null" when empty)
async function gator(cat, ra, dec, r, cols) {
  const u = `https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?${new URLSearchParams({ catalog: cat, spatial: 'cone', objstr: `${ra} ${dec}`, radius: r, radunits: 'arcsec', outfmt: 1, selcols: cols })}`;
  const lines = (await (await fetch(u)).text()).split('\n'), head = lines.find(l => l.startsWith('|'));
  if (!head) throw new Error(`IRSA sent no ${cat} table`);
  const names = head.split('|').map(c => c.trim()).filter(Boolean);
  return lines.filter(l => l.trim() && !/^[\\|]/.test(l)).map(l => Object.fromEntries(l.trim().split(/\s+/).map((v, i) => [names[i], v === 'null' ? null : v])))
    .sort((a, b) => +a.dist - +b.dist);
}

let fail = 0;
const table = [];
for (const [name, ra, dec] of STARS) {
  const tm = await gator('fp_psc', ra, dec, ISO, 'ra,dec,j_m,h_m,k_m,ph_qual');
  const wise = await gator('allwise_p3as_psd', ra, dec, 3, 'ra,dec,w1mpro,w2mpro,ph_qual');
  const me = tm[0];
  if (!me || +me.dist > 2) { console.log(`SKIP ${name}: no 2MASS star within 2"`); continue; }
  const ks = s => 10 ** (-0.4 * +s.k_m);
  const others = tm.slice(1).filter(s => s.k_m).reduce((a, s) => a + ks(s), 0) / ks(me);
  const cat = { J: me.j_m, H: me.h_m, Ks: me.k_m, W1: wise[0]?.w1mpro, W2: wise[0]?.w2mpro };
  const r = await spectrum(ra, dec, { api: BASE, maps });
  const row = [name, `neighbours ${(100 * others).toFixed(1)}%${others < 0.1 ? '' : ' (crowded: not judged)'}`];
  for (const [b, lam, zp] of BANDS) {
    const near = r.points.filter(p => !p.doubt && Math.abs(p.lam / lam - 1) <= 0.04).map(p => p.flux).sort((x, y) => x - y);
    const ours = near.length ? near[near.length >> 1] : NaN, theirs = cat[b] ? zp * 1000 * 10 ** (-0.4 * +cat[b]) : NaN;
    const ratio = ours / theirs, ok = Math.abs(ratio - 1) <= 0.3;
    const judged = others < 0.1;   // isolated: 2MASS neighbours within 25" add under 10% of its Ks light
    if (judged && Number.isFinite(ratio) && !ok) fail++;
    row.push(`${b} ${ours.toFixed(1)} vs ${theirs.toFixed(1)} mJy (${Number.isFinite(ratio) ? ratio.toFixed(2) : 'n/a'}, n=${near.length})${judged && Number.isFinite(ratio) && !ok ? ' FAIL' : ''}`);
  }
  table.push(row);
  console.log(row.join(' | '));
}
const judged = table.filter(r => !r[1].includes('crowded')).length;
console.log(fail ? `FAIL ${fail} band(s) of isolated stars more than 30% off` : `PASS every band within 30% for the ${judged} isolated stars`);
process.exit(fail || judged < 3 ? 1 : 0);
