"""Calibrate the Colors self-check's systematic floor (colors_ref.SYS_FLOOR) on quiet fields only (plan deviation 1).

In each quiet field (SPOT2 and the decade field a27, both far from star-forming regions) every quiet star (2MASS AAA,
Ks 9 to 13, one component, uncrowded, not a known variable) is measured exactly as the reference measures comparisons, in
every exposure. The statistic is each pass-to-pass change of the 3 to 5 um band mean over its sigma (statistical errors plus
floor x flux in quadrature, colors_ref.pair_z); the floor is the value that makes its robust spread (1.4826 MAD) 1 over
all pairs of both fields. C-0176's field is never read.
Run: python -I bake/colors_calib.py <field_dir> [<field_dir> ...] <out.json>
"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import colors_ref as C
from concurrent.futures import ProcessPoolExecutor
from scipy.spatial import cKDTree


def quiet_band_means(d, nproc=8):
    cats = C.load_field(d); K = C.components(cats['catwise'], cats['allwise'], cats['gaia']); n = len(K['ra'])
    ra0, dec0 = C.ra_mean(K['ra']), K['dec'].mean(); kx, ky = C.tan(K['ra'], K['dec'], ra0, dec0); TM = cats['twomass']
    tx, ty = C.tan([C.fl(r['ra']) for r in TM], [C.fl(r['dec']) for r in TM], ra0, dec0); dd, j = cKDTree(np.c_[tx, ty]).query(np.c_[kx, ky])
    Km = np.array([C.fl(TM[q]['k_m']) if a < C.STAR_R else np.nan for a, q in zip(dd, j)]); qual = np.array([TM[q]['ph_qual'] if a < C.STAR_R else 'XXX' for a, q in zip(dd, j)])
    var = C.known_variables(cats, kx, ky, ra0, dec0); tr = cKDTree(np.c_[kx, ky]); w1 = np.nan_to_num(K['w1'], nan=99)
    crowd = np.array([any(w1[q] < w1[i] + 2.5 for q in tr.query_ball_point([kx[i], ky[i]], C.CROWD_R) if q != i) for i in range(n)])
    stars = [int(i) for i in np.nonzero((qual == 'AAA') & (Km >= 9) & (Km <= 13) & (K['nmem'] == 1) & ~crowd & ~var)[0]]
    E = C.load_exposures(d)
    gref = np.array([[C.fl(r['ra']), C.fl(r['dec']), C.fl(r['pmra']), C.fl(r['pmdec']), C.fl(r['phot_g_mean_mag'])] for r in cats['gaia']]).reshape(-1, 5)
    gref = gref[(gref[:, 4] > 10.5) & (gref[:, 4] < 17)]
    with ProcessPoolExecutor(nproc) as ex: X = list(ex.map(C._prep, [(e, gref) for e in E], chunksize=4))
    P = C.psfs(X, K); X = [a for a in X if P[a['det']] is not None]
    with ProcessPoolExecutor(nproc) as ex:
        R = list(ex.map(C._fit, [({k: a[k] for k in ('sub', 'bad', 'sig_ap', 'x0', 'y0', 't', 'det', 'shift', 'w')}, K, P[a['det']], stars) for a in X], chunksize=2))
    rows = np.array([r for rr in R for r in rr], float).reshape(-1, 5)
    t = np.sort(np.unique(rows[:, 4])); g = C.pass_groups(t); passes = np.array([t[g == k].mean() for k in np.unique(g)])
    S = C.per_source(rows, stars, passes)
    return S, len(passes), len(stars), len(X)


def spread(z): z = np.asarray(z); return float(1.4826 * np.median(np.abs(z - np.median(z))))


def main(dirs, out):
    fields = {}
    for d in dirs:
        S, npass, ns, nx = quiet_band_means(d); fields[os.path.basename(d.rstrip('/'))] = (S, npass, ns, nx)
    zs = lambda s: [z for S, npass, _, _ in fields.values() for R in S.values() for z in C.pair_z(R, npass, s)]
    lo, hi = 0.0, 0.3
    if spread(zs(0.0)) <= 1: floor = 0.0
    else:
        for _ in range(40):
            mid = (lo + hi) / 2
            if spread(zs(mid)) > 1: lo = mid
            else: hi = mid
        floor = round(hi, 4)
    rep = dict(floor=floor, spread_at_floor=spread(zs(floor)), spread_without_floor=spread(zs(0.0)), pairs=len(zs(floor)),
               fraction_over_3_sigma_at_floor=float(np.mean(np.abs(zs(floor)) > 3)), fraction_over_3_sigma_without=float(np.mean(np.abs(zs(0.0)) > 3)),
               fields={k: dict(quiet_stars=ns, measured=len(S), passes=npass, exposures=nx, spread_at_floor=spread([z for R in S.values() for z in C.pair_z(R, npass, floor)])) for k, (S, npass, ns, nx) in fields.items()})
    json.dump(rep, open(out, 'w'), indent=1); print(json.dumps(rep, indent=1))


if __name__ == '__main__':
    main(sys.argv[1:-1], sys.argv[-1])
