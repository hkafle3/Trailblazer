// Offline checks for /api/depth (worker/src/depth.js): the distance rules, the readers, the dev-only fault gate and the
// per-source answer with a fake archive and cache. The live comparison with the catalogs is worker/depth_eval.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { starDistance, comovingPc, galaxyReason, galaxyDistance, readGaia, readCount, readSimbad, readSkybot, devFlags, depthAnswer } from './src/depth.js';

const near = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);

test('star distance: inverse parallax after the +0.017 mas zero point', () => {
  const [d, lo, hi] = starDistance(4.983, 0.017);
  near(d, 200); near(lo, 1000 / 5.017); near(hi, 1000 / 4.983);
});

test('comoving distance matches a fine Simpson integral and the low-z Hubble law', () => {
  const ref = z => { const n = 20000, h = z / n, f = x => 1 / Math.sqrt(0.3 * (1 + x) ** 3 + 0.7); let s = f(0) + f(z); for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * f(k * h); return 299792.458 / 70 * 1e6 * s * h / 3; };
  for (const z of [0.0123, 0.24895, 1.0, 2.19, 7.5, 13.2]) near(comovingPc(z), ref(z), 1e-9);
  near(comovingPc(0.001), 299792.458 * 0.001 / 70 * 1e6, 1e-3);
  assert.equal(comovingPc(-0.001), 0);
});

test('galaxy rule: reasons in order, placed only from z 0.01 with quality A-D and not photometric', () => {
  assert.equal(galaxyReason(null, 'A', 's'), 'no redshift');
  assert.equal(galaxyReason(0.5, 'C', 'p'), 'redshift not spectroscopic');
  assert.equal(galaxyReason(0.5, 'C', 'se'), null);
  assert.equal(galaxyReason(0.5, 'E', 's'), 'redshift quality E');
  assert.equal(galaxyReason(0.5, null, null), 'redshift quality E');
  assert.equal(galaxyReason(0.004, 'A', 's'), 'z below 0.01');
  assert.equal(galaxyReason(-0.001, 'A', 's'), 'z below 0.01');
  assert.equal(galaxyReason(0.01, 'D', null), null);
  const [d, lo, hi] = galaxyDistance(0.1, 29, 'v');
  assert.ok(lo < d && d < hi);
});

test('readers refuse anything that is not the table asked for', () => {
  assert.throws(() => readGaia('<VOTABLE><INFO name="QUERY_STATUS" value="ERROR"/>'), /no table/);
  assert.deepEqual(readGaia('source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,ruwe,pmra,pmdec\n'), []);
  const [s] = readGaia('source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,ruwe,pmra,pmdec\n3698955238387034240,180.09,-0.04,4.5767512814443,0.044751193,,1.01,-3.2,1.5\n');
  assert.equal(s.id, '3698955238387034240'); assert.equal(s.g, null); near(s.d_pc, 1000 / (4.5767512814443 + 0.017));
  assert.equal(readCount('n\n270\n'), 270);
  assert.throws(() => readCount('<html>Page unavailable</html>'), /no count/);
  const head = 'oid,main_id,otype,ra,dec,rvz_redshift,rvz_err,rvz_type,rvz_qual,rvz_nature\n';
  const [g] = readSimbad(head + '1,"SDSS J115938.03+000027.3","G",179.908475,0.007602,0.24895,,z,C,"s"\n', true);
  assert.equal(g.id, 'SDSS J115938.03+000027.3'); near(g.d_pc, comovingPc(0.24895));
  assert.throws(() => readSimbad(head + '1,"x","G",1,1,0.002,,z,C,"s"\n', true), /does not match/);
  assert.equal(readSimbad(head + '1,"x","G",1,1,,,,,\n', false)[0].reason, 'no redshift');
  assert.throws(() => readSimbad('<!doctype html><title>Page unavailable</title>', true), /no table/);
});

test('SkyBoT: 204 is empty, blank 200 and unreadable rows are errors, a row without dg is unknown', () => {
  assert.deepEqual(readSkybot(204, '').placed, []);
  assert.throws(() => readSkybot(200, ''), /no list/);
  assert.throws(() => readSkybot(200, '[{"Name":"x","Class":"MB","RA (hms)":"bad","DEC (dms)":"+05 09 51.4"}]'), /unreadable/);
  const row = { Name: '3I', 'RA (hms)': '11 08 37.6919', 'DEC (dms)': '+05 09 51.450', Class: 'Comet', 'VMag (mag)': 0, 'Err (arcsec)': 0.97 };
  const s = readSkybot(200, JSON.stringify([{ ...row, 'dg (ua)': 1.80715592229, 'dh (ua)': 2.1467 }, { ...row, Name: 'no dg' }]));
  assert.equal(s.count, 1); near(s.placed[0].d_pc, 1.80715592229 / 206264.80624709636);
  assert.equal(s.placed[0].mag, null); assert.equal(s.unknown[0].reason, 'no distance'); assert.ok(!('d_pc' in s.unknown[0]));
});

test('fault flags work only with DEPTH_FAULTS=1', () => {
  const url = new URL('http://x/api/depth?ra=1&dec=1&fail=stars,sso&fresh=1');
  assert.deepEqual(devFlags(url, {}), { faults: new Set(), fresh: false });
  assert.deepEqual(devFlags(url, { DEPTH_FAULTS: 'true' }), { faults: new Set(), fresh: false });
  assert.deepEqual(devFlags(url, { DEPTH_FAULTS: '1' }), { faults: new Set(['stars', 'sso']), fresh: true });
});

// a fake archive: answers each query by what it asks for; a fake cache that records puts
function fakes({ failGaia = false } = {}) {
  const store = new Map(), calls = [];
  const get = async u => {
    calls.push(u);
    const q = new URL(u).searchParams.get('QUERY') ?? '';
    if (u.includes('gea.esac') && failGaia) throw new Error('HTTP 503');
    if (q.startsWith('SELECT COUNT')) return u.includes('gea.esac') && !q.includes('parallax') ? 'n\n10\n' : 'n\n1\n';
    if (u.includes('gea.esac')) return 'source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,ruwe,pmra,pmdec\n1,1,1,2,0.1,9,1.0,0,0\n';
    return 'oid,main_id,otype,ra,dec,rvz_redshift,rvz_err,rvz_type,rvz_qual,rvz_nature\n' + (q.includes('rvz_redshift >=') ? '1,"g1","G",1,1,0.2,,z,C,"s"\n' : '2,"g2","G",1,1,,,,,\n');
  };
  const getWithStatus = async () => [204, ''];
  const cache = { match: async k => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, r) => store.set(k, await r.text()) };
  return { get, getWithStatus, cache, store, calls, faults: new Set(), fresh: false, waitUntil: () => {} };
}

test('answer: every source ok and cached on its own; a failing source is unavailable and never cached', async () => {
  const d = fakes();
  const a = await depthAnswer({ ra: 1, dec: 1, t: 61000.5 }, d);
  const b = JSON.parse(a.body);
  assert.equal(a.complete, true);
  assert.equal(b.sources.stars.count, 1); assert.equal(b.sources.stars.unknown_count, 9);
  assert.equal(b.sources.galaxies.count, 1); assert.equal(b.sources.galaxies.unknown[0].reason, 'no redshift');
  assert.equal(b.sources.sso.count, 0);
  assert.equal(d.store.size, 3);
  const n = d.calls.length;
  await depthAnswer({ ra: 1, dec: 1, t: 61000.5 }, d);
  assert.equal(d.calls.length, n, 'a cached answer asks no archive');

  const f = fakes({ failGaia: true });
  const c = await depthAnswer({ ra: 1, dec: 1, t: null }, f);
  const e = JSON.parse(c.body);
  assert.equal(c.complete, false);
  assert.deepEqual(e.sources.stars, { status: 'unavailable', error: 'Gaia archive is not answering', retry_after: 30 });
  assert.equal(e.sources.galaxies.status, 'ok'); assert.equal(e.sources.sso.status, 'skipped');
  assert.ok(![...f.store.keys()].some(k => k.includes('stars')));

  const h = fakes(), real = h.get;
  h.get = async u => (new URL(u).searchParams.get('QUERY') ?? '').startsWith('SELECT COUNT') && u.includes('gea.esac') && u.includes('parallax') ? 'n\n5\n' : real(u);
  assert.equal(JSON.parse((await depthAnswer({ ra: 1, dec: 1, t: null }, h)).body).sources.stars.status, 'unavailable', 'rows that disagree with the count');

  const g = fakes(); g.faults = new Set(['galaxies']);
  assert.equal(JSON.parse((await depthAnswer({ ra: 1, dec: 1, t: null }, g)).body).sources.galaxies.error, 'forced failure (dev)');
});
