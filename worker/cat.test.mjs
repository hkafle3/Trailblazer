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
