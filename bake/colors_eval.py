"""Colors evaluator, science part (plan.md E1 and E3), on the reference (bake/colors_ref.py). Thresholds fixed in plan.md
before the reference first ran; a miss is reported, never retuned.
  E1  C-0176 against lead-check/data/spec_L1.json: T in 650..710 K, b within 10% of 2.75 mJy, aS within 2% of 1.043,
      D5 and D6 excess within 0.10 of +0.70 and +0.99, star-only chi2/dof >= 5, star + dust <= 1.5, verdicts as report.md
      (rise seen, no spikes, no dips, no seam jumps).
  E3  C-0175: rise "inconclusive: too bright, saturated in N of M exposures". The SPOT2 quiet star (frozen rule: 2MASS AAA,
      Ks 10 to 12, isolated, not variable, nearest the field centre with at least 12 comparisons): every fingerprint not
      seen, temperature "no dust to measure".
Run: python -I bake/colors_eval.py <fields_dir> <out_dir>      (fields_dir/L1, C0175, SPOT2: colors_ref field directories)
"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import colors_ref as C
from scipy.spatial import cKDTree

C0176, C0175 = (84.0181, -6.577), (76.9563, 30.4013)


def e1(res):
    f = res['fits']['all']; ex = res['excess_by_detector']; fp = res['fingerprints']
    chk = {'T in 650..710 K': 650 <= f['T'] <= 710, 'b within 10% of 2.75 mJy': abs(f['b'] / 2.75 - 1) <= 0.10, 'aS within 2% of 1.043': abs(res['aS'] / 1.043 - 1) <= 0.02,
           'D5 excess within 0.10 of +0.70': abs(ex['D5']['mean'] - 0.70) <= 0.10, 'D6 excess within 0.10 of +0.99': abs(ex['D6']['mean'] - 0.99) <= 0.10,
           'star-only chi2/dof >= 5': f['chi2_star'] / f['dof_star'] >= 5, 'star + dust chi2/dof <= 1.5': f['chi2_star_dust'] / f['dof_star_dust'] <= 1.5,
           'rise seen': fp['rise']['verdict'] == 'seen', 'spikes not seen': fp['spike']['verdict'] == 'not seen', 'dips not seen': fp['dip']['verdict'] == 'not seen', 'seams not seen': fp['seam']['verdict'] == 'not seen'}
    nums = dict(T=f['T'], T_1sigma=f['T_1sigma'], b=round(f['b'], 3), aS=round(res['aS'], 4), D5=round(ex['D5']['mean'], 3), D6=round(ex['D6']['mean'], 3),
                chi2_star_per_dof=round(f['chi2_star'] / f['dof_star'], 2), chi2_dust_per_dof=round(f['chi2_star_dust'] / f['dof_star_dust'], 2), n_comp=res['comparisons']['n'])
    return chk, nums


def quiet_candidates(d):
    """SPOT2's quiet star, frozen rule: 2MASS AAA, Ks 10 to 12, one component, no CatWISE neighbour within 15 arcsec less than
    2.5 mag fainter, no Gaia VARIABLE within 5 arcsec, nearest the field centre first."""
    cats = C.load_field(d); K = C.components(cats['catwise'], cats['allwise'], cats['gaia']); fld = json.load(open(f'{d}/field.json')) if os.path.exists(f'{d}/field.json') else None
    ra0, dec0 = C.ra_mean(K['ra']), K['dec'].mean(); kx, ky = C.tan(K['ra'], K['dec'], ra0, dec0); TM = cats['twomass']
    tx, ty = C.tan([C.fl(r['ra']) for r in TM], [C.fl(r['dec']) for r in TM], ra0, dec0); dd, j = cKDTree(np.c_[tx, ty]).query(np.c_[kx, ky])
    w1 = np.nan_to_num(K['w1'], nan=99); tr = cKDTree(np.c_[kx, ky]); GV = [r for r in cats['gaia'] if r['phot_variable_flag'] == 'VARIABLE']
    vx, vy = C.tan([C.fl(r['ra']) for r in GV], [C.fl(r['dec']) for r in GV], ra0, dec0) if GV else ([], [])
    vt = cKDTree(np.c_[vx, vy]) if GV else None; out = []
    cx, cy = (fld['ra'], fld['dec']) if fld else (ra0, dec0)
    for i in range(len(K['ra'])):
        if dd[i] >= 2 or TM[j[i]]['ph_qual'] != 'AAA' or not 10 <= C.fl(TM[j[i]]['k_m']) <= 12 or K['nmem'][i] != 1: continue
        if any(w1[q] < w1[i] + 2.5 for q in tr.query_ball_point([kx[i], ky[i]], 15.0) if q != i): continue
        if vt is not None and vt.query([kx[i], ky[i]])[0] < 5: continue
        out.append((float(C.sep_as(K['ra'][i], K['dec'][i], cx, cy)), float(K['ra'][i]), float(K['dec'][i]), str(K['name'][i])))
    return sorted(out)


def main(fields, out):
    os.makedirs(out, exist_ok=True); report = {}; ok = True
    res = C.run(f'{fields}/L1', *C0176); json.dump(res, open(f'{out}/L1.json', 'w'), indent=1)
    chk, nums = e1(res); report['E1'] = dict(checks=chk, numbers=nums); ok &= all(chk.values())
    res = C.run(f'{fields}/C0175', *C0175); json.dump(res, open(f'{out}/C0175.json', 'w'), indent=1)
    rise = res.get('fingerprints', {}).get('rise', {})
    c = {'C-0175 rise inconclusive, too bright': rise.get('verdict') == 'inconclusive' and rise.get('reason', '').startswith('too bright, saturated in ')}
    report['E3 C-0175'] = dict(checks=c, rise=rise, saturation=res.get('saturation')); ok &= all(c.values())
    picked = None
    for sep, ra, dec, name in quiet_candidates(f'{fields}/SPOT2')[:6]:
        res = C.run(f'{fields}/SPOT2', ra, dec)
        if res.get('comparisons', {}).get('n', 0) >= C.MIN_COMP: picked = (name, ra, dec, sep); break
    if picked is None: c = {'quiet star found': False}
    else:
        json.dump(res, open(f'{out}/SPOT2.json', 'w'), indent=1); fp = res['fingerprints']
        c = {f'{k} not seen': fp[k]['verdict'] == 'not seen' for k in ('rise', 'spike', 'dip', 'seam')}
        c['temperature: no dust to measure'] = fp['temperature']['verdict'] == 'not seen' and fp['temperature']['reason'] == 'no dust to measure'
    report['E3 quiet star'] = dict(checks=c, star=picked, fingerprints=res.get('fingerprints') if picked else None, fit=res.get('fits', {}).get('all') if picked else None); ok &= all(c.values())
    report['pass'] = bool(ok)
    json.dump(report, open(f'{out}/eval.json', 'w'), indent=1, default=str)
    for k, v in report.items():
        if k == 'pass': continue
        print(k, {n: 'PASS' if p else 'FAIL' for n, p in v['checks'].items()}, v.get('numbers', ''))
    print('PASS' if ok else 'FAIL')
    return ok


if __name__ == '__main__':
    sys.exit(0 if main(sys.argv[1], sys.argv[2]) else 1)
