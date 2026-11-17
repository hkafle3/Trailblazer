// What a comet's page says, as plain sentences, each with the label it carries (comet-plan/fact-table.md, rules R1-R9).
// Pure functions of the comet's record (GET /api/comets/:id: detail.facts from bake/comet_facts.py, the SPHEREx
// measurements in detail.co2) and the daily snapshot (now: the Worker's cron, "as of" its date) on a given day.
// Nothing here reads the page or the clock: comet.js passes today, web/tests/facts_test.mjs passes fixed days.
//
// A sentence is { text, label }: label is 'measured' (SPHEREx, TrailBlazer), 'predicted' (JPL, dated), 'needs' (needs
// data), 'name' (how comet names work), or null (general background with no number). **x** marks a number shown bold.

export const AU_KM = 149.6e6, MOON_KM = 384400, EARTH_KMS = 29.8, W = 45, AUD_KMS = AU_KM / 86400;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const JD_UNIX = 2440587.5, MJD_JD = 2400000.5, DAY = 864e5;
export const jdMs = jd => (jd - JD_UNIX) * DAY;
export const mjdMs = mjd => jdMs(mjd + MJD_JD);
const utc = (ms, o) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
export const day = ms => utc(ms, { day: 'numeric', month: 'short', year: 'numeric' }).replace('Sept', 'Sep');     // 22 Dec 2026
export const monthYear = ms => utc(ms, { month: 'long', year: 'numeric' });                                     // December 2026
const mon = ms => utc(ms, { month: 'short' }).replace('Sept', 'Sep');
export const dayMs = s => Date.parse(s + 'T00:00:00Z');   // 'YYYY-MM-DD' -> ms

// ---------- numbers, formatted in one place: 3 significant figures ----------
export const sig = (x, n = 3) => {
  const v = Number(x.toPrecision(n));
  return v >= 1000 ? Math.round(v).toLocaleString('en-US') : String(v);
};
export function dist(au) {
  const km = au * AU_KM;
  if (km >= 1e9) return `${sig(km / 1e9)} billion km`;
  if (km >= 1e6) return `${sig(km / 1e6)} million km`;
  return `${sig(km)} km`;
}
const b = s => `**${s}**`;
export const plain = s => s.replace(/\*\*/g, '');
const S = (text, label) => ({ text, label });

// ---------- names (R4) ----------
const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXY';   // half-month letters: I skipped, Z unused
const ORD = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const ALSO = { '3I/ATLAS': 'C/2025 N1' };     // an interstellar object's comet designation (JPL Horizons)
export function parseName(id) {
  let m = id.match(/^(\d+)I\/(.+)$/);
  if (m) return { kind: 'I', n: +m[1], who: m[2] };
  m = id.match(/^(\d+)P\/(.+?)(?:-([B-Z]))?$/);
  if (m) return { kind: 'P', n: +m[1], who: m[2], frag: m[3] ?? null, parent: m[3] ? `${m[1]}P/${m[2]}` : null };
  m = id.match(/^([CP])\/(\d{4}) ([A-Z])([A-Z]?)(\d*)(?:-([B-Z]))?(?: \((.+)\))?$/);
  if (!m) return { kind: '?' };
  const [, kind, year, half, second, , frag, who] = m, k = LETTERS.indexOf(half);
  return { kind, year: +year, half, asteroid: !!second, k, frag: frag ?? null, who: who ?? null,
    code: `${year} ${half}${second}${m[5]}`, parent: frag ? id.replace(`-${frag}`, '') : null };
}
// the half-month a provisional designation names: [start ms, end ms)
export function foundWindow(id) {
  const p = parseName(id);
  if (p.year == null || p.k < 0 || p.frag) return null;
  const month = p.k >> 1, first = !(p.k & 1);
  const start = Date.UTC(p.year, month, first ? 1 : 16), end = first ? Date.UTC(p.year, month, 16) : Date.UTC(p.year, month + 1, 1);
  return { start, end, first, month };
}
export function decode(id) {
  const p = parseName(id), out = [];
  if (p.kind === 'I') {
    out.push({ code: `${p.n}I`, text: `the ${ORD(p.n)} confirmed interstellar object` });
    if (ALSO[id]) out.push({ code: ALSO[id], text: 'its comet name' });
  } else if (p.kind === 'P' && p.n) {
    if (!p.frag) out.push({ code: `${p.n}P`, text: 'numbered: seen coming back at least twice' });
  } else if (p.kind === 'C') out.push({ code: 'C/', text: 'takes over 200 years to go round, or may not come back' });
  else if (p.kind === 'P') out.push({ code: 'P/', text: 'comes back within 200 years' });
  const w = foundWindow(id);
  if (w) out.push({ code: p.code, text: `found in the ${w.first ? 'first' : 'second'} half of ${MONTHS[w.month]} ${p.year}` });
  if (p.asteroid && !p.frag) out.push({ code: p.code.split(' ')[1], text: 'first catalogued as an asteroid' });
  if (p.frag) out.push({ code: `-${p.frag}`, text: `fragment ${p.frag} of ${p.parent}` });
  if (p.who) out.push({ code: p.who, text: 'named for who found it' });
  return out;
}

// ---------- the inputs, checked once ----------
// now: the snapshot, shown only within 2 days of its date; ORB and NOW from different JPL solutions are not combined
export function inputs(c, now, today) {
  const d = c.detail ?? {}, orb = d.facts?.orb ?? null;
  // the baked passages, sorted into before and after the given day (the bake day's split goes stale once one passes)
  let f = d.facts ?? null;
  if (f?.peri) {
    const ps = [f.peri.prev, f.peri.next].filter(Boolean);
    f = { ...f, peri: { ...f.peri, prev: ps.filter(p => jdMs(p.jd) <= today).at(-1) ?? null, next: ps.find(p => jdMs(p.jd) > today) ?? null } };
  }
  const age = now ? Math.floor(today / DAY) - dayMs(now.as_of) / DAY : null;   // whole days since the snapshot's date
  const fresh = age != null && age >= -1 && age <= 2;
  const n = fresh ? now : null;
  return { id: c.id, d, f, orb, now: n, same: !!(n && orb && n.soln === orb.soln), today, name: parseName(c.id) };
}

// ---------- R1 Is it dangerous ----------
function compare(au) {
  if (au >= 0.9 && au <= 1.1) return 'about our distance from the Sun';
  if (au >= 0.5) return `${(Math.round(au * 10) / 10).toFixed(1)} times Earth's distance from the Sun`;
  return `${Math.round(au * AU_KM / MOON_KM).toLocaleString('en-US')} times the Moon's distance`;
}
export function danger(x) {
  const { orb, f, today } = x, card = { q: 'Is it dangerous?', label: 'predicted', src: srcOrb(x) };
  if (!orb || orb.moid == null) return { ...card, a: null, needs: true, d: [S('Its closest possible distance to Earth needs data.', 'needs')] };
  const enc = f.enc, week = enc && Math.abs(today - jdMs(enc.jd)) <= 7 * DAY;
  let a, d;
  if (orb.moid >= 0.05) {
    a = 'No.';
    d = [S(`In JPL's current orbit, its path and Earth's never come closer than ${b(dist(orb.moid))}, ${compare(orb.moid)}.`, 'predicted')];
  } else if (enc) {
    a = 'Not on this pass.';
    d = [S(`Its path passes within ${b(dist(orb.moid))} of Earth's, but the closest it comes to Earth this time is ${b(dist(enc.delta))} on ${day(jdMs(enc.jd))}.`, 'predicted')];
  } else {
    return { ...card, a: null, needs: true, d: [S(`Its path passes within ${b(dist(orb.moid))} of Earth's.`, 'predicted'), S('Closest approach: needs data.', 'needs')] };
  }
  if (week) d.push(S('This week it is near its closest to Earth.', 'predicted'));
  return { ...card, a, d };
}

// ---------- R2 Can I see it ----------
const CNST = { And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila', Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga', Boo: 'Boötes',
  Cae: 'Caelum', Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major', CMi: 'Canis Minor', Cap: 'Capricornus',
  Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus', Col: 'Columba',
  Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis', Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux', Cyg: 'Cygnus',
  Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules',
  Hor: 'Horologium', Hya: 'Hydra', Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra',
  Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra', Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans',
  Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus', Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus',
  Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum',
  Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe', Tuc: 'Tucana',
  UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo', Vol: 'Volans', Vul: 'Vulpecula' };
export const CAVEAT = 'Comet brightness forecasts are often off by a magnitude or two.';
// why JPL's magnitude cannot be used (R2's status gate), or null
export function magGate(x) {
  const { f, now } = x;
  if (!now) return 'Today’s forecast needs data.';
  if (f?.status === 'fragment') return 'It is a fragment of a comet, and JPL’s brightness forecast does not cover the pieces.';
  if (f?.status === 'disrupted') return `It ${f.status_note ?? 'broke up'}, so brightness forecasts no longer apply.`;
  if (extrapolated(x)) return 'JPL’s last sighting of it came before it passed the Sun, so today’s brightness is a guess.';
  if (now.T == null || now.T > 30) return 'JPL has no usable brightness forecast for it.';
  return null;
}
// the orbit's last observation came before a perihelion that has passed by the given day (R2's status gate)
export function extrapolated(x) {
  const { f, orb, today } = x;
  if (f?.extrapolated) return true;
  const p = f?.peri?.prev;
  return !!(p && orb?.last_obs && dayMs(orb.last_obs) < jdMs(p.jd) && jdMs(p.jd) <= today);
}
export function see(x) {
  const { now } = x, card = { q: 'Can I see it?', label: 'predicted', src: srcNow(x) };
  const gate = magGate(x);
  if (gate) return { ...card, a: null, needs: true, d: [S(gate, 'needs')] };
  const T = now.T, el = Math.round(now.elong), d = [];
  if (now.elong < 20) return { ...card, a: 'Not now.', d: [S(`It is too close to the Sun in the sky (${b(Math.floor(now.elong) + '°')} away).`, 'predicted'), S(CAVEAT, null)] };
  let a;
  if (T <= 6) a = 'Maybe by eye from a dark site.';
  else if (T <= 10) { a = 'Not by eye.'; d.push(S('Binoculars or a small telescope may show it.', 'predicted')); }
  else { a = 'Not by eye.'; d.push(S('It needs a telescope, and a fuzzy comet looks fainter than its number.', 'predicted')); }
  if (T > 6 && T <= 16) d.push(S(`About ${b(sig(2.512 ** (T - 6), 2) + ' times')} too faint for your eyes (magnitude ${T.toFixed(1)}; bigger is fainter; the eye stops near 6).`, 'predicted'));
  else d.push(S(`Magnitude ${b(T.toFixed(1))} (bigger is fainter; the eye stops near 6).`, 'predicted'));
  const sky = now.side === '/T' ? 'Evening sky' : now.side === '/L' ? 'Morning sky' : 'In the sky';
  const far = now.dec > 50 ? ', far north in the sky' : now.dec < -50 ? ', far south in the sky' : '';
  d.push(S(`${sky}, ${el}° from the Sun, in ${CNST[now.cnst] ?? now.cnst}${far}.`, 'predicted'));
  d.push(S(CAVEAT, null));
  return { ...card, a, d };
}

// ---------- R3 Where is it going ----------
// the nearest passage, the direction and what to say; phrase: the lead's clause
export function going(x) {
  const { f, now, today, name, same } = x, card = { q: 'Where is it going?', label: 'predicted', src: srcBoth(x) };
  if (!f) return { ...card, a: null, needs: true, d: [S('Its path needs data.', 'needs')] };
  const { prev, next } = f.peri, orb = f.orb, d = [];
  const near = [prev, next].filter(Boolean).sort((p, q) => Math.abs(jdMs(p.jd) - today) - Math.abs(jdMs(q.jd) - today))[0];
  let a, phrase;
  if (name.kind === 'I') {
    a = 'Leaving the Solar System.'; phrase = 'leaving it';
    if (prev) d.push(S(`It passed closest to the Sun on ${b(day(jdMs(prev.jd)))}, ${b(dist(prev.q))} from it.`, 'predicted'));
  } else if (near && Math.abs(jdMs(near.jd) - today) <= W * DAY) {
    a = 'Passing the Sun now.'; phrase = 'passing the Sun now';
    d.push(S(`Closest on ${b(day(jdMs(near.jd)))}, ${b(dist(near.q))} from it.`, 'predicted'));
  } else if (now && same && now.rdot < 0 && next) {
    a = 'Heading toward the Sun.'; phrase = 'heading toward the Sun';
    d.push(S(`Closest on ${b(day(jdMs(next.jd)))}.`, 'predicted'));
  } else if (now && same && now.rdot > 0 && prev) {
    a = 'Heading away from the Sun.'; phrase = 'heading away from the Sun';
    d.push(S(`It passed closest on ${b(day(jdMs(prev.jd)))}.`, 'predicted'));
  } else return { ...card, a: null, needs: true, d: [S(now && !same ? 'JPL updated its orbit since these facts were baked; the direction needs data.' : 'Its direction needs data.', 'needs')] };
  if (orb.per != null && orb.per < 200 && name.kind !== 'I' && next && !(a === 'Passing the Sun now.' && near === next) && a !== 'Heading toward the Sun.')
    d.push(S(`Next closest to the Sun: ${b(monthYear(jdMs(next.jd)))}.`, 'predicted'));
  if (now && same && !magGate(x) && now.T30 != null && now.T30 - now.T >= 0.3 - 1e-9) d.push(S('Predicted to fade.', 'predicted'));
  if (orb.q < 0.01) d.push(S('It skims the Sun; comets this close often break up.', 'predicted'));
  return { ...card, a, d, phrase };
}

// ---------- the size / distance / speed card (R7) ----------
export function measures(x) {
  const { now } = x, card = { q: 'How big, how far, how fast?', label: 'predicted', src: srcNow(x) };
  const nd = { v: 'needs data', label: 'needs' };
  let speed = nd;
  if (now?.vx != null) {
    const v = Math.hypot(now.vx, now.vy, now.vz) * AUD_KMS;
    speed = { v: `${sig(v)} km/s round the Sun${Math.abs(v / EARTH_KMS - 1) <= 0.15 ? ", about Earth's speed round the Sun" : ''}`, label: 'predicted' };
  }
  return { ...card, kv: [['Solid core', nd], ['From Earth', now ? { v: dist(now.delta), label: 'predicted' } : nd],
    ['From the Sun', now ? { v: dist(now.r), label: 'predicted' } : nd], ['Speed', speed]] };
}

// ---------- R5 Is it new / its orbit ----------
function monthsBetween(a, b2) {   // whole calendar months from a to b (ms)
  const A = new Date(a), B = new Date(b2);
  let m = (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + B.getUTCMonth() - A.getUTCMonth();
  if (B.getUTCDate() < A.getUTCDate()) m--;
  return m;
}
export function firstPicture(x) {
  const i = x.f?.inv, ph = x.d.photos ?? [];
  const t = [i?.first, ...ph.map(p => p.mjd)].filter(v => v != null);
  return t.length ? mjdMs(Math.min(...t)) : null;
}
export function orbit(x) {
  const { orb, name, id } = x, card = { q: 'Is it new? Where from?', label: 'predicted', src: srcOrb(x) };
  if (!orb) return { ...card, a: null, needs: true, d: [S('Its orbit needs data.', 'needs')] };
  const P = orb.per, d = [];
  let a;
  if (name.kind === 'I') a = 'Just passing through.';
  else if (name.kind === 'P' && name.n && !name.frag && P != null) { a = 'A regular.'; d.push(S(`It comes back about every ${b(sig(P, 2) + ' years')}.`, 'predicted')); }
  else if (orb.e < 1 && P != null && P < 200) a = `It comes back about every ${sig(P, 2)} years.`;
  else if (orb.e < 1 && P != null && orb.a != null && orb.a <= 200) a = `Its orbit takes about ${sig(P, 2)} years (rough).`;
  else if (orb.e < 1) { a = 'Its orbit takes thousands of years or more.'; d.push(S('Too long to pin down; the planets change it each pass.', 'predicted')); }
  else { a = 'Its return is uncertain.'; d.push(S('In the current calculation its path is open; the planets will decide if it comes back.', 'predicted')); }
  const w = foundWindow(id);
  if (w && !name.frag) {
    d.push(S(`Found in ${MONTHS[w.month]} ${name.year}.`, 'name'));
    const first = firstPicture(x);
    if (first != null && first < w.start) {
      const m = monthsBetween(first, w.start);
      d.push(S(m >= 1 ? `SPHEREx photographed its patch of sky ${b(m + (m === 1 ? ' month' : ' months'))} before it was found.` : 'SPHEREx photographed its patch of sky shortly before it was found.', 'measured'));
    }
  }
  return { ...card, a, d };
}

// ---------- R6 What is it made of ----------
const MON_SHORT = k => new Date(`${k}-01T00:00:00Z`);
function monthsList(keys) {   // ['2026-09', '2026-10'] -> 'Sep and Oct 2026'
  const ds = keys.map(MON_SHORT), yrs = [...new Set(ds.map(d2 => d2.getUTCFullYear()))];
  const names = ds.map(d2 => mon(d2.getTime()) + (yrs.length > 1 ? ' ' + d2.getUTCFullYear() : ''));
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return yrs.length > 1 ? list : `${list} ${yrs[0]}`;
}
export function co2Months(d) {
  return Object.entries(d.co2 ?? {}).filter(([, v]) => v.state === 'detected' && v.cont >= 1).sort(([a], [b2]) => a.localeCompare(b2));
}
export function chartMonth(d) {   // eligible detected months, then the most band points, then the highest excess/sigma
  const e = co2Months(d);
  if (!e.length) return null;
  return e.slice().sort(([, p], [, q]) => q.n_band - p.n_band || q.excess / q.sigma - p.excess / p.sigma)[0][0];
}
export function made(x) {
  const { d } = x, v = d.co2_verdict ?? null, card = { q: 'What is it made of?', label: 'measured', src: v ? srcSx(x) : null };
  const base = S('Comets are mostly ice and dust.', null), water = 'Water: needs data';
  if (v === 'detected') {
    const ms = co2Months(d), out = [base];
    if (ms.length) {
      const r = ms.map(([, m]) => Math.round(m.band / m.cont)), lo = Math.min(...r), hi = Math.max(...r);
      out.push(S(`${b(lo === hi ? `${lo} times` : `${lo} to ${hi} times`)} brighter at carbon dioxide's colour than beside it (${monthsList(ms.map(([k]) => k))}).`, 'measured'));
    }
    return { ...card, a: 'Carbon dioxide gas detected.', d: out, water, chart: chartMonth(d) };
  }
  if (v === 'unclear') {
    const un = Object.values(d.co2 ?? {}).filter(m => m.state === 'unclear');
    const miss = un.length && un.every(m => m.n_band === 0 || m.n_cont === 0 || /^0 measurements/.test(m.why ?? ''));
    return { ...card, a: 'These measurements do not settle it.', d: [base, ...(miss ? [S('The spectrum misses that colour.', 'measured')] : [])], water };
  }
  if (v === 'quiet') return { ...card, a: 'No carbon dioxide glow found.', d: [base], water };
  return { ...card, label: 'needs', a: 'Not measured yet.', d: [base], needs: true, water };
}

// ---------- R8 visits ----------
const monthKey = ms => new Date(ms).toISOString().slice(0, 7);
export function visits(x) {
  const vs = x.f?.inv?.visits ?? [], w = foundWindow(x.id), co2 = x.d.co2 ?? {};
  let firstSeen = true;
  return vs.map((v, k) => {
    const s = mjdMs(v.start), e = mjdMs(v.end), out = [];
    let title;
    if (v.verdict === 'seen') {
      title = firstSeen ? 'First seen.' : 'Seen.';
      firstSeen = false;
      out.push(S(`Its light stood ${b(Math.round(v.snr) + ' times')} above the picture's noise.`, 'measured'));
    } else if (v.verdict === 'parent') {   // a fragment's light within its parent's measuring circle: maybe the parent's
      title = 'Light near the parent’s position.';
      out.push(S(`It may be the parent comet’s light: the two were ${b(Math.round(v.near_parent) + ' arcseconds')} apart, inside the measuring circle.`, 'measured'));
    } else if (v.verdict === 'faint') title = 'Not detected. The ring marks where JPL puts it.';
    else if (v.verdict === 'unseen') title = `No detection in the ${v.measured} of ${v.n.toLocaleString('en-US')} pictures measured. The ring marks where JPL puts it.`;
    else title = 'Could not be measured here.';
    if (v.delta != null) out.push(S(`${b(dist(v.delta))} away.`, 'predicted'));
    if ((v.verdict === 'faint' || v.verdict === 'unseen') && v.T != null && v.T <= 30 && !x.f?.status) out.push(S(`Magnitude ${v.T.toFixed(1)} then.`, 'predicted'));
    if (v.n >= 100) out.push(S('A part of the sky SPHEREx photographs often.', 'measured'));
    if (w && e < w.start) out.push(S('Before it was found.', 'measured'));
    const spanned = [];
    for (let m = new Date(Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth(), 1)); m.getTime() <= e; m.setUTCMonth(m.getUTCMonth() + 1)) spanned.push(monthKey(m.getTime()));
    const months = spanned.filter(m => co2[m]?.state === 'detected');
    if (months.length) out.push(S(`Carbon dioxide detected in ${MONTHS[+months[0].slice(5) - 1]}'s combined measurements.`, 'measured'));
    // the card's one short line (Ed, 17 Nov): the full sentences go to the card's hover and to Advanced
    const short = { seen: `Seen: ${Math.round(v.snr ?? 0)} times above the picture's noise.`, parent: 'Light near its parent’s position; maybe the parent’s.',
      faint: 'Too faint here.', unseen: `Not seen in the ${v.measured} of ${v.n.toLocaleString('en-US')} pictures measured.` }[v.verdict] ?? 'Could not be measured here.';
    return { k, when: span(s, e), start: s, end: e, title, short, d: out, verdict: v.verdict, n: v.n, link: v.link, img: v.img, lam: v.lam ?? null };
  });
}
export function span(s, e) {   // 15-22 Jun 2025, 15 Feb-2 Mar 2026, 27 Jul 2025
  const D = ms => utc(ms, { day: 'numeric' }), Y = ms => new Date(ms).getUTCFullYear();
  if (D(s) === D(e) && mon(s) === mon(e) && Y(s) === Y(e)) return `${D(s)} ${mon(s)} ${Y(s)}`;
  if (Y(s) !== Y(e)) return `${D(s)} ${mon(s)} ${Y(s)}–${D(e)} ${mon(e)} ${Y(e)}`;
  if (mon(s) !== mon(e)) return `${D(s)} ${mon(s)}–${D(e)} ${mon(e)} ${Y(e)}`;
  return `${D(s)}–${D(e)} ${mon(e)} ${Y(e)}`;
}

// ---------- R9 lead ----------
const PLANETS = [['Mercury', 0.387], ['Venus', 0.723], ['Earth', 1], ['Mars', 1.524], ['Jupiter', 5.203], ['Saturn', 9.537], ['Uranus', 19.19], ['Neptune', 30.07]];
export function orbitClause(x) {
  const { orb, name } = x;
  if (name.kind === 'I') return 'A comet from outside the Solar System';
  if (!orb) return null;
  const P = orb.per;
  if (orb.e < 1 && P != null && P < 20) {
    const Q = orb.q * (1 + orb.e) / (1 - orb.e), inner = PLANETS.filter(([, a]) => a < orb.q).at(-1), outer = PLANETS.find(([, a]) => a > Q);
    const from = inner ? `between ${inner[0]}'s path` : `from inside Mercury's path`, to = outer ? `${outer[0]}'s path` : 'beyond Neptune';
    return `A comet that loops ${from} ${inner ? 'and' : 'to'} ${to} every ${sig(P, 2)} years`;
  }
  if (orb.e < 1 && P != null && P <= 200) return `A comet that comes back every ${sig(P, 2)} years`;
  if (orb.e < 1) return 'A comet on a very long orbit';
  return 'A comet passing through the inner Solar System';
}
export function counts(x) {
  const vs = x.f?.inv?.visits ?? [];
  const k = verdict => vs.filter(v => v.verdict === verdict).length;
  return { n: vs.length, seen: k('seen'), parent: k('parent'), unseen: k('unseen'), measured: vs.filter(v => v.verdict !== 'unmeasured').length,
    valid: vs.reduce((t, v) => t + (v.measured ?? 0), 0), pictures: x.f?.inv?.n ?? 0 };
}
export function sxClause(x) {
  const v = x.d.co2_verdict, c = counts(x);
  let s;
  if (v === 'detected') s = 'SPHEREx detected carbon dioxide around it';
  else if (c.seen) s = `SPHEREx detected it on ${c.seen} of ${c.n} visit${c.n === 1 ? '' : 's'}` + (c.parent ? `; on ${c.parent} more, light near its parent’s position may be the parent’s` : '');
  else if (c.parent) s = `SPHEREx caught light near its parent’s position on ${c.parent} of ${c.n} visit${c.n === 1 ? '' : 's'}; it may be the parent’s light`;
  else if (c.unseen) s = `No detection in the ${c.valid.toLocaleString('en-US')} of ${c.pictures.toLocaleString('en-US')} SPHEREx pictures measured`;
  else if (c.n && c.measured === c.n) s = 'SPHEREx’s pictures did not detect it';
  else if (c.n && !c.measured) s = `None of its ${c.n} SPHEREx visit${c.n === 1 ? '' : 's'} could be measured`;
  else if (c.n) s = `SPHEREx’s pictures did not detect it; ${c.measured} of ${c.n} visit${c.n === 1 ? '' : 's'} could be measured`;
  else return null;
  if (v === 'unclear') s += '; the carbon dioxide answer is not settled';
  return s + '.';
}
export function lead(x, g = going(x)) {
  const o = orbitClause(x), sx = sxClause(x), out = [];
  if (o) out.push(S(g.phrase ? `${o}, ${g.phrase}.` : `${o}.`, 'predicted'));
  if (sx) out.push(S(sx, 'measured'));
  return out;
}

// ---------- chips, next box ----------
export function chips(x, g = going(x)) {
  const v = x.d.co2_verdict, c = counts(x), out = [];
  if (v === 'detected') out.push(S('Carbon dioxide detected', 'measured'));
  else if (v === 'unclear') out.push(S('Carbon dioxide: not settled', 'measured'));
  else if (c.seen) out.push(S(`Detected on ${c.seen} of ${c.n} visits`, 'measured'));
  else if (c.parent) out.push(S(`Light near its parent on ${c.parent} of ${c.n} visits`, 'measured'));
  else if (c.unseen) out.push(S('No detection in the pictures measured', 'measured'));
  else if (c.measured) out.push(S('Not detected in SPHEREx pictures', 'measured'));
  const { prev, next } = x.f?.peri ?? {}, t = x.today;   // the passage nearer today
  const p = [prev, next].filter(Boolean).sort((a, b2) => Math.abs(jdMs(a.jd) - t) - Math.abs(jdMs(b2.jd) - t))[0];
  if (p && jdMs(p.jd) > t) out.push(S(`Closest to the Sun ${day(jdMs(p.jd))}`, 'predicted'));
  else if (p) out.push(S(`Was closest to the Sun ${day(jdMs(p.jd))}`, 'predicted'));
  return out;
}
export function upcoming(x) {
  const { f, today } = x, out = [];
  if (!f) return out;
  const enc = f.enc;
  if (enc && Math.abs(today - jdMs(enc.jd)) <= 7 * DAY) out.push({ when: `This week`, what: 'Near its closest to Earth', now: true });
  const nx = f.peri.next;
  if (nx && jdMs(nx.jd) > today) out.push({ when: (jdMs(nx.jd) - today < 400 * DAY ? day : monthYear)(jdMs(nx.jd)), what: 'Closest to the Sun' });
  return out;
}

// ---------- sources shown under each card ----------
function srcOrb(x) { return x.orb ? `JPL orbit (${x.orb.soln}, ${day(dayMs(x.f.baked))})` : null; }
function srcNow(x) { return x.now ? `JPL prediction, as of ${day(dayMs(x.now.as_of))}` : null; }
function srcBoth(x) { return x.now ? srcNow(x) : srcOrb(x); }
function srcSx(x) {
  const ms = Object.keys(x.d.co2 ?? {});
  const my = k => `${mon(MON_SHORT(k).getTime())} ${k.slice(0, 4)}`;
  return ms.length ? `Measured by SPHEREx, ${ms.length > 1 ? `${my(ms[0])} to ${my(ms.at(-1))}` : my(ms[0])}` : 'Measured by SPHEREx';
}

// ---------- the list (L1-L5) ----------
export function group(c) {   // L4, from SPHEREx verdicts only
  const v = c.co2 ?? c.detail?.co2_verdict;
  if (v === 'detected') return 'co2';
  if (v === 'unclear') return 'unsettled';
  if (c.seen > 0 || v === 'quiet') return 'seen';
  if (c.parent > 0) return 'parent';
  if (c.unseen > 0) return 'partial';
  if (c.measured > 0) return 'faint';
  return 'unchecked';
}
export const GROUPS = [
  { key: 'co2', name: 'Carbon dioxide detected', say: 'SPHEREx measured the carbon dioxide glow around them.' },
  { key: 'unsettled', name: 'Measured, not settled', say: 'Their light was split by colour; the carbon dioxide answer is not clear.' },
  { key: 'seen', name: 'Detected in pictures', say: 'SPHEREx pictures show them. Their gases are not measured.' },
  { key: 'parent', name: 'Light near the parent comet', say: 'Pieces of comets that broke up: SPHEREx saw light where they should be, close enough to the parent comet to be its light.' },
  { key: 'faint', name: 'Not detected', say: 'SPHEREx photographed where they were, but they did not show.' },
  { key: 'partial', name: 'No detection so far', say: 'SPHEREx measured some of their pictures and found nothing; the rest are not checked yet.' },
  { key: 'unchecked', name: 'Not yet checked', say: 'No SPHEREx picture of them could be measured.' },
];

// every card at once, as the page shows them
export function page(c, now, today) {
  const x = inputs(c, now, today), g = going(x);
  return { x, decode: decode(c.id), lead: lead(x, g), chips: chips(x, g), cards: [danger(x), see(x), g, measures(x), orbit(x), made(x)],
    visits: visits(x), next: upcoming(x) };
}
