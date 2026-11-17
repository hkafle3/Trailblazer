// The identity rule for the time-lapse's dot in the middle (web/live/identity.js), case by case. The verdict, Depth's
// target and the Discuss offer all use it. Run: node web/tests/identity_check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { middle, identify } from '../live/identity.js';

const a = 6.15;   // a SPHEREx pixel, arcsec: the match radius is two of them (12.3")
const star = (e, n) => ({ kind: 'star', name: 'S', pos: [[e, n]] });
const rock = (...pos) => ({ kind: 'asteroid', name: 'R', pos });
const CASES = [
  // [what, the measured source (or null), candidates, the match expected, the nearby expected]
  ['star with proper motion, on the dot', [1, 2], [star(2.5, 3)], 'S', null],
  ['star 10 to 60 arcsec off: nearby', [0, 0], [star(40, 0)], null, 'S'],
  ['star 12 arcsec off, inside two pixels: the dot', [0, 0], [star(12, 0)], 'S', null],
  ['asteroid on the dot in one exposure', [0, 0], [rock([-100, 0], [3, 1], [100, 0])], 'R', null],
  ['asteroid crossing the middle between exposures, far in each: not the dot', [0, 0], [rock([-120, 0], [120, 0])], null, null],
  ['asteroid 25 arcsec off: nearby', [0, 0], [rock([25, 0])], null, 'R'],
  ['no catalog object: nothing (Depth says distance unknown)', [0, 0], [], null, null],
  ['the source measured 15 arcsec off is something else: the centre is the dot', [15, 0], [star(14, 0)], null, 'S'],
  ['asteroid on the dot only at a baked visit\'s middle (not an exposure time): nearby, never the dot', [0, 0], [{ kind: 'asteroid', name: 'R', pos: [], near: [[3, 0]] }], null, 'R'],
  ['asteroid on the dot at an exposure, also near at the middle: the dot', [0, 0], [{ kind: 'asteroid', name: 'R', pos: [[4, 0]], near: [[40, 0]] }], 'R', null],
];
for (const [what, src, cands, want, near] of CASES) {
  const { match, nearby } = identify(middle(src, a), cands, a);
  assert.equal(match?.name ?? null, want, `${what}: match`);
  assert.equal(nearby?.name ?? null, near, `${what}: nearby`);
}
// Barnard's Star, real data: in every baked visit, Gaia's place for it (its proper motion applied, pred_east/north) is
// within two pixels of the source measured there
const m = JSON.parse(readFileSync(new URL('../data/flip/barnard/manifest.json', import.meta.url)));
const c = (m.grid - 1) / 2, px = m.arcsec_per_pixel;
for (const f of m.frames) {
  const src = f.x != null ? [(c - f.x) * px, (f.y - c) * px] : null;
  const { match } = identify(middle(src, px), [{ name: "Barnard's Star", pos: [[f.pred_east, f.pred_north]] }], px);
  assert.equal(match?.name, "Barnard's Star", `Barnard's Star, ${f.start}`);
}
console.log(`PASS identity rule: ${CASES.length} cases and Barnard's Star in all ${m.frames.length} baked visits`);
