// E2 through the page's own fetcher: web/live/colorsworker.js builds a fixture star live (its exposure search, header reads,
// footprints and S3 range reads, then colors.js), with the fixture's frozen catalogues served as /api/cat and the reference
// fixture's field centre as the footprint centre, and the result must match bake/colors_ref.py's on the same star.
// Also reports what a live build costs (bytes read, seconds, peak memory): plan.md E10's numbers, in Node.
//   node web/tests/colors_live_parity.mjs <fixture_dir> <ref.json> <ra> <dec> <app base, for /api/images>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildLive } from '../live/colorsworker.js';

const [dir, refFile, ra, dec, app] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5], process.argv[6]];
const ref = JSON.parse(fs.readFileSync(refFile, 'utf8')), field = JSON.parse(fs.readFileSync(path.join(dir, 'field.json'), 'utf8'));
const FILE = { '2mass': 'twomass.csv', catwise: 'catwise.csv', allwise: 'allwise.csv', gaia: 'gaia.csv', simbad: 'simbad.csv', vsx: 'vsx.tsv' };
const server = http.createServer(async (q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/api/cat') { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end(fs.readFileSync(path.join(dir, FILE[u.searchParams.get('cat')]))); return; }
  const r = await fetch(app + q.url); s.writeHead(r.status, { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' }); s.end(Buffer.from(await r.arrayBuffer()));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
let bytes = 0, peak = 0; const t0 = Date.now(), mem = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 500);
const R = await buildLive({ base, ra, dec, field, progress: p => { if (p.bytes) bytes = p.bytes; } });
clearInterval(mem); server.close();
const secs = (Date.now() - t0) / 1000;
let fail = 0; const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); fail += !ok; };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
check(R.state === ref.state && R.reason === ref.reason, `state ${R.state} "${R.reason}"${R.detail ? ` (${R.detail})` : ''}`);
check(JSON.stringify(R.comparisons?.names) === JSON.stringify(ref.comparisons?.names), `comparisons identical (${R.comparisons?.n} of ${ref.comparisons?.n})`);
const v = x => JSON.stringify(Object.fromEntries(Object.entries(x.fingerprints ?? {}).map(([k, f]) => [k, [f.verdict, f.reason]])));
check(v(R) === v(ref), `verdicts and reasons identical ${v(R)}`);
check(R.data?.exposures_used === ref.data?.exposures_used, `exposures used ${R.data?.exposures_used} (reference ${ref.data?.exposures_used})`);
let worst = 0, same = true;
for (const p of ref.passes ?? []) {
  const q = (R.passes ?? []).find(x => x.key === p.key);
  if (!q || JSON.stringify(q.lam) !== JSON.stringify(p.lam)) { same = false; continue; }
  for (const k of ['mjy', 'err', 'sigma']) p[k]?.forEach((x, i) => { worst = Math.max(worst, rel(q[k][i], x)); });
}
check(same && worst <= 0.01, `every pass's bins identical, flux, error and sigma within 1% (worst ${(100 * worst).toFixed(4)}%)`);
for (const [k, f] of Object.entries(ref.fits ?? {})) {
  if (!f) continue; const g = R.fits?.[k];
  check(g && rel(g.a, f.a) <= 0.02 && (rel(g.b, f.b) <= 0.02 || Math.abs(g.b - f.b) <= 0.02) && (ref.fingerprints.rise.verdict !== 'seen' || Math.abs(g.T - f.T) <= 10), `fit ${k}: a ${g?.a.toFixed(4)} b ${g?.b.toFixed(3)} T ${g?.T} (reference ${f.a.toFixed(4)} ${f.b.toFixed(3)} ${f.T})`);
}
console.log(`live build: ${(bytes / 1e9).toFixed(2)} GB read, ${secs.toFixed(0)} s, peak memory ${(peak / 1e9).toFixed(2)} GB (Node, one thread)`);
console.log(fail ? `live parity: ${fail} failed` : 'live parity: PASS');
process.exit(fail ? 1 : 0);
