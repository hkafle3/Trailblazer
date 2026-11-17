#!/usr/bin/env python3
"""Evaluator for GET /api/depth (contract: docs/api.md, "GET /api/depth"). Python standard library only.

Run with the app up and the dev fault flags on (worker/.dev.vars has DEPTH_FAULTS=1):
    npm run dev            then    python3 worker/depth_eval.py [base url, default http://127.0.0.1:8787]

For about 20 patches it asks the endpoint, then asks ESA Gaia, SIMBAD (Harvard mirror) and IMCCE SkyBoT itself with its
own queries, applies the distance rules with its own code, and prints PASS/FAIL for:
  1. every placed distance equals the independently recomputed value (relative 1e-6); comets also within 1% of JPL Horizons
  2. nothing is placed without a catalog distance, and no unknown carries a distance
  3. counts and truncation flags match the direct catalog query for the same cone and cuts
  4. cold request (cache reads skipped with fresh=1) under 5 s at the 90th percentile; cached request under 1 s
  5. a source forced to fail (fail=..., dev only) is "unavailable" while the others still answer
Exit status 0 only when every check passes.
"""
import csv, io, json, math, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787').rstrip('/')
R = 0.15                  # cone radius, deg
LIMIT = 1000              # rows kept per list
REL = 1e-6
AU_PC = 1 / 206264.80624709636
C_KMS = 299792.458
H0, OM, OL = 70.0, 0.3, 0.7

# (name, ra, dec, t MJD). Comet patches are centred where JPL Horizons put the comet at a SPHEREx photo time from
# web/data/comets/*/comet.json; the other dates are inside the survey.
PATCHES = [
    ("Baade's Window (dense bulge)", 270.9000, -30.0300, 60794.7889),
    ('Galactic centre', 266.4000, -28.9000, 60900.5),
    ('Cygnus, Milky Way disk', 305.0000, 40.0000, 60900.5),
    ('Empty high latitude (north)', 150.0000, 70.0000, 61000.5),
    ('Empty high latitude (south)', 10.0000, -80.0000, 61000.5),
    ('3I/ATLAS on 14 Dec 2025', 167.1309, 5.1732, 61023.3194),
    ('P/2021 N1 (ZTF) visit', 154.9519, -0.4738, 60794.7889),
    ('210P/Christensen visit', 320.7610, -19.6460, 60795.4999),
    ('C/2025 R2 (SWAN) visit', 315.1811, -5.4265, 60975.4762),
    ('Ecliptic at RA 12h', 180.0000, 0.0000, 61023.3194),
    ('Coma cluster', 194.9530, 27.9806, 61000.5),
    ('Virgo, M87', 187.7059, 12.3911, 61000.5),
    ('M31', 10.6847, 41.2690, 61000.5),
    ('Hubble Deep Field (galaxy truncation)', 189.2000, 62.2100, 61000.5),
    ('LMC', 80.8939, -69.7561, 61000.5),
    ('Pleiades', 56.7500, 24.1167, 61000.5),
    ('Orion nebula', 83.8221, -5.3911, 61000.5),
    ("Barnard's Star", 269.4463, 4.7671, 60900.5),
    ('South ecliptic pole deep field', 90.0000, -66.5607, 61000.5),
    ('North ecliptic pole deep field', 270.0000, 66.5607, 61000.5),
    ('Abell 1689', 197.8730, -1.3410, 61000.5),
]
# JPL Horizons geocentric range (au) at the same times, fetched 2026-11-17: an ephemeris independent of SkyBoT
HORIZONS = {'3I': (61023.3194, 1.80744065021807), 'P/2021 N1': (60794.7889, 3.44090877339549),
            '210P': (60795.4999, 2.81190815209798), 'C/2025 R2': (60975.4762, 0.30499235820635)}


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': 'comet-hunt-depth-eval'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode(), dict(r.headers)


def tap(base, query):
    url = base + '?' + urllib.parse.urlencode({'REQUEST': 'doQuery', 'LANG': 'ADQL', 'FORMAT': 'csv', 'QUERY': query})
    for attempt in range(3):
        try:
            status, text, _ = get(url)
            rows = list(csv.DictReader(io.StringIO(text)))
            return rows
        except Exception as e:  # noqa: BLE001  one retry for a flaky archive
            last = e
            time.sleep(2)
    raise last


ESA = 'https://gea.esac.esa.int/tap-server/tap/sync'
SIMBAD = 'https://simbad.harvard.edu/simbad/sim-tap/sync'


def num(x):
    return None if x in (None, '') else float(x)


# ---- independent distance rules ----
def star_distance(plx, err):
    p = plx + 0.017
    return 1000 / p, 1000 / (p + err), 1000 / (p - err)


def comoving_pc(z, n=2000):
    if z <= 0:
        return 0.0
    f = lambda x: 1 / math.sqrt(OM * (1 + x) ** 3 + OL)
    h = z / n
    s = f(0) + f(z) + sum((4 if k % 2 else 2) * f(k * h) for k in range(1, n))
    return C_KMS / H0 * 1e6 * s * h / 3


def galaxy_reason(z, qual, nature):
    if z is None:
        return 'no redshift'
    if nature is not None and not nature.startswith('s'):
        return 'redshift not spectroscopic'
    if qual not in ('A', 'B', 'C', 'D'):
        return 'redshift quality E'
    if z < 0.01:
        return 'z below 0.01'
    return None


def galaxy_distance(z, err, ztype):
    sm = 0.0 if err is None else (err * (1 + z) / C_KMS if ztype == 'v' else err)
    sz = math.sqrt(sm ** 2 + (300 * (1 + z) / C_KMS) ** 2)
    return comoving_pc(z), comoving_pc(max(z - sz, 0)), comoving_pc(z + sz)


# ---- direct catalog queries (the script's own) ----
def gaia_direct(ra, dec):
    cone = f'1=CONTAINS(POINT(ra, dec), CIRCLE({ra}, {dec}, {R}))'
    with ThreadPoolExecutor(2) as ex:
        rows = ex.submit(tap, ESA, f'SELECT source_id, parallax, parallax_error FROM gaiadr3.gaia_source WHERE {cone} AND parallax_over_error > 5 AND ruwe < 1.4')
        total = ex.submit(tap, ESA, f'SELECT COUNT(*) AS n FROM gaiadr3.gaia_source WHERE {cone}')
        return {r['source_id']: (float(r['parallax']), float(r['parallax_error'])) for r in rows.result()}, int(total.result()[0]['n'])


def simbad_direct(ra, dec):
    rows = tap(SIMBAD, f"SELECT TOP 200000 main_id, rvz_redshift, rvz_err, rvz_type, rvz_qual, rvz_nature FROM basic "
                       f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {R}))=1 AND otype='G..'")
    out = {}
    for r in rows:
        out[r['main_id']] = (num(r['rvz_redshift']), num(r['rvz_err']), r['rvz_type'] or None, r['rvz_qual'] or None, r['rvz_nature'] or None)
    return out


def skybot_direct(ra, dec, t):
    q = urllib.parse.urlencode({'-ep': repr(t + 2400000.5), '-ra': ra, '-dec': dec, '-rd': R, '-mime': 'json',
                                '-output': 'basic', '-objFilter': '101', '-from': 'comet-hunt-eval'})
    status, text, _ = get('https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?' + q)
    rows = [] if status == 204 or not text.strip() else json.loads(text)
    return {str(r.get('Name') or r.get('Num')): r.get('dg (ua)') for r in rows}


# ---- the endpoint ----
def depth(ra, dec, t, extra=''):
    t0 = time.time()
    status, text, headers = get(f'{BASE}/api/depth?ra={ra}&dec={dec}&t={t}{extra}')
    return time.time() - t0, status, json.loads(text), headers


def close(a, b):
    return a == b or (a is not None and b is not None and abs(a - b) <= REL * max(abs(a), abs(b)))


class Checks:
    def __init__(self):
        self.fails = {k: [] for k in '12345'}
        self.n = {k: 0 for k in '12345'}

    def ok(self, k, cond, msg):
        self.n[k] += 1
        if not cond:
            self.fails[k].append(msg)


def compare(c, name, body, gaia, simbad, sky):
    S = body['sources']
    # stars
    st = S['stars']
    good, total = gaia
    c.ok('3', st['count'] == len(good), f'{name}: stars count {st["count"]} != Gaia {len(good)}')
    c.ok('3', st['truncated'] == (len(good) > LIMIT), f'{name}: stars truncated flag wrong')
    c.ok('3', len(st['placed']) == min(len(good), LIMIT), f'{name}: {len(st["placed"])} stars placed, wanted {min(len(good), LIMIT)}')
    c.ok('3', st['unknown_count'] == total - len(good), f'{name}: stars unknown {st["unknown_count"]} != {total - len(good)}')
    ids = [s['id'] for s in st['placed']]
    c.ok('3', len(set(ids)) == len(ids), f'{name}: duplicate stars')
    for s in st['placed']:
        if s['id'] not in good:
            c.ok('2', False, f'{name}: star {s["id"]} placed but has no good Gaia parallax')
            continue
        plx, err = good[s['id']]
        c.ok('2', s['d_pc'] is not None, f'{name}: star without distance in placed')
        want = star_distance(plx, err)
        c.ok('1', s['d_lo_pc'] < s['d_pc'] < s['d_hi_pc'], f'{name}: star {s["id"]} interval out of order')
        c.ok('1', all(close(a, b) for a, b in zip((s['d_pc'], s['d_lo_pc'], s['d_hi_pc']), want)),
             f'{name}: star {s["id"]} {s["d_pc"]} != {want[0]}')
        c.ok('1', close(s['raw']['parallax_mas'], plx) and close(s['raw']['parallax_error_mas'], err), f'{name}: star {s["id"]} raw differs')
    # galaxies
    ga = S['galaxies']
    placed = {k: v for k, v in simbad.items() if galaxy_reason(v[0], v[3], v[4]) is None}
    unknown = {k: v for k, v in simbad.items() if k not in placed}
    c.ok('3', ga['count'] == len(placed), f'{name}: galaxies count {ga["count"]} != SIMBAD {len(placed)}')
    c.ok('3', ga['unknown_count'] == len(unknown), f'{name}: galaxy unknown {ga["unknown_count"]} != SIMBAD {len(unknown)}')
    c.ok('3', ga['truncated'] == (len(placed) > LIMIT) and ga['unknown_truncated'] == (len(unknown) > LIMIT), f'{name}: galaxy truncation flags wrong')
    c.ok('3', len(ga['placed']) == min(len(placed), LIMIT) and len(ga['unknown']) == min(len(unknown), LIMIT), f'{name}: galaxy list lengths wrong')
    for g in ga['placed']:
        v = placed.get(g['id'])
        if v is None:
            c.ok('2', False, f'{name}: galaxy {g["id"]} placed but SIMBAD gives it no usable redshift')
            continue
        want = galaxy_distance(v[0], v[1], v[2])
        c.ok('1', g['d_lo_pc'] < g['d_pc'] < g['d_hi_pc'], f'{name}: galaxy {g["id"]} interval out of order')
        c.ok('1', all(close(a, b) for a, b in zip((g['d_pc'], g['d_lo_pc'], g['d_hi_pc']), want)), f'{name}: galaxy {g["id"]} {g["d_pc"]} != {want[0]}')
        c.ok('1', close(g['raw']['z'], v[0]), f'{name}: galaxy {g["id"]} raw z differs')
    for g in ga['unknown']:
        c.ok('2', not any(k.startswith('d_') for k in g), f'{name}: unknown galaxy {g["id"]} carries a distance')
        v = unknown.get(g['id'])
        c.ok('3', v is not None and g['reason'] == galaxy_reason(v[0], v[3], v[4]), f'{name}: unknown galaxy {g["id"]} reason {g.get("reason")}')
    # solar system
    so = S['sso']
    got = {o['name']: o for o in so['placed']}
    with_d = {k: v for k, v in sky.items() if isinstance(v, (int, float)) and v > 0}
    c.ok('3', set(got) == set(with_d), f'{name}: SkyBoT objects {sorted(set(got) ^ set(with_d))[:5]} differ')
    c.ok('3', len(so['unknown']) == len(sky) - len(with_d), f'{name}: SkyBoT unknown count differs')
    for nm, o in got.items():
        if nm not in with_d:
            c.ok('2', False, f'{name}: {nm} placed without a SkyBoT distance')
            continue
        c.ok('1', close(o['d_pc'], with_d[nm] * AU_PC) and o['d_lo_pc'] is None and o['d_hi_pc'] is None, f'{name}: {nm} distance differs')
        for key, (t, delta) in HORIZONS.items():
            if nm == key or nm.startswith(key):
                c.ok('1', abs(o['raw']['dg_au'] - delta) / delta < 0.01, f'{name}: {nm} SkyBoT {o["raw"]["dg_au"]} vs Horizons {delta}')
                print(f'    {nm}: SkyBoT {o["raw"]["dg_au"]:.6f} au, Horizons {delta:.6f} au ({(o["raw"]["dg_au"] - delta) / delta * 100:+.3f}%)')
    for o in so['unknown']:
        c.ok('2', not any(k.startswith('d_') for k in o), f'{name}: unknown SkyBoT object carries a distance')
    return {k for k in HORIZONS if any(n == k or n.startswith(k) for n in got)}


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, math.ceil(p / 100 * len(xs)) - 1)]


def main():
    c = Checks()
    cold, cached, complete = [], [], []
    comets_seen = set()
    for name, ra, dec, t in PATCHES:
        dt, status, body, _ = depth(ra, dec, t, '&fresh=1')
        cold.append(dt)
        pending = first = [k for k, v in body['sources'].items() if v['status'] == 'pending']
        t0 = time.time() - dt
        for _ in range(12):   # a pending source finishes in the background; ask again after retry_after, as a UI would
            if not pending:
                break
            time.sleep(max(v.get('retry_after', 5) for v in body['sources'].values() if v['status'] == 'pending'))
            _, status, body, _ = depth(ra, dec, t)
            pending = [k for k, v in body['sources'].items() if v['status'] == 'pending']
        complete.append(time.time() - t0)
        dt2, status, body, headers = depth(ra, dec, t)
        cached.append(dt2)
        states = {k: v['status'] for k, v in body['sources'].items()}
        print(f'{name}: cold {dt:.2f} s (pending: {",".join(first) or "none"}), complete {complete[-1]:.2f} s, cached {dt2:.3f} s, {states}')
        if any(s != 'ok' for s in states.values()):
            for k in '123':
                c.ok(k, False, f'{name}: not every source answered: {states}')
            continue
        with ThreadPoolExecutor(3) as ex:
            g, s, k = ex.submit(gaia_direct, ra, dec), ex.submit(simbad_direct, ra, dec), ex.submit(skybot_direct, ra, dec, t)
            try:
                direct = g.result(), s.result(), k.result()
            except Exception as e:  # noqa: BLE001
                print(f'    direct query failed, patch skipped: {e}')
                continue
        S = body['sources']
        print(f'    stars {S["stars"]["count"]} placed / {S["stars"]["unknown_count"]} unknown{" (truncated)" if S["stars"]["truncated"] else ""}; '
              f'galaxies {S["galaxies"]["count"]} / {S["galaxies"]["unknown_count"]}{" (truncated)" if S["galaxies"]["truncated"] or S["galaxies"]["unknown_truncated"] else ""}; '
              f'sso {S["sso"]["count"]} / {len(S["sso"]["unknown"])}')
        comets_seen |= compare(c, name, body, *direct)
    c.ok('1', comets_seen == set(HORIZONS), f'comets missing from SkyBoT answers: {set(HORIZONS) - comets_seen}')

    # 4: timing
    p90 = pct(cold, 90)
    c.ok('4', p90 < 5, f'cold p90 {p90:.2f} s')
    c.ok('4', max(cached) < 1, f'slowest cached {max(cached):.3f} s')

    # 5: fault injection, on the 3I patch (all three sources cached by now)
    name, ra, dec, t = PATCHES[5]
    for fail in ('sso', 'stars', 'galaxies', 'sso,stars,galaxies'):
        _, status, body, headers = depth(ra, dec, t, f'&fail={fail}')
        states = {k: v['status'] for k, v in body['sources'].items()}
        want = {k: 'unavailable' if k in fail.split(',') else 'ok' for k in states}
        c.ok('5', status == 200 and states == want, f'fail={fail}: {status} {states}')
        c.ok('5', 'no-store' in headers.get('Cache-Control', ''), f'fail={fail}: response may be cached')
        c.ok('5', all('placed' not in v and 'count' not in v and 'error' in v for k, v in body['sources'].items() if v['status'] == 'unavailable'),
             f'fail={fail}: an unavailable source still carries objects')
    _, status, body, _ = depth(ra, dec, t)
    c.ok('5', all(v['status'] == 'ok' for v in body['sources'].values()), 'a forced failure was remembered')
    # an archive that fails late (after the 4 s deadline, in the background): the next ask must say unavailable, not
    # pending forever; the failure is noted for 60 s and a later success clears it. On a fresh patch so nothing is cached.
    ra2, dec2, t2 = 33.3333, -44.4444, 61000.5
    _, status, body, _ = depth(ra2, dec2, t2, '&fresh=1&outage=galaxies')
    c.ok('5', body['sources']['galaxies']['status'] == 'pending', f'late outage: first ask {body["sources"]["galaxies"]}')
    time.sleep(3)   # the background fetch fails 5 s after it started
    _, status, body, headers = depth(ra2, dec2, t2)
    states = {k: v['status'] for k, v in body['sources'].items()}
    c.ok('5', states == {'sso': 'ok', 'stars': 'ok', 'galaxies': 'unavailable'} or states == {'sso': 'pending', 'stars': 'ok', 'galaxies': 'unavailable'},
         f'late outage: second ask {states}')
    c.ok('5', 'placed' not in body['sources']['galaxies'] and 'no-store' in headers.get('Cache-Control', ''), 'late outage: unavailable carries objects or is cacheable')
    _, status, body, _ = depth(ra2, dec2, t2, '&fresh=1')
    c.ok('5', body['sources']['galaxies']['status'] == 'ok', f'late outage: a fresh fetch did not succeed {body["sources"]["galaxies"]}')
    _, status, body, _ = depth(ra2, dec2, t2)
    c.ok('5', body['sources']['galaxies']['status'] == 'ok', 'late outage: the success did not replace the failure note')
    _, status, body, _ = depth(ra, dec, t, '&fail=stars&fresh=1')
    c.ok('5', body['sources']['stars']['status'] == 'unavailable', 'fail with fresh did not fail')

    print()
    print(f'cold: p50 {pct(cold, 50):.2f} s, p90 {p90:.2f} s, max {max(cold):.2f} s; until complete: p50 {pct(complete, 50):.2f} s, '
          f'p90 {pct(complete, 90):.2f} s, max {max(complete):.2f} s; cached: max {max(cached):.3f} s')
    labels = {'1': 'placed distances equal recomputed catalog values', '2': 'nothing placed without a catalog distance',
              '3': 'counts match direct catalog queries', '4': 'cold p90 < 5 s, cached < 1 s', '5': 'forced source failure is reported'}
    bad = 0
    for k in '12345':
        f = c.fails[k]
        print(f'{"PASS" if not f else "FAIL"} {k}. {labels[k]} ({c.n[k] - len(f)}/{c.n[k]} assertions)')
        for m in f[:10]:
            print('     ', m)
        bad += bool(f)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
