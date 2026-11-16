"""Evaluator for bake/detector_cold.py. Every bar below was written before the detector first ran on the two target
patches and is never loosened; a miss is reported as a number. Only this file knows where the targets are: the detector
is handed a patch centre (deliberately off the target) and a size.

Checks
  1, 2  blind recovery : WISE 0855-0714 and Epsilon Indi B are each in the top 5 candidates of their patch (so: methane
                         coloured), with a speed within 30% of the published one and a direction within 30 degrees.
  3     false          : candidates that are neither a target nor a catalogued (SIMBAD) object with the same proper
                         motion, per square degree over all four patches, at most CAP.
  4     Barnard's Star : fast but not methane coloured, so never a candidate (its measured motion is reported if seen).
  5     Ed's flash     : nothing (candidate or mover) within 60 arcsec of it.
  6     glitches       : 60 single-exposure glitches planted in the Pisces patch, half of them as a pair made to look
                         like a mover (one in the first pass, one in the last, 3 to 10 arcsec apart): 0 candidates on them.
  report only          : 40 planted cold movers in the same run (4.5 um only, 0.3 to 5 mJy, 0.5 to 8 arcsec/yr): the
                         share recovered as candidates with the right motion. No bar: it measures depth, it is not a gate.
Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp --with matplotlib \
       python -I bake/detector_cold_eval.py [--reuse]      (--reuse: score existing cold_<patch>.json, do not search again)
"""
import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_cold as d

CAP, TOP, SPEED, ANGLE = 1.0, 5, 0.30, 30.0   # frozen
MATCH, NEAR_FLASH, NEAR_GLITCH = 20.0, 60.0, 20.0   # arcsec
SIZE = 0.6                                    # degrees, every patch
N_GLITCH, N_MOVER, SEED = 60, 40, 20261115
PATCHES = {  # name: (label, centre ra, dec). Each target sits 0.14 to 0.17 degrees from its patch centre.
    'hydra': ('Hydra patch', 133.90, -7.34),
    'indus': ('Indus patch', 330.85, -56.70),
    'barnard': ('Ophiuchus patch', 269.55, 4.85),
    'flash': ('Pisces patch', 7.75, 15.60),
}
# positions near 2026 (as bake/flipbook.py); motions in arcsec/yr (east, north)
TRUTH = {
    'hydra': dict(name='WISE 0855-0714', ra=133.7587, dec=-7.2421, pm=(-8.110, 0.660), source='Luhman & Esplin 2016'),
    'indus': dict(name='Epsilon Indi B', ra=331.096, dec=-56.801, pm=(3.967, -2.536), source='Gaia DR3, Epsilon Indi A (same system)'),
}
BARNARD = dict(ra=269.4463, dec=4.7671, pm=(-0.802, 10.362))
FLASH = dict(ra=7.6317, dec=15.7040, obs='2026W01_2A_0524_3')

sep = lambda m, t: float(np.hypot((m['ra'] - t['ra']) * np.cos(np.radians(t['dec'])), m['dec'] - t['dec']) * 3600)
def motion_ok(m, pm):
    sp = m['mu'] / np.hypot(*pm); ang = float(np.degrees(abs(np.arctan2(m['mu_east'] * pm[1] - m['mu_north'] * pm[0], m['mu_east'] * pm[0] + m['mu_north'] * pm[1]))))
    return bool(1 - SPEED <= sp <= 1 + SPEED and ang <= ANGLE), float(sp), ang

def plant(name):
    """Truth for check 6 and the planted movers, drawn here with its own seed. -> injection dict for the detector, truth."""
    rng = np.random.default_rng(SEED); P = json.load(open(f'{d.CACHE}/{name}/patch.json')); E = sorted(P['images']['D6'], key=lambda e: e['t']); half = SIZE * 1800 - 60
    sig = {e['obs']: 1.4826 * np.nanmedian(np.abs((z := np.load(f"{d.CACHE}/{name}/D6_{e['obs']}.npz")['img']) - np.nanmedian(z))) for e in E}
    first = [e for e in E if e['t'] < E[0]['t'] + d.EPOCH_GAP]; last = [e for e in E if e['t'] > E[-1]['t'] - d.EPOCH_GAP]; inj, gl, mv = {}, [], []
    add = lambda e, x, y, s, kind: inj.setdefault(('D6', e['obs']), []).append((*(float(v) for v in d.untan(x, y, P['ra'], P['dec'])), float(s), kind))
    for k in range(N_GLITCH):
        x, y = rng.uniform(-half, half, 2); kind = str(rng.choice(['psf', 'pixel'])); snr = float(np.exp(rng.uniform(np.log(10), np.log(200)))); paired = k % 2 == 0
        e = first[rng.integers(len(first))] if paired else E[rng.integers(len(E))]; add(e, x, y, snr * 3 * sig[e['obs']], kind)
        if paired:
            r, th = rng.uniform(3, 10), rng.uniform(0, 2 * np.pi); e2 = last[rng.integers(len(last))]; add(e2, x + r * np.cos(th), y + r * np.sin(th), snr * 3 * sig[e2['obs']], kind)
        gl.append(dict(x=float(x), y=float(y), kind=kind, snr=snr, paired=paired))
    t0 = E[0]['t']
    for k in range(N_MOVER):
        x, y = rng.uniform(-half, half, 2); mu = float(np.exp(rng.uniform(np.log(0.5), np.log(8)))); pa = float(rng.uniform(0, 2 * np.pi)); mjy = float(np.exp(rng.uniform(np.log(0.3), np.log(5))))
        for e in E:
            dt = (e['t'] - t0) / 365.25; add(e, x + mu * np.sin(pa) * dt, y + mu * np.cos(pa) * dt, mjy / (1e9 * (d.PIX / d.AS) ** 2), 'psf')
        mv.append(dict(x=float(x), y=float(y), mu=mu, pm=(mu * np.sin(pa), mu * np.cos(pa)), mjy=mjy))
    return inj, dict(glitches=gl, movers=mv, ra=P['ra'], dec=P['dec'])

def main():
    reuse = '--reuse' in sys.argv; R = {}
    for name, (label, ra, dec) in PATCHES.items():
        if not os.path.exists(f'{d.CACHE}/{name}/patch.json'): d.prep(name, ra, dec, SIZE, label)
        R[name] = json.load(open(f'{d.OUT}/cold_{name}.json')) if reuse and os.path.exists(f'{d.OUT}/cold_{name}.json') else d.run(name)
    rows, detail = [], {}
    for name, t in TRUTH.items():                                      # checks 1 and 2
        c = R[name]['candidates']; hit = [(i, m) for i, m in enumerate(c) if sep(m, t) <= MATCH]; mov = [m for m in R[name]['movers'] if sep(m, t) <= MATCH]
        if hit:
            i, m = hit[0]; ok, sp, ang = motion_ok(m, t['pm'])
            rows.append((f"{t['name']} recovered blind", f'top {TOP}, methane colour, speed within {SPEED:.0%}, direction within {ANGLE:.0f} deg',
                         f"rank {i + 1} of {len(c)}, {m['mu']:.2f} vs {np.hypot(*t['pm']):.2f} arcsec/yr ({sp:.0%}), {ang:.0f} deg off, 4.5/3.3 ratio at least {m['ratio_lo']:.1f} ({m['ratio_vs_stars']:.1f} x stars)", ok and i < TOP))
        else:
            why = (f"seen as a mover ({mov[0]['mu']:.2f} arcsec/yr, {mov[0]['sigma']:.1f} sigma) but colour {mov[0]['ratio_vs_stars'] and round(mov[0]['ratio_vs_stars'], 2)} x stars is under {d.COLOUR_MIN}"
                   if mov else 'not found as a mover') if R[name]['epochs'] else 'no data'
            rows.append((f"{t['name']} recovered blind", f'top {TOP}, methane colour, speed within {SPEED:.0%}, direction within {ANGLE:.0f} deg', f"not among {len(c)} candidates: {why}. {R[name]['note']}", False))
        detail[name] = dict(target=t, candidates=len(c), hit=hit[0][1] if hit else None, mover=mov[0] if mov else None)
    area = sum(r['area_sqdeg'] for r in R.values()); un = [m for n, r in R.items() for m in r['candidates'] if not (n in TRUTH and sep(m, TRUTH[n]) <= MATCH) and not m.get('known_name')]
    known = [m for n, r in R.items() for m in r['candidates'] if m.get('known_name') and not (n in TRUTH and sep(m, TRUTH[n]) <= MATCH)]
    rows.append(('False candidates', f'at most {CAP} per square degree', f'{len(un)} unmatched in {area:.2f} sq deg = {len(un) / area:.2f} per sq deg ({len(known)} more matched a catalogued mover)', len(un) / area <= CAP))
    bc = [m for m in R['barnard']['candidates'] if sep(m, BARNARD) <= MATCH]; bm = [m for m in R['barnard']['movers'] if sep(m, BARNARD) <= MATCH]
    rows.append(("Barnard's Star is not a cold candidate", '0 candidates on it', f"{len(bc)} candidates; " + (f"seen as a mover at {bm[0]['mu']:.2f} arcsec/yr (Gaia 10.39), colour {bm[0]['ratio_vs_stars'] and round(bm[0]['ratio_vs_stars'], 2)} x stars"
                 if bm else 'not measured as a mover either (see result.md)'), not bc))
    fl = [m for m in R['flash']['movers'] if sep(m, FLASH) <= NEAR_FLASH]
    rows.append(("Ed's flash is not a candidate", f'0 candidates or movers within {NEAR_FLASH:.0f} arcsec', f"{len(fl)} (patch has {len(R['flash']['movers'])} movers, {len(R['flash']['candidates'])} candidates)", not fl))
    inj, T = plant('flash'); out, _ = d.search('flash', inj); json.dump(out, open(f'{d.OUT}/planted_flash.json', 'w')); json.dump(T, open(f'{d.OUT}/truth_flash.json', 'w'))
    xy = lambda m: d.tan(m['ra'], m['dec'], T['ra'], T['dec']); near = lambda m, g: np.hypot(xy(m)[0] - g['x'], xy(m)[1] - g['y'])
    planted = lambda m: any(near(m, g) <= 15 and motion_ok(m, g['pm'])[0] for g in T['movers'])   # fixed after run 1: a planted mover that happens to sit near a glitch is not a glitch hit
    gh = [m for m in out['candidates'] if not planted(m) and any(near(m, g) <= NEAR_GLITCH for g in T['glitches'])]; gm = [m for m in out['movers'] if not planted(m) and any(near(m, g) <= NEAR_GLITCH for g in T['glitches'])]
    rows.append(('Single-exposure glitches', f'0 candidates on {N_GLITCH} planted glitches', f'{len(gh)} candidates, {len(gm)} movers of any colour', not gh))
    found = []
    for g in T['movers']:
        g['found'] = any(near(m, g) <= 15 and motion_ok(m, g['pm'])[0] for m in out['candidates']); found.append(g['found'])
    bright = [g['found'] for g in T['movers'] if g['mjy'] >= 1.0]
    rows.append(('Planted cold movers (report only)', 'no bar', f"{sum(found)} of {len(found)} recovered; at 1 mJy and brighter {sum(bright)} of {len(bright)}", None))
    table = '| check | bar | measured | result |\n|---|---|---|---|\n' + '\n'.join(f"| {a} | {b} | {c} | {'PASS' if ok else 'report only' if ok is None else 'FAIL'} |" for a, b, c, ok in rows)
    print(table); open(f'{d.OUT}/eval_table.md', 'w').write(table + '\n')
    val = dict(known_recovered=sum(bool(r[3]) for r in rows[:2]), known_expected=2, planted_found=round(sum(found) / len(found), 3), false_per_sqdeg=round(len(un) / area, 2))
    json.dump(dict(validation=val, rows=[dict(check=a, bar=b, measured=c, passed=ok) for a, b, c, ok in rows], detail=detail, planted=T['movers'],
                   patches={n: dict(epochs=r['epochs'], anchor=r.get('anchor'), error_model=r.get('error_model'), star_ratio=r.get('star_ratio'), movers=len(r['movers']), candidates=len(r['candidates'])) for n, r in R.items()}),
              open(f'{d.OUT}/eval.json', 'w'), indent=1, default=float)
    sys.exit(0 if all(ok is not False for *_, ok in rows) else 1)

if __name__ == '__main__':
    main()
