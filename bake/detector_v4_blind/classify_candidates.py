"""Post-run classification of the blind test's baseline candidates (never fed back into the detector). For each candidate:
cross-match (6 arcsec at MJD 61000; motion within 20% and 15 deg where the catalogue has one) against the UltracoolSheet
snapshot, the field's SIMBAD and Gaia snapshots; a stamp of the four pass stacks along the fitted track; the frozen
plot (astrometry and spectrum). -> candidates.json and PNGs in <out>/candidates/"""
import sys, os, json, csv, pickle, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); BAKE = os.path.dirname(HERE); sys.path.insert(0, BAKE)
import run_blind as RB, detector_v4_eval as E, detector_v3_fetch as F
os.environ['DET_V4_OUT'] = RB.OUT
import detector_v4 as D
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
fl = E.fl

def at61000(ra, dec, pmra, pmdec, mjd0):
    dt = (61000.0 - mjd0) / 365.25; return ra + pmra * dt / 3600 / np.cos(np.radians(dec)), dec + pmdec * dt / 3600

def main():
    S = json.load(open(RB.OUT + '/summary.json')); od = RB.OUT + '/candidates'; os.makedirs(od, exist_ok=True); res = []
    UC = [r for r in csv.DictReader(open(F.CACHE + '/ucs/UltracoolSheet-Main.csv')) if r['ra_20250703_formula'] not in ('', 'NaN')]
    for c in S['candidates']:
        n = c['field']; d = f'{RB.CACHE}/{n}'; m = dict(c); m['matches'] = []
        for r in UC:
            if abs(fl(r['dec_20250703_formula']) - c['dec']) > 0.01: continue
            pe, pn = fl(r['pmra_formula']) / 1000, fl(r['pmdec_formula']) / 1000; a, dd = at61000(fl(r['ra_20250703_formula']), fl(r['dec_20250703_formula']), pe if np.isfinite(pe) else 0, pn if np.isfinite(pn) else 0, 60859.0)
            s = E.sep_as(c['ra'], c['dec'], a, dd)
            if s <= 6: m['matches'].append(dict(cat='UltracoolSheet', name=r['name'], spt=r['spt_ir'] or r['spt_opt'], sep=s, motion_ok=bool(np.isfinite(pe) and E.motion_ok(c['pm_e'], c['pm_n'], pe, pn)[0])))
        for r in csv.DictReader(open(d + '/simbad.csv')):
            pe, pn = fl(r['pmra']) / 1000, fl(r['pmdec']) / 1000; a, dd = at61000(fl(r['ra']), fl(r['dec']), pe if np.isfinite(pe) else 0, pn if np.isfinite(pn) else 0, 51544.5)
            s = E.sep_as(c['ra'], c['dec'], a, dd)
            if s <= 6: m['matches'].append(dict(cat='SIMBAD', name=r['main_id'], otype=r['otype'], spt=r['sp_type'], sep=s, motion_ok=bool(np.isfinite(pe) and E.motion_ok(c['pm_e'], c['pm_n'], pe, pn)[0])))
        for r in csv.DictReader(open(d + '/gaia.csv')):
            if abs(fl(r['dec']) - c['dec']) > 0.01: continue
            pe, pn = fl(r['pmra']) / 1000, fl(r['pmdec']) / 1000; a, dd = at61000(fl(r['ra']), fl(r['dec']), pe, pn, 57388.5); s = E.sep_as(c['ra'], c['dec'], a, dd)
            if s <= 6: m['matches'].append(dict(cat='Gaia DR3', name=r['source_id'], g=fl(r['phot_g_mean_mag']), bp_rp=fl(r['bp_rp']), sep=s, motion_ok=bool(E.motion_ok(c['pm_e'], c['pm_n'], pe, pn)[0])))
        # stamp: pass stacks along the fitted track
        o = json.load(open(f'{RB.RUNS}/base/{n}/out.json')); mv = next(q for q in o['movers'] if q['id'] == c['id']); A = pickle.load(open(f'{RB.OUT}/stageA/{D.cache_key(d)}.pkl', 'rb')); N = A['N']
        used = [j for j, p in enumerate(A['passes']) if p['used']]; fig, ax = plt.subplots(1, len(used), figsize=(3 * len(used), 3.2))
        for k, j in enumerate(used):
            p = A['passes'][j]; dt = (p['t'] - D.MJD_CW) / 365.25; x, y = mv['track'][0] + mv['track'][2] * dt, mv['track'][1] + mv['track'][3] * dt; u, v = D.to_px(p, N, x, y); ui, vi = int(round(float(u))), int(round(float(v))); h = 12
            cut = A['stacks'][j]['s'][max(vi - h, 0):vi + h + 1, max(ui - h, 0):ui + h + 1]; q = ax[k]; vmax = np.nanpercentile(cut, 99.5)
            q.imshow(cut, origin='lower', cmap='gray', vmin=-0.2 * vmax, vmax=vmax); q.plot(float(u) - max(ui - h, 0), float(v) - max(vi - h, 0), '+', color='#e33', ms=14); q.set_title(f"{p['year']:.2f}", fontsize=8); q.set_xticks([]); q.set_yticks([])
        fig.suptitle(f"{c['id']} {c['ra']:.5f} {c['dec']:+.5f}: 4.5 um pass stacks (77 arcsec, x east, y north), red + = fitted track", fontsize=8); fig.tight_layout(); fig.savefig(f"{od}/{c['id']}_stamps.png", dpi=110); plt.close(fig)
        m['plots'] = [f"{c['id']}_stamps.png"] + [os.path.basename(p_) for p_ in D.plot(f'{RB.RUNS}/base/{n}/out.json', od) if os.path.basename(p_).startswith(c['id'])]
        res.append(m); print(c['id'], [(x['cat'], x.get('name'), x.get('spt') or x.get('otype') or x.get('g'), round(x['sep'], 1), x['motion_ok']) for x in m['matches']], flush=True)
    json.dump(res, open(od + '/candidates.json', 'w'), indent=1, default=float)

if __name__ == '__main__':
    main()
