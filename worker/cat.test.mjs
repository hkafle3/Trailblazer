// E9 of the Colors plan, offline: GET /api/cat and GET /api/colors (worker/src/cat.js) with a fake archive, a fake R2 and
// a fake rate limiter. Unlisted catalogue or bad position 400; upstream 5xx, HTML, a short or wrong table never stored;
// redirects refused; the CDS-down fallback to CfA; 429 past the limit; a warm hit served with the archives unreachable;
// a bake more than 2 arcsec away is 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, colorsBaked, readCat } from './src/cat.js';

function fakeEnv(limit = Infinity) {
  const store = new Map(); let n = 0;
  return { store, OLDSKY: {
    get: async k => (store.has(k) ? { body: store.get(k), httpMetadata: {} } : null),
    put: async (k, v) => { store.set(k, typeof v === 'string' ? v : new Uint8Array(v)); return { size: v.length }; } },
    CAT_LIMIT: { limit: async () => ({ success: ++n <= limit }) } };
}
const req = (q, ip = '1.2.3.4') => [new Request(`https://x/api/cat?${q}`, { headers: { 'CF-Connecting-IP': ip } }), new URL(`https://x/api/cat?${q}`)];
import { CATS } from './src/cat.js';
const csv = (head, rows = 2) => head + '\n' + Array.from({ length: rows }, (_, i) => `${i},84.0,-6.5`).join('\n') + '\n';
const full = first => Object.values(CATS).find(c => c.first === first).need.join(',');
const VSX = '#\n#   VizieR Astronomical Server\n#Column\tOID\nOID\tName\tType\tRAJ2000\tDEJ2000\n \t \t \tdeg\tdeg\n----\t----\t----\t----\t----\n1\tOY Ori\tINS\t83.99\t-6.61\n\n';
function archive(override = () => null) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init }); const o = override(url); if (o) return o;
    const u = new URL(url);
    if (u.host === 'irsa.ipac.caltech.edu') { const q = u.searchParams.get('QUERY'); return new Response(csv(q.split(' ')[1].split(',').join(',')), { headers: { 'Content-Type': 'text/csv' } }); }
    if (u.host.startsWith('simbad')) return new Response(csv('main_id,otype,ra,dec'), { headers: { 'Content-Type': 'text/csv' } });
    if (u.host.startsWith('vizier')) return new Response(VSX, { headers: { 'Content-Type': 'text/tab-separated-values' } });
    return new Response('no', { status: 404 });
  };
  return { f, calls };
}
const text = async r => new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));

test('refusals: unlisted catalogue and bad positions are 400, before any archive call', async () => {
  const { f, calls } = archive(), env = fakeEnv();
  for (const q of ['cat=sdss&ra=1&dec=1', 'cat=2mass&ra=360&dec=1', 'cat=2mass&ra=1&dec=91', 'cat=2mass&ra=&dec=1', 'cat=2mass&ra=x&dec=1', 'ra=1&dec=1'])
    assert.equal((await cat(...req(q), env, { fetch: f })).status, 400, q);
  assert.equal(calls.length, 0);
});
test('a miss stores what the archive sent, keyed by the rounded spot; a hit is served with the archives down', async () => {
  const { f } = archive(), env = fakeEnv();
  for (const c of ['2mass', 'catwise', 'allwise', 'gaia', 'simbad', 'vsx']) {
    const r = await cat(...req(`cat=${c}&ra=84.01812&dec=-6.57701`), env, { fetch: f });
    assert.equal(r.status, 200, c); assert.equal(r.headers.get('X-Cat'), 'miss');
  }
  assert.deepEqual([...env.store.keys()].sort(), ['allwise', 'catwise', 'gaia', '2mass', 'simbad'].map(c => `cat/v1/${c}/84.018-6.577.csv`).concat('cat/v1/vsx/84.018-6.577.tsv').sort());
  const down = async () => { throw new TypeError('network down'); };
  const r = await cat(...req('cat=gaia&ra=84.0181&dec=-6.5770'), env, { fetch: down });
  assert.equal(r.status, 200); assert.equal(r.headers.get('X-Cat'), 'hit'); assert.match(await text(r), /^source_id,ra,dec,pmra/);
});
test('the archive queries: IRSA TAP with the reference columns in a 0.275 degree cone', async () => {
  const { f, calls } = archive(), env = fakeEnv();
  await cat(...req('cat=gaia&ra=84.0181&dec=-6.577'), env, { fetch: f });
  const q = new URL(calls[0].url).searchParams.get('QUERY');
  assert.match(q, /phot_variable_flag FROM gaia_dr3_source WHERE phot_g_mean_mag < 20 AND pmra IS NOT NULL AND CONTAINS\(POINT\('ICRS',ra,dec\),CIRCLE\('ICRS',84.018,-6.577,0.275\)\)=1/);
  assert.equal(calls[0].init.redirect, 'manual');
});
test('upstream 5xx, HTML, a wrong table, a short table, a missing column and a redirect are never stored', async () => {
  const bad = [new Response('source_id,ra,dec,pmra,pmdec,phot_g_mean_mag\n1,2,3,4,5,6\n', { headers: { 'Content-Type': 'text/csv' } }), new Response('err', { status: 502 }), new Response('<html>maintenance</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('<?xml version="1.0"?><VOTABLE>ERROR</VOTABLE>\n', { headers: { 'Content-Type': 'text/plain' } }), new Response('designation,ra\n1,2', { headers: { 'Content-Type': 'text/csv' } }),
    new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })];
  for (const b of bad) {
    const { f } = archive(() => b.clone()), env = fakeEnv();
    const r = await cat(...req(b.headers.get('Content-Type') === 'text/csv' && b.status === 200 ? 'cat=gaia&ra=84&dec=-6' : 'cat=2mass&ra=84&dec=-6'), env, { fetch: f });
    assert.equal(r.status, 503); assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(env.store.size, 0);
  }
});
test('SIMBAD and VizieR fall back to the CfA mirrors when Strasbourg is down', async () => {
  for (const [c, cds] of [['simbad', 'simbad.cds.unistra.fr'], ['vsx', 'vizier.cds.unistra.fr']]) {
    const { f, calls } = archive(u => (new URL(u).host === cds ? new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) : null)), env = fakeEnv();
    const r = await cat(...req(`cat=${c}&ra=84&dec=-6`), env, { fetch: f });
    assert.equal(r.status, 200); assert.deepEqual(calls.map(x => new URL(x.url).host), [cds, cds.replace(/^(simbad|vizier)\.cds\.unistra\.fr$/, (_, h) => `${h}.${h === 'simbad' ? 'harvard.edu' : 'cfa.harvard.edu'}`)]);
  }
});
test('429 past the miss limit; hits are never limited', async () => {
  const { f } = archive(), env = fakeEnv(1);
  assert.equal((await cat(...req('cat=2mass&ra=10&dec=10'), env, { fetch: f })).status, 200);
  assert.equal((await cat(...req('cat=2mass&ra=11&dec=10'), env, { fetch: f })).status, 429);
  assert.equal((await cat(...req('cat=2mass&ra=10&dec=10'), env, { fetch: f })).status, 200);
});
test('the size cap holds even without a Content-Length', async () => {
  const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('designation,ra\n')); for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1 << 20).fill(49)); c.close(); } });
  const { f } = archive(() => new Response(big, { headers: { 'Content-Type': 'text/csv' } })), env = fakeEnv();
  assert.equal((await cat(...req('cat=2mass&ra=1&dec=1'), env, { fetch: f })).status, 503); assert.equal(env.store.size, 0);
});
test('GET /api/colors: the bake within 2 arcsec, else 404; bad position 400', async () => {
  const env = fakeEnv(); env.store.set('colors/v1/84.018-6.577/centre.json', JSON.stringify({ ra: 84.0181, dec: -6.577 })); env.store.set('colors/v1/84.018-6.577/result.json', '{"v":1}');
  const at = q => colorsBaked(new URL(`https://x/api/colors?${q}`), env);
  assert.equal((await at('ra=84.0181&dec=-6.577')).status, 200);
  assert.equal((await at('ra=84.0181&dec=-6.5765')).status, 200);    // 1.8 arcsec
  assert.equal((await at('ra=84.0181&dec=-6.5764')).status, 404);    // 2.2 arcsec, same key
  assert.equal((await at('ra=84.5&dec=-6.577')).status, 404);
  assert.equal((await at('ra=400&dec=0')).status, 400);
});
test('readCat rounds to 0.001 degree as the other stores do', () => {
  assert.deepEqual(readCat(new URL('https://x/api/cat?cat=vsx&ra=10.0004&dec=-4.5005')), { cat: 'vsx', ra: 10, dec: -4.501, key: 'cat/v1/vsx/10.000-4.501.tsv' });
});
test('a partial (206) answer with a whole header and whole rows is never stored', async () => {
  const head = CATS['2mass'].need.join(','), body = `${head}\n${CATS['2mass'].need.map(() => '1').join(',')}\n`;
  const { f } = archive(() => new Response(body, { status: 206, headers: { 'Content-Type': 'text/csv' } })), env = fakeEnv();
  const r = await cat(...req('cat=2mass&ra=84&dec=-6'), env, { fetch: f });
  assert.equal(r.status, 503); assert.equal(env.store.size, 0);
});
// The Brightness change card's NEOWISE single exposures: a cone of r arcsec about a spot rounded to 0.0001 degree, TAP
// first, Gator when TAP fails (its IPAC table stored as TAP's CSV), refusals before any archive call.
const NEO = CATS.neowise.need.join(',');
const GATOR = `\\fixlen = T\n\\RowsRetrieved = 2\n|          ra|         dec|          clon|            mjd|  w1mpro| w1sigmpro|   w1snr|  w2mpro| w2sigmpro|   w2snr| qual_frame| qi_fact| saa_sep| moon_masked| cc_flags|  dist|\n|      double|      double|          char|         double|  double|    double|  double|  double|    double|  double|        int|  double|  double|        char|     char|double|\n`
  + '   85.6275860   -8.5486080   05h42m30.62s  57089.39936119   10.150      0.021     52.1    9.968      0.021     51.7          10      1.0   99.878           00      0000   0.4\n'
  + '   85.6275650   -8.5486637   05h42m30.62s  57089.20236935   10.124       null     67.3   10.082      0.017     64.1          10      1.0   73.957           01      0000   0.5\n';
test('neowise: a 0.0001 degree key with the radius; refusals before any archive call', async () => {
  assert.deepEqual(readCat(new URL('https://x/api/cat?cat=neowise&ra=85.627573&dec=-8.548694')), { cat: 'neowise', ra: 85.6276, dec: -8.5487, r: 5, key: 'cat/v1/neowise/85.6276-8.5487_5.csv' });
  assert.equal(readCat(new URL('https://x/api/cat?cat=neowise&ra=10&dec=4&r=12')).key, 'cat/v1/neowise/10.0000+4.0000_12.csv');
  assert.notEqual(readCat(new URL('https://x/api/cat?cat=neowise&ra=10.0001&dec=4')).key, readCat(new URL('https://x/api/cat?cat=neowise&ra=10.0004&dec=4')).key);
  assert.equal(readCat(new URL('https://x/api/cat?cat=catwise&ra=10.0001&dec=4')).key, readCat(new URL('https://x/api/cat?cat=catwise&ra=10.0004&dec=4')).key);   // the others keep 0.001
  const { f, calls } = archive(), env = fakeEnv();
  for (const q of ['cat=neowise&ra=10&dec=4&r=2', 'cat=neowise&ra=10&dec=4&r=31', 'cat=neowise&ra=10&dec=4&r=4.5', 'cat=neowise&ra=361&dec=4'])
    assert.equal((await cat(...req(q), env, { fetch: f })).status, 400, q);
  assert.equal(calls.length, 0);
});
test('neowise: TAP answers; when it fails, Gator\'s table is stored as the same CSV (null as empty)', async () => {
  const { f, calls } = archive(), env = fakeEnv();
  let r = await cat(...req('cat=neowise&ra=85.62757&dec=-8.54869&r=6'), env, { fetch: f });
  assert.equal(r.status, 200); assert.match(new URL(calls[0].url).searchParams.get('QUERY'), /FROM neowiser_p1bs_psd WHERE CONTAINS\(POINT\('ICRS',ra,dec\),CIRCLE\('ICRS',85.6276,-8.5487,0.001667\)\)=1/);
  const g = archive(u => (u.includes('/TAP/') ? new Response('err', { status: 502 }) : new Response(GATOR, { headers: { 'Content-Type': 'text/plain' } }))), env2 = fakeEnv();
  r = await cat(...req('cat=neowise&ra=85.62757&dec=-8.54869'), env2, { fetch: g.f });
  assert.equal(r.status, 200); assert.equal(g.calls.length, 2); assert.match(g.calls[1].url, /Gator\/nph-query\?catalog=neowiser_p1bs_psd&spatial=cone&objstr=85.6276\+-8.5487&radius=5/);
  const body = await text(r);
  assert.equal(body, `${NEO}\n85.6275860,-8.5486080,57089.39936119,10.150,0.021,52.1,9.968,0.021,51.7,10,1.0,99.878,00,0000\n85.6275650,-8.5486637,57089.20236935,10.124,,67.3,10.082,0.017,64.1,10,1.0,73.957,01,0000\n`);
  assert.equal(new TextDecoder().decode(env2.store.get('cat/v1/neowise/85.6276-8.5487_5.csv')), body);
  const none = archive(u => (u.includes('/TAP/') ? new Response('err', { status: 502 }) : new Response('[struct stat="ERROR", msg="busy"]\n', { headers: { 'Content-Type': 'text/plain' } }))), env3 = fakeEnv();
  assert.equal((await cat(...req('cat=neowise&ra=85.62757&dec=-8.54869'), env3, { fetch: none.f })).status, 503); assert.equal(env3.store.size, 0);
});
test('neowise: a spot NEOWISE never detected is a header-only table, stored', async () => {
  const empty = `\\fixlen = T\n\\RowsRetrieved = 0\n|          ra|         dec|          clon|            mjd|  w1mpro| w1sigmpro|   w1snr|  w2mpro| w2sigmpro|   w2snr| qual_frame| qi_fact| saa_sep| moon_masked| cc_flags|\n`;
  const g = archive(u => (u.includes('/TAP/') ? new Response('err', { status: 503 }) : new Response(empty, { headers: { 'Content-Type': 'text/plain' } }))), env = fakeEnv();
  const r = await cat(...req('cat=neowise&ra=10&dec=-89'), env, { fetch: g.f });
  assert.equal(r.status, 200); assert.equal(await text(r), `${NEO}\n`);
});
