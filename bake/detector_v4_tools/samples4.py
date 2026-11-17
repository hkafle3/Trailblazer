"""Development only (v4): cache forced-photometry samples so classifier variants can be compared without rerunning.
usage: samples4.py <dev field> <variant: mov|base> <out tag of the run to read movers from>
mov:  every spectrum-stage mover (tagged with the plant it matches; crowd plants marked).
base: every spectrum-stage mover, the field's target track, 120 random Gaia stars, up to 60 static CatWISE sources with
      no Gaia star within 3 arcsec (galaxies/AGN), reddest W1-W2 first, and up to 40 red static no-Gaia CatWISE sources
      13 to 24 arcsec from a row 1 to 4 mag brighter (crowded impostors matched to the crowding challenge).
Writes detector-v4/tmp/samples/<field>_<variant>.pkl"""
import sys, os, json, pickle, numpy as np
from concurrent.futures import ProcessPoolExecutor
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad'
sys.path.insert(0, S + '/wt-detector-v4/bake'); import detector_v4 as D, detector_v3_fetch as F, detector_v4_eval as E
from scipy.spatial import cKDTree

def main(n, v, tag):
    f = next(q for q in E.DEV['fields'] if q['field'] == n); d = E.run_dir('dev', n, 'base' if v == 'crowd' else v); o = json.load(open(f'{d}/out_{tag}.json' if tag != 'out' else d + '/out.json')) if v != 'crowd' else json.load(open(E.run_dir('dev', n, 'base') + '/out.json'))
    P = json.load(open(d + '/field.json')); pt = [p['t'] for p in o['passes'] if p['used']]
    G, C, T, Al = D.read_cat(d); ref = G[(G[:, 4] > 10.5) & (G[:, 4] < 17) & (np.hypot(G[:, 2], G[:, 3]) < 100)]
    with ProcessPoolExecutor(8) as ex: X = list(ex.map(D.prep, [(d, e, ref) for e in json.load(open(d + '/exposures.json'))], chunksize=8))
    items = []; truth = json.load(open(f'{E.TRUTH}/dev/{n}.json'))['movers'] if v == 'mov' else []
    if v == 'crowd': o['movers'] = []
    A = pickle.load(open(f'{D.V4OUT}/stageA/{D.cache_key(d)}.pkl', 'rb'))
    for m in o['movers']:
        if m['stage'] != 'spectrum': continue
        p = next((p for p in truth if np.hypot((p['ra'] - m['ra']) * np.cos(np.radians(m['dec'])), p['dec'] - m['dec']) * 3600 < 6), None)
        nbs = D.crowd_neighbours(A, m, G) if m.get('phot') == 'psf' else []
        items.append(dict(kind=('crowdplant' if p['crowd'] else 'plant') if p else 'mover', label=p['id'] if p else m['id'], w2=m['w2'], phot=m.get('phot'), sm=D.spectrum(X, P, m['track'], m['plx_nuisance'], nbs, A.get('dpsf'))))
    if v == 'crowd':                       # crowded no-Gaia impostors measured exactly as the run would (neighbour-aware photometry)
        gx, gy = F.tan(G[:, 0], G[:, 1], P['ra'], P['dec']); cx, cy = F.tan(C[:, 0], C[:, 1], P['ra'], P['dec']); dd, _ = cKDTree(np.c_[gx, gy]).query(np.c_[cx, cy]); tc = cKDTree(np.c_[cx, cy])
        ok = (dd > 3) & (C[:, 9] < 14.5) & (np.hypot(C[:, 4], C[:, 5]) < 0.1) & np.isfinite(C[:, 8]) & (np.abs(cx) < P['size'] * 1500) & (np.abs(cy) < P['size'] * 1500)
        crowd = np.array([any(13 <= np.hypot(cx[q] - cx[k], cy[q] - cy[k]) <= 24 and C[k, 9] - 4 <= C[q, 9] <= C[k, 9] - 1 for q in tc.query_ball_point([cx[k], cy[k]], 24)) if ok[k] else False for k in range(len(C))])
        for k in np.nonzero(ok & crowd)[0][:40]:
            m = dict(t=pt, track=[float(cx[k]), float(cy[k]), 0.0, 0.0], f45_mjy=171787.0 * 10 ** (-0.4 * C[k, 9])); nbs = D.crowd_neighbours(A, m, G)
            items.append(dict(kind='crowded_nogaia_psf', label=f'W1-W2={C[k, 8] - C[k, 9]:.2f}', w2=float(C[k, 9]), sm=D.spectrum(X, P, m['track'], 0.0, nbs, A.get('dpsf'))))
    if v == 'base':
        dt = (D.MJD_REF - D.MJD_CW) / 365.25; dtg = (D.MJD_CW - D.MJD_GAIA) / 365.25
        if f.get('target') and f['kind'] in ('dwarf', 'mdwarf'):
            t = f['target']; x, y = F.tan(t['ra'], t['dec'], P['ra'], P['dec']); plx = (t.get('plx_mas') or 0) / 1000 if np.isfinite(t.get('plx_mas') or 0) else 0
            items.append(dict(kind='target_' + f['kind'], label=t['name'], w2=t.get('w2'), sm=D.spectrum(X, P, [float(x) - t['pme'] * dt, float(y) - t['pmn'] * dt, t['pme'], t['pmn']], min(plx, 0.3))))
        rng = np.random.default_rng(1); st = G[(G[:, 4] > 13) & (G[:, 4] < 19.5)]; st = st[rng.permutation(len(st))[:120]]
        for g in st:
            x, y = F.tan(g[0], g[1], P['ra'], P['dec']); pe, pn = g[2] / 1000, g[3] / 1000
            items.append(dict(kind='star', label=f'G={g[4]:.1f} bp_rp={g[5]:.2f}', w2=None, sm=D.spectrum(X, P, [float(x) + pe * dtg, float(y) + pn * dtg, pe, pn], 0.0)))
        gx, gy = F.tan(G[:, 0], G[:, 1], P['ra'], P['dec']); cx, cy = F.tan(C[:, 0], C[:, 1], P['ra'], P['dec']); dd, _ = cKDTree(np.c_[gx, gy]).query(np.c_[cx, cy]); tc = cKDTree(np.c_[cx, cy])
        ok = (dd > 3) & (C[:, 9] < 14.5) & (np.hypot(C[:, 4], C[:, 5]) < 0.1) & np.isfinite(C[:, 8]) & (np.abs(cx) < P['size'] * 1500) & (np.abs(cy) < P['size'] * 1500)
        crowd = np.array([any(13 <= np.hypot(cx[q] - cx[k], cy[q] - cy[k]) <= 24 and C[k, 9] - 4 <= C[q, 9] <= C[k, 9] - 1 for q in tc.query_ball_point([cx[k], cy[k]], 24)) if ok[k] else False for k in range(len(C))])
        for kind, sel, cap in (('nogaia', ok & ~crowd, 60), ('crowded_nogaia', ok & crowd, 40)):
            for k in np.nonzero(sel)[0][np.argsort(-(C[sel, 8] - C[sel, 9]))][:cap]:
                items.append(dict(kind=kind, label=f'W1-W2={C[k, 8] - C[k, 9]:.2f}', w2=float(C[k, 9]), sm=D.spectrum(X, P, [float(cx[k]), float(cy[k]), 0.0, 0.0], 0.0)))
    os.makedirs(f'{S}/detector-v4/tmp/samples', exist_ok=True); pickle.dump(dict(pt=pt, items=items), open(f'{S}/detector-v4/tmp/samples/{n}_{v}.pkl', 'wb'))
    print(n, v, len(items), {k: sum(i['kind'] == k for i in items) for k in sorted({i['kind'] for i in items})}, flush=True)

if __name__ == '__main__':
    main(*sys.argv[1:4])
