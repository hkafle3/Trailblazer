// Adaptive quality for the intro film (intro.js): which of its quality steps to draw at, from how far apart the frames
// come. Kept apart from the film so it can be checked on its own with made-up frame times (tests/intro_quality.mjs).
//
// adaptive(n) -> frame(ms): n steps, 0 the best. Call frame() with each frame's time; it returns the step to draw at, and
// changes it only at the end of a second of playing.
// - Down: a second whose frames came over SLOW ms apart on average steps down one. If that did not bring the frames at
//   least a tenth closer together, the picture was not what was slow (a display held to 30 frames a second, as a laptop
//   saving power does, or a busy machine): the step is taken back and quality is left alone from then on.
// - Up: only after GOOD seconds in a row under FAST ms, and the wait doubles each time that step up has failed (5, 10, 20 s).
//   A step up fails when the second after it is slow again; it is taken back at once. After a failure the better step is
//   tried again only when the frames are clearly faster than they were when it failed (measured headroom), for the whole
//   doubled wait: under a steady load nothing has changed, so it is not tried again and the quality does not flip back
//   and forth. (A display held to 60 frames a second cannot show headroom: after one failed step up it stays down.)
export const SLOW = 20, FAST = 17.5, GOOD = 5;

export function adaptive(n) {
  let q = 0, ms = 0, frames = 0, good = 0, was = 0, off = false, trial = 0;
  const fails = new Array(n).fill(0), base = new Array(n).fill(0);   // per step: its failed trials, and how fast the frames were (one step cheaper) when it last failed
  return function frame(dt) {
    if (off) return q;
    ms += dt; frames++; if (ms < 1000) return q;
    const mean = ms / frames; ms = frames = 0;
    if (was) { const helped = mean < .9 * was; was = 0; if (!helped) { off = true; return --q; } }   // the step down did not help: back, and stop
    if (trial) { const before = trial; trial = 0; if (mean > SLOW) { fails[q]++; base[q] = before; good = 0; return ++q; } }   // a failed step up: back at once
    if (mean > SLOW && q < n - 1) { good = 0; was = mean; return ++q; }
    const room = q > 0 && mean < FAST && (!fails[q - 1] || mean < .9 * base[q - 1]);   // a good second, with room for the better step
    if (!room) { good = 0; return q; }
    if (++good >= GOOD * 2 ** fails[q - 1]) { good = 0; trial = mean; return --q; }
    return q;
  };
}
