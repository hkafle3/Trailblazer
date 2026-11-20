// The Brightness change card's arithmetic (timelapse.html; the build runs in live/colorsworker.js, mode 'bright'). Pure
// functions, no fetching, so web/tests/brightness_unit.mjs checks them in Node.
// SPHEREx's light of a star in one survey pass, synthesized in a WISE band (colors.js wisePass, the decade detector's
// method), is put on CatWISE's scale by calibration stars measured in the same pictures (calibrators below): offset-only,
// per pass, the median of their SPHEREx / CatWISE flux ratios. They are bright (W1 9 to 14), so the median is precise
// for faint stars too (Colors' comparison stars match the star's brightness, so a faint star's were noisy: 0.1 mag).

export const ZP = { W1: 309540, W2: 171790 };   // mJy at magnitude 0, Vega (Jarrett et al. 2011), as colors.js
export const MIN_COMP = 5;
const D2R = Math.PI / 180;
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

// Calibration stars among the components K (colors.js components): single, clean CatWISE sources with W1 9 to 14 (bright,
// short of WISE's saturation), no other component within 15" brighter than their W1 + 2.5, no variable (vars: [[ra, dec]],
// Gaia, SIMBAD, VSX) within 5", and a W1 - W2 colour within tol of the star's (the synthesis's colour term), tol widening
// from 0.2 to 1.6 mag until there are 20; the `most` nearest the star. -> component indices.
export function calibrators(K, T, vars = [], most = 60) {
  // arcsec east and north of the star, RA wrapped (a field across RA 0)
  const n = K.ra.length, cd = Math.cos(K.dec[T] * D2R), xy = (a, d) => [((a - K.ra[T] + 540) % 360 - 180) * cd * 3600, (d - K.dec[T]) * 3600];
  const P = Array.from({ length: n }, (_, i) => xy(K.ra[i], K.dec[i])), V = vars.map(([a, d]) => xy(a, d));
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const base = [];
  for (let i = 0; i < n; i++) {
    const w1 = K.w1[i], w2 = K.w2[i];
    if (i === T || K.nmem[i] !== 1 || K.src[i] !== 'cw' || !(w1 >= 9 && w1 <= 14) || !Number.isFinite(w2) || K.ab[i] !== '00' || K.cc[i] !== '00' || K.nb[i] !== 1) continue;
    if (V.some(v => near(v, P[i]) < 5)) continue;
    let crowded = false;
    for (let j = 0; j < n && !crowded; j++) crowded = j !== i && Math.abs(P[j][1] - P[i][1]) <= 15 && near(P[j], P[i]) <= 15 && !(K.w1[j] > w1 + 2.5);
    if (!crowded) base.push(i);
  }
  const ct = K.w1[T] - K.w2[T], c0 = Number.isFinite(ct) ? ct : 0;
  let pick = [];
  for (const tol of [0.2, 0.4, 0.8, 1.6, Infinity]) { pick = base.filter(i => Math.abs(K.w1[i] - K.w2[i] - c0) <= tol); if (pick.length >= 20) break; }
  return pick.sort((a, b) => near(P[a], P[T]) - near(P[b], P[T])).slice(0, most);
}

// The scale (k: SPHEREx's synthesized flux over CatWISE's, for the same star) is nearly the same everywhere: with the
// file's own ePSF and a strip of 15 rows each side it was 0.929 (W1) and 0.969 (W2), 1.6% from field to field and pass to
// pass (measured on the calibration stars of the 12 Orion changer fields, 2026-11-20; the stars measured were not used).
// A strip that narrow holds few calibration stars, so their median and this prior are combined by their weights: with
// many stars the field's own scale leads, with few (under MIN_COMP) the prior alone sets it.
export const PRIOR = { W1: 0.929, W2: 0.969, rel: 0.016, floor: 0.04 };   // floor: a star's own scatter where too few calibrate
// t: the target's pass ({ f, err, sys, ok } in mJy, or null); comps: [{ p (their pass, same shape), m (CatWISE mag) }].
// -> { m, e, n, k, s } or { why } (with limit, the 3-sigma magnitude, when the star is not detected). The error, in
// relative flux, adds in quadrature: the floor s (the calibration stars' scatter about their median: PSF mismatch,
// catalogue errors, noise; PRIOR.floor when they are too few), the scale's error, and the star's own statistical and
// W2-tail errors.
export function calibrate(t, comps, band, prior = PRIOR) {
  if (!t) return { why: 'too few wavelengths measured' };
  if (!t.ok) return { why: 'not enough of the band measured' };
  const r = comps.filter(c => c.p?.ok && c.p.f > 0 && Number.isFinite(c.m)).map(c => c.p.f / (ZP[band] * 10 ** (-0.4 * c.m)));
  let k = prior[band], relK = prior.rel, s = prior.floor;
  if (r.length >= MIN_COMP) {
    const km = median(r), sm = 1.4826 * median(r.map(v => Math.abs(v / km - 1))), rm = Math.max(1.2533 * sm / Math.sqrt(r.length), 1e-4);
    const w0 = 1 / relK ** 2, w1 = 1 / rm ** 2;
    k = Math.exp((w0 * Math.log(k) + w1 * Math.log(km)) / (w0 + w1)); relK = 1 / Math.sqrt(w0 + w1); s = sm;
  }
  // under 3 sigma of its own noise it is not detected: a limit (3 sigma), not a magnitude
  if (!(t.f > 3 * t.err)) return { why: 'not detected', limit: -2.5 * Math.log10(3 * t.err / (k * ZP[band])) };
  const rel = Math.hypot(s, (t.err ?? 0) / t.f, (t.sys ?? 0) / t.f, relK);
  return { m: -2.5 * Math.log10(t.f / (k * ZP[band])), e: 2.5 / Math.LN10 * rel, n: r.length, k: +k.toFixed(4), s: +s.toFixed(4) };
}

// the change from the WISE value: d in magnitudes (negative: brighter), its error, and in words. A catalogue value
// without an error leaves the change's error unknown (NaN): no "about the same" then, and no +/- in magText
export function change(m, e, ref, refErr) {
  const d = m - ref, de = Math.hypot(e, refErr), x = 10 ** (0.4 * Math.abs(d));
  const f = x < 1.995 ? x.toFixed(2) : x < 99.5 ? x.toPrecision(2) : String(Math.round(x));   // 1.25x, 3.5x, 12x, 100x (never 1.0e+2)
  const words = Math.abs(d) < 2 * de ? 'about the same' : `${f}× ${d < 0 ? 'brighter' : 'dimmer'}`;
  return { d, e: de, words };
}
export const magText = (d, e) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}${Number.isFinite(e) ? ` ± ${e.toFixed(2)}` : ''} mag`;

// the pass nearest an MJD, if within 60 days (passes: [mjd, ...])
export function nearestPass(passes, mjd) {
  let k = -1;
  passes.forEach((p, i) => { if (Math.abs(p - mjd) <= 60 && (k < 0 || Math.abs(p - mjd) < Math.abs(passes[k] - mjd))) k = i; });
  return k;
}

// NEOWISE-R visits in a band (the frozen truth rule, decade_truth.visits): a good exposure has a detection with SNR >= 5,
// qual_frame > 0, qi_fact > 0, saa_sep > 5, the band's moon_masked and cc_flags characters 0, is fainter than WISE's
// saturation (W1 8.0, W2 7.0) and lies within 2.5" of the star where it was then (at(mjd) -> [ra, dec]). Visits split at
// 30-day gaps; one counts with 5 good exposures or more: the median, error 1.253 std / sqrt(n), at least 0.02 mag.
const SATURATES = { W1: 8.0, W2: 7.0 };
export function neowiseVisits(rows, band, at) {
  const b = band === 'W1' ? 1 : 2, k = b - 1, num = v => (v === '' || v == null ? NaN : Number(v));
  const good = rows.filter(r => {
    const m = num(r[`w${b}mpro`]), [ra, dec] = at(num(r.mjd));
    const sep = Math.hypot(((num(r.ra) - ra + 540) % 360 - 180) * Math.cos(dec * D2R), num(r.dec) - dec) * 3600;
    return Number.isFinite(num(r[`w${b}sigmpro`])) && num(r[`w${b}snr`]) >= 5 && num(r.qual_frame) > 0 && num(r.qi_fact) > 0 && num(r.saa_sep) > 5
      && (r.moon_masked || '00')[k] === '0' && (r.cc_flags || '0000')[k] === '0' && m > SATURATES[band] && sep <= 2.5;
  }).map(r => [num(r.mjd), num(r[`w${b}mpro`])]).sort((x, y) => x[0] - y[0]);
  const visits = [];
  good.forEach((g, i) => { if (!i || g[0] - good[i - 1][0] > 30) visits.push([]); visits.at(-1).push(g); });
  return visits.filter(v => v.length >= 5).map(v => {
    const m = v.map(g => g[1]), mean = m.reduce((s, x) => s + x, 0) / m.length;
    const sd = Math.sqrt(m.reduce((s, x) => s + (x - mean) ** 2, 0) / (m.length - 1));   // ddof 1, as the rule
    return { mjd: v.reduce((s, g) => s + g[0], 0) / v.length, m: median(m), e: Math.max(0.02, 1.253 * sd / Math.sqrt(m.length)), n: m.length };
  });
}

// the NEOWISE request for a place: RA and Dec rounded once to the route's 0.0001 degree, RA then wrapped into [0, 360),
// so the caller asks for exactly the cone the route stores (worker/src/cat.js readCat), never 360.0000
export function neoQuery(ra, dec, r) {
  const q = v => Math.round(v * 1e4) / 1e4, a = (q(ra) % 360 + 360) % 360;
  return `cat=neowise&ra=${(a >= 360 ? 0 : a).toFixed(4)}&dec=${q(dec).toFixed(4)}&r=${r}`;
}

export const yearOf = mjd => 2000 + (mjd - 51544.5) / 365.25;
