"""Development (v4): classifier variants on cached samples (detector-v4/tmp/samples/*.pkl).
usage: reclass4.py <variant json> [...]   e.g. '{"COMMON_ERR": false, "DWARF_USE": [...]}'
Per variant: plant and crowd-plant cold fraction by W2 bin at the spectrum stage, real dwarf and M-dwarf targets, and the
impostor margin (dchi2, the methane evidence, cut D_MIN) distribution and verdicts for random Gaia stars, no-Gaia static
sources (galaxies/AGN), crowded no-Gaia sources and non-plant movers."""
import sys, glob, json, pickle, numpy as np
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad'
sys.path.insert(0, S + '/wt-detector-v4/bake'); import detector_v4 as D, detector_v4_eval as E
TR = {p['id']: p for f in glob.glob(E.TRUTH + '/dev/*.json') for p in json.load(open(f))['movers']}
data = [(f.split('/')[-1][:-4], pickle.load(open(f, 'rb'))) for f in sorted(glob.glob(S + '/detector-v4/tmp/samples/*.pkl'))]
W2B = [11.5, 12.5, 13.5, 14.0, 14.5, 15.0, 15.5]
DEF = {k: getattr(D, k) for k in ('COMMON_ERR', 'PSF_SYS', 'Q_MAX', 'CAL_FLOOR', 'D_MIN', 'SHARE_MIN', 'DWARF_USE')}
def run(var):
    for k, v in DEF.items(): setattr(D, k, v)
    for k, v in json.loads(var).items(): setattr(D, k, v)
    D._T.clear(); out = {}
    for name, z in data:
        for it in z['items']: out.setdefault(it['kind'], []).append((name, it['label'], it['w2'], D.classify(it['sm'], z['pt'])))
    print('===', var)
    for kind in ('plant', 'crowdplant'):
        byb = {}
        for name, lab, w2, c in out.get(kind, []): byb.setdefault(int(np.digitize(TR[lab]['w2'], W2B) - 1), []).append(c['verdict'] == 'cold')
        print(f' {kind} cold at spectrum stage by W2 bin:', {f'{W2B[b]}-{W2B[b + 1]}': f'{sum(v)}/{len(v)}' for b, v in sorted(byb.items())})
        print('   failures W2<14:', [(lab, round(TR[lab]['w2'], 2), c['verdict'], round(c.get('dchi2', np.nan)), round(c.get('q_dwarf', np.nan), 1), round(c.get('dwarf_share_45', np.nan), 2)) for name, lab, w2, c in out.get(kind, []) if c['verdict'] != 'cold' and TR[lab]['w2'] < 14.0])
    for k in ('target_dwarf', 'target_mdwarf'):
        for name, lab, w2, c in out.get(k, []): print(f'  {k:14s} {lab:30s} {c["verdict"]:12s} dchi2 {c.get("dchi2", np.nan):9.0f} q {c.get("q_dwarf", np.nan):5.1f} share {c.get("dwarf_share_45", np.nan):5.2f} sn {c.get("sn", np.nan):6.0f}')
    for k in ('star', 'nogaia', 'crowded_nogaia', 'crowded_nogaia_psf', 'mover'):
        v = out.get(k, []); dc = np.array([c.get('dchi2', np.nan) for *_, c in v]); vs = [c['verdict'] for *_, c in v]; fin = dc[np.isfinite(dc)]
        sh = np.array([c.get('dwarf_share_45', np.nan) for *_, c in v])
        print(f'  {k:15s} n {len(v)} verdicts', {q: vs.count(q) for q in sorted(set(vs))}, 'dchi2 top5', np.sort(fin)[-5:].round(0).tolist(), 'of those with share>=0.5:', np.sort(dc[np.isfinite(dc) & (sh >= 0.5)])[-3:].round(0).tolist())
for v in sys.argv[1:]: run(v)
