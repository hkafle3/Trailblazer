// Checks web/sky-place.js against astropy's get_constellation on the 50 fixed positions bake/sky_labels.py wrote, the
// candidate page's place line for C-0176, and labels.json's size budget (64 KB gzipped). Run: node web/tests/sky_place.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { constellationAt, placeLine } from '../sky-place.js';

const here = p => new URL(p, import.meta.url);
const fx = JSON.parse(readFileSync(here('fixtures/constellations50.json'), 'utf8'));
const wrong = fx.points.filter(p => constellationAt(p.ra, p.dec) !== p.con);
assert.equal(fx.points.length, 50);
assert.deepEqual(wrong.map(p => `${p.what} (${p.ra}, ${p.dec}): ${constellationAt(p.ra, p.dec)}, astropy ${p.con}`), [], 'constellation lookup');
const raw = readFileSync(here('../data/labels.json')), labels = JSON.parse(raw);
assert.equal(placeLine(fx.c0176, labels.objects), fx.c0176.line, 'C-0176 place line');
assert.equal(placeLine({ ra: 0, dec: -90 }, labels.objects).split(',')[0], 'In Octans', 'south pole');
const gz = gzipSync(raw, { level: 9 }).length;
assert.ok(gz <= 64 * 1024, `labels.json is ${gz} bytes gzipped (65536 allowed)`);
console.log(`sky_place: 50 of 50 constellations match astropy; C-0176 "${fx.c0176.line}"; labels.json ${(gz / 1024).toFixed(1)} KB gzipped`);
