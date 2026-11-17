"""Blind purity test driver (design: design.py beside this file). Frozen detector v4 only.
  python -I run_blind.py base        frozen v4 on every fetched field (baseline)
  python -I run_blind.py plant       90 injected movers (evaluator writer) into copies of the fields
  python -I run_blind.py mov         frozen v4 on the planted copies
  python -I run_blind.py score       rate, candidates, completeness -> summary.json"""
import sys, os, json, csv, hashlib, subprocess, shutil, numpy as np
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__)); BAKE = os.path.dirname(HERE); sys.path.insert(0, BAKE)
import detector_v3_fetch as F
import detector_v4_eval as E
from scipy.stats import beta, chi2
OUT = os.environ.get('DET_BLIND_OUT', os.path.dirname(F.OUT) + '/detector-blind'); CACHE = OUT + '/cache'
FL = json.load(open(HERE + '/fields.json')); RUNS = OUT + '/runs'
SPEED, W2B, NPB = [0.3, 0.6, 1.2, 3.0], [11.5, 12.5, 13.5, 14.0], 10
FROZEN = '734dc40'

def fields():
    """The 7 per stratum actually used: kept fields whose fetch succeeded, then replacements in order."""
    out = []
    for s in sorted({f['stratum'] for f in FL['fields']}):
        ok = [f for f in FL['fields'] if f['stratum'] == s and os.path.exists(f"{CACHE}/{f['field']}/manifest.json")]
        out += ok[:7]
    return out
def check_frozen():
    r = subprocess.run(['git', '-C', BAKE, 'diff', '--quiet', FROZEN, 'HEAD', '--', 'detector_v4.py', 'detector_v4_templates.json', 'detector_v4_frozen.json'])
    s = subprocess.run(['git', '-C', BAKE, 'status', '--porcelain', '--', 'detector_v4.py', 'detector_v4_templates.json', 'detector_v4_frozen.json'], capture_output=True, text=True).stdout.strip()
    assert r.returncode == 0 and not s, 'detector files differ from the freeze'
def detect(src, out):
    if os.path.exists(out): return 0
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run([sys.executable, '-I', BAKE + '/detector_v4.py', 'run', src, out], capture_output=True, text=True, env=dict(os.environ, DET_V4_OUT=OUT))
    open(out.replace('.json', '.log'), 'w').write(f'rc {r.returncode}\n' + r.stdout + r.stderr); return r.returncode
def base():
    check_frozen()
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(lambda f: detect(f"{CACHE}/{f['field']}", f"{RUNS}/base/{f['field']}/out.json"), fields()))
    print('base return codes', rc)

def plant():
    rng = np.random.default_rng(int(hashlib.sha256(FL['plant_seed'].encode()).hexdigest()[:12], 16)); S = json.load(open(E.INJ_SPECTRA))
    FF = fields(); U = {f['field']: E.Usable(f"{RUNS}/base/{f['field']}/out.json") for f in FF}; CW = {n: E.read_csv(f'{CACHE}/{n}/catwise.csv') for n in U}
    P = {n: [] for n in U}; taken = {n: [] for n in U}; names = sorted(U); k = 0; rej = dict(usable=0, apart=0)
    for si in range(3):
        for wi in range(3):
            got = 0
            while got < NPB:
                n = names[k % len(names)]; k += 1; f = next(q for q in FF if q['field'] == n); half = F.SIZE * 1800 - E.EDGE
                x, y = rng.uniform(-half, half, 2); ra, dec = (float(v) for v in F.untan(x, y, f['ra'], f['dec']))
                if not U[n].at(ra, dec): rej['usable'] += 1; continue
                if any(E.sep_as(ra, dec, a, d) < E.APART for a, d in taken[n]): rej['apart'] += 1; continue
                mu = float(np.exp(rng.uniform(np.log(SPEED[si]), np.log(SPEED[si + 1])))); w2 = float(rng.uniform(W2B[wi], W2B[wi + 1])); pa = rng.uniform(0, 2 * np.pi)
                plx = 0.0 if rng.random() < 0.25 else float(rng.uniform(0, 0.25)); spec = (sorted(S['spectra'])[int(rng.integers(len(S['spectra'])))], float(rng.uniform(-0.3, 0.3)), float(np.exp(rng.uniform(np.log(0.5), np.log(2.0)))))
                _, m45, m33 = E.spectrum_fn(S, *spec); mjy = E.ZP_W2 * 1e3 * 10 ** (-0.4 * w2); w1 = -2.5 * np.log10(mjy * m33 / m45 / 1e3 / E.ZP_W1); pme, pmn = mu * np.sin(pa), mu * np.cos(pa)
                a15, d15 = (float(v[0]) for v in F.track(ra, dec, pme, pmn, 0.0, E.MJD_CW, E.MJD_REF))
                crowded = E.near_any(ra, dec, CW[n], 24.0, 'ra_pm', 'dec_pm', lambda r: E.fl(r['w2mpro_pm']) < w2 + 1.0)
                P[n].append(dict(kind='mover', id=f'{n}-p{len(P[n]) + 1:02d}', cid=len(P[n]), ra=ra, dec=dec, pme=float(pme), pmn=float(pmn), plx=plx, w2=w2, w1=float(w1), mjy45=float(mjy), spec=spec, cw=(a15, d15),
                                 blur=float(rng.uniform(0, E.BLUR_MAX)), speed_bin=si, w2_bin=wi, row=bool(rng.random() < E.P_ROW), crowd=False, brighter_row_within_24=bool(crowded)))
                taken[n].append((ra, dec)); got += 1
    def write(n):
        src = f'{CACHE}/{n}'; dst = f'{RUNS}/mov_inputs/{n}'; shutil.rmtree(dst, ignore_errors=True); Ex = json.load(open(src + '/exposures.json'))
        L = E.inject(src, dst, Ex, P[n]) if P[n] else []; rr = np.random.default_rng(int(hashlib.sha256((FL['plant_seed'] + n).encode()).hexdigest()[:12], 16))
        for m in P[n]: m['exposures_added'] = sum(l['cid'] == m['cid'] for l in L)
        rows = list(CW[n]) + [E.synth_row(rr, CW[n], *m['cw'], m['pme'], m['pmn'], m['w1'], m['w2']) for m in P[n] if m['row']]; rows.sort(key=lambda r: E.fl(r['dec']))
        os.makedirs(dst, exist_ok=True); E.write_csv(dst + '/catwise.csv', rows, list(CW[n][0].keys())); E.link_rest(src, dst, ('catwise.csv', 'exp') if P[n] else ('catwise.csv',))
        if not P[n] and not os.path.exists(dst + '/exp'): os.symlink(os.path.realpath(src + '/exp'), dst + '/exp')
        json.dump(P[n], open(f'{OUT}/truth/{n}.json', 'w'), indent=1); print(n, len(P[n]), 'plants', flush=True)
    os.makedirs(OUT + '/truth', exist_ok=True)
    with ThreadPoolExecutor(3) as ex: list(ex.map(write, names))
    json.dump(rej, open(OUT + '/truth/rejected.json', 'w'))
def mov():
    check_frozen()
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(lambda f: detect(f"{RUNS}/mov_inputs/{f['field']}", f"{RUNS}/mov/{f['field']}/out.json"), fields()))
    print('mov return codes', rc)

def ci90(k, n): return (float(beta.ppf(0.05, k, n - k + 1)) if k else 0.0, float(beta.ppf(0.95, k + 1, n - k)) if k < n else 1.0) if n else (0.0, 1.0)
def score():
    FF = fields(); area = 0.0; cands = []; per = {}; PL = []
    for f in FF:
        o = json.load(open(f"{RUNS}/base/{f['field']}/out.json")); a = o['usable']['area_sqdeg']; area += a
        per[f['field']] = dict(stratum=f['stratum'], l=f['l'], b=f['b'], area=a, candidates=len(o['candidates']), seeds=o['seeds'], movers=len(o['movers']), spectrum_stage=sum(m['stage'] == 'spectrum' for m in o['movers']), proposals=o['link'].get('proposals'),
                               gaia_rows=sum(1 for _ in open(f"{CACHE}/{f['field']}/gaia.csv")) - 1, catwise_rows=sum(1 for _ in open(f"{CACHE}/{f['field']}/catwise.csv")) - 1)
        cands += [dict(field=f['field'], id=c['id'], ra=c['ra'], dec=c['dec'], pm_e=c['pm_e'], pm_n=c['pm_n'], pm=c['pm'], w2=c['w2'], path=c['path'], dchi2=c['spectrum']['dchi2'], share=c['spectrum']['dwarf_share_45'], q=c['spectrum']['q_dwarf'], sn=c['spectrum']['sn'], phot=c.get('phot')) for c in o['candidates']]
        mp = f"{RUNS}/mov/{f['field']}/out.json"; T = json.load(open(f"{OUT}/truth/{f['field']}.json")) if os.path.exists(f"{OUT}/truth/{f['field']}.json") else []
        if T and os.path.exists(mp):
            om = json.load(open(mp)); mm = E.one_to_one(om['candidates'], T)
            for i, t in enumerate(T):
                c = om['candidates'][mm[i]] if i in mm else None; ok = bool(c and E.motion_ok(c['pm_e'], c['pm_n'], t['pme'], t['pmn'])[0]); mv = E.one_to_one(om['movers'], [t]) if not ok else {}
                PL.append(dict(id=t['id'], field=f['field'], stratum=f['stratum'], speed_bin=t['speed_bin'], w2_bin=t['w2_bin'], w2=t['w2'], row=t['row'], crowded=t['brighter_row_within_24'], found=ok, path=c.get('path') if c else None,
                               why='' if ok else ('candidate with wrong motion' if c else (f"{om['movers'][mv[0]]['stage']}, {om['movers'][mv[0]]['verdict']}" if 0 in mv else 'no mover record'))))
    k = len(cands); ub = float(chi2.ppf(0.95, 2 * (k + 1)) / 2 / area) if area else None
    grid = {f'{SPEED[s]}-{SPEED[s + 1]} x {W2B[w]}-{W2B[w + 1]}': f"{sum(p['found'] for p in PL if p['speed_bin'] == s and p['w2_bin'] == w)}/{sum(1 for p in PL if p['speed_bin'] == s and p['w2_bin'] == w)}" for s in range(3) for w in range(3)}
    sub = lambda sel: (sum(p['found'] for p in sel), len(sel), ci90(sum(p['found'] for p in sel), len(sel)))
    res = dict(frozen=FROZEN, fields=len(FF), area_sqdeg=area, candidates=cands, rate_per_sqdeg=k / area, rate_upper95=ub, per_field=per, completeness=dict(all=sub(PL), with_row=sub([p for p in PL if p['row']]), crowded=sub([p for p in PL if p['crowded']]),
               uncrowded=sub([p for p in PL if not p['crowded']]), by_stratum={s: sub([p for p in PL if p['stratum'] == s]) for s in sorted({p['stratum'] for p in PL})}, grid=grid), plants=PL)
    json.dump(res, open(OUT + '/summary.json', 'w'), indent=1, default=float)
    print(json.dumps({k_: v for k_, v in res.items() if k_ not in ('plants', 'per_field')}, indent=1, default=float)); [print(n, v) for n, v in per.items()]

if __name__ == '__main__':
    dict(base=base, plant=plant, mov=mov, score=score)[sys.argv[1]]()
