// E4, mutations must FAIL: each makes a copy of web/live/colors.js with one deliberate error and runs the E2 parity test
// (web/tests/colors_parity.mjs) on it against the reference; the test must fail every time. Copies live outside the repo.
//   node web/tests/colors_mutations.mjs <fixture_dir> <ref.json> <ra> <dec> <work_dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), src = fs.readFileSync(path.join(here, '../live/colors.js'), 'utf8');
const [fixture, ref, ra, dec, work] = process.argv.slice(2);
const swap = (s, a, b) => { if (!s.includes(a)) throw new Error(`mutation anchor not found: ${a.slice(0, 60)}`); return s.replace(a, b); };
const MUTANTS = {
  // a 15% jump above 4.42 um in the star's own measurements
  jump_442: s => swap(s, 'const raw = rr.filter((r) => Number.isFinite(r[2]) && Number.isFinite(r[3])).map((r) => r.slice(1))',
    'const raw = rr.filter((r) => Number.isFinite(r[2]) && Number.isFinite(r[3])).map((r) => { const q = r.slice(1); if (i === idx[0] && q[0] > 4.42) q[1] *= 1.15; return q; })'),
  // the template shifted by one bin
  template_shift: s => swap(s, '    const v = A.map((a) => a[i]).filter(Number.isFinite), m = median(v);', '    const v = A.map((a) => a[Math.max(0, i - 1)]).filter(Number.isFinite), m = median(v);'),
  // passes 1 and 3 swapped
  swap_passes: s => swap(s, 'passes = Array.from(new Set(g), (k) => mean(times.filter((_, i) => g[i] === k)))', 'passes = Array.from(new Set(g), (k) => mean(times.filter((_, i) => g[i] === k))).reverse()'),
  // the star as its own comparison
  self_comparison: s => swap(s, '    if(i===T||K.nmem[i]!==1)return false;', '    if(i===T)return true;if(K.nmem[i]!==1)return false;'),
  // W1 scaling in place of Ks
  w1_for_ks: s => swap(s, 'NORM = qual[T] === "AAA" ? "K" : "W1"', 'NORM = "W1"'),
  // cutout.js's mask (no ghost bits 22 to 24, no growth of OVERFLOW and BLOOM) in place of prep's
  cutout_mask: s => swap(swap(s, 'const BAD = [0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 27, 28, 29]', 'const BAD = [0, 1, 2, 6, 9, 10, 11, 15, 17, 25, 27, 28, 29]'),
    'const GROW = 1 << 1 | 1 << 26', 'const GROW = 0'),
};
const run = (name, mutate) => new Promise(done => {
  const dir = path.join(work, name), live = path.join(dir, 'web/live'), tests = path.join(dir, 'web/tests');
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(live, 'colors.js'), mutate(src));
  fs.copyFileSync(path.join(here, '../live/fits.js'), path.join(live, 'fits.js'));
  fs.copyFileSync(path.join(here, 'colors_parity.mjs'), path.join(tests, 'colors_parity.mjs'));
  execFile('node', [path.join(tests, 'colors_parity.mjs'), fixture, ref, ra, dec], { maxBuffer: 64 << 20 }, (err, out) => {
    // the run-time check does not count, nor does a crash: a mutant is caught only by a science check failing
    const failed = out.split('\n').filter(l => l.startsWith('FAIL') && !l.includes('build performance')).map(l => l.slice(5, 60)), ran = /^PASS 1\. |^FAIL 1\. /m.test(out);
    done({ name, caught: ran && failed.length > 0, ran, failed });
  });
});
// the unmutated copy first: it must run every check and fail none, or the mutants prove nothing
const base = await run('baseline', s => s);
if (!base.ran || base.failed.length) { console.log(`FAIL baseline: ${base.ran ? base.failed.join('; ') : 'the parity test did not run'}`); process.exit(1); }
console.log('PASS baseline: the unmutated copy passes every science check');
const res = await Promise.all(Object.entries(MUTANTS).map(([n, m]) => run(n, m)));
let bad = 0;
for (const r of res) { console.log(`${r.caught ? 'PASS' : 'FAIL'} ${r.name}: ${r.caught ? 'caught by ' + (r.failed.join('; ') || 'a crash') : (r.ran ? 'SURVIVED the parity test' : 'did not run')}`); bad += !r.caught; }
console.log(bad ? `E4: ${bad} mutation(s) survived` : 'E4: PASS, every mutation caught');
process.exit(bad ? 1 : 0);
