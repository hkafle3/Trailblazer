"""Held-out test of the 4 sigma motion bar for bake/detector_cold.py. Frozen in its own commit before any new patch was searched.

Why: at the shipped 5 sigma bar WISE 0855 is missed (4.1 sigma); at 4 sigma it is found, but that was seen after the
fact. This test asks whether 4 sigma holds on targets the detector has never been run on. Only DET_COLD_SIG changes (5 -> 4).

Target rule (written before choosing): spectral type T6 or later, or Y; published proper motion at least 2.5 arcsec/yr;
W2 at most 13.5 Vega; |galactic latitude| > 10; no star brighter than about 4 mag within 0.5 deg; at least two SPHEREx
passes 0.4 yr apart; not WISE 0855 or Epsilon Indi B.
Source of the list: SIMBAD (Harvard mirror, 2026-11-15), every object with sp_type T5 to T9, sdT or Y and total proper
motion >= 2500 mas/yr. Five rows came back:
  2MASS J02540788+0223563  T8    2.60 arcsec/yr  W2 about 12.7   -> IN  (= WISEPA J025409.45+022359.1)
  2MASS J11145133-2618235  T7.5  2.95 arcsec/yr  W2 about 12.2   -> IN
  WISEA J085510.74-071442.5                                      -> out, excluded by name
  WISE J163940.83-684738.6 Y0pec 3.16 arcsec/yr  W2 13.54        -> out, fainter than W2 13.5
  SCR J1845-6357B          T6    2.54 arcsec/yr                  -> out, 1 arcsec from its M8.5 primary: no W2 of its own
W2 values are AllWISE numbers quoted from memory (CDS VizieR was down); both kept targets are 0.8 mag or more inside the
limit. Kirkpatrick et al. 2021 (20 pc census) lists the same two with the same motions to within 5%.
Positions are SIMBAD's (2MASS, epoch about 1999.5) moved to 2026.0 with SIMBAD's proper motions.

Bars, unchanged from detector_cold_eval.py: top 5, methane colour, speed within 30%, direction within 30 degrees; at most
1.0 unmatched candidates per square degree (reported for the new patches and for all six); 0 on Ed's flash; 0 on planted
glitches. One run. No threshold changes after it.
Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp --with matplotlib \
       python -I bake/detector_cold_heldout.py
"""
import os, sys, json, numpy as np
os.environ['DET_COLD_SIG'] = '4'
os.environ['DET_COLD_OUT'] = os.environ.get('DET_COLD_HELDOUT', '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector-cold/heldout')   # holds a link named cache to the shared cache
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_cold as d, detector_cold_eval as ev

def at2026(ra, dec, pmra, pmdec, epoch=1999.5):
    dt = 2026.0 - epoch; return dict(ra=ra + pmra * dt / 3600 / np.cos(np.radians(dec)), dec=dec + pmdec * dt / 3600, pm=(pmra, pmdec))
NEW = {  # patch: (label, centre ra, dec), target. Each target is about 0.17 deg from its patch centre.
    'crater': (('Hydra south patch', 168.84, -26.21), dict(name='2MASS J1114-2618', **at2026(168.713905, -26.306545, -2.9272, -0.3742))),
    'cetus': (('Cetus patch', 43.42, 2.51), dict(name='WISE 0254+0223', **at2026(43.53286, 2.398985, 2.578, 0.309))),
}

def main():
    assert d.SIG_MIN == 4.0
    R, rows = {}, []; truth = dict(ev.TRUTH, **{n: t for n, (_, t) in NEW.items()})
    for name, (label, ra, dec) in {**{n: p for n, (p, _) in NEW.items()}, **ev.PATCHES}.items():
        if not os.path.exists(f'{d.CACHE}/{name}/patch.json'): d.prep(name, ra, dec, ev.SIZE, label)
        R[name] = d.run(name)
    bar = f'top {ev.TOP}, methane colour, speed within {ev.SPEED:.0%}, direction within {ev.ANGLE:.0f} deg'
    for name, t in truth.items():
        c = R[name]['candidates']; hit = [(i, m) for i, m in enumerate(c) if ev.sep(m, t) <= ev.MATCH]; held = 'held-out' if name in NEW else 'seen before, not held-out'
        if hit:
            i, m = hit[0]; ok, sp, ang = ev.motion_ok(m, t['pm'])
            rows.append((f"{t['name']} ({held})", bar, f"rank {i + 1} of {len(c)}, {m['mu']:.2f} vs {np.hypot(*t['pm']):.2f} arcsec/yr ({sp:.0%}), {ang:.0f} deg off, {m['sigma']:.1f} sigma, ratio at least {m['ratio_lo']:.1f} ({m['ratio_vs_stars']:.1f} x stars)", ok and i < ev.TOP))
        else:
            near = sorted((ev.sep(m, t), m) for m in R[name]['movers'])[:1]
            why = f"nearest mover {near[0][0]:.0f} arcsec away ({near[0][1]['mu']:.2f} arcsec/yr, {near[0][1]['sigma']:.1f} sigma, colour {near[0][1]['ratio_vs_stars'] and round(near[0][1]['ratio_vs_stars'], 2)} x stars)" if near else 'no movers at all'
            rows.append((f"{t['name']} ({held})", bar, f"not among {len(c)} candidates; {why}. Passes: {[(round(e['year'], 2), e['exposures']) for e in R[name]['epochs']]} {R[name]['note']}", False))
    def false(names):
        area = sum(R[n]['area_sqdeg'] for n in names); un = [m for n in names for m in R[n]['candidates'] if not (n in truth and ev.sep(m, truth[n]) <= ev.MATCH) and not m.get('known_name')]
        return f'{len(un)} unmatched in {area:.2f} sq deg = {len(un) / area:.2f} per sq deg', len(un) / area <= ev.CAP
    rows.append(('False candidates, new patches', f'at most {ev.CAP} per sq deg', *false(list(NEW)))); rows.append(('False candidates, all six patches', f'at most {ev.CAP} per sq deg', *false(list(R))))
    fl = [m for m in R['flash']['movers'] if ev.sep(m, ev.FLASH) <= ev.NEAR_FLASH]; rows.append(("Ed's flash at 4 sigma", '0 candidates or movers within 60 arcsec', str(len(fl)), not fl))
    inj, T = ev.plant('flash'); out, _ = d.search('flash', inj); xy = lambda m: d.tan(m['ra'], m['dec'], T['ra'], T['dec']); near = lambda m, g: np.hypot(xy(m)[0] - g['x'], xy(m)[1] - g['y'])
    planted = lambda m: any(near(m, g) <= 15 and ev.motion_ok(m, g['pm'])[0] for g in T['movers'])
    gh = [m for m in out['candidates'] if not planted(m) and any(near(m, g) <= ev.NEAR_GLITCH for g in T['glitches'])]
    rows.append(('Planted glitches at 4 sigma', f'0 candidates on {ev.N_GLITCH}', f"{len(gh)} candidates; {sum(any(near(m, g) <= 15 and ev.motion_ok(m, g['pm'])[0] for m in out['candidates']) for g in T['movers'])} of {ev.N_MOVER} planted movers recovered", not gh))
    table = '| check | bar | measured | result |\n|---|---|---|---|\n' + '\n'.join(f"| {a} | {b} | {c} | {'PASS' if ok else 'FAIL'} |" for a, b, c, ok in rows)
    print(table); allok = all(r[3] for r in rows); open(f'{d.OUT}/heldout_table.md', 'w').write(table + f"\n\nAll pass: {allok}\n")
    json.dump(dict(validation=dict(known_recovered=sum(bool(r[3]) for r in rows[:len(truth)]), known_expected=len(truth), planted_found=None, false_per_sqdeg=0.0 if false(list(R))[1] and false(list(R))[0].startswith('0 ') else None)), open(f'{d.OUT}/eval.json', 'w'))
    if allok: d.publish(list(R), 'candidates_4sigma.json', 'candidates_4sigma')
    sys.exit(0 if allok else 1)

if __name__ == '__main__':
    main()
