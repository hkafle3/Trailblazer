// One rule for "what is the dot in the middle of the time-lapse". The verdict, Depth's target and the Discuss sheet's
// "It's X" offer all use it (timelapse.html identityAt), so they never disagree. Positions are arcsec east and north of
// the patch centre; a is SPHEREx's pixel in arcsec (web/tests/identity_check.mjs checks the rule case by case).
// - The dot: the patch centre, at the source measured there when it lies within two pixels of it (a better position);
//   a source measured farther off is something else.
// - A catalog object is the dot when one of its positions is within two pixels of it (about the PSF's width plus a
//   measured position's error). A star's position is its place at this visit, moved by its own proper motion. A comet's
//   or asteroid's positions are where SkyBoT puts it at each exposure's own time: never a time between exposures, so one
//   that crossed the middle between two exposures and was far off in both is not the dot. A baked visit has no
//   exposure times, only its middle: a place SkyBoT gives for that (a candidate's `near`) makes it nearby at most.
// - Closer than NEAR but not on the dot is "nearby", said as such; it does not make the dot known.
export const NEAR = 60;

export function middle(src, a) {
  return src && Math.hypot(src[0], src[1]) <= 2 * a ? src : [0, 0];
}

// cands: [{ ...anything, pos: [[east, north], ...], near?: [[east, north], ...] }] -> { match, nearby }, each the
// candidate with its distance d, or null. pos can make it the dot; near (a place not at an exposure's time) only nearby.
export function identify(mid, cands, a) {
  let match = null, nearby = null;
  const dist = ps => Math.min(...(ps ?? []).map(([e, n]) => Math.hypot(e - mid[0], n - mid[1])));
  for (const c of cands) {
    const d = dist(c.pos), dn = Math.min(d, dist(c.near));
    if (d <= 2 * a) { if (!match || d < match.d) match = { ...c, d }; }
    else if (dn <= NEAR && (!nearby || dn < nearby.d)) nearby = { ...c, d: dn };
  }
  return { match, nearby };
}
