// Bake one spot's Colors result (the showcase, C-0176) with the page's own code (web/live/colorsworker.js and colors.js, run
// here in Node), so the candidate page shows it at once instead of reading about 1 GB from S3. The catalogues come through
// the app's /api/cat (so they are stored in its R2 as well), SPHEREx from S3.
// Writes <out>/result.json and <out>/centre.json, then, with --put, stores them in R2 at colors/v1/<pos>/ (wrangler r2).
//   node bake/colors_bake.mjs --api http://127.0.0.1:8811 --ra 84.0181 --dec -6.577 --out <dir> [--put local|remote --bucket <b> --config <toml>]
// Production (Ed, once he has reported the showcase): --api https://comet-hunt.comet-hunt.workers.dev --put remote
//   --bucket comet-hunt-oldsky --config worker/wrangler.toml
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildLive } from '../web/live/colorsworker.js';
import { posKey } from '../worker/src/oldsky.js';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg('api') ?? 'http://127.0.0.1:8811', ra = Number(arg('ra') ?? 84.0181), dec = Number(arg('dec') ?? -6.577), out = arg('out');
const put = arg('put'), bucket = arg('bucket') ?? 'comet-hunt-oldsky', config = arg('config') ?? 'worker/wrangler.toml';
if (!out) throw new Error('--out <dir> (never /tmp for anything kept)');
let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(); } catch {}
const t0 = Date.now();
const result = await buildLive({ base, ra, dec, progress: p => process.stdout.write(`\r${p.text}${p.bytes ? ` (${(p.bytes / 1e9).toFixed(2)} GB)` : ''}`.padEnd(90)) });
Object.assign(result, { ra, dec, baked_at: new Date().toISOString(), code: `web/live/colors.js @ ${commit}` });
// an archive that did not answer is never baked: the page would show it for good
if (result.state === 'unavailable') { console.error(`\nnot baked: ${result.reason}`); process.exit(1); }
const prefix = `colors/v1/${posKey(ra, dec)}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/result.json`, JSON.stringify(result));
writeFileSync(`${out}/centre.json`, JSON.stringify({ ra, dec }));   // the Worker serves the bake only within 2 arcsec of this
const f = result.fits?.all, fp = result.fingerprints ?? {};
console.log(`\n${result.state}${result.reason ? ': ' + result.reason : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s; T ${f?.T} K ${JSON.stringify(f?.T_1sigma)}, b ${f?.b?.toFixed(3)} mJy, ${result.comparisons?.n} comparisons; ` +
  Object.entries(fp).map(([k, v]) => `${k} ${v.verdict}`).join(', '));
if (put) {
  if (!['local', 'remote'].includes(put)) throw new Error('--put local or remote');
  for (const [file, type] of [['result.json', 'application/json'], ['centre.json', 'application/json']])
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${prefix}/${file}`, '--file', `${out}/${file}`, '--content-type', type, `--${put}`, '--config', config], { stdio: 'inherit' });
  console.log(`stored at ${bucket}/${prefix}/ (${put})`);
}
