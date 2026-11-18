// Checks the Explore search's RA and Dec reader and name matching (web/search-core.js). Run: node web/tests/search_core.mjs
import assert from 'node:assert/strict';
import { parse, matchLocal, matchPlaces, sesameRaDec, sep } from '../search-core.js';
import { readFileSync } from 'node:fs';

const near = (got, ra, dec, why) => {
  assert.ok(got && 'ra' in got, `${why}: ${JSON.stringify(got)}`);
  assert.ok(Math.abs(got.ra - ra) < 1e-3 && Math.abs(got.dec - dec) < 1e-3, `${why}: got ${got.ra}, ${got.dec}, want ${ra}, ${dec}`);
};
// the challenge's WISE 0855: 08h55m10.8s -07d14m42s is RA 133.795, Dec -7.245
for (const q of ['08h55m10.8s -07d14m42s', '08:55:10.8 -07:14:42', '08 55 10.8 -07 14 42', '8h55m10.8s, -7d14m42s', '08h55m10.8s −07°14′42″'])
  near(parse(q), 133.795, -7.245, q);
for (const q of ['269.45 4.69', '269.45, +4.69', 'RA 269.45 Dec 4.69', 'ra=269.45 dec=4.69', 'RA 269.45° Dec +4.69°', '  269.45   4.69 '])
  near(parse(q), 269.45, 4.69, q);
near(parse('17h57m48s +04d41m36s'), 269.45, 4.6933, 'the help text example');
near(parse('08 55 10.8 -7.245'), 133.795, -7.245, 'sexagesimal RA, decimal Dec');
near(parse('08 55 10.8 07 14 42'), 133.795, 7.245, 'six plain numbers, no sign');
near(parse('0 -90'), 0, -90, 'the south pole');
near(parse('360 0'), 0, 0, 'RA 360 is RA 0');

assert.deepEqual(parse('271 95').error, 'Dec 95 is off the sky.');
assert.match(parse('271 95').help, /-90 to \+90/);
assert.equal(parse('400 10').error, 'RA 400 is off the sky.');
assert.equal(parse('25h 10d').error, 'RA 25h is off the sky.');
assert.equal(parse('-5 10').error, 'RA -5 is off the sky.');
assert.match(parse('08h75m 10d').error, /minutes over 59/);
assert.ok(Math.abs(parse('08h55m10.8s').half - 133.795) < 1e-3, 'only an RA');
assert.equal(parse('269.45').half, 269.45);
assert.ok(parse('1 2 3').error, 'three plain numbers');
for (const q of ['3I/ATLAS', 'barnard', 'Vega', 'HD 1234', 'planet nine', 'M31', '', 'WISE 0855'])
  assert.equal(parse(q), null, `${q} is a name`);

// names
const comets = [{ id: '3I/ATLAS' }, { id: 'C/2024 T5 (ATLAS)' }, { id: 'C/2023 A3 (Tsuchinshan-ATLAS)' }, { id: '2P/Encke' }];
assert.equal(matchLocal('barnard', comets).targets[0].label, "Barnard's Star");
assert.equal(matchLocal('gj 699', comets).targets[0].label, 'GJ 699');
assert.equal(matchLocal("Barnard's Star", comets).targets[0].rank, 0);
assert.equal(matchLocal('eps Ind B', comets).targets[0].t.key, 'epsindib');
assert.equal(matchLocal('Epsilon Indi B', comets).targets[0].t.key, 'epsindib');
for (const q of ['WISE 0855-0714', 'WISE J085510.83-071442.5', 'wise0855', 'wise 0855'])
  assert.equal(matchLocal(q, comets).targets[0]?.t.key, 'wise0855', q);
assert.deepEqual(matchLocal('atlas', comets).comets.map(m => m.c.id), ['3I/ATLAS', 'C/2024 T5 (ATLAS)', 'C/2023 A3 (Tsuchinshan-ATLAS)']);
assert.equal(matchLocal('3i atlas', comets).comets[0].c.id, '3I/ATLAS');
assert.equal(matchLocal('3I/ATLAS', comets).comets[0].rank, 0);
const m = matchLocal('atlas', comets).comets[2];
assert.equal(m.c.id.slice(m.s, m.e), 'ATLAS', 'the bold part');
assert.equal(matchLocal('r', comets).comets.length, 0, 'one letter only matches word starts');
assert.equal(matchLocal('planet nine', comets).targets.length + matchLocal('planet nine', comets).comets.length, 0);

// Sesame's answer
assert.deepEqual(sesameRaDec('# Vega\n#=S=Simbad: 1\n%J 279.23473479 +38.78368896 = 18:36:56.33 +38:47:01.2\n'), { ra: 279.23473479, dec: 38.78368896 });
assert.equal(sesameRaDec('#! *** Nothing found *** \n'), null);
// a %P proper motion moves the star to the year asked: Barnard's Star in 2026.0 is near where SPHEREx photographed it
// (the baked target, 269.4463 4.7671, from Aug 2025 to Aug 2026), not at its J2000 place 4.5 arcmin south
{ const b = sesameRaDec("# Barnard's star\n%J 269.45207696 +04.69339088 = 17:57:48.49 +04:41:36.2\n%P -801.551 +10362.394 [0.032 0.036 0] A 2020yCat.1350....0G\n", 2026);
  assert.ok(sep(b.ra, b.dec, 269.4463, 4.7671) * 3600 < 15, `Barnard's Star in 2026: ${JSON.stringify(b)}`);
  const j = sesameRaDec("%J 269.45207696 +04.69339088\n%P -801.551 +10362.394\n", 2000);
  assert.ok(Math.abs(j.ra - 269.45207696) < 1e-9 && Math.abs(j.dec - 4.69339088) < 1e-9, 'year 2000 is the catalog place'); }
assert.ok(Math.abs(sep(0, 0, 90, 0) - 90) < 1e-9 && sep(10, 20, 10, 20) === 0);
// the sky's names (labels.json, the order search.js gives them): a constellation by name or abbreviation, objects, stars
{ const d = JSON.parse(readFileSync(new URL('../data/labels.json', import.meta.url), 'utf8'));
  const places = [...d.constellations.map(c => ({ ...c, aka: [c.id] })), ...d.objects.filter(o => o.kind !== 'star'), ...d.objects.filter(o => o.kind === 'star')];
  const first = q => matchPlaces(q, places)[0]?.p.name;
  assert.equal(first('orion'), 'Orion'); assert.equal(first('Ori'), 'Orion'); assert.equal(first('UMa'), 'Ursa Major');
  assert.equal(first('orion neb'), 'Orion Nebula'); assert.equal(first('pleiades'), 'Pleiades'); assert.equal(first('betelgeuse'), 'Betelgeuse');
  assert.equal(first('andromeda'), 'Andromeda', 'the constellation before the galaxy');
  assert.ok(matchPlaces('andromeda', places).some(x => x.p.name === 'Andromeda Galaxy'));
  assert.equal(new Set(d.constellations.map(c => c.id)).size, 88, 'all 88 constellations (Serpens in two parts)');
  assert.deepEqual(matchPlaces('', places), []); assert.deepEqual(matchPlaces('zzzq', places), []); }
console.log('PASS search_core: RA and Dec reader, name matching, sky names, Sesame answer');
