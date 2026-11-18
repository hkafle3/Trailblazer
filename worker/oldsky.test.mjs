// Offline checks for GET /api/oldsky (worker/src/oldsky.js), E6 of the phase 2 plan, with a fake IRSA, a fake R2 and a
// fake rate limiter: refusals, gzip kept and checked, upstream errors and HTML never stored, redirects refused, the size
// cap, 429 past the limit, a warm hit served with IRSA unreachable. The live checks (sha256 against a direct IRSA
// download, a real miss and hit) are in worker/test_contract.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { oldsky, stored, blinkBaked, readRequest, posKey } from './src/oldsky.js';

const card = (k, v) => (k.padEnd(8) + (v === undefined ? '' : '= ' + String(v).padStart(20))).padEnd(80);
function fitsBytes(cards) {
  let h = [card('SIMPLE', 'T'), card('BITPIX', -32), card('NAXIS', 2), card('NAXIS1', 2), card('NAXIS2', 2), ...cards.map(([k, v]) => card(k, v)), card('END')].join('');
  h = h.padEnd(Math.ceil(h.length / 2880) * 2880, ' ');
  const out = new Uint8Array(h.length + 2880); out.set(new TextEncoder().encode(h)); return out;
}
const gzip = async b => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const SIA = 's_ra,s_dec,dataproduct_subtype,energy_bandpassname,access_url,obs_id\n' +
  '83.5446,-6.0578,science,W2,https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/08/0835/0835m061_ac51/0835m061_ac51-w2-int-3.fits,0835m061_ac51\n' +
  '83.5446,-6.0578,science,W1,https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/08/0835/0835m061_ac51/0835m061_ac51-w1-int-3.fits,0835m061_ac51\n';
const IBE = 'fname,ordate,hemisphere,scanno,filter\nki1030244.fits.gz,001126,n,103,k\nhi1030244.fits.gz,001126,n,103,h\nki1020021.fits.gz,001126,n,102,k\n';

// a fake IRSA: answers by URL; `override(url)` may return a Response to replace the normal one
async function fakeIrsa(override = () => null) {
  const w2 = fitsBytes([['BAND', 2], ['DATEOBS1', "'2010-03-06T22:30:53.139'"], ['DATEOBS2', "'2010-09-17T04:47:46.567'"]]);
  const cov = await gzip(fitsBytes([['BAND', 2]])), ks = await gzip(fitsBytes([['FILTER', "'k'"], ['ORDATE', "'001126'"]]));
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const o = override(url); if (o) return o;
    if (url.includes('/SIA?')) return new Response(SIA);
    if (url.includes('/ibe/search/twomass')) return new Response(IBE);
    if (url.includes('-w2-int-3.fits')) return new Response(w2);
    if (url.includes('-w2-cov-3.fits.gz')) return new Response(cov);
    if (url.includes('/twomass/allsky/allsky/001126n/')) return new Response(ks);
    return new Response('not found', { status: 404 });
  };
  return { f, calls, w2, cov, ks };
}
function fakeEnv(limit = Infinity) {
  const store = new Map(); let n = 0;
  return { store, OLDSKY: {
    get: async k => (store.has(k) ? { body: store.get(k).v, httpMetadata: store.get(k).meta, httpEtag: '"x"' } : null),
    put: async (k, v, opt) => { store.set(k, { v: typeof v === 'string' ? v : new Uint8Array(v), meta: opt?.httpMetadata }); } },
    OLDSKY_LIMIT: { limit: async () => ({ success: ++n <= limit }) } };
}
const req = (q, ip = '1.2.3.4') => { const url = new URL(`https://x.test/api/oldsky?${q}`); return [new Request(url, { headers: { 'CF-Connecting-IP': ip } }), url]; };
const sha = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');

test('400 for an unlisted survey or band, a bad position or another size', async () => {
  const env = fakeEnv(), { f, calls } = await fakeIrsa();
  for (const q of ['survey=neowise&band=W2&ra=1&dec=1', 'survey=allwise&band=Ks&ra=1&dec=1', 'survey=2mass&band=W1&ra=1&dec=1', 'survey=allwise&band=W3&ra=1&dec=1',
    'survey=allwise&band=W2&ra=abc&dec=1', 'survey=allwise&band=W2&ra=Infinity&dec=1', 'survey=allwise&band=W2&ra=NaN&dec=1', 'survey=allwise&band=W2&ra=&dec=1',
    'survey=allwise&band=W2&ra=360&dec=1', 'survey=allwise&band=W2&ra=-1&dec=1', 'survey=allwise&band=W2&ra=1&dec=91', 'survey=allwise&band=W2&ra=1',
    'survey=allwise&band=W2&ra=1&dec=1&size=600', 'survey=allwise&band=W2&ra=1&dec=1&size=7800', 'band=W2&ra=1&dec=1']) {
    const r = await oldsky(...req(q), env, { fetch: f });
    assert.equal(r.status, 400, q);
  }
  assert.equal(calls.length, 0, 'a refused request never reaches IRSA');
  assert.equal(env.store.size, 0);
});

test('positions are canonical: rounded to 0.001 degree, one key', () => {
  assert.equal(readRequest(new URL('https://x/api/oldsky?survey=allwise&band=W2&ra=84.01808&dec=-6.5775')).prefix, 'oldsky/v1/allwise/W2/780/84.018-6.578/');
  assert.equal(readRequest(new URL('https://x/api/oldsky?survey=allwise&band=W2&ra=84.0184&dec=-6.57751')).prefix, 'oldsky/v1/allwise/W2/780/84.018-6.578/');
  assert.equal(posKey(359.9996, 4.5), '0.000+4.500');
});

test('a miss fetches, checks and stores the bytes as IRSA sent them (gzip or not), then a hit needs no IRSA', async () => {
  const env = fakeEnv(), irsa = await fakeIrsa();
  const r = await oldsky(...req('survey=allwise&band=W2&ra=84.01808&dec=-6.5775'), env, { fetch: irsa.f });
  assert.equal(r.status, 200); const m = await r.json();
  assert.deepEqual(m.tiles.map(t => [t.name, t.gzip]), [['allwise_W2_int.fits', false], ['allwise_W2_cov.fits', true]]);
  assert.equal(m.tiles[0].header.DATEOBS1, '2010-03-06T22:30:53.139');
  const int = env.store.get('oldsky/v1/allwise/W2/780/84.018-6.578/allwise_W2_int.fits').v, cov = env.store.get('oldsky/v1/allwise/W2/780/84.018-6.578/allwise_W2_cov.fits').v;
  assert.deepEqual(int, irsa.w2); assert.deepEqual(cov, irsa.cov);
  assert.equal(m.tiles[0].sha256, await sha(irsa.w2)); assert.equal(m.tiles[1].sha256, await sha(irsa.cov));
  for (const c of irsa.calls) { assert.equal(c.init.redirect, 'manual'); assert.ok(c.url.startsWith('https://irsa.ipac.caltech.edu/')); }
  // warm: IRSA unreachable, the stored answer still served
  const r2 = await oldsky(...req('survey=allwise&band=W2&ra=84.0181&dec=-6.5775'), env, { fetch: () => { throw new Error('IRSA blocked'); } });
  assert.equal(r2.status, 200); assert.equal(r2.headers.get('X-Oldsky'), 'hit'); assert.deepEqual((await r2.json()).tiles.length, 2);
  const file = await stored(new URL(`https://x.test/${m.tiles[1].path}`), env);
  assert.equal(file.status, 200); assert.deepEqual(new Uint8Array(await new Response(file.body).arrayBuffer()), irsa.cov);
});

test('2MASS: every Ks tile from one box search, named and ordered as the reference', async () => {
  const env = fakeEnv(), irsa = await fakeIrsa();
  const m = await (await oldsky(...req('survey=2mass&band=Ks&ra=84.01808&dec=-6.5775'), env, { fetch: irsa.f })).json();
  assert.deepEqual(m.tiles.map(t => t.name), ['2mass_Ks_001126_ki1020021.fits', '2mass_Ks_001126_ki1030244.fits']);
  assert.ok(m.tiles[1].source.startsWith('https://irsa.ipac.caltech.edu/ibe/data/twomass/allsky/allsky/001126n/s103/image/ki1030244.fits.gz?center=84.018,-6.578&size=780arcsec'));
  assert.ok(irsa.calls[0].url.includes('SIZE=0.2006&INTERSECT=OVERLAPS'));
});

test('an upstream 5xx, an HTML page, a redirect or a non-FITS body is never stored', async () => {
  const cases = {
    '503': u => (u.includes('int-3') ? new Response('busy', { status: 503 }) : null),
    'HTML with 200': u => (u.includes('cov-3') ? new Response('<html><body>Proxy Error</body></html>', { headers: { 'Content-Type': 'text/html' } }) : null),
    'gzip of HTML': u => null,
    'redirect': u => (u.includes('int-3') ? new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.fits' } }) : null),
    'search busy': u => (u.includes('/SIA?') ? new Response('Server busy, try later') : null),
    'search 502': u => (u.includes('/SIA?') ? new Response('', { status: 502 }) : null),
  };
  const html = await gzip(new TextEncoder().encode('<html>not fits</html>'));
  cases['gzip of HTML'] = u => (u.includes('cov-3') ? new Response(html) : null);
  for (const [name, o] of Object.entries(cases)) {
    const env = fakeEnv(), irsa = await fakeIrsa(o);
    const r = await oldsky(...req('survey=allwise&band=W2&ra=84.01808&dec=-6.5775'), env, { fetch: irsa.f });
    assert.equal(r.status, 503, name); assert.equal((await r.json()).error, 'older survey unavailable', name);
    assert.equal(r.headers.get('Cache-Control'), 'no-store', name);
    assert.equal(env.store.size, 0, `${name}: nothing stored`);
    assert.ok(!irsa.calls.some(c => c.url.includes('evil.example')), 'a redirect is never followed');
  }
});

test('a tile over 4 MB, a wrong band, or a search pointing off IRSA is refused', async () => {
  const big = new Uint8Array(5 << 20); big.set(new TextEncoder().encode('SIMPLE  ='));
  for (const [name, o] of [['too big', u => (u.includes('int-3') ? new Response(big) : null)],
    ['wrong band', u => (u.includes('int-3') ? new Response(fitsBytes([['BAND', 1]])) : null)],
    ['off IRSA', u => (u.includes('/SIA?') ? new Response(SIA.replaceAll('https://irsa.ipac.caltech.edu', 'https://evil.example')) : null)]]) {
    const env = fakeEnv(), irsa = await fakeIrsa(o);
    const r = await oldsky(...req('survey=allwise&band=W2&ra=84.01808&dec=-6.5775'), env, { fetch: irsa.f });
    assert.equal(r.status, 503, name); assert.equal(env.store.size, 0, name);
    assert.ok(!irsa.calls.some(c => c.url.includes('evil.example')), name);
  }
});

test('429 past the limit, on misses only', async () => {
  const env = fakeEnv(2), irsa = await fakeIrsa();
  const s = [];
  for (const ra of [10, 11, 12]) s.push((await oldsky(...req(`survey=allwise&band=W2&ra=${ra}&dec=1`), env, { fetch: irsa.f })).status);
  assert.deepEqual(s, [200, 200, 429]);
  assert.equal((await oldsky(...req('survey=allwise&band=W2&ra=10&dec=1'), env, { fetch: irsa.f })).status, 200, 'a stored spot is never limited');
});

test('stored files: canonical keys only; the baked blink by position', async () => {
  const env = fakeEnv();
  env.store.set('blink/v1/84.018-6.578/result.json', { v: '{"v":1}', meta: { contentType: 'application/json' } });
  for (const p of ['/api/oldsky/v1/allwise/W2/780/84.018-6.578/../../x', '/api/oldsky/v1/neowise/W2/780/84.018-6.578/a.fits', '/api/blink/v1/84.018-6.578/other.json', '/api/oldsky/v1/allwise/W2/600/84.018-6.578/a.fits'])
    assert.equal((await stored(new URL(`https://x.test${p}`), env)).status, 404, p);
  assert.equal((await stored(new URL('https://x.test/api/blink/v1/84.018-6.578/result.json'), env)).status, 200);
  assert.equal((await blinkBaked(new URL('https://x.test/api/blink?ra=84.01808&dec=-6.5775'), env)).status, 200);
  assert.equal((await blinkBaked(new URL('https://x.test/api/blink?ra=10&dec=1'), env)).status, 404);
  assert.equal((await blinkBaked(new URL('https://x.test/api/blink?ra=x&dec=1'), env)).status, 400);
});
