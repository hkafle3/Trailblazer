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
// from 0.2 to 1.6 mag until there are 20; the 60 nearest the star. -> component indices.
export function calibrators(K, T, vars = []) {
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
  for (const tol of [0.2, 0.4, 0.8, 1.6]) { pick = base.filter(i => Math.abs(K.w1[i] - K.w2[i] - c0) <= tol); if (pick.length >= 20) break; }
  return pick.sort((a, b) => near(P[a], P[T]) - near(P[b], P[T])).slice(0, 60);
}

// t: the target's pass ({ f, err, sys, ok } in mJy, or null); comps: [{ p (their pass, same shape), m (CatWISE mag) }].
// -> { m, e, n } or { why }. The error, in relative flux, adds in quadrature: s, the calibration stars' scatter about the
// median (each star's measuring floor: PSF mismatch, catalogue errors, noise; s / sqrt(n) x 1.2533 is the median's
// error), and the star's own statistical and W2-tail errors.
export function calibrate(t, comps, band) {
  if (!t) return { why: 'too few wavelengths measured' };
  if (!t.ok) return { why: 'not enough of the band measured' };
  const r = comps.filter(c => c.p?.ok && c.p.f > 0 && Number.isFinite(c.m)).map(c => c.p.f / (ZP[band] * 10 ** (-0.4 * c.m)));
  if (r.length < MIN_COMP) return { why: `${r.length} calibration stars measured, ${MIN_COMP} needed` };
  if (!(t.f > 0)) return { why: 'not detected' };
  const k = median(r), s = 1.4826 * median(r.map(v => Math.abs(v / k - 1)));
  const rel = Math.hypot(s, (t.err ?? 0) / t.f, (t.sys ?? 0) / t.f, 1.2533 * s / Math.sqrt(r.length));
  return { m: -2.5 * Math.log10(t.f / (k * ZP[band])), e: 2.5 / Math.LN10 * rel, n: r.length };
}

// the change from the WISE value: d in magnitudes (negative: brighter), its error, and in words. A catalogue value
// without an error leaves the change's error unknown (NaN): no "about the same" then, and no +/- in magText
export function change(m, e, ref, refErr) {
  const d = m - ref, de = Math.hypot(e, refErr), x = 10 ** (0.4 * Math.abs(d));
  const f = x < 1.995 ? x.toFixed(2) : x.toPrecision(2);   // 1.25x, 3.5x, 12x
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

export const yearOf = mjd => 2000 + (mjd - 51544.5) / 365.25;
