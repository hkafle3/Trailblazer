// Bake one spot's "Then and now" blink (the showcase, J053604.34-063439.0) with the page's own code (web/live/blinkworker.js
// and blink.js, run here in Node), so the candidate page shows it at once instead of reading about 200 MB from S3.
// The old-survey tiles come through the app's /api/oldsky (so they are stored in its R2 as well), SPHEREx from S3.
// Writes <out>/result.json and <out>/frames.bin, then, with --put, stores them in R2 at blink/v1/<pos>/ (wrangler r2).
//   node bake/blink_bake.mjs --api http://127.0.0.1:8811 --ra 84.01808 --dec -6.5775 --out /tmp/blink [--put local|remote --bucket comet-hunt-oldsky]
// The result carries every band's report and checks (the evaluator's numbers), and the code's commit.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as B from '../web/live/blink.js';
import { buildBand, bandMessage, Unavailable } from '../web/live/blinkworker.js';
import { posKey } from '../worker/src/oldsky.js';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg('api') ?? 'http://127.0.0.1:8811', ra = Number(arg('ra') ?? 84.01808), dec = Number(arg('dec') ?? -6.5775), out = arg('out') ?? '/tmp/blink-bake';
const put = arg('put'), bucket = arg('bucket') ?? 'comet-hunt-oldsky', config = arg('config') ?? 'worker/wrangler.toml';
const here = new URL('../web/data/', import.meta.url);
const curves = JSON.parse(readFileSync(new URL('bands.json', here))), waves = JSON.parse(readFileSync(new URL('wavemaps.json', here)));
const grid = B.makeGrid(ra, dec), pos = posKey(ra, dec);
let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(); } catch {}

const bands = {}, parts = []; let off = 0;
for (const band of ['W2', 'W1', 'Ks']) {
  const t0 = Date.now();
  try {
    const rep = await buildBand(band, { base, ra, dec, grid, curves, waves, progress: t => process.stdout.write(`\r${band}: ${t}`.padEnd(70)) });
    const m = bandMessage(band, rep);
    if (m.frames) {
      m.frames = Object.fromEntries(Object.entries(m.frames).map(([k, a]) => { parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); const r = [off, a.length]; off += a.byteLength; return [k, r]; }));
    }
    bands[band] = m;
    console.log(`\n${band}: ${m.state} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ratio ${rep.lead_ratio}, z ${rep.lead_z_vs_field}, ${rep.qualified_stars} stars, scatter ${rep.field_scatter_robust_sigma}, `
      + `${rep.spherex.exposures_used} exposures (${rep.spherex.exposures_at_lead} at the star), evaluator ${rep.passed ? 'PASS' : 'FAIL'}${rep.passed ? '' : ': ' + Object.entries(rep.checks).filter(([, v]) => !v).map(([k]) => k).concat(rep.expectation === false ? ['lead_expectation'] : []).join(', ')}`);
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    bands[band] = { type: 'band', band, state: e.state, reason: e.message };
    console.log(`\n${band}: ${e.state}: ${e.message}`);
  }
}
const prefix = `blink/v1/${pos}`;
const result = { v: 1, ra, dec, designation: B.designation(ra, dec), baked_at: new Date().toISOString(), code: `web/live/blink.js @ ${commit}`, frames_path: `api/${prefix}/frames.bin`, bands };
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/result.json`, JSON.stringify(result));
writeFileSync(`${out}/frames.bin`, Buffer.concat(parts));
console.log(`wrote ${out}/result.json and frames.bin (${(off / 1e6).toFixed(1)} MB)`);
if (put) {
  if (!['local', 'remote'].includes(put)) throw new Error('--put local or remote');
  for (const [f, type] of [['frames.bin', 'application/octet-stream'], ['result.json', 'application/json']])
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${prefix}/${f}`, '--file', `${out}/${f}`, '--content-type', type, `--${put}`, '--config', config], { stdio: 'inherit' });
  console.log(`stored at ${bucket}/${prefix}/ (${put})`);
}
