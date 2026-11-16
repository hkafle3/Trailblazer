"""Detector v3, field selection (P3). Written and run BEFORE any detector code exists; its output
(bake/detector_v3_fields.json) is committed with it and is the frozen list of development and final fields.

Source catalogue (snapshot in the cache, sha256 checked): The UltracoolSheet v2.1.0, "UltracoolSheet - Main.csv",
Zenodo record 15802304 (Best, Dupuy, Liu, Sanghi, Siverd, Zhang 2025). Literature astrometry = its *_formula columns
(position at 2025-07-03, proper motion, with ref_pm_formula kept per target).

HELD-OUT T DWARFS (check 1). Eligibility, all from catalogues and footprints, none from detector output:
  E1 type T5 or later (sptnum_formula >= 25)
  E2 total proper motion 0.3 to 3.0 arcsec/yr
  E3 W2 11.0 to 14.5 mag (Vega), so 6.8 to 0.27 mJy
  E4 |galactic latitude| >= 10 and |ecliptic latitude| <= 80 (no deep fields)
  E5 not a development object, not one of v2's four (WISE 0855-0714, Eps Indi B, 2MASS 1114-2618, WISE 0254+0223),
     and at least 2 degrees from every development field and every v2 patch
  E6 binary and crowding: no higher-mass companion within 120 arcsec; no 2MASS star with Ks < 9 within
     20 + 25 * (9 - Ks) arcsec of the 2026 position; no CatWISE source within 12 arcsec of the 2015.4 position that is
     not the target itself (more than 3 arcsec away) and brighter than the target's W2 + 1.0. Unresolved binaries stay.
     A target with no CatWISE row of its own stays eligible (that is a real failure mode of the method).
  E7 SPHEREx coverage at the 2026 position from SIA footprints (DR1 + QR3): at least 2 passes of at least 8 D6
     exposures each, and at least 8 D4 exposures
Strata: slow (0.3 to 1.0) or fast (1.0 to 3.0 arcsec/yr) x bright (W2 < 13.5) or faint (13.5 to 14.5); 3 per stratum.
Order inside a stratum: ascending sha256("detector-v3-2026-11-16:" + name). The first 3 that pass E1 to E7 are taken;
later ones are the predeclared replacements, used only if a field cannot be downloaded at preflight.
Every exclusion is listed with its rule. Patch: 0.56 deg square; the target sits 0.08 to 0.20 deg from the centre at a
random angle (numpy default_rng seeded from the same hash).

NON-DWARF CONTROLS (check 5). Gaia DR3 stars with pm 0.3 to 3 arcsec/yr, BP-RP > 2.4 (M dwarfs), G 15 to 18.5,
ruwe < 1.4, parallax > 10 mas, |b| >= 15; same hash order; E4 (ecliptic), E5, E6, E7 apply, plus CatWISE W2 of the
star's own row 11.0 to 14.5 (flux matched to the dwarfs). First 2 go to development, next 6 are final.

OTHER FINAL FIELDS. Plane field: centred on galactic l = 60, b = +15 (if E7 fails at the centre: l = 75, 90, ...).
Flash field: centre RA 7.75, Dec +15.60 (holds Ed's flash at RA 7.6317, Dec +15.7040).

DEVELOPMENT FIELDS (tuning allowed), fixed by name here: seven T dwarfs (two of them v2's), Barnard's Star (diagnostic,
and the development field at |b| 10 to 20), two M-dwarf controls.

Final fields get neutral names f01.. in hash order of their centre, so a directory name does not reveal what is in it.
Run: python -I bake/detector_v3_select.py     (needs the cache from detector_v3_fetch.py for the UltracoolSheet only)
"""
import sys, os, io, csv, json, hashlib, numpy as np
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_v3_fetch as F

SEED = 'detector-v3-2026-11-16'
UCS = F.CACHE + '/ucs/UltracoolSheet-Main.csv'
UCS_SHA = '2307303072ebf729be6e7af6ec67c0a9feed6c2ab6f0adb35444bfab5724a184'
MJD_REF = 61000.0                  # 2025-11-21: epoch of every "2026 position" below and of the evaluator's matching
MJD_UCS = 60859.0                  # 2025-07-03
N_PER, N_CTRL_DEV, N_CTRL = 3, 2, 6
DEV_DWARFS = ['PSO J043.5395+02.3995', '2MASS J11145133-2618235', '2MASSI J0415195-093506', '2MASSI J0937347+293142', '2MASSI J0727182+171001',
              '2MASS J15031961+2525196', '2MASSI J0243137-245329', 'WISE J004945.61+215120.0']
V2 = [(133.76, -7.24), (331.10, -56.80), (168.71, -26.31), (43.53, 2.40), (269.45, 4.77), (7.75, 15.60)]   # v2 objects and patches
BARNARD = ('dev_barnard', 269.55, 4.85)
FLASH = (7.75, 15.60)
h = lambda s: hashlib.sha256(f'{SEED}:{s}'.encode()).hexdigest()
fl = lambda v: float(v) if v not in ('', 'null', 'NaN', None) else float('nan')
sepdeg = lambda a, d, a2, d2: float(np.degrees(np.arccos(np.clip(np.sin(np.radians(d)) * np.sin(np.radians(d2)) + np.cos(np.radians(d)) * np.cos(np.radians(d2)) * np.cos(np.radians(a - a2)), -1, 1))))

def galactic(ra, dec, inverse=False):
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    if inverse: c = SkyCoord(l=ra * u.deg, b=dec * u.deg, frame='galactic').icrs; return float(c.ra.deg), float(c.dec.deg)
    c = SkyCoord(ra * u.deg, dec * u.deg); return float(c.galactic.b.deg), float(c.barycentrictrueecliptic.lat.deg)

def at(ra, dec, pme, pmn, mjd0, mjd):
    dt = (mjd - mjd0) / 365.25; return ra + pme * dt / 3600 / np.cos(np.radians(dec)), dec + pmn * dt / 3600

def offset(name, ra, dec):
    """Patch centre so the target sits 0.08 to 0.20 deg off centre."""
    rng = np.random.default_rng(int(h(name)[:12], 16)); r, th = rng.uniform(0.08, 0.20) * 3600, rng.uniform(0, 2 * np.pi)
    a, d = F.untan(-r * np.sin(th), -r * np.cos(th), ra, dec); return round(float(a), 4), round(float(d), 4)

def cached(key, fn):
    """Network answers are kept on disk (cache/select), so a rerun after a failed query continues and gives the same list."""
    f = f"{F.CACHE}/select/{hashlib.sha256(key.encode()).hexdigest()[:20]}.json"; os.makedirs(os.path.dirname(f), exist_ok=True)
    if not os.path.exists(f): json.dump(fn(), open(f, 'w'))
    return json.load(open(f))
def cover(ra, dec): return cached(f'cover {ra:.6f} {dec:.6f}', lambda: F.cover(ra, dec))
def cone(table, cols, ra, dec, r_as): return cached(f'cone {table} {cols} {ra:.6f} {dec:.6f} {r_as}', lambda: cone_(table, cols, ra, dec, r_as))
def cone_(table, cols, ra, dec, r_as):
    t = F.get(F.IRSA, dict(QUERY=f"SELECT {cols} FROM {table} WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{r_as / 3600}))=1", FORMAT='csv'))
    if not t.startswith(cols.split(',')[0]): raise IOError(t[:200])
    return list(csv.DictReader(io.StringIO(t)))

def network_rules(c, w2=None):
    """E6 (catalogue part) and E7 for a candidate dict(ra, dec at MJD_REF, pme, pmn). -> reason string or None; fills c."""
    cov = cover(c['ra'], c['dec']); c['coverage'] = cov
    if sum(n >= 8 for n in cov['d6_per_pass']) < 2 or cov['d4'] < 8: return f"E7 coverage {cov['d6_per_pass']} D6 per pass, {cov['d4']} D4"
    for s in cone('fp_psc', 'ra,dec,k_m', c['ra'], c['dec'], 300):
        k = fl(s['k_m'])
        if k < 9 and sepdeg(c['ra'], c['dec'], fl(s['ra']), fl(s['dec'])) * 3600 < 20 + 25 * (9 - k): return f'E6 2MASS Ks {k} star within its exclusion radius'
    a, d = at(c['ra'], c['dec'], c['pme'], c['pmn'], MJD_REF, 57170.0); rows = cone('catwise_2020', 'ra_pm,dec_pm,w2mpro_pm,pmra,pmdec', a, d, 12)
    own = [s for s in rows if sepdeg(a, d, fl(s['ra_pm']), fl(s['dec_pm'])) * 3600 <= 3]
    c['catwise_own'] = dict(w2=fl(own[0]['w2mpro_pm']), pmra=fl(own[0]['pmra']), pmdec=fl(own[0]['pmdec'])) if own else None
    ref = w2 if w2 is not None else (c['catwise_own'] or {}).get('w2')
    if w2 is None and not (ref is not None and 11.0 <= ref <= 14.5): return f'flux: own CatWISE W2 {ref} outside 11.0 to 14.5'
    for s in rows:
        if sepdeg(a, d, fl(s['ra_pm']), fl(s['dec_pm'])) * 3600 > 3 and fl(s['w2mpro_pm']) < ref + 1.0: return f"E6 CatWISE neighbour W2 {s['w2mpro_pm']} within 12 arcsec"
    return None

def pick(cands, need, w2key=None, workers=3):
    """Walk cands in order, apply the network rules, keep the first `need`. -> taken, log"""
    taken, log, i = [], [], 0
    while len(taken) < need and i < len(cands):
        batch = cands[i:i + max(workers, need - len(taken))]; i += len(batch)
        with ThreadPoolExecutor(workers) as ex: why = list(ex.map(lambda c: network_rules(c, c.get(w2key) if w2key else None), batch))
        for c, w in zip(batch, why):
            if w: log.append(dict(name=c['name'], excluded=w))
            elif len(taken) < need: taken.append(c)
            else: log.append(dict(name=c['name'], excluded='not needed (eligible, next replacement)', replacement=True, **{k: c[k] for k in ('ra', 'dec', 'pme', 'pmn')}))
    return taken, log

def main():
    assert F.sha(UCS) == UCS_SHA, 'UltracoolSheet snapshot changed'
    rows = list(csv.DictReader(open(UCS))); out = dict(seed=SEED, mjd_ref=MJD_REF, source='UltracoolSheet v2.1.0 Main.csv, Zenodo 15802304', source_sha256=UCS_SHA, size=F.SIZE, dev=[], final=[], excluded=[])
    def ucs(x):
        pme, pmn = fl(x['pmra_formula']) / 1000, fl(x['pmdec_formula']) / 1000; ra, dec = at(fl(x['ra_20250703_formula']), fl(x['dec_20250703_formula']), pme, pmn, MJD_UCS, MJD_REF)
        return dict(name=x['name'], ra=float(ra), dec=float(dec), pme=pme, pmn=pmn, pm=float(np.hypot(pme, pmn)), w2=fl(x['W2']), w1=fl(x['W1']), spt=fl(x['sptnum_formula']), spt_text=x['spt_ir'] or x['spt_opt'],
                    ref_pm=x['ref_pm_formula'], plx_mas=fl(x['plx_formula']), unresolved_multiple=x['multiplesystem_unresolved_in_this_table'], companion=x['has_higher_mass_companion'], companion_sep=fl(x['sep_companion']))
    U = [ucs(x) for x in rows if x['ra_20250703_formula'] not in ('', 'NaN')]
    # development fields
    for n in DEV_DWARFS:
        c = next(u for u in U if u['name'] == n); a, d = offset(n, c['ra'], c['dec']); out['dev'].append(dict(field='dev_' + ''.join(ch for ch in n.split('J')[-1] if ch.isdigit())[:4], ra=a, dec=d, kind='dwarf', target=c))
    out['dev'].append(dict(field=BARNARD[0], ra=BARNARD[1], dec=BARNARD[2], kind='barnard', target=dict(name="Barnard's Star", ra=269.4463, dec=4.7671, pme=-0.802, pmn=10.362)))
    devc = [(f['ra'], f['dec']) for f in out['dev']] + V2
    far = lambda c: all(sepdeg(c['ra'], c['dec'], a, d) >= 2 for a, d in devc)
    # held-out dwarfs
    pool = []
    for c in U:
        if not (c['spt'] >= 25 and 0.3 <= c['pm'] <= 3.0 and 11.0 <= c['w2'] <= 14.5): continue      # E1 to E3 define the pool
        b, el = galactic(c['ra'], c['dec']); c['glat'], c['elat'] = b, el
        why = ('E4 galactic latitude' if abs(b) < 10 else 'E4 ecliptic latitude' if abs(el) > 80 else 'E5 development or v2 object or within 2 deg of one' if (c['name'] in DEV_DWARFS or not far(c))
               else 'E6 higher-mass companion within 120 arcsec' if (c['companion'] != 'N' and c['companion_sep'] < 120) else None)
        c['stratum'] = ('slow' if c['pm'] < 1.0 else 'fast') + '-' + ('bright' if c['w2'] < 13.5 else 'faint')
        if why: out['excluded'].append(dict(name=c['name'], stratum=c['stratum'], excluded=why))
        else: pool.append(c)
    out['pool'] = dict(e1_e3=len(pool) + len(out['excluded']), after_cheap_rules=len(pool), by_stratum={s: sum(c['stratum'] == s for c in pool) for s in ('slow-bright', 'slow-faint', 'fast-bright', 'fast-faint')})
    for s in ('slow-bright', 'slow-faint', 'fast-bright', 'fast-faint'):
        taken, log = pick(sorted([c for c in pool if c['stratum'] == s], key=lambda c: h(c['name'])), N_PER, 'w2')
        out['excluded'] += [dict(stratum=s, **l) for l in log]
        for c in taken: a, d = offset(c['name'], c['ra'], c['dec']); out['final'].append(dict(ra=a, dec=d, kind='dwarf', target=c))
    # M-dwarf controls
    f = F.CACHE + '/gaia_mdwarf_movers.csv'
    if not os.path.exists(f):
        t, src = F.gaia_query("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp, ruwe, b FROM {t} WHERE pm > 300 AND pm < 3000 AND bp_rp > 2.4 AND phot_g_mean_mag > 15 AND phot_g_mean_mag < 18.5 AND ruwe < 1.4 AND parallax > 10")
        open(f, 'w').write(t)
    out['control_source'] = dict(file='gaia_mdwarf_movers.csv', sha256=F.sha(f), rows=sum(1 for _ in open(f)) - 1); M = []
    for x in csv.DictReader(open(f)):
        if abs(fl(x['b'])) < 15: continue
        pme, pmn = fl(x['pmra']) / 1000, fl(x['pmdec']) / 1000; ra, dec = at(fl(x['ra']), fl(x['dec']), pme, pmn, 57388.5, MJD_REF)          # Gaia DR3 epoch 2016.0
        c = dict(name='Gaia DR3 ' + x['source_id'], ra=float(ra), dec=float(dec), pme=pme, pmn=pmn, pm=float(np.hypot(pme, pmn)), g=fl(x['phot_g_mean_mag']), bp_rp=fl(x['bp_rp']), plx_mas=fl(x['parallax']))
        if abs(galactic(ra, dec)[1]) <= 80 and far(c) and all(sepdeg(ra, dec, t['ra'], t['dec']) >= 2 for t in out['final']): M.append(c)
    taken, log = pick(sorted(M, key=lambda c: h(c['name'])), N_CTRL_DEV + N_CTRL); out['control_excluded'] = log
    for i, c in enumerate(taken):
        a, d = offset(c['name'], c['ra'], c['dec'])
        if i < N_CTRL_DEV: out['dev'].append(dict(field=f'dev_m{i + 1}', ra=a, dec=d, kind='mdwarf', target=c))
        else: out['final'].append(dict(ra=a, dec=d, kind='mdwarf', target=c))
    # plane and flash fields
    for l in range(60, 181, 15):
        ra, dec = galactic(l, 15.0, inverse=True); cov = cover(ra, dec)
        if sum(n >= 8 for n in cov['d6_per_pass']) >= 2 and cov['d4'] >= 8: out['final'].append(dict(ra=round(ra, 4), dec=round(dec, 4), kind='plane', l=l, b=15.0, coverage=cov)); break
        out['excluded'].append(dict(name=f'plane field l={l}', excluded=f'E7 coverage {cov}'))
    out['final'].append(dict(ra=FLASH[0], dec=FLASH[1], kind='flash', flash=dict(ra=7.6317, dec=15.7040, obs='2026W01_2A_0524_3', det='D1')))
    for i, f_ in enumerate(sorted(out['final'], key=lambda f_: h(f"{f_['ra']},{f_['dec']}"))): f_['field'] = f'f{i + 1:02d}'
    out['final'].sort(key=lambda f_: f_['field'])
    json.dump(out, open(os.path.dirname(os.path.abspath(__file__)) + '/detector_v3_fields.json', 'w'), indent=1)
    print('dev', [(f_['field'], f_['kind'], f_['target']['name']) for f_ in out['dev']])
    print('final', [(f_['field'], f_['kind'], (f_.get('target') or {}).get('name'), (f_.get('target') or {}).get('stratum')) for f_ in out['final']])
    print('pool', out['pool'], 'excluded', len(out['excluded']), 'control excluded', len(out['control_excluded']))

if __name__ == '__main__':
    main()
