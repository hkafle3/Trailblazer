"""Evaluator for bake/detector.py: the five pass/fail checks of the detector plan, with the plan-review changes.
The thresholds below were fixed before any evaluation run and are never loosened; a miss is reported as a number.
Truth (planted movers, glitches, stationary controls) is drawn here with its own seed and written to truth_<field>.json;
the detector only ever sees pixels.
Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp --with matplotlib \
       python -I bake/detector_eval.py            (after `detector.py prep <field>` for each field)
"""
import sys, os, json, time, datetime, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector as d

CAP = 1.0            # check 4: unmatched candidates allowed per searchable square degree (frozen up front)
RECOVER = 0.80       # checks 1 and 3
SPEED, ANGLE = 0.10, 5.0
N_MOVERS, N_GLITCH, N_ATTACH, SEED = 60, 120, 8, 20261115
FLASH = dict(field='flash', obs='2026W01_2A_0524_3', ra=7.63355, dec=15.70797)   # the bright blob Ed saw in that exposure


def burst_ok(E, use):
    """Can the linker in principle join these usable exposures? Two bursts with 2+ photos each inside the link window."""
    bs = {}
    for i in use: bs.setdefault(E[i]['burst'], []).append(E[i]['t'])
    two = sorted(np.mean(v) for v in bs.values() if len(v) >= 2)
    return any(0 < (b - a) * 24 <= d.LINK_H for a in two for b in two)

def make_truth(field, E, P, mlim):
    rng = np.random.default_rng(SEED + sum(map(ord, field))); ra0, dec0 = d.FIELDS[field][1:3]; nb = max(e['burst'] for e in E) + 1
    def anchor():
        a = int(rng.integers(len(E))); ra, dec = E[a]['w'].all_pix2world(rng.uniform(100, 1940), rng.uniform(100, 1940), 0); return a, d.tan(float(ra), float(dec), ra0, dec0)
    def path(xi, eta, vx, vy, ta):
        out = []
        for i, e in enumerate(E):
            dt = (e['t'] - ta) * 24; ra, dec = d.untan(xi + vx * dt, eta + vy * dt, ra0, dec0); v, ins, x, y = d.sample(e, ra, dec)
            if ins[0]: out.append((i, float(x[0]), float(y[0]), bool(np.isfinite(v[0]))))
        return out
    movers = []
    while len(movers) < N_MOVERS:
        a, (xi, eta) = anchor(); rate = float(np.exp(rng.uniform(np.log(5), np.log(200)))); pa = float(rng.uniform(0, 360))
        pts = path(xi, eta, rate * np.sin(np.radians(pa)), rate * np.cos(np.radians(pa)), E[a]['t']); use = [p[0] for p in pts if p[3]]
        if len(use) < 3: continue
        base = (E[use[-1]]['t'] - E[use[0]]['t']) * 24
        if rate * base < 3 * d.PIX: continue                       # review item 6: total motion of at least 3 px
        m = float(rng.uniform(mlim - 3, mlim + 0.5))
        movers.append(dict(id=len(movers), rate=rate, pa=pa, mag=m, s=float(d.unmag(m)), pts=pts, n_use=len(use), baseline_h=base, linkable=burst_ok(E, use)))
    stat = []
    for kind in ['const'] * 10 + ['variable'] * 10 + ['flare'] * 5:
        a, (xi, eta) = anchor(); pts = path(xi, eta, 0, 0, E[a]['t']); m = float(rng.uniform(mlim - 3, mlim - 0.5))
        f = np.ones(nb) if kind == 'const' else np.exp(rng.normal(0, 1, nb)) if kind == 'variable' else (np.arange(nb) == E[a]['burst']).astype(float)
        stat.append(dict(id=len(stat), kind=kind, mag=m, s=float(d.unmag(m)), pts=pts, factor=f.tolist()))
    gl = []
    for k in range(N_GLITCH):
        i = int(rng.integers(len(E))); snr = float(np.exp(rng.uniform(np.log(8), np.log(200))))
        gl.append(dict(id=k, i=i, x=float(rng.uniform(50, 1990)), y=float(rng.uniform(50, 1990)), kind=str(rng.choice(['pixel', 'blob', 'psf'])), snr=snr, s=snr * 3 * E[i]['sig'], flagged=bool(rng.random() < 0.5), attached=None))
    for m in [m for m in movers if m['linkable']][:N_ATTACH]:      # a glitch 2.5 px beside a real track, to see if it gets pulled in
        i, x, y, _ = [p for p in m['pts'] if p[3]][0]; th = rng.uniform(0, 2 * np.pi)
        gl.append(dict(id=len(gl), i=i, x=x + 2.5 * np.cos(th), y=y + 2.5 * np.sin(th), kind='psf', snr=None, s=m['s'] * float(rng.uniform(0.5, 2)), flagged=False, attached=m['id']))
    return dict(movers=movers, stat=stat, glitches=gl)

def injector(E, T, P):
    idx = {e['obs']: i for i, e in enumerate(E)}; per = {i: dict(P=P, psf=[], pix=[]) for i in range(len(E))}
    for m in T['movers']:
        for i, x, y, _ in m['pts']: per[i]['psf'].append((x, y, m['s']))
    for s in T['stat']:
        for i, x, y, _ in s['pts']:
            if s['factor'][E[i]['burst']] > 0: per[i]['psf'].append((x, y, s['s'] * s['factor'][E[i]['burst']]))
    for g in T['glitches']: per[g['i']]['pix'].append((g['x'], g['y'], g['s'], g['kind'], g['flagged']))
    return lambda e: per[idx[e['obs']]]

def area(E):
    """Searchable square degrees: sky seen by 2+ photos in each of two bursts inside the link window (2 arcmin cells)."""
    c = np.array([e['w'].wcs.crval for e in E]); g = np.arange(-5, 5, 1 / 30); ra0, dec0 = c.mean(0)
    X, Y = np.meshgrid(g, g); ra, dec = d.untan(X.ravel() * 3600, Y.ravel() * 3600, ra0, dec0); nb = max(e['burst'] for e in E) + 1; cnt = np.zeros((nb, len(ra)), int)
    for e in E: cnt[e['burst']] += np.isfinite(d.sample(e, ra, dec)[0])
    tb = np.array([np.mean([e['t'] for e in E if e['burst'] == b]) for b in range(nb)]); ok = np.zeros(len(ra), bool)
    for a in range(nb):
        for b in range(a + 1, nb):
            if (tb[b] - tb[a]) * 24 <= d.LINK_H: ok |= (cnt[a] >= 2) & (cnt[b] >= 2)
    return float(ok.sum() / 900)

def nearest(D, i, x, y, r=1.5):
    k = np.nonzero(D['e'] == i)[0]; dd = np.hypot(D['x'][k] - x, D['y'][k] - y)
    return (int(k[np.argmin(dd)]) if len(k) and dd.min() <= r else None)

def evaluate(field):
    out = dict(field=field); E, D, K, X, tracks = d.run(field)            # baseline, real data only; expected list is frozen inside run()
    C = json.load(open(f'{d.OUT}/candidates_{field}.json')); mlim = C['depth_ab']; P = np.load(f'{d.CACHE}/{field}/psf.npy')
    # check 1
    elig = [o['name'] for o in X if o['eligible']]; got = {k['known'] for k in tracks if k['known']}
    excl = {}
    for o in X: excl[o['excluded'] or 'eligible'] = excl.get(o['excluded'] or 'eligible', 0) + 1
    out['check1'] = dict(expected=len(elig), recovered=sum(n in got for n in elig), missed=[n for n in elig if n not in got], skybot_objects=len(X), breakdown=excl,
                         also_recovered_not_on_list=sorted(got - set(elig)))
    # check 4
    A = area(E); un = [k for k in tracks if not k['known']]
    out['check4'] = dict(unmatched=len(un), area_sqdeg=A, per_sqdeg=len(un) / A if A else None, cap=CAP, shuffled_time_tracks=C['shuffled_time']['tracks'])
    # Ed's flash: did it enter the data, and where was it rejected
    if field == FLASH['field']:
        i = [e['obs'] for e in E].index(FLASH['obs']); k = np.nonzero(D['e'] == i)[0]
        r = np.hypot((D['ra'][k] - FLASH['ra']) * np.cos(np.radians(FLASH['dec'])), D['dec'][k] - FLASH['dec']) * 3600; j = k[np.argmin(r)]
        out['flash'] = dict(detected=bool(r.min() < 20), sep_arcsec=float(r.min()), snr=float(D['snr'][j]), sharp=float(D['sharp'][j]), rejected_as=D['why'][j] or 'not rejected (orphan)',
                            flag_bits=[b for b in range(31) if int(D['flags'][j]) >> b & 1], in_a_track=any(int(j) in t['idx'] for t in tracks), index=int(j))
    # injected run
    T = make_truth(field, E, P, mlim); json.dump(T, open(f'{d.OUT}/truth_{field}.json', 'w'))
    E2, D2 = d.detect(field, injector(E, T, P)); tr2, st2 = d.link(E2, D2, field)
    lab = {}                                                               # detection index -> truth item
    for m in T['movers']:
        for i, x, y, _ in m['pts']:
            q = nearest(D2, i, x, y)
            if q is not None: lab[q] = ('mover', m['id'])
    for s in T['stat']:
        for i, x, y, _ in s['pts']:
            q = nearest(D2, i, x, y)
            if q is not None and s['factor'][E[i]['burst']] > 0: lab[q] = ('stat', s['id'])
    gfate = {}
    for g in T['glitches']:
        q = nearest(D2, g['i'], g['x'], g['y']); key = ('attached ' if g['attached'] is not None else '') + ('flagged ' if g['flagged'] else 'unflagged ') + g['kind']
        gfate.setdefault(key, {}); w = 'not detected' if q is None else (D2['why'][q] or 'orphan'); gfate[key][w] = gfate[key].get(w, 0) + 1
        if q is not None: lab[q] = ('glitch', g['id'])
    res = {}; glitch_in = 0; stat_in = 0; attach_pulled = 0; cand2 = 0
    for k in tr2:
        k['known'] = d.match_known(k, D2, K, E2); ls = [lab.get(q) for q in k['idx']]; mv = [l[1] for l in ls if l and l[0] == 'mover']
        if not k['known']:
            cand2 += 1; stat_in += sum(1 for l in ls if l and l[0] == 'stat') >= 2
            if any(l and l[0] == 'glitch' for l in ls): glitch_in += len(mv) < 3; attach_pulled += len(mv) >= 3
        if mv:
            m = max(set(mv), key=mv.count)
            if mv.count(m) >= 3 and (m not in res or k['n'] > res[m]['n']): res[m] = k
    rows = []; crowd = lambda m: np.mean([np.any((D2['e'] == i) & (D2['why'] == 'star') & (np.hypot(D2['x'] - x, D2['y'] - y) < 5) & (np.hypot(D2['x'] - x, D2['y'] - y) > 1.5)) for i, x, y, u in m['pts'] if u]) >= 0.34
    for m in T['movers']:
        k = res.get(m['id']); r = dict(id=m['id'], rate=m['rate'], mag=m['mag'], above_limit=m['mag'] <= mlim, baseline_h=m['baseline_h'], linkable=m['linkable'], n_use=m['n_use'], crowded=bool(crowd(m)), found=k is not None)
        ft = {}
        for i, x, y, u in m['pts']:
            if u: q = nearest(D2, i, x, y); w = f"b{E[i]['burst']}:" + ('miss' if q is None else (D2['why'][q] or 'ok')); ft[w] = ft.get(w, 0) + 1
        r['fate'] = ft
        if k:
            r['track'] = dict(n=k['n'], n_total=k['n_total'], bursts=k['bursts'], rate=k['rate'], span_h=k['span_h'], rms=k['rms'])
            da = abs((k['pa'] - m['pa'] + 180) % 360 - 180); r.update(speed_err=abs(k['rate'] - m['rate']) / m['rate'], angle_err=da); r['good'] = r['speed_err'] <= SPEED and da <= ANGLE
        rows.append(r)
    ab = [r for r in rows if r['above_limit']]; frac = lambda q: (sum(1 for r in q if r.get('good')), sum(1 for r in q if r['found']), len(q))
    bins = {}
    for name, f in [('rate 5-20', lambda r: r['rate'] < 20), ('rate 20-60', lambda r: 20 <= r['rate'] < 60), ('rate 60-200', lambda r: r['rate'] >= 60),
                    ('bright (1.5+ mag above limit)', lambda r: r['mag'] <= mlim - 1.5), ('within 1.5 mag of limit', lambda r: r['mag'] > mlim - 1.5),
                    ('baseline under 1 h', lambda r: r['baseline_h'] < 1), ('baseline 1-96 h', lambda r: 1 <= r['baseline_h'] <= 96), ('baseline over 96 h', lambda r: r['baseline_h'] > 96),
                    ('linkable (2 bursts of 2+ photos within 96 h)', lambda r: r['linkable']), ('not linkable', lambda r: not r['linkable']),
                    ('isolated', lambda r: not r['crowded']), ('crowded', lambda r: r['crowded'])]:
        bins[name] = frac([r for r in ab if f(r)])
    out['check3'] = dict(planted=len(rows), above_limit=len(ab), good_found_total=frac(ab), below_limit=frac([r for r in rows if not r['above_limit']]), bins=bins, rows=rows)
    sfate = {}
    for s in T['stat']:
        for i, x, y, u in s['pts']:
            q = nearest(D2, i, x, y)
            if u and s['factor'][E[i]['burst']] > 0: sfate.setdefault(s['kind'], {}); w = 'not detected' if q is None else (D2['why'][q] or 'orphan'); sfate[s['kind']][w] = sfate[s['kind']].get(w, 0) + 1
    out['check2'] = dict(glitches=len(T['glitches']), candidate_tracks_with_a_glitch=int(glitch_in), mover_tracks_that_pulled_in_a_glitch=int(attach_pulled), fate=gfate)
    out['check5'] = dict(controls=len(T['stat']), candidate_tracks_on_a_stationary_control=int(stat_in), fate=sfate,
                         baseline_candidates_below_min_motion=sum(1 for k in un if k['rate'] * k['span_h'] < d.MOVE_MIN))
    out['injected_run'] = dict(stage=st2, candidate_tracks=cand2, tracks_with_no_planted_or_known=sum(1 for k in tr2 if not k['known'] and not any(lab.get(q) for q in k['idx'])))
    out['stage_counts'] = C['stage_counts']; out['depth_ab'] = mlim; out['exposures'] = len(E); out['bursts'] = C['bursts']
    return out, (E, D, K, X, tracks)

def ui_json(allr, summ):
    """web/data/candidates.json for the UI: real tracks plus a few rejected detections as proof. No planted fakes."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); os.makedirs(f'{root}/web/data/candidates', exist_ok=True); cands = []; n = 0
    def add(field, verdict, dets, track, checks, score, name, strip_from=None, make=None):
        nonlocal n; n += 1; cid = f'K-{n:04d}'; dst = f'{root}/web/data/candidates/{cid}.png'
        if strip_from: os.replace(strip_from, dst) if False else open(dst, 'wb').write(open(strip_from, 'rb').read())
        else: checks['other_detector'] = (lambda v: None if v is None else bool(v >= 3))(make(dst))
        cands.append(dict(id=cid, score=score, verdict=verdict, known_name=name, detections=dets, track=track, checks=checks, strip=f'data/candidates/{cid}.png', region=d.FIELDS[field][0]))
    for field, (E, D, K, X, tracks) in allr.items():
        for k in tracks:
            add(field, 'known' if k['known'] else 'worth_reporting', [{q: v for q, v in x.items() if q != 'flags'} for x in k['detections']],
                dict(rate_arcsec_hr=round(k['rate'], 1), pa_deg=round(k['pa'], 1), rms_arcsec=round(k['rms'], 2), distance_guess=d.guess(k['rate'])),
                dict(n_photos=k['n'], n_total=k['n_total'], other_detector=None if k['d4'] is None else bool(k['d4'] >= 3), flagged=False, skybot_match=bool(k['known'])), k['score'], k['known'], strip_from=f"{d.OUT}/strips/{k['id']}.png")
        picks = []
        if field == FLASH['field'] and 'flash' in summ[field]: picks.append((summ[field]['flash']['index'], 'glitch'))
        rng = np.random.default_rng(3)
        for why, verdict, lo, hi in (('flag', 'glitch', 15, 300), ('shape', 'glitch', 10, 300), ('star', 'star', 20, 200)):
            k = np.nonzero((D['why'] == why) & (D['snr'] > lo) & (D['snr'] < hi) & ((why != 'flag') | ((D['flags'] & 1) > 0)) & ((why != 'shape') | (D['sharp'] > d.SHARP_MAX)))[0]   # flag: TRANSIENT; shape: single-pixel hits only
            picks += [(int(q), verdict) for q in rng.choice(k, min(1, len(k)), replace=False)]
        for q, verdict in picks:
            i = int(D['e'][q]); det = dict(t=float(D['t'][q]), ra=float(D['ra'][q]), dec=float(D['dec'][q]), det='D1', flux_mjy=float(D['s'][q] * d.JY * 1e3), snr=float(D['snr'][q]), obs=E[i]['obs'])
            looks = int(sum(d.sample(e, det['ra'], det['dec'])[1][0] for e in E))
            add(field, verdict, [det], dict(rate_arcsec_hr=0, pa_deg=None, rms_arcsec=None, distance_guess=None),
                dict(n_photos=1, n_total=looks, other_detector=None, flagged=bool(D['why'][q] == 'flag'), skybot_match=False, rejected_as=str(D['why'][q])), 0.0, None,
                make=lambda dst, i=i, det=det, q=q: d.spot_strip(dst, f"{verdict}: rejected as '{D['why'][q]}'  SNR {det['snr']:.0f}  {E[i]['obs']}", E, field, det['ra'], det['dec'], i))
    c3 = [sum(summ[f]['check3']['good_found_total'][j] for f in summ) for j in (0, 2)]
    json.dump(dict(generated=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), detector_version=d.VERSION,
                   regions=[dict(name=d.FIELDS[f][0], ra=d.FIELDS[f][1], dec=d.FIELDS[f][2], radius_deg=2.5) for f in allr],
                   validation=dict(known_recovered=sum(summ[f]['check1']['recovered'] for f in summ), known_expected=sum(summ[f]['check1']['expected'] for f in summ),
                                   planted_found=round(c3[0] / c3[1], 3) if c3[1] else None, false_per_sqdeg=round(sum(summ[f]['check4']['unmatched'] for f in summ) / sum(summ[f]['check4']['area_sqdeg'] for f in summ), 3)),
                   candidates=cands), open(f'{root}/web/data/candidates.json', 'w'), indent=1)
    return len(cands)

if __name__ == '__main__':
    fields = sys.argv[1:] or list(d.FIELDS); summ, allr = {}, {}
    for f in fields:
        t0 = time.time(); summ[f], allr[f] = evaluate(f); print(f, 'evaluated in', round(time.time() - t0), 's')
    tot = lambda c, j: sum(summ[f][c][j] for f in summ)
    e1, r1 = tot('check1', 'expected'), tot('check1', 'recovered'); g = [sum(summ[f]['check3']['good_found_total'][j] for f in summ) for j in range(3)]
    burden = tot('check4', 'unmatched') / sum(summ[f]['check4']['area_sqdeg'] for f in summ); fl = summ.get('flash', {}).get('flash')
    checks = {
        '1 known asteroids recovered': dict(value=f'{r1} of {e1}' + (f' ({r1 / e1:.0%})' if e1 else ''), passed=None if e1 == 0 else bool(r1 / e1 >= RECOVER and r1 >= 1), bar='>= 80%, at least one'),
        '2 flash and planted glitches in candidates': dict(value=f"{tot('check2', 'candidate_tracks_with_a_glitch')} glitch-made tracks and {tot('check2', 'mover_tracks_that_pulled_in_a_glitch')} planted-mover tracks that pulled a glitch in, of {tot('check2', 'glitches')} planted; flash {'rejected as ' + fl['rejected_as'] if fl and fl['detected'] else 'NOT SEEN'}",
                                                         passed=bool(tot('check2', 'candidate_tracks_with_a_glitch') + tot('check2', 'mover_tracks_that_pulled_in_a_glitch') == 0 and fl and fl['detected'] and not fl['in_a_track'] and fl['rejected_as'] in ('flag', 'shape', 'persist')), bar='0, and the flash rejected at the glitch stage'),
        '3 planted movers found with right speed and direction': dict(value=f'{g[0]} of {g[2]} above the limit ({g[0] / max(g[2], 1):.0%}); found at all {g[1]}', passed=bool(g[2] > 0 and g[0] > 0 and g[0] / g[2] >= RECOVER), bar='>= 80%, speed within 10%, direction within 5 deg'),
        '4 unmatched-candidate burden': dict(value=f"{tot('check4', 'unmatched')} in {sum(summ[f]['check4']['area_sqdeg'] for f in summ):.1f} sq deg = {burden:.2f} per sq deg; shuffled-time tracks {tot('check4', 'shuffled_time_tracks')}", passed=bool(burden < CAP), bar=f'< {CAP} per searchable sq deg'),
        '5 stationary sources as candidates': dict(value=f"{tot('check5', 'candidate_tracks_on_a_stationary_control')} of {tot('check5', 'controls')} controls; {tot('check5', 'baseline_candidates_below_min_motion')} real candidates under the motion floor",
                                                    passed=bool(tot('check5', 'candidate_tracks_on_a_stationary_control') == 0 and tot('check5', 'baseline_candidates_below_min_motion') == 0), bar='0'),
    }
    json.dump(dict(checks=checks, fields=summ, cap=CAP, version=d.VERSION), open(f'{d.OUT}/eval_summary.json', 'w'), indent=1, default=str)
    nui = ui_json(allr, summ)
    for k, v in checks.items(): print(('PASS' if v['passed'] else 'NOT TESTED' if v['passed'] is None else 'FAIL'), '|', k, '|', v['value'], '| bar:', v['bar'])
    print('ui candidates', nui)
