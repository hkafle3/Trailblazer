// The Brightness change card's numbers against the frozen detector pipeline. Runs the card's own build
// (live/colorsworker.js buildBright, what the page's Web Worker runs) on a test set and compares each SPHEREx pass:
// - changers: Delta W1 and W2 (SPHEREx minus CatWISE) within 0.15 mag of the pipeline's, pass by pass;
// - steady stars: |Delta| < 0.1 mag, or a too-bright or blended state; and the median |Delta / error| within a factor
//   of 2 of 0.67, its value for honest Gaussian errors;
// - every pass the pipeline measured is measured here too.
// The test set is a JSON file kept outside this public repo (it holds sealed AI-review truth):
//   { "stars": [{ "name", "kind": "changer" | "steady", "ra", "dec", "pipeline": { "W1": { "per_pass": [{ "year", "delta_mag" }] }, "W2": ... } }] }
// Run with the app up:  node web/tests/brightness_numbers.mjs <testset.json> [base url] [results dir]
// Network: the image search, NASA's S3 copy of SPHEREx, IRSA. About 30 s to a few minutes a star.
import fs from 'node:fs';
import path from 'node:path';
import { buildBright } from '../live/colorsworker.js';
import { change, yearOf } from '../live/brightness.js';

const [setFile, BASE = 'http://127.0.0.1:8787', OUT = null] = process.argv.slice(2);
if (!setFile) { console.error('usage: node web/tests/brightness_numbers.mjs <testset.json> [base url] [results dir]'); process.exit(2); }
const stars = JSON.parse(fs.readFileSync(setFile, 'utf8')).stars;
// BRIGHT_STRIP_H, BRIGHT_CAP: try other strip heights and picture caps than the card's (comparisons only)
const OPTS = Object.fromEntries([['stripH', process.env.BRIGHT_STRIP_H], ['cap', process.env.BRIGHT_CAP]].filter(([, v]) => v != null).map(([k, v]) => [k, +v]));
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const zs = [], rows = [];
for (const s of stars) {
  const file = OUT && path.join(OUT, `${s.name}${Object.entries(OPTS).map(([k, v]) => `_${k}${v}`).join('')}.json`);   // other options: other files
  let res = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!res || res.input_failure) {
    const t0 = Date.now();
    res = await buildBright({ base: BASE, ra: s.ra, dec: s.dec, at: 61100, ...OPTS }).catch(e => ({ state: 'error', reason: String(e.message || e) }));
    res.secs = (Date.now() - t0) / 1000;
    if (file) fs.writeFileSync(file, JSON.stringify(res));
  }
  const head = `${s.kind.padEnd(7)} ${s.name}  ${res.state}${res.reason ? ` (${res.reason})` : ''}${res.star?.blend > 1 ? ` blend ${res.star.blend}` : ''}${res.download ? `  ${res.download.exposures} pictures ${Math.round(res.download.bytes / 1e6)} MB ${Math.round(res.secs ?? 0)} s` : ''}`;
  console.log(head);
  const fine = s.kind === 'steady' && (res.state === 'too-bright' || res.star?.blend > 1);
  if (res.state !== 'ok' && !fine) { fails++; console.log('   FAIL no measurement'); continue; }
  for (const b of ['W1', 'W2']) {
    const [ref, refE] = res.star.ref_mag[b], pipe = s.pipeline[b].per_pass, out = [], mine = res.spherex?.[b] ?? [];
    // passes matched one to one, nearest first within 0.1 year; every pass the pipeline measured must be matched here
    const used = new Set(), match = mine.map(p => {
      const y = yearOf(p.mjd), q = pipe.filter(x => !used.has(x) && Math.abs(x.year - y) < 0.1).sort((a, c) => Math.abs(a.year - y) - Math.abs(c.year - y))[0];
      if (q) used.add(q);
      return q;
    });
    for (const q of pipe) if (!fine && !used.has(q)) { fails++; out.push(`${q.year} no pass here FAIL`); }
    for (const [i, p] of mine.entries()) {
      const y = yearOf(p.mjd), q = match[i];
      // not detected: right if the pipeline's value is fainter than the card's 3-sigma limit (within 0.15)
      if (p.limit != null) { const bad = !!q && !fine && ref + q.delta_mag < p.limit - 0.15; if (bad) fails++; out.push(`${y.toFixed(2)} not detected, fainter than ${p.limit.toFixed(2)}${q ? ` pipe ${(ref + q.delta_mag).toFixed(2)}` : ''}${bad ? ' FAIL' : ''}`); continue; }
      if (p.m == null) { const bad = !!q && !fine; if (bad) fails++; out.push(`${y.toFixed(2)} ${p.why}${bad ? ' FAIL' : ''}`); continue; }
      const c = change(p.m, p.e, ref, refE);
      let ok;
      if (s.kind === 'changer') ok = !q || Math.abs(c.d - q.delta_mag) <= 0.15;   // a pass the pipeline did not use: shown, not compared
      else { ok = fine || Math.abs(c.d) < 0.1; if (!fine) zs.push(c.d / c.e); }   // the error spread: measured steady stars only
      if (!ok) fails++;
      rows.push({ name: s.name, kind: s.kind, band: b, year: +y.toFixed(2), d: +c.d.toFixed(3), e: +c.e.toFixed(3), pipe: q?.delta_mag ?? null, ok });
      out.push(`${y.toFixed(2)} ${c.d >= 0 ? '+' : ''}${c.d.toFixed(3)}±${c.e.toFixed(3)}${q ? ` pipe ${q.delta_mag >= 0 ? '+' : ''}${q.delta_mag.toFixed(3)} diff ${(c.d - q.delta_mag).toFixed(3)}` : ''}${ok ? '' : ' FAIL'}`);
    }
    console.log(`   ${b} ${out.join(' | ')}`);
  }
}
// honest errors: on steady stars |Delta / error| has a median of 0.67 for Gaussian errors; within a factor of 2 passes
if (zs.length) {
  const a = zs.map(Math.abs).sort((x, y) => x - y), med = a[a.length >> 1], ok = med >= 0.33 && med <= 1.33;
  if (!ok) fails++;
  console.log(`steady stars: ${zs.length} pass-band values, median |Delta / error| ${med.toFixed(2)} (0.67 if the errors are honest; pass 0.33 to 1.33)${ok ? '' : ' FAIL'}, ${a.filter(v => v > 2).length} beyond 2 (about 5% expected)`);
}
if (OUT) fs.writeFileSync(path.join(OUT, 'table.json'), JSON.stringify(rows, null, 1));
console.log(fails ? `FAIL ${fails} pass-band values off` : 'PASS every changer within 0.15 mag of the pipeline and every steady star within 0.1 mag (or too bright / blended)');
process.exit(fails ? 1 : 0);
