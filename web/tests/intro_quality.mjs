// Checks the intro film's adaptive quality (web/intro-quality.js) with made-up frame times: each case is a frame time
// for each quality step (and, for some, a change partway), played for two minutes. Run: node web/tests/intro_quality.mjs
import assert from 'node:assert/strict';
import { adaptive } from '../intro-quality.js';

function play(n, msAt, seconds = 120) {   // msAt(step, t): the frame time at that step, t seconds in. Returns the steps taken: [t, step]
  const frame = adaptive(n), steps = []; let q = 0, t = 0;
  while (t < seconds * 1000) { const dt = msAt(q, t / 1000); t += dt; const s = frame(dt); if (s !== q) { steps.push([+(t / 1000).toFixed(2), s]); q = s; } }
  return { steps, q };
}
const ups = steps => steps.filter(([, s], i) => s < (i ? steps[i - 1][1] : 0)).length;

// Codex's case: the best step holds 30 frames a second, the next 60. It steps down, tries the best step once more after
// five good seconds, finds it slow, and stays down: no flipping back and forth.
{ const { steps, q } = play(3, s => (s === 0 ? 1000 / 30 : 1000 / 60));
  assert.equal(q, 1, `steady load: ends on step ${q}, ${JSON.stringify(steps)}`);
  assert.ok(ups(steps) <= 1 && steps.length <= 3, `steady load flips: ${JSON.stringify(steps)}`);
  console.log('steady load (30 fps at the best step, 60 at the next):', JSON.stringify(steps)); }

// The same on a phone's four steps, where the second step helps but not enough (26 ms) and the third is enough.
{ const { steps, q } = play(4, s => [1000 / 30, 26, 1000 / 60, 1000 / 60][s]);
  assert.equal(q, 2, `phone steady load: ends on step ${q}, ${JSON.stringify(steps)}`);
  assert.ok(ups(steps) <= 1 && steps.length <= 4, `phone steady load flips: ${JSON.stringify(steps)}`);
  console.log('phone steady load:', JSON.stringify(steps)); }

// A display held to 30 frames a second (Low Power Mode): no step helps, so the one step down is taken back and that is all.
{ const { steps, q } = play(3, () => 1000 / 30);
  assert.deepEqual(steps.map(s => s[1]), [1, 0], `30 Hz display: ${JSON.stringify(steps)}`); assert.equal(q, 0);
  console.log('display held to 30 fps:', JSON.stringify(steps)); }

// A steady 60 at the best step: nothing changes.
{ const { steps } = play(3, () => 1000 / 60); assert.deepEqual(steps, [], `steady 60 fps changed steps: ${JSON.stringify(steps)}`); }

// A short spike (3 s of slow frames at every step), then a steady 60: down once, then back to the best step to stay.
{ const { steps, q } = play(3, (s, t) => (t > 2 && t < 5 ? 26 : 1000 / 60));
  assert.equal(q, 0, `after a spike: ends on step ${q}, ${JSON.stringify(steps)}`);
  assert.ok(steps.length <= 4 && steps.at(-1)[0] < 20, `after a spike it does not settle back soon: ${JSON.stringify(steps)}`);
  console.log('a 3 s spike:', JSON.stringify(steps)); }

// A fast display (120 Hz) under a load that lifts: the best step costs 24 ms, the next 14. The best step fails its trial
// and is not tried again while nothing changes; when the load lifts at 50 s (12 ms and 7 ms) the measured headroom lets
// it try once more, after the doubled wait, and it holds.
{ const { steps, q } = play(3, (s, t) => (t < 50 ? [24, 14, 9][s] : [12, 7, 5][s]));
  assert.equal(q, 0, `load lifts: ends on step ${q}, ${JSON.stringify(steps)}`);
  const before = steps.filter(([t]) => t < 50);
  assert.ok(ups(before) <= 1, `under the load it flips: ${JSON.stringify(steps)}`);
  const back = steps.at(-1)[0]; assert.ok(back > 59 && back < 66, `the retry should wait 10 good seconds after the load lifts: ${JSON.stringify(steps)}`);
  console.log('120 Hz, load lifts at 50 s:', JSON.stringify(steps)); }

// Every trace: never more than one step at a time, and the step stays in range.
for (const n of [3, 4]) for (let seed = 1; seed <= 40; seed++) {
  let x = seed; const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const frame = adaptive(n); let q = 0;
  for (let i = 0; i < 20000; i++) { const s = frame(8 + rnd() * 30 * (1 - q / n)); assert.ok(Math.abs(s - q) <= 1 && s >= 0 && s < n, `jumped from ${q} to ${s}`); q = s; }
}
console.log('intro_quality: all checks passed');
