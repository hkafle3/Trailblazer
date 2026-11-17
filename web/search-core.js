// The Explore search's pure parts, no page needed: the five Examples targets, the RA and Dec reader, and name matching.
// web/search.js draws the box and uses these; web/tests/search_core.mjs checks them with node (npm test).

// Ming's five Examples (explore.html), at the positions their time-lapses use (data/flip/<key>/manifest.json). WISE 0855
// moves about 8 arcsec a year: its manifest has where it is now, as the time-lapse does, not the catalog's 2010 place.
// `aka`: other names people type. CDS Sesame does not know the short ones, so they resolve here.
export const TARGETS = [
  { key: 'barnard', name: "Barnard's Star", ra: 269.4463, dec: 4.7671, aka: ['Barnard', 'GJ 699', 'Gliese 699', 'V2500 Oph'] },
  { key: 'epsindib', name: 'Epsilon Indi B', ra: 331.096, dec: -56.801, aka: ['eps Ind B', 'eps Indi B', 'Epsilon Indi Ba'] },
  { key: 'wise0855', name: 'WISE 0855', ra: 133.7587, dec: -7.2421, aka: ['WISE 0855-0714', 'WISE J085510.83-071442.5', 'WISE J0855-0714'] },
  { key: 'rwaur', name: 'RW Aurigae', ra: 76.9563, dec: 30.4013, aka: ['RW Aur'] },
  { key: 'rdra', name: 'R Draconis', ra: 248.1674, dec: 66.7552, aka: ['R Dra'] },
];

// ---- RA and Dec ----
// Decimal degrees ("269.45 4.69", "269.45, +4.69", "RA 269.45 Dec 4.69", "269.45° +4.69°") or sexagesimal
// ("08h55m10.8s -07d14m42s", "08:55:10.8 -07:14:42", "08 55 10.8 -07 14 42"). RA written with h, colons or as three
// plain numbers is hours (times 15). Returns null when the text is not numbers at all (a name), else one of
//   { ra, dec }                     degrees, in range
//   { half: ra }                    only an RA so far
//   { error, help }                 which number is wrong, and the rule it breaks
const LEAD = new Set(['h', 'd', '°']), MORE = new Set([':', 'h', 'd', '°', 'm', "'", '′']);
export function parse(q) {
  const s = q.replace(/[−–]/g, '-').replace(/\b(ra|dec)\b\s*[:=]?/gi, ' ').replace(/,/g, ' ').trim();
  if (!/^[+-]?\s*(\d|\.\d)/.test(s)) return null;
  const re = /([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)\s*([hmsd°'"′″:]?)\s*/giy, toks = [];
  for (let m; re.lastIndex < s.length;) {
    const at = re.lastIndex;
    if (!(m = re.exec(s))) return null;   // letters or stray marks: a name, not coordinates
    toks.push({ sign: m[1], n: +m[2], unit: m[3].toLowerCase(), text: s.slice(at, re.lastIndex).trim() });
  }
  // one group per value: a sign or a lead unit (h, d, °) starts a new one, and so does anything after a value that ended
  let groups = [];
  for (const t of toks) {
    const g = groups.at(-1);
    if (!g || t.sign || LEAD.has(t.unit) || !MORE.has(g.at(-1).unit) || g.length === 3) groups.push([t]); else g.push(t);
  }
  // plain numbers: a sign starts the Dec ("08 55 10.8 -7.245"); else 4 or 6 split in half ("08 55 10.8 07 14 42")
  const plain = toks.every(t => !t.unit), k = toks.findIndex((t, i) => i && t.sign);
  if (plain && toks.length > 2) groups = k > 0 ? [toks.slice(0, k), toks.slice(k)] : toks.length % 2 ? groups : [toks.slice(0, toks.length / 2), toks.slice(toks.length / 2)];
  if (groups.some(g => g.length > 3)) return { error: 'That is more than an RA and a Dec.', help: 'Type RA, then Dec:' };
  if (groups.length > 2) return { error: 'That is more than an RA and a Dec.', help: 'Type RA, then Dec:' };
  const text = g => g.map(t => t.text).join(g.some(t => t.unit) ? '' : ' ');
  const vals = groups.map((g, i) => {
    const [a, b = 0, c = 0] = g.map(t => t.n), hours = i === 0 && (g[0].unit === 'h' || (g[0].unit === ':') || (plain && g.length > 1));
    const name = i ? 'Dec' : 'RA';
    if (b >= 60 || c >= 60) return { error: `${name} ${text(g)} has ${b >= 60 ? 'minutes' : 'seconds'} over 59.`, help: 'Minutes and seconds run from 0 to 59. Type RA, then Dec:' };
    const v = (g[0].sign === '-' ? -1 : 1) * (a + b / 60 + c / 3600);
    if (i === 0 && (v < 0 || v > (hours ? 24 : 360)))
      return { error: `RA ${text(g)} is off the sky.`, help: 'RA runs from 0 to 360, or 0h to 24h. Type RA, then Dec:' };
    if (i === 1 && Math.abs(v) > 90) return { error: `Dec ${text(g)} is off the sky.`, help: 'Dec runs from -90 to +90. Type RA, then Dec:' };
    return { v: i === 0 ? (hours ? v * 15 : v) % 360 : v };
  });
  const bad = vals.find(x => x.error);
  if (bad) return bad;
  return vals.length === 1 ? { half: vals[0].v } : { ra: vals[0].v, dec: vals[1].v };
}

// ---- names ----
// Lowercase letters and digits only, so "3i atlas", "wise0855" and "WISE 0855-0714" all match. A hit is ranked: the whole
// name 0, its start 1, the start of a word 2, anywhere 3 (only from 3 letters typed, so "r" does not list half the sky).
// s and e mark the matched part in the original name, for bold.
export const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function hit(name, nq) {
  const idx = [];
  let n = '';
  for (let i = 0; i < name.length; i++) { const c = name[i].toLowerCase(); if (/[a-z0-9]/.test(c)) { idx.push(i); n += c; } }
  let best = null;
  for (let p = n.indexOf(nq); nq && p >= 0; p = n.indexOf(nq, p + 1)) {
    const s = idx[p], rank = n === nq ? 0 : p === 0 ? 1 : !/[a-z0-9]/i.test(name[s - 1]) ? 2 : 3;
    if (!best || rank < best.rank) best = { rank, s, e: idx[p + nq.length - 1] + 1 };
  }
  return best && (nq.length >= 3 || best.rank < 3) ? best : null;
}
// targets: [{ t, label, s, e, rank }] (label: the name that matched, its own name when it does, else an alias); comets: [{ c, s, e, rank }]
export function matchLocal(q, comets, max = 6) {
  const nq = norm(q), by = (a, b) => a.rank - b.rank;
  if (!nq) return { targets: [], comets: [] };
  const targets = TARGETS.map(t => {
    let b = null;
    for (const label of [t.name, ...t.aka]) { const h = hit(label, nq); if (h && (!b || h.rank < b.rank)) b = { t, label, ...h }; }
    const own = hit(t.name, nq);   // shown by its own name when that matches too ("barnard": Barnard's Star, not the alias Barnard)
    return b && (own ? { t, label: t.name, ...own, rank: b.rank } : b);
  }).filter(Boolean).sort(by);
  // among equal matches: comets with a CO2 glow first (3I/ATLAS), then the ones SPHEREx photographed most
  const score = c => (c.co2 === 'detected' ? 1e6 : 0) + (c.photos ?? 0);
  const cs = comets.map(c => { const h = hit(c.id, nq); return h && { c, ...h }; }).filter(Boolean).sort((a, b) => by(a, b) || score(b.c) - score(a.c)).slice(0, max);
  return { targets, comets: cs };
}

// angle between two sky positions, in degrees
export function sep(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180, a = Math.sin((dec2 - dec1) * r / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin((ra2 - ra1) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / r;
}

// CDS Sesame's plain-text answer: the line starting %J has RA and Dec in degrees (J2000, epoch 2000.0). null when it
// found nothing. A %P line is the proper motion (mas/yr, RA already times cos Dec): the star is moved to `year`, so a
// fast star opens where SPHEREx sees it now. Barnard's Star has moved 4.5 arcmin since 2000, so its J2000 place is
// empty sky in a 6 arcmin time-lapse.
export function sesameRaDec(text, year = 2000 + (Date.now() - Date.UTC(2000, 0, 1, 12)) / 31557600000) {
  const m = text.match(/^%J\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)/m);
  if (!m) return null;
  let ra = +m[1], dec = +m[2];
  const p = text.match(/^%P\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)/m);
  if (p) {
    const dt = year - 2000;
    dec = Math.max(-90, Math.min(90, dec + +p[2] / 3.6e6 * dt));
    ra = ((ra + +p[1] / 3.6e6 * dt / Math.cos(dec * Math.PI / 180)) % 360 + 360) % 360;
  }
  return { ra, dec };
}
