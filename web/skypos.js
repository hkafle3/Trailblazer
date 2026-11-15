// Ecliptic poles and the deep-field test, shared by the map and the time-lapse.
// The obliquity matches worker/src/index.js, which searches the deep-survey
// collections only when |ecliptic latitude| is above DEEP_LAT.
export const OBLIQUITY = 23.4393;
export const DEEP_LAT = 75;

export const POLES = [
  { id: 'nep', name: 'North ecliptic pole', short: 'NEP', ra: 270, dec: 90 - OBLIQUITY },
  { id: 'sep', name: 'South ecliptic pole', short: 'SEP', ra: 90, dec: OBLIQUITY - 90 },
];

export function eclipticLat(ra, dec) {
  const e = OBLIQUITY * Math.PI / 180, a = ra * Math.PI / 180, d = dec * Math.PI / 180;
  return Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a)) * 180 / Math.PI;
}

export const deepField = (ra, dec) => Math.abs(eclipticLat(ra, dec)) > DEEP_LAT;

export function cadenceText(ra, dec) {
  return deepField(ra, dec)
    ? 'High-cadence deep field. SPHEREx revisits the ecliptic poles often.'
    : 'Outside the high-cadence deep field: fewer frames available.';
}

export function timelapseHref(ra, dec, { det = 'D1', diff = false } = {}) {
  const q = new URLSearchParams({ ra: ra.toFixed(4), dec: dec.toFixed(4), det });
  if (diff) q.set('diff', '1');
  return `patch.html?${q}`;
}
