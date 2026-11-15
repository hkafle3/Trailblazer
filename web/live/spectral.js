// SPHEREx's 102 spectral channels, and the colour composite of several of them (timelapse.html, the Spectral card).
//
// Channels: 6 detectors (bands) of 17 channels each. The mission defines the channels geometrically, splitting each
// band's design range evenly in log wavelength: channel i (1..17) of a band runs from
//   lo * (hi / lo) ** ((i - 1) / 17)   to   lo * (hi / lo) ** (i / 17)
// with lo, hi the band's design range below (Hui et al. 2026, "Spectral response of SPHEREx", arXiv:2602.09139:
// Table 1 for the ranges, equations 1 and 2 for the channels, "defined geometrically ... to simplify survey planning"). The level-2 images are not binned into channels: each pixel has its own wavelength
// (the detector's linear-variable filter, web/data/wavemaps.json). So a channel's photo is made of the exposures whose
// wavelength at the spot falls inside that channel (live/pipeline.js). LVF curvature puts some pixels a little outside
// their band's nominal range (wavemaps.json D1 starts at 0.735 µm); those belong to no channel.
export const SP_BANDS = [[0.75, 1.11], [1.11, 1.64], [1.64, 2.42], [2.42, 3.82], [3.82, 4.42], [4.42, 5.00]];
export const CHANNELS = SP_BANDS.flatMap(([lo, hi], d) => Array.from({ length: 17 }, (_, k) => ({
  n: d * 17 + k, detector: `D${d + 1}`,
  lo: lo * (hi / lo) ** (k / 17), hi: lo * (hi / lo) ** ((k + 1) / 17), um: lo * (hi / lo) ** ((k + 0.5) / 17) })));

// The colour of a wavelength: the patch viewer's old Spectral tint, 0.75 µm blue to 5 µm red, linear in µm
const RAMP = [[0, [120, 170, 255]], [.2, [110, 225, 255]], [.4, [140, 255, 170]], [.6, [255, 235, 120]], [.8, [255, 160, 80]], [1, [255, 95, 95]]];
export function colourOf(um) {
  const t = Math.min(1, Math.max(0, (um - 0.75) / 4.25));
  for (let n = 1; n < RAMP.length; n++) if (t <= RAMP[n][0]) {
    const [t0, a] = RAMP[n - 1], [t1, b] = RAMP[n], f = (t - t0) / (t1 - t0);
    return a.map((v, k) => v + f * (b[k] - v));
  }
  return RAMP.at(-1)[1];
}

// For each frame of the main channel, the other channel's frame of the same visit (null when that channel has no
// exposure in it). All detectors are exposed at once, so the same visit has nearly the same mean time on every one;
// a visit spans at most 14 days (pipeline.js visits()).
export function align(main, other) {
  return main.map(f => {
    let best = null;
    for (const g of other) if (Math.abs(g.mjd - f.mjd) < 7 && (!best || Math.abs(g.mjd - f.mjd) < Math.abs(best.mjd - f.mjd))) best = g;
    return best;
  });
}

// The composite of one pixel: each layer's grey level (0..1, or null for no data) times its colour, added, then
// scaled so a pixel at full in every layer present has its strongest colour component at 255. A source seen in one
// channel only keeps that channel's colour at its share of the brightness.
export function mix(levels, colours) {
  const out = [0, 0, 0], sum = [0, 0, 0];
  levels.forEach((g, n) => {
    if (g == null) return;
    for (let k = 0; k < 3; k++) { out[k] += g * colours[n][k]; sum[k] += colours[n][k]; }
  });
  const top = Math.max(...sum);
  return top ? out.map(v => 255 * v / top) : null;
}
