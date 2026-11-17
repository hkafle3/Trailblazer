// web/facts.js against hand-reviewed sentences for every edge case comet-plan/fact-table.md names (open orbits, fragments,
// MOID under 0.05 AU, elongation under 20 degrees, extrapolated and broken magnitudes, exact threshold values, the
// period placeholder, upcoming against past perihelion, a stale snapshot, another JPL solution), then every known comet
// in web/tests/fixtures/comets.json (GET /api/comets/:id plus its snapshot, frozen by bake/comet_facts_fixture.py) scanned
// for forbidden phrases and empty answers.
// Run: node web/tests/facts_test.mjs
import fs from 'node:fs';
import * as F from '../facts.js';

let fails = 0, n = 0;
const eq = (got, want, what) => { n++; if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log(`FAIL ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };
const txt = card => [card.a, ...card.d.map(s => F.plain(s.text))].filter(Boolean);
const TODAY = Date.parse('2026-11-17T12:00:00Z');
const JD = s => Date.parse(s + 'T00:00:00Z') / 864e5 + 2440587.5;
const MJD = s => JD(s) - 2400000.5;
const orb = o => ({ des: 'X', soln: 'JPL#1', moid: 1.5, e: 0.5, q: 1.5, per: 5.2, a: 3, ...o });
const facts = (o = {}, more = {}) => ({ baked: '2026-11-17', orb: orb(o), peri: { prev: null, next: null }, enc: null, status: null, status_note: null,
  extrapolated: false, inv: { n: 0, visits: [] }, ...more });
const now = o => ({ as_of: '2026-11-17', soln: 'JPL#1', T: 12, T30: 12.1, r: 2, rdot: 1, delta: 1.5, elong: 90, side: '/T', cnst: 'Cyg', ra: 300, dec: 10,
  vx: 0.01, vy: 0, vz: 0, ...o });
const X = (id, f, nw = now({}), d = {}) => F.inputs({ id, detail: { co2_verdict: null, co2: {}, ...d, facts: f } }, nw, TODAY);

// ---------- R1 ----------
eq(txt(F.danger(X('C/2026 A2 (Bok)', facts({ moid: 0.999906 }, { enc: { jd: JD('2026-11-16') + 0.625, delta: 1.5819 } })))),
  ['No.', "In JPL's current orbit, its path and Earth's never come closer than 150 million km, about our distance from the Sun.", 'This week it is near its closest to Earth.'],
  'R1 Bok: MOID 1.0 AU, closest to Earth on 16 Nov');
eq(txt(F.danger(X('3I/ATLAS', facts({ moid: 0.36155099 })))),
  ['No.', "In JPL's current orbit, its path and Earth's never come closer than 54.1 million km, 141 times the Moon's distance."], 'R1 3I: Moon distances under 0.5 AU');
eq(txt(F.danger(X('C/x', facts({ moid: 0.5 }))))[1], "In JPL's current orbit, its path and Earth's never come closer than 74.8 million km, 0.5 times Earth's distance from the Sun.", 'R1 at exactly 0.5 AU');
eq(txt(F.danger(X('C/x', facts({ moid: 1.1 }))))[1].endsWith('about our distance from the Sun.'), true, 'R1 at exactly 1.1 AU');
eq(txt(F.danger(X('C/x', facts({ moid: 1.11 }))))[1].endsWith("1.1 times Earth's distance from the Sun."), true, 'R1 just over 1.1 AU');
eq(txt(F.danger(X('C/x', facts({ moid: 0.05 }))))[0], 'No.', 'R1 at exactly 0.05 AU is "No."');
eq(txt(F.danger(X('C/2026 P3 (SWAN)', facts({ moid: 0.0312 }, { enc: { jd: JD('2026-08-20'), delta: 0.4 } })))),
  ['Not on this pass.', "Its path passes within 4.67 million km of Earth's, but the closest it comes to Earth this time is 59.8 million km on 20 Aug 2026."], 'R1 MOID under 0.05 with the encounter computed');
const noEnc = F.danger(X('P/2021 N1 (ZTF)', facts({ moid: 0.0312 })));
eq([noEnc.a, noEnc.needs, ...noEnc.d.map(s => [F.plain(s.text), s.label])], [null, true, ["Its path passes within 4.67 million km of Earth's.", 'predicted'], ['Closest approach: needs data.', 'needs']], 'R1 MOID under 0.05 without the encounter');
eq(txt(F.danger(X('C/x', facts({ moid: 2 }, { enc: { jd: JD('2026-11-09'), delta: 1 } })))).length, 2, 'R1 closest to Earth 8 days ago: no "this week"');

// ---------- R2 ----------
eq(txt(F.see(X('C/2026 A2 (Bok)', facts(), now({ T: 13.797, elong: 98.5409, side: '/T', cnst: 'Cyg', dec: 43.5 })))),
  ['Not by eye.', 'It needs a telescope, and a fuzzy comet looks fainter than its number.',
    'About 1,300 times too faint for your eyes (magnitude 13.8; bigger is fainter; the eye stops near 6).', 'Evening sky, 99° from the Sun, in Cygnus.', F.CAVEAT], 'R2 Bok');
eq(txt(F.see(X('235P/LINEAR', facts(), now({ T: 20.5, elong: 45.2, side: '/T', cnst: 'Sct', dec: -10 })))),
  ['Not by eye.', 'It needs a telescope, and a fuzzy comet looks fainter than its number.', 'Magnitude 20.5 (bigger is fainter; the eye stops near 6).',
    'Evening sky, 45° from the Sun, in Scutum.', F.CAVEAT], 'R2 235P: fainter than 16, no ratio');
eq(txt(F.see(X('C/x', facts(), now({ T: 6, elong: 60, side: '/L', cnst: 'Gem' })))),
  ['Maybe by eye from a dark site.', 'Magnitude 6.0 (bigger is fainter; the eye stops near 6).', 'Morning sky, 60° from the Sun, in Gemini.', F.CAVEAT], 'R2 at exactly magnitude 6');
eq(txt(F.see(X('C/x', facts(), now({ T: 10, elong: 60 })))).slice(0, 3),
  ['Not by eye.', 'Binoculars or a small telescope may show it.', 'About 40 times too faint for your eyes (magnitude 10.0; bigger is fainter; the eye stops near 6).'], 'R2 at exactly magnitude 10');
eq(txt(F.see(X('C/x', facts(), now({ T: 16, elong: 60 }))))[2], 'About 10,000 times too faint for your eyes (magnitude 16.0; bigger is fainter; the eye stops near 6).', 'R2 at exactly magnitude 16');
eq(txt(F.see(X('C/x', facts(), now({ T: 16.04, elong: 60 }))))[2], 'Magnitude 16.0 (bigger is fainter; the eye stops near 6).', 'R2 just over 16: no ratio');
eq(txt(F.see(X('C/x', facts(), now({ elong: 19.9 })))), ['Not now.', 'It is too close to the Sun in the sky (19° away).', F.CAVEAT], 'R2 elongation under 20');
eq(txt(F.see(X('C/x', facts(), now({ elong: 20 }))))[0], 'Not by eye.', 'R2 elongation exactly 20');
eq(txt(F.see(X('C/x', facts(), now({ dec: 50.5, cnst: 'UMa' }))))[3], 'Evening sky, 90° from the Sun, in Ursa Major, far north in the sky.', 'R2 far north');
eq(txt(F.see(X('C/x', facts(), now({ dec: -62, cnst: 'Tuc', side: '/L' }))))[3], 'Morning sky, 90° from the Sun, in Tucana, far south in the sky.', 'R2 far south');
const gated = (f, nw, why) => { const c = F.see(X('C/x', f, nw)); eq([c.a, c.needs, c.d.map(s => s.label)], [null, true, ['needs']], why); return F.plain(c.d[0].text); };
eq(gated(facts(), now({ T: 30.1 }), 'R2 magnitude over 30'), 'JPL has no usable brightness forecast for it.', 'R2 magnitude over 30: the reason');
gated(facts(), now({ T: null }), 'R2 magnitude missing');
eq(txt(F.see(X('C/x', facts(), now({ T: 30 }))))[0], 'Not by eye.', 'R2 at exactly magnitude 30');
eq(gated(facts({}, { extrapolated: true }), now({ T: 23.8 }), 'R2 extrapolated (C/2024 G3)'),
  'JPL’s last sighting of it came before it passed the Sun, so today’s brightness is a guess.', 'R2 extrapolated: the reason');
eq(gated(facts({}, { status: 'fragment' }), now({ T: 44.3 }), 'R2 fragment (C/2025 K1-B)'), 'It is a fragment of a comet, and JPL’s brightness forecast does not cover the pieces.', 'R2 fragment: the reason');
gated(facts({}, { status: 'disrupted', status_note: 'broke up in spring 2025' }), now({ T: 27.7 }), 'R2 broke up (C/2025 F2)');
eq(gated(facts(), now({ as_of: '2026-11-14' }), 'R2 snapshot 3 days old'), 'Today’s forecast needs data.', 'R2 stale snapshot: the reason');
eq(txt(F.see(X('C/x', facts(), now({ as_of: '2026-11-15' }))))[0], 'Not by eye.', 'R2 snapshot 2 days old still shows');

// ---------- R3 ----------
const P = (d, q) => ({ jd: JD(d), q });
eq(txt(F.going(X('C/2026 A2 (Bok)', facts({ e: 0.9977, per: 23890, q: 1.9378, a: 829 }, { peri: { prev: null, next: P('2026-12-22', 1.9378) } }), now({ rdot: -4.66 })))),
  ['Passing the Sun now.', 'Closest on 22 Dec 2026, 290 million km from it.'], 'R3 Bok: 35 days before perihelion');
eq(F.going(X('C/x', facts({ e: 1.001, per: null }, { peri: { prev: null, next: P('2027-01-01', 1) } }), now({ rdot: -3 }))).a, 'Passing the Sun now.', 'R3 exactly 45 days before perihelion');
eq(txt(F.going(X('C/x', facts({ e: 1.001, per: null }, { peri: { prev: null, next: P('2027-01-02', 1) } }), now({ rdot: -3 })))),
  ['Heading toward the Sun.', 'Closest on 2 Jan 2027.'], 'R3 46 days before perihelion, inbound');
eq(txt(F.going(X('235P/LINEAR', facts({ e: 0.4276, per: 6.43, q: 1.978 }, { peri: { prev: P('2025-12-19', 1.978), next: P('2032-05-28', 1.98) } }), now({ rdot: 2.1, T: 20.5, T30: 20.6 })))),
  ['Heading away from the Sun.', 'It passed closest on 19 Dec 2025.', 'Next closest to the Sun: May 2032.'], 'R3 235P: outbound, next return from the integrated ephemeris');
eq(txt(F.going(X('2P/Encke', facts({ e: 0.847, per: 3.3, q: 0.336 }, { peri: { prev: P('2026-06-01', 0.336), next: null } }), now({ rdot: 3 })))),
  ['Heading away from the Sun.', 'It passed closest on 1 Jun 2026.'], 'R3 periodic without an integrated next return: no next line');
eq(txt(F.going(X('C/x', facts({ e: 1.0003, per: null }, { peri: { prev: P('2026-05-01', 1.5), next: null } }), now({ rdot: 5, T: 15, T30: 15.3 })))),
  ['Heading away from the Sun.', 'It passed closest on 1 May 2026.', 'Predicted to fade.'], 'R3 fading by 0.3 magnitudes in 30 days');
eq(txt(F.going(X('C/x', facts({ e: 1.0003, per: null }, { peri: { prev: P('2026-05-01', 1.5), next: null } }), now({ rdot: 5, T: 15, T30: 15.29 })))).length, 2, 'R3 fading by 0.29: not said');
eq(txt(F.going(X('C/x', facts({ e: 1.0003, per: null }, { peri: { prev: P('2026-05-01', 1.5), next: null }, extrapolated: true }), now({ rdot: 5, T: 15, T30: 16 })))).length, 2, 'R3 no fading from an extrapolated magnitude');
eq(txt(F.going(X('3I/ATLAS', facts({ e: 6.12, per: null, q: 1.352 }, { peri: { prev: P('2025-10-29', 1.3566), next: null } }), now({ rdot: 50 })))),
  ['Leaving the Solar System.', 'It passed closest to the Sun on 29 Oct 2025, 203 million km from it.'], 'R3 interstellar');
eq(txt(F.going(X('C/2026 A1 (MAPS)', facts({ e: 0.99996, per: 1899, q: 0.0057, a: 153 }, { peri: { prev: P('2026-04-04', 0.0057), next: null } }), now({ rdot: 9 }))))[2],
  'It skims the Sun; comets this close often break up.', 'R3 Sun-skimmer');
const other = F.going(X('C/x', facts({}, { peri: { prev: P('2026-05-01', 1.5), next: null } }), now({ soln: 'JPL#2', rdot: 5 })));
eq([other.a, other.needs, F.plain(other.d[0].text)], [null, true, 'JPL updated its orbit since these facts were baked; the direction needs data.'], 'R3 another JPL solution: no direction');

// a later day: the passages are sorted again, and an orbit last seen before a passed perihelion gates the magnitude
const later = Date.parse('2027-02-10T12:00:00Z');
const XL = (f, nw) => F.inputs({ id: 'C/x', detail: { co2: {}, facts: f } }, nw, later);
eq(txt(F.going(XL(facts({ e: 0.5, per: 6, q: 1.5 }, { peri: { prev: P('2020-12-22', 1.5), next: P('2026-12-22', 1.5) } }), now({ as_of: '2027-02-10', rdot: 3 })))),
  ['Heading away from the Sun.', 'It passed closest on 22 Dec 2026.'], 'R3 after the baked next perihelion has passed');
eq(F.see(XL(facts({ last_obs: '2026-11-16' }, { peri: { prev: null, next: P('2026-12-22', 1.5) } }), now({ as_of: '2027-02-10', T: 12 }))).needs, true, 'R2 last seen before a perihelion that has since passed');
eq(txt(F.going(X('C/x', facts({ e: 1.0003, per: null }, { peri: { prev: P('2026-05-01', 1.5), next: null } }), now({ rdot: 5, T: 13.8, T30: 14.1 })))).at(-1), 'Predicted to fade.', 'R3 fading by exactly 0.3 in decimals');

// ---------- R4 ----------
eq(F.decode('C/2026 A2 (Bok)').map(p => p.text), ['takes over 200 years to go round, or may not come back', 'found in the first half of January 2026', 'named for who found it'], 'R4 Bok');
eq(F.decode('235P/LINEAR').map(p => p.text), ['numbered: seen coming back at least twice', 'named for who found it'], 'R4 235P');
eq(F.decode('3I/ATLAS').map(p => p.code + ': ' + p.text), ['3I: the 3rd confirmed interstellar object', 'C/2025 N1: its comet name', 'ATLAS: named for who found it'], 'R4 3I');
eq(F.decode('240P/NEAT-B').map(p => p.text), ['fragment B of 240P/NEAT', 'named for who found it'], 'R4 a numbered fragment: no return history');
eq(F.decode('C/2025 K1-D (ATLAS)').map(p => p.text), ['takes over 200 years to go round, or may not come back', 'fragment D of C/2025 K1 (ATLAS)', 'named for who found it'], 'R4 a fragment: no discovery date');
eq(F.decode('P/2018 VN2 (Leonard)').map(p => p.text), ['comes back within 200 years', 'found in the first half of November 2018', 'first catalogued as an asteroid', 'named for who found it'], 'R4 asteroid-style code, V');
eq(F.decode('C/2025 J1 (Borisov)')[1].text, 'found in the first half of May 2025', 'R4 J follows H (I is skipped)');
eq(F.decode('C/2024 H5 (x)')[1].text, 'found in the second half of April 2024', 'R4 H');
eq(F.decode('C/2025 Y1 (ATLAS)')[1].text, 'found in the second half of December 2025', 'R4 Y');

// ---------- R5 ----------
eq(txt(F.orbit(X('C/2026 A2 (Bok)', facts({ e: 0.9977, per: 23890, a: 829 }, { inv: { first: MJD('2025-06-05'), visits: [] } })))),
  ['Its orbit takes thousands of years or more.', 'Too long to pin down; the planets change it each pass.', 'Found in January 2026.',
    'SPHEREx photographed its patch of sky 6 months before it was found.'], 'R5 Bok');
eq(txt(F.orbit(X('235P/LINEAR', facts({ e: 0.4276, per: 6.43 })))), ['A regular.', 'It comes back about every 6.4 years.'], 'R5 numbered');
eq(txt(F.orbit(X('P/2026 T1 (ATLAS)', facts({ e: 0.6, per: 12.34 })))), ['It comes back about every 12 years.', 'Found in October 2026.'], 'R5 unnumbered periodic');
eq(txt(F.orbit(X('C/2026 A1 (MAPS)', facts({ e: 0.99996, per: 1899.8, a: 153.4 })))), ['Its orbit takes about 1,900 years (rough).', 'Found in January 2026.'], 'R5 P over 200, a under 200 AU');
eq(txt(F.orbit(X('C/2025 K1-C (ATLAS)', facts({ e: 0.99995, per: 9.9e5, a: 9950 })))), ['Its orbit takes thousands of years or more.', 'Too long to pin down; the planets change it each pass.'], 'R5 near-parabolic, huge period, fragment: no found line');
eq(txt(F.orbit(X('C/2024 T5 (ATLAS)', facts({ e: 1.0003, per: null, a: null })))), ['Its return is uncertain.', 'In the current calculation its path is open; the planets will decide if it comes back.', 'Found in October 2024.'], 'R5 open orbit');
eq(txt(F.orbit(X('3I/ATLAS', facts({ e: 6.12, per: null, a: null })))), ['Just passing through.'], 'R5 interstellar');
eq(txt(F.orbit(X('C/2025 L2 (MAPS)', facts({ e: 1.0001, per: null, a: null }, { inv: { first: MJD('2025-06-01') - 19 + 0.0, visits: [] } }))))[3],
  'SPHEREx photographed its patch of sky shortly before it was found.', 'R5 first picture 19 days before the window (C/2025 L2)');
eq(txt(F.orbit(X('C/2025 L2 (MAPS)', facts({ e: 1.0001, per: null, a: null }, { inv: { first: MJD('2025-06-02'), visits: [] } })))).length, 3, 'R5 first picture inside the window: nothing said');
eq(txt(F.orbit(X('C/2026 A2 (Bok)', facts({ e: 0.9977, per: 23890, a: 829 }, { inv: { first: MJD('2025-12-01'), visits: [] } }))))[3],
  'SPHEREx photographed its patch of sky 1 month before it was found.', 'R5 exactly one month');

// ---------- R6 ----------
const BOK_CO2 = { '2025-06': { state: 'unclear', n_band: 0, n_cont: 2, why: '0 measurements in the CO2 band' }, '2026-09': { state: 'detected', n_band: 6, band: 36.8, cont: 5.79, excess: 31, sigma: 0.43 },
  '2026-10': { state: 'detected', n_band: 3, band: 28.7, cont: 6.9, excess: 21.8, sigma: 0.9 } };
const m1 = F.made(X('C/2026 A2 (Bok)', facts(), now({}), { co2_verdict: 'detected', co2: BOK_CO2 }));
eq([...txt(m1), m1.water, m1.chart], ['Carbon dioxide gas detected.', 'Comets are mostly ice and dust.', "4 to 6 times brighter at carbon dioxide's colour than beside it (Sep and Oct 2026).", 'Water: needs data', '2026-09'], 'R6 Bok');
const A3 = { '2025-08': { state: 'detected', n_band: 4, band: 26.51, cont: 0.17, excess: 26.34, sigma: 0.61 }, '2025-12': { state: 'detected', n_band: 4, band: 307.54, cont: 38.52, excess: 269.03, sigma: 13.63 } };
const m3 = F.made(X('3I/ATLAS', facts(), now({}), { co2_verdict: 'detected', co2: A3 }));
eq([...txt(m3), m3.chart], ['Carbon dioxide gas detected.', 'Comets are mostly ice and dust.', "8 times brighter at carbon dioxide's colour than beside it (Dec 2025).", '2025-12'], 'R6 3I: August left out (continuum 0.17 mJy)');
eq(txt(F.made(X('C/x', facts(), now({}), { co2_verdict: 'unclear', co2: { '2025-07': { state: 'unclear', n_band: 0, n_cont: 0 } } }))),
  ['These measurements do not settle it.', 'Comets are mostly ice and dust.', 'The spectrum misses that colour.'], 'R6 unclear, colour not covered');
eq(txt(F.made(X('C/x', facts(), now({}), { co2_verdict: 'unclear', co2: { '2025-07': { state: 'unclear', n_band: 3, n_cont: 9 } } }))),
  ['These measurements do not settle it.', 'Comets are mostly ice and dust.'], 'R6 unclear, colour covered');
eq(txt(F.made(X('235P/LINEAR', facts()))), ['Not measured yet.', 'Comets are mostly ice and dust.'], 'R6 not measured');

// ---------- R7 ----------
const sp = (v, why) => F.measures(X('C/x', facts(), now({ vx: v / F.AUD_KMS, vy: 0, vz: 0 }))).kv[3][1].v;
eq(sp(29.87), "29.9 km/s round the Sun, about Earth's speed round the Sun", 'R7 Earth-like speed');
eq(sp(18.2), '18.2 km/s round the Sun', 'R7');
eq(sp(25.4), "25.4 km/s round the Sun, about Earth's speed round the Sun", 'R7 within 15% of Earth');
eq(sp(25.2), '25.2 km/s round the Sun', 'R7 just past 15% under Earth');
eq(sp(34.2), "34.2 km/s round the Sun, about Earth's speed round the Sun", 'R7 within 15% over Earth');
eq(F.measures(X('C/x', facts(), null)).kv.map(([k, v]) => v.v), ['needs data', 'needs data', 'needs data', 'needs data'], 'R7 no snapshot: every value needs data');

// ---------- R8 ----------
const vis = (o) => ({ start: MJD('2026-02-15'), end: MJD('2026-03-02'), n: 44, dets: ['D1'], delta: 3.88, verdict: 'seen', snr: 59.8, measured: 3, tried: 3,
  link: { t: MJD('2026-02-20'), ra: 1, dec: 2, det: 'D1' }, img: null, T: 15.2, ...o });
const v8 = F.visits(X('C/2026 A2 (Bok)', facts({}, { inv: { visits: [vis({ verdict: 'faint', start: MJD('2025-06-10'), end: MJD('2025-06-22'), n: 113, delta: 5.68, T: 22.3 }),
  vis({}), vis({ start: MJD('2026-09-10'), end: MJD('2026-10-04'), n: 558, delta: 2.03 }), vis({ verdict: 'unmeasured', snr: null, delta: null })] } }), now({}),
  { co2: BOK_CO2 }));
eq(v8.map(v => [v.when, v.title, ...v.d.map(s => F.plain(s.text))]), [
  ['10–22 Jun 2025', 'Not detected. The ring marks where JPL puts it.', '850 million km away.', 'Magnitude 22.3 then.', 'A part of the sky SPHEREx photographs often.', 'Before it was found.'],
  ['15 Feb–2 Mar 2026', 'First seen.', "Its light stood 60 times above the picture's noise.", '580 million km away.'],
  ['10 Sep–4 Oct 2026', 'Seen.', "Its light stood 60 times above the picture's noise.", '304 million km away.', 'A part of the sky SPHEREx photographs often.', "Carbon dioxide detected in September's combined measurements."],
  ['15 Feb–2 Mar 2026', 'Could not be measured here.']], 'R8 Bok-like visits');
eq(F.visits(X('240P/NEAT-B', facts({}, { status: 'fragment', inv: { visits: [vis({ verdict: 'parent', near_parent: 12 })] } })))[0].title, 'Light near the parent’s position.', 'R8 a fragment within 25 arcsec of its parent');
eq(F.span(Date.parse('2025-07-27T05:00:00Z'), Date.parse('2025-07-27T09:00:00Z')), '27 Jul 2025', 'R8 a one-day visit');
eq(F.span(Date.parse('2025-12-20T00:00:00Z'), Date.parse('2026-01-03T00:00:00Z')), '20 Dec 2025–3 Jan 2026', 'R8 a visit across the new year');

// ---------- R9 ----------
const lead = (id, f, nw, d) => F.lead(X(id, f, nw, d)).map(s => s.text);
eq(lead('C/2026 A2 (Bok)', facts({ e: 0.9977, per: 23890, a: 829 }, { peri: { prev: null, next: P('2026-12-22', 1.94) } }), now({ rdot: -4.7 }), { co2_verdict: 'detected' }),
  ['A comet on a very long orbit, passing the Sun now.', 'SPHEREx detected carbon dioxide around it.'], 'R9 Bok');
eq(lead('235P/LINEAR', facts({ e: 0.4276, per: 6.43, q: 1.978 }, { peri: { prev: P('2025-12-19', 1.978), next: P('2032-05-28', 1.98) },
  inv: { visits: [vis({}), vis({}), vis({}), vis({ verdict: 'faint' })] } }), now({ rdot: 2.1 })),
  ["A comet that loops between Mars's path and Jupiter's path every 6.4 years, heading away from the Sun.", 'SPHEREx detected it on 3 of 4 visits.'], 'R9 235P');
eq(lead('3I/ATLAS', facts({ e: 6.12, per: null }, { peri: { prev: P('2025-10-29', 1.36), next: null } }), now({ rdot: 50 }), { co2_verdict: 'detected' }),
  ['A comet from outside the Solar System, leaving it.', 'SPHEREx detected carbon dioxide around it.'], 'R9 3I');
eq(lead('2P/Encke', facts({ e: 0.847, per: 3.3, q: 0.336 }, { peri: { prev: P('2026-06-01', 0.336), next: null }, inv: { visits: [vis({ verdict: 'faint' }), vis({ verdict: 'unmeasured' })] } }), now({ rdot: 3 })),
  ["A comet that loops from inside Mercury's path to Jupiter's path every 3.3 years, heading away from the Sun.", 'SPHEREx’s pictures did not detect it; 1 of 2 visits could be measured.'], 'R9 Encke: inside Mercury, one visit unmeasured');
eq(lead('C/2024 T5 (ATLAS)', facts({ e: 1.0003, per: null }, { peri: { prev: P('2026-01-01', 2), next: null }, inv: { visits: [vis({ verdict: 'faint' }), vis({ verdict: 'faint' })] } }), now({ rdot: 3 }), { co2_verdict: 'unclear' }),
  ['A comet passing through the inner Solar System, heading away from the Sun.', 'SPHEREx’s pictures did not detect it; the carbon dioxide answer is not settled.'], 'R9 open orbit, all faint, unclear');
eq(lead('P/x', facts({ e: 0.9, per: 70 })), ['A comet that comes back every 70 years.'], 'R9 P 20-200, direction unknown: no clause');
eq(F.lead(X('C/x', facts({ e: 1.0003, per: null }, { inv: { visits: [vis({ verdict: 'unmeasured' })] } }), now({ rdot: 3 }))).map(s => s.text).at(-1), 'None of its 1 SPHEREx visit could be measured.', 'R9 no visit could be measured');

// ---------- chips and the next box (rows 4, 5, 21) ----------
const chips = (id, f, d) => F.chips(X(id, f, now({}), d)).map(s => [s.text, s.label]);
eq(chips('C/2026 A2 (Bok)', facts({}, { peri: { prev: null, next: P('2026-12-22', 1.94) } }), { co2_verdict: 'detected' }),
  [['Carbon dioxide detected', 'measured'], ['Closest to the Sun 22 Dec 2026', 'predicted']], 'chips Bok');
eq(chips('235P/LINEAR', facts({}, { peri: { prev: P('2025-12-19', 1.98), next: P('2032-05-28', 1.98) }, inv: { visits: [vis({}), vis({ verdict: 'faint' })] } })),
  [['Detected on 1 of 2 visits', 'measured'], ['Was closest to the Sun 19 Dec 2025', 'predicted']], 'chips 235P: the passage nearer today');
eq(chips('3I/ATLAS', facts({}, { peri: { prev: P('2025-10-29', 1.36), next: null } }), { co2_verdict: 'detected' })[1], ['Was closest to the Sun 29 Oct 2025', 'predicted'], 'chips 3I');
eq(F.upcoming(X('C/2026 A2 (Bok)', facts({}, { peri: { prev: null, next: P('2026-12-22', 1.94) }, enc: { jd: JD('2026-11-16'), delta: 1.58 } }))),
  [{ when: 'This week', what: 'Near its closest to Earth', now: true }, { when: '22 Dec 2026', what: 'Closest to the Sun' }], 'next box Bok');
eq(F.upcoming(X('235P/LINEAR', facts({}, { peri: { prev: P('2025-12-19', 1.98), next: P('2032-05-28', 1.98) } }))), [{ when: 'May 2032', what: 'Closest to the Sun' }], 'next box 235P');

// ---------- review of ea27606: partial non-detections, parent light (fix 1, fix 2) ----------
// a visit not detected in only some of its pictures never reads as a flat "Not detected" (R8: all valid pictures below 5)
const part = F.visits(X('C/x', facts({}, { inv: { visits: [vis({ verdict: 'unseen', snr: null, n: 6, measured: 5, tried: 5 })] } })))[0];
eq([part.title, ...part.d.map(s => F.plain(s.text))], ['No detection in the 5 of 6 pictures measured. The ring marks where JPL puts it.', '580 million km away.', 'Magnitude 15.2 then.'], 'fix 1: a partly measured visit');
eq(F.visits(X('C/x', facts({}, { inv: { visits: [vis({ verdict: 'faint', snr: null, n: 6, measured: 6, tried: 6 })] } })))[0].title, 'Not detected. The ring marks where JPL puts it.', 'fix 1: a fully measured visit');
eq(F.lead(X('C/x', facts({ e: 1.0003, per: null }, { inv: { n: 50, visits: [vis({ verdict: 'unseen', snr: null, n: 30, measured: 12, tried: 12 }), vis({ verdict: 'faint', snr: null, n: 20, measured: 20, tried: 20 })] } }), now({ rdot: 3 }))).map(s => s.text).at(-1),
  'No detection in the 32 of 50 SPHEREx pictures measured.', 'fix 1: the lead does not claim a non-detection beyond what was measured');
eq(F.chips(X('C/x', facts({}, { inv: { visits: [vis({ verdict: 'unseen', snr: null })] } }))).map(s => s.text)[0], 'No detection in the pictures measured', 'fix 1: chip');
eq(F.group({ seen: 0, parent: 0, measured: 2, unseen: 1, visits: 2 }), 'partial', 'fix 1: list group');
// a fragment's light within its parent's measuring circle is never counted as the fragment detected
const frag = X('C/2023 R1-B (PANSTARRS)', facts({ e: 1.0003, per: null }, { status: 'fragment', inv: { visits: [vis({ verdict: 'faint', snr: null }), vis({ verdict: 'parent', near_parent: 23 }), vis({ verdict: 'parent', near_parent: 12.2 })] } }), now({ rdot: 3 }));
eq(F.lead(frag).map(s => s.text).at(-1), 'SPHEREx caught light near its parent’s position on 2 of 3 visits; it may be the parent’s light.', 'fix 2: lead');
eq(F.chips(frag).map(s => s.text)[0], 'Light near its parent on 2 of 3 visits', 'fix 2: chip');
eq(F.visits(frag).map(v => v.title), ['Not detected. The ring marks where JPL puts it.', 'Light near the parent’s position.', 'Light near the parent’s position.'], 'fix 2: visit titles');
eq(F.group({ seen: 0, parent: 2, measured: 3, unseen: 0, visits: 3 }), 'parent', 'fix 2: list group');

// ---------- every known comet: nothing forbidden, nothing empty ----------
const FIX = new URL('./fixtures/comets.json', import.meta.url);
if (fs.existsSync(FIX)) {
  const { today, comets } = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const T0 = Date.parse(today + 'T12:00:00Z');
  for (const c of comets) {
    const p = F.page(c, c.now, T0), e = c.detail?.facts?.orb?.e;
    const sentences = [...p.lead, ...p.chips, ...p.cards.flatMap(k => [{ text: k.a ?? '' }, ...k.d ?? [], ...(k.kv ?? []).map(([, v]) => ({ text: v.v }))]),
      ...p.visits.flatMap(v => [{ text: v.title }, ...v.d]), ...p.decode.map(x => ({ text: x.text }))].map(s => F.plain(s.text));
    const bad = sentences.filter(s => (e >= 1 && /\bloop/i.test(s)) || (/\bonly\b/i.test(s) && /hemisphere/i.test(s)) || /another star/i.test(s)
      || (/\bnever\b/i.test(s) && !/current orbit/i.test(s)) || /NaN|undefined|null|Infinity/.test(s));
    eq(bad, [], `${c.id}: forbidden phrases`);
    eq(p.cards.filter(k => !k.a && !k.needs && !k.kv).map(k => k.q), [], `${c.id}: every card answers or says needs data`);
    eq(p.cards.length, 6, `${c.id}: six cards`);
    // fix 1: "faint" only for a visit whose every picture was measured; fix 2: no "seen" fragment visit within 25 arcsec of its parent
    const vs = c.detail?.facts?.inv?.visits ?? [];
    eq(vs.filter(v => v.verdict === 'faint' && v.tried < v.n).length, 0, `${c.id}: faint visits not fully measured`);
    eq(vs.filter(v => v.verdict === 'seen' && v.near_parent != null).length, 0, `${c.id}: fragment visits counted as seen within the parent's circle`);
    // fix 4: a visit's quoted SNR is the shown picture's own: the picture file is the measurement's
    eq(vs.filter(v => v.snr != null && !(v.pic && v.img && v.img.endsWith(`/${v.pic.obs}_${v.pic.det}.png`) && v.pic.snr === v.snr)).length, 0, `${c.id}: visits whose SNR is not the shown picture's`);
  }
  console.log(`${comets.length} known comets scanned (${today})`);
} else { fails++; console.log(`FAIL no fixture at ${FIX.pathname} (python3 bake/comet_facts_fixture.py)`); }

console.log(`${fails ? 'FAIL' : 'PASS'} facts: ${n - fails} of ${n} checks`);
process.exit(fails ? 1 : 0);
