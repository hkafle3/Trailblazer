// Example data for /api/comets and /api/explored, until labels and comments live in D1.
// Every response built from this file carries "example": true so the page can say so.
// Days count from the coverage map's start, MJD 60789 (2025-04-24); see web/data/coverage.json.

// tags: how many people tagged the comet's dots comet / asteroid / glitch / not sure
export const COMETS = [
  { id: 'C-0147', kind: 'comet', ra: 328, dec: 34, day: 127, tail: -150, tags: { comet: 12, asteroid: 1, glitch: 0, unsure: 1 } },
  { id: 'C-0152', kind: 'comet', ra: 18, dec: 22, day: 160, tail: -35, tags: { comet: 6, asteroid: 1, glitch: 0, unsure: 0 } },
  { id: 'C-0161', kind: 'comet', ra: 300, dec: -30, day: 210, tail: -120, tags: { comet: 2, asteroid: 1, glitch: 0, unsure: 1 } },
  { id: 'C-0170', kind: 'comet', ra: 95, dec: -12, day: 245, tail: -200, tags: { comet: 5, asteroid: 0, glitch: 0, unsure: 0 } },
  { id: 'C-0174', kind: 'comet', ra: 140, dec: 48, day: 330, tail: -60, tags: { comet: 1, asteroid: 0, glitch: 1, unsure: 1 } },
  // real: interstellar comet 3I/ATLAS, which SPHEREx observed in August 2025 (position from JPL Horizons, 2025-08-10)
  { id: '3I/ATLAS', kind: 'known', ra: 246.71, dec: -16.79, day: 108, real: true },
  { id: 'known-1', kind: 'known', ra: 60, dec: 21 }, { id: 'known-2', kind: 'known', ra: 122, dec: 17 },
  { id: 'known-3', kind: 'known', ra: 171, dec: 4 }, { id: 'known-4', kind: 'known', ra: 282, dec: -24 },
  { id: 'known-5', kind: 'known', ra: 346, dec: -7 }, { id: 'known-6', kind: 'known', ra: 35, dec: -38 }
];

// A spot nobody has checked yet: RW Aurigae's patch, which the time-lapse already has baked frames for.
export const SUGGEST = { ra: 77, dec: 30.4 };

const RAD = Math.PI / 180;
const sep = (ra1, d1, ra2, d2) =>
  Math.acos(Math.min(1, Math.sin(d1 * RAD) * Math.sin(d2 * RAD) + Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((ra1 - ra2) * RAD))) / RAD;
const rnd = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };   // same numbers every run

// The sky cut into patch-sized cells (51 bands of Dec, each split into about 3.5 degree steps of RA).
// n = times people checked the cell. Busy areas sit around the example comets and famous targets.
export function exploredCells() {
  const hot = [[328, 34, 9, 1], [18, 22, 8, .9], [300, -30, 6, .6], [95, -12, 8, .8], [140, 48, 5, .5], [246.7, -16.8, 10, 1],
    [84, -2, 11, 1], [56.8, 24.1, 7, 1], [266, -29, 10, .9], [80, -69, 7, .7], [10.7, 41.3, 7, .9], [270, 66.6, 6, .7], [201, -43, 6, .6]];
  const bands = 51, step = 180 / bands, cells = [];
  let total = 0;
  for (let i = 0; i < bands; i++) {
    const d0 = 90 - i * step, d1 = d0 - step, dm = (d0 + d1) / 2;
    const n = Math.max(1, Math.round(360 * Math.cos(dm * RAD) / 3.5));
    for (let j = 0; j < n; j++) {
      total++;
      const ra0 = 360 * j / n, ra1 = 360 * (j + 1) / n, ra = (ra0 + ra1) / 2;
      let p = 0;
      for (const [hr, hd, s, w] of hot) p += w * Math.exp(-((sep(ra, dm, hr, hd) / s) ** 2));
      const beta = Math.asin(Math.sin(dm * RAD) * Math.cos(23.44 * RAD) - Math.cos(dm * RAD) * Math.sin(23.44 * RAD) * Math.sin(ra * RAD)) / RAD;
      p += .2 * Math.exp(-((beta / 9) ** 2));   // people look along the ecliptic, where comets are
      p *= .35 + 1.1 * rnd(i, j);
      if (sep(ra, dm, SUGGEST.ra, SUGGEST.dec) < 7) p = 0;
      const checks = p > .62 ? 20 : p > .34 ? 6 : p > .15 ? 1 : 0;
      if (checks) cells.push({ ra_min: +ra0.toFixed(3), ra_max: +ra1.toFixed(3), dec_min: +d1.toFixed(3), dec_max: +d0.toFixed(3), checks });
    }
  }
  return { total, cells };
}
