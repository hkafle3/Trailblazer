"""Detector v4, selection (step 1). Written and run BEFORE any v4 detector or evaluator code; its two outputs are
committed with it and are frozen:
  bake/detector_v4_fields.json  FINAL fields only (held-out targets, controls, plane and blank fields, crowding rule)
  bake/detector_v4_dev.json     DEVELOPMENT fields only (v3's 11 development fields and v3's 20 final fields, which are
                                development fields now) and the declared template and injection donors
The detector's template builder may read only detector_v4_dev.json (A13).

Source catalogue (snapshot, sha256 checked): The UltracoolSheet v2.1.0, "UltracoolSheet - Main.csv", Zenodo 15802304,
the same file v3 used. Literature astrometry = its *_formula columns (position at 2025-07-03, proper motion).

HELD-OUT T AND Y DWARFS (check 1). v3's rule, applied to the entries v3 did not use:
  E1 type T5 or later (sptnum_formula >= 25)
  E2 total proper motion 0.3 to 3.0 arcsec/yr
  E3 W2 11.0 to 14.5 mag (Vega)
  E4 |galactic latitude| >= 10 and |ecliptic latitude| <= 80
  E5 never inspected (A13): not a v3 development or final object, not one of v2's four, not a template or injection
     donor; at least 2 deg from every v3 field (31), every v2 patch (6) and every donor's position; at least 3.5 deg
     from v1's three full-detector fields (RA 30.0 Dec +12.2, the flash, Barnard's Star)
  E6 binary and crowding (v3's rule): no higher-mass companion within 120 arcsec; no 2MASS Ks < 9 star within
     20 + 25 (9 - Ks) arcsec of the 2026 position; no CatWISE source within 12 arcsec of the 2015.4 position that is not
     the target (more than 3 arcsec away) and brighter than the target's W2 + 1.0. A target with no CatWISE row stays.
  E7 SPHEREx coverage at the 2026 position from SIA footprints (DR1 + QR3): at least 2 passes of at least 8 D6
     exposures each, and at least 8 D4 exposures
  E8 no sky shared with an earlier pick: a field centre at least 1.5 deg from every final field already taken
Strata (v3's): slow (0.3 to 1.0) or fast (1.0 to 3.0 arcsec/yr) x bright (W2 < 13.5) or faint (13.5 to 14.5), 3 per
stratum, so 12. Order inside a stratum: ascending sha256("detector-v4-2026-11-16:" + name); the first 3 that pass E1 to
E8 are taken, later eligible ones are the predeclared replacements (used only if a field cannot be fetched).
Y DWARFS (decision, frozen here): Y dwarfs are EXTRA, in addition to the 12: the first entries with sptnum_formula >= 30
in the same hash order that pass E2 to E8 and are not already taken, up to 2 (the eligible Y pool is small; the final
set must hold at least 2 real Y dwarfs counting any drawn into a stratum, else the selection fails). Check 1 counts all
held-out targets (12 + the extras). The Y claim is judged only on the real Y targets in the final set (the 2 extras plus any Y drawn
into a stratum), reported as its own row: the claim holds only if every one of them is recovered. No planted Y.
Patch: 0.56 deg square, the target 0.08 to 0.20 deg from the centre at a random angle (rng seeded from the same hash).

NON-DWARF CONTROLS (check 5). v3's rule: Gaia DR3 pm 0.3 to 3 arcsec/yr, BP-RP > 2.4, G 15 to 18.5, ruwe < 1.4,
parallax > 10 mas, |b| >= 15, |ecliptic latitude| <= 80, E5, E6, E7, E8 and the star's own CatWISE W2 11.0 to 14.5;
same hash order; the first 6 are final controls (v3's eight are excluded by E5).

PLANE FIELD. Galactic b = +15 at l = 75, 90, ... 345, then b = -15 at l = 0, 15, ... 345: the first centre passing E5,
E7 and E8. BLANK FIELDS (for area): 2 centres drawn by a numpy rng seeded from the hash of "blank", uniform on the sky,
kept if |b| >= 20, |ecliptic latitude| <= 80 and E5, E7, E8 hold, first 2 kept.
Final fields get neutral names f01.. in hash order of their centre. Expected usable area (v3's 0.28 sq deg per field):
23 fields, about 6.5 sq deg, against the 5.5 sq deg bar.

CROWDING CHALLENGE (A12), a separate plant set reported apart from the legacy isolated plants, frozen here:
  72 plants: speed bins 0.3-0.6, 0.6-1.2, 1.2-3.0 arcsec/yr x W2 11.5-12.5, 12.5-13.5, 13.5-14.0, 8 per bin
  neighbour: a real CatWISE row with W2 from the plant's W2 - 4.0 to W2 - 1.0 and W2 >= 8.5
  separation from that neighbour 13 to 24 arcsec at MJD 61000 and at least 10 arcsec at the CatWISE epoch (2015.4)
  otherwise isolated as the legacy plants: no other CatWISE row within 12 arcsec of the 2015.4 position, no other
  row brighter than the plant's W2 + 1 within 12 arcsec of the MJD 61000 position, 150 arcsec from other plants
  mask status: recorded per plant (flagged fraction of D6 pixels within 2 px), never a selection rule
  archive representation: a synthetic CatWISE row with the probability and error inflation the evaluator's archive
  model measures on development catalogues for sources 13 to 24 arcsec from a brighter row (frozen with the evaluator)
  replacement: a failed draw is redrawn and counted by reason, exactly as for legacy plants
  reporting: per bin and pooled with a 90% interval, and the same plants run through v3's frozen detector; its own
  PASS (at least 80% pooled and in every bin, 7 of 8) is reported and does NOT enter the five-check verdict

Run: python -I bake/detector_v4_select.py      (network: SIA footprints and IRSA cones, answers cached on disk)
"""
import sys, os, csv, json, hashlib, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_v3_fetch as F
import detector_v3_select as S3

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 'detector-v4-2026-11-16'
V4 = os.environ.get('DET_V4_OUT', os.path.dirname(F.OUT) + '/detector-v4')
V3CACHE = F.CACHE                                   # v3 cache: UltracoolSheet, control pool, development fields
S3.F.CACHE = V4 + '/cache'                          # network answers of this selection go to the v4 cache (cache/select)
UCS, UCS_SHA = S3.UCS, S3.UCS_SHA
MJD_REF = 61000.0
N_PER, N_Y, N_CTRL, N_BLANK = 3, 2, 6, 2
V1 = [(30.0, 12.2), (7.6317, 15.7040), (269.4463, 4.7671)]
h = lambda s: hashlib.sha256(f'{SEED}:{s}'.encode()).hexdigest()
fl, sepdeg, galactic, at = S3.fl, S3.sepdeg, S3.galactic, S3.at

def offset(name, ra, dec):
    rng = np.random.default_rng(int(h(name)[:12], 16)); r, th = rng.uniform(0.08, 0.20) * 3600, rng.uniform(0, 2 * np.pi)
    a, d = F.untan(-r * np.sin(th), -r * np.cos(th), ra, dec); return round(float(a), 4), round(float(d), 4)

CROWD = dict(n_per_bin=8, speed_bins=[0.3, 0.6, 1.2, 3.0], w2_bins=[11.5, 12.5, 13.5, 14.0], contrast_mag=[1.0, 4.0], neighbour_w2_min=8.5,
             sep_ref_arcsec=[13.0, 24.0], sep_catwise_min_arcsec=10.0, isolate_arcsec=12.0, apart_arcsec=150.0, gate=0.80, gate_per_bin=7,
             note='separate challenge, reported with its own PASS, not part of the five-check verdict; archive model frozen with the evaluator')

def main():
    assert F.sha(UCS) == UCS_SHA, 'UltracoolSheet snapshot changed'
    V3 = json.load(open(HERE + '/detector_v3_fields.json'))
    import detector_v3_eval as E3, detector_v3 as D3
    # development metadata (separate file)
    dev = [dict(f, set='v3 development', cache=f"{V3CACHE}/{f['field']}") for f in V3['dev']] + \
          [dict(f, field='v3_' + f['field'], set='v3 final (development in v4)', cache=f"{V3CACHE}/{f['field']}") for f in V3['final']]
    donors = dict(injection=list(E3.INJ_FROM), fitter_v3=list(D3.TEMPLATE_FROM), fitter_v4_candidates=['WISEPA J041022.71+150248.5', 'WISEPA J213456.73-713743.6'],
                  note='injection and fitter donors are disjoint; every donor is a development object; any v4 template is built only from these')
    assert not set(donors['injection']) & (set(donors['fitter_v3']) | set(donors['fitter_v4_candidates']))
    tgt = lambda f: f.get('target') or {}
    used = ({tgt(f).get('name') for f in V3['dev'] + V3['final']} - {None}) | set(donors['injection']) | set(donors['fitter_v3']) | set(donors['fitter_v4_candidates'])
    dpos = [(tgt(f)['ra'], tgt(f)['dec']) for f in V3['dev'] + V3['final'] if tgt(f).get('ra') is not None]
    inspected = [(f['ra'], f['dec']) for f in V3['dev'] + V3['final']] + S3.V2 + dpos
    def e5(ra, dec, name=None):
        if name in used: return 'E5 v3 object or donor'
        if any(sepdeg(ra, dec, a, d) < 2.0 for a, d in inspected): return 'E5 within 2 deg of an inspected field or donor'
        if any(sepdeg(ra, dec, a, d) < 3.5 for a, d in V1): return 'E5 within 3.5 deg of a v1 field'
        return None
    final = []
    e8 = lambda ra, dec: None if all(sepdeg(ra, dec, f['ra'], f['dec']) >= 1.5 for f in final) else 'E8 within 1.5 deg of another final field'
    def take(cands, need, w2key, kind, extra=None):
        """Walk cands in order, keep the first `need` that pass E8 (against fields already taken) and the network rules
        (E6, E7). -> log of everything not kept"""
        log, got = [], 0
        for c in cands:
            if got >= need: log.append(dict(name=c['name'], excluded='not needed (next replacement if eligible)', replacement=True)); continue
            a, d = offset(c['name'], c['ra'], c['dec']); why = e8(a, d) or S3.network_rules(c, c.get(w2key) if w2key else None)
            if why: log.append(dict(name=c['name'], excluded=why)); continue
            final.append(dict(ra=a, dec=d, kind=kind, target=c, **({'extra': extra} if extra else {}))); got += 1
        return log
    out = dict(seed=SEED, mjd_ref=MJD_REF, source='UltracoolSheet v2.1.0 Main.csv, Zenodo 15802304', source_sha256=UCS_SHA, size=F.SIZE, crowding=CROWD, excluded=[])
    rows = list(csv.DictReader(open(UCS)))
    def ucs(x):
        pme, pmn = fl(x['pmra_formula']) / 1000, fl(x['pmdec_formula']) / 1000; ra, dec = at(fl(x['ra_20250703_formula']), fl(x['dec_20250703_formula']), pme, pmn, S3.MJD_UCS, MJD_REF)
        return dict(name=x['name'], ra=float(ra), dec=float(dec), pme=pme, pmn=pmn, pm=float(np.hypot(pme, pmn)), w2=fl(x['W2']), w1=fl(x['W1']), spt=fl(x['sptnum_formula']), spt_text=x['spt_ir'] or x['spt_opt'],
                    ref_pm=x['ref_pm_formula'], plx_mas=fl(x['plx_formula']), unresolved_multiple=x['multiplesystem_unresolved_in_this_table'], companion=x['has_higher_mass_companion'], companion_sep=fl(x['sep_companion']))
    U = [ucs(x) for x in rows if x['ra_20250703_formula'] not in ('', 'NaN')]
    pool = []
    for c in U:
        if not (c['spt'] >= 25 and 0.3 <= c['pm'] <= 3.0 and 11.0 <= c['w2'] <= 14.5): continue
        b, el = galactic(c['ra'], c['dec']); c['glat'], c['elat'] = b, el
        c['stratum'] = ('slow' if c['pm'] < 1.0 else 'fast') + '-' + ('bright' if c['w2'] < 13.5 else 'faint')
        why = ('E4 galactic latitude' if abs(b) < 10 else 'E4 ecliptic latitude' if abs(el) > 80 else e5(c['ra'], c['dec'], c['name'])
               or ('E6 higher-mass companion within 120 arcsec' if (c['companion'] != 'N' and c['companion_sep'] < 120) else None))
        if why: out['excluded'].append(dict(name=c['name'], stratum=c['stratum'], excluded=why))
        else: pool.append(c)
    out['pool'] = dict(after_cheap_rules=len(pool), by_stratum={s: sum(c['stratum'] == s for c in pool) for s in ('slow-bright', 'slow-faint', 'fast-bright', 'fast-faint')}, y=sum(c['spt'] >= 30 for c in pool))
    for s in ('slow-bright', 'slow-faint', 'fast-bright', 'fast-faint'):
        out['excluded'] += [dict(stratum=s, **l) for l in take(sorted([c for c in pool if c['stratum'] == s], key=lambda c: h(c['name'])), N_PER, 'w2', 'dwarf')]
    taken = {f['target']['name'] for f in final}
    out['excluded'] += [dict(stratum='Y extra', **l) for l in take(sorted([c for c in pool if c['spt'] >= 30 and c['name'] not in taken], key=lambda c: h(c['name'])), N_Y, 'w2', 'dwarf', extra='Y')]
    assert sum(f['target']['spt'] >= 30 for f in final) >= 2, 'fewer than 2 real Y dwarfs in the final set'
    # M-dwarf controls
    f = V3CACHE + '/gaia_mdwarf_movers.csv'; out['control_source'] = dict(file=f, sha256=F.sha(f), rows=sum(1 for _ in open(f)) - 1); M = []
    for x in csv.DictReader(open(f)):
        if abs(fl(x['b'])) < 15: continue
        pme, pmn = fl(x['pmra']) / 1000, fl(x['pmdec']) / 1000; ra, dec = at(fl(x['ra']), fl(x['dec']), pme, pmn, 57388.5, MJD_REF)
        c = dict(name='Gaia DR3 ' + x['source_id'], ra=float(ra), dec=float(dec), pme=pme, pmn=pmn, pm=float(np.hypot(pme, pmn)), g=fl(x['phot_g_mean_mag']), bp_rp=fl(x['bp_rp']), plx_mas=fl(x['parallax']))
        if abs(galactic(ra, dec)[1]) <= 80 and not e5(ra, dec, c['name']) and all(sepdeg(ra, dec, t['target']['ra'], t['target']['dec']) >= 2 for t in final): M.append(c)
    out['control_excluded'] = take(sorted(M, key=lambda c: h(c['name'])), N_CTRL, None, 'mdwarf')
    # plane field, blank fields
    def ok_centre(ra, dec):
        if e5(ra, dec) or e8(ra, dec): return e5(ra, dec) or e8(ra, dec)
        cov = S3.cover(ra, dec); return None if (sum(n >= 8 for n in cov['d6_per_pass']) >= 2 and cov['d4'] >= 8) else f'E7 coverage {cov}'
    for b, ls in ((15.0, range(75, 346, 15)), (-15.0, range(0, 346, 15))):
        if any(f['kind'] == 'plane' for f in final): break
        for l in ls:
            ra, dec = galactic(l, b, inverse=True); why = ok_centre(ra, dec)
            if why: out['excluded'].append(dict(name=f'plane field l={l} b={b}', excluded=why)); continue
            final.append(dict(ra=round(ra, 4), dec=round(dec, 4), kind='plane', l=l, b=b)); break
    rng = np.random.default_rng(int(h('blank')[:12], 16)); tries = 0
    while sum(f['kind'] == 'blank' for f in final) < N_BLANK and tries < 400:
        tries += 1; ra, dec = float(rng.uniform(0, 360)), float(np.degrees(np.arcsin(rng.uniform(-1, 1)))); b, el = galactic(ra, dec)
        why = 'galactic latitude under 20' if abs(b) < 20 else 'ecliptic latitude over 80' if abs(el) > 80 else ok_centre(ra, dec)
        if why: out['excluded'].append(dict(name=f'blank field {ra:.3f} {dec:.3f}', excluded=why)); continue
        final.append(dict(ra=round(ra, 4), dec=round(dec, 4), kind='blank'))
    for i, f_ in enumerate(sorted(final, key=lambda f_: h(f"{f_['ra']},{f_['dec']}"))): f_['field'] = f'f{i + 1:02d}'
    out['final'] = sorted(final, key=lambda f_: f_['field'])
    json.dump(out, open(HERE + '/detector_v4_fields.json', 'w'), indent=1)
    json.dump(dict(seed=SEED, note='development fields of detector v4 (tuning allowed); never read by the evaluator for final scoring', fields=dev, donors=donors), open(HERE + '/detector_v4_dev.json', 'w'), indent=1)
    print('final', [(f_['field'], f_['kind'], tgt(f_).get('name'), tgt(f_).get('stratum'), tgt(f_).get('spt_text'), f_.get('extra')) for f_ in out['final']])
    print('pool', out['pool'], 'excluded', len(out['excluded']), 'control excluded', len(out['control_excluded']))

if __name__ == '__main__':
    main()
