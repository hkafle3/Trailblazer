// The all-sky map's maths, shared by Explore (explore.js) and the comet page's mini map (comet.js),
// so both pages put a comet in the same place for the same date.
export const R2 = Math.SQRT2, RAD = Math.PI / 180;
export const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;

// Mollweide: map longitude (degrees, -180..180, positive right) and Dec -> [u, v] in 0..1 across the map
export function fwdLon(lon, dec) {
  const lat = dec * RAD;
  let t = lat;
  for (let i = 0; i < 10 && Math.abs(dec) < 89.9; i++) t -= (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * t));
  const x = (2 * R2 / Math.PI) * lon * RAD * Math.cos(t), y = R2 * Math.sin(t);
  return [(x + 2 * R2) / (4 * R2), (R2 - y) / (2 * R2)];
}
export const fwd = (ra, dec) => fwdLon(wrap(-ra), dec);   // RA increases to the left, RA 0 in the middle

// Days count from the first SPHEREx photo (data/coverage.json: mjd0, days). LAST_DAY is where Explore's timeline starts.
export const MJD0 = 60789, LAST_DAY = 529;
export const dayDate = (day, opts) => new Date((MJD0 + day - 40587) * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
// ?day= in the address: a whole day on the timeline, or the timeline's default
export function dayParam() {
  const s = new URLSearchParams(location.search).get('day'), d = Math.round(+s);
  return s && d >= 0 && d <= LAST_DAY ? d : LAST_DAY;
}

// A known comet's place on a day: [ra, dec, magnitude] along its JPL path, `track` = [[day, ra, dec, magnitude], ...] every 10 days.
// No path (missing or empty) gives null: the caller keeps the comet's fixed place. A single point is that point on every day.
export function trackAt(track, day) {
  if (!track?.length) return null;
  if (track.length === 1) return track[0].slice(1);
  const i = Math.min(track.length - 2, Math.max(0, Math.floor(day / 10))), [d0, r0, c0, m0] = track[i], [d1, r1, c1, m1] = track[i + 1];
  const f = Math.min(1, Math.max(0, (day - d0) / (d1 - d0))), dr = ((r1 - r0 + 540) % 360) - 180;   // shortest way round in RA
  return [(r0 + f * dr + 360) % 360, c0 + f * (c1 - c0), m0 == null ? m1 : m1 == null ? m0 : m0 + f * (m1 - m0)];
}

// The whole path as an SVG path on a 2000 x 1000 map: one point per day from trackAt(), so the comet's dot is always on it.
// Where the comet leaves one side of the map and comes back on the other (longitude passes 180), the line runs to the
// edge, lifts, and starts again on the far edge. The crossing is found in longitude, before projecting: near the poles
// the two edges are close together on the map, so the size of the jump there says nothing.
export function trackPath(track) {
  if (!track?.length) return '';
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1); };
  let d = '', prev = null;
  for (let day = track[0][0], end = track[track.length - 1][0]; day <= end; day++) {
    const [ra, dec] = trackAt(track, day), lon = wrap(-ra);
    if (prev && Math.abs(lon - prev[0]) > 180) {
      const edge = prev[0] > 0 ? 180 : -180, f = (edge - prev[0]) / (lon + 2 * edge - prev[0]), at = prev[1] + f * (dec - prev[1]);
      d += 'L' + P(edge, at) + 'M' + P(-edge, at) + 'L' + P(lon, dec);
    } else d += (prev ? 'L' : 'M') + P(lon, dec);
    prev = [lon, dec];
  }
  return d;
}
