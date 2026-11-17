"""Evaluator for bake/detector_v4.py. Version: v3's frozen evaluator (b5f0c1b + 7b8147a) with the D5 repair and the
A10, A11, A14 to A18 fixes of the v4 plan review, frozen in one commit before any v4 detector code. Bars are v3's
(A1). Development fields may be scored as often as needed; final fields are scored once.

How the detector is called (ordinary input files and nothing else):
    python -I bake/detector_v4.py run <field_dir> <out.json>
  Injected data are written by THIS file into copies of the exposure files and of catwise.csv; directory names are
  hashes; truth stays under truth/ and is never passed on. out.json holds movers, candidates (cold, best first, one
  per physical source) and usable (as in v3), and for every mover the seed path(s) that produced it.

CHECKS (PASS, FAIL or INVALID; an INVALID check is never a pass; any required run that is missing or crashed makes
the checks that need it INVALID, it never shrinks a denominator)
 1 Held-out T and Y dwarfs (detector_v4_fields.json, kind dwarf: 12 stratified + the extra Y; FROZEN_INVENTORY). Recovered = a candidate
   one to one within 6 arcsec at MJD 61000, in the top 3 of its field, speed within 20% and direction within 15 deg
   of the literature. PASS: at least 80%. A target whose inputs are unavailable is INVALID and leaves the
   denominator; fewer than 12 valid targets make the check INVALID. 90% Clopper-Pearson interval. Y row (reported,
   not gating): the Y claim holds only if every real Y target is recovered.
 2 Legacy isolated plants (v3's design): speed 0.3-0.6, 0.6-1.2, 1.2-3.0 arcsec/yr x W2 11.5-12.5, 12.5-13.5,
   13.5-14, 14-14.5, 14.5-15, 15-15.5, 16 per bin, eligible inside the baseline usable map and in v3's isolated
   domain. W2 is a proxy: -2.5 log10(mean f_nu over 4.0 to 5.0 um / 171.787 Jy), not the W2 passband (A11), so
   completeness is stated in that proxy. The limit is FIXED at 14.0 (A1). PASS: every speed x flux bin brighter
   than 14.0 recovers at least 13 of 16 and so does the pooled set. All eligible plants count. Recovery is also
   reported conditional on the plant having its CatWISE row (2% withheld at random).
   CROWDING CHALLENGE (A12, rule frozen in detector_v4_fields.json): 72 plants 13 to 24 arcsec from a real CatWISE
   row 1 to 4 mag brighter, in the same mover runs, rows drawn by the archive model (A10). Reported separately with
   its own PASS (80% pooled and 7 of 8 per bin), not part of the five-check verdict, and compared with v3's frozen
   detector run on the same inputs.
   Injection (A11): measured ePSF zone, broadened and given a wing so that its central-pixel and 7x7 fractions match
   real stars on development exposures (detector_v4_inject_psf.json), on a 15 x 15 stamp, plus a per-plant extra
   Gaussian blur of 0 to 0.3 px (declared PSF-mismatch challenge). No source photon noise is added (declared).
 3 False candidates: every baseline candidate on the final fields that is not one-to-one matched in position (6
   arcsec) AND motion (20%, 15 deg) to a held-out target or an UltracoolSheet T/Y dwarf. Duplicates and known
   non-dwarfs count. Usable area = sum of the baseline usable maps (final fields are at least 1.5 deg apart).
   PASS: one-sided 95% Poisson upper bound under 1.0 per sq deg, with at least 5.5 usable sq deg including a field
   at |b| 10 to 20. Diagnostic nulls, no bar: CatWISE shifted 90 arcsec four ways, CatWISE motions reversed; counts
   are reported by seed path and stage.
 4 Artifacts, in a run with artifacts only (D5 repair, A15, A16): every component has a unique id, is placed only
   where the input cutout covers it on unflagged pixels (placement attempts recorded), and is verified after writing
   (pixel difference sum within 2% of the requested amplitude, centroid within 0.6 px). Singles in D5/D6 with a
   synthetic CatWISE mover through them; pairs (first and last pass) on such a track; persistence at ONE fixed D6
   detector pixel in four exposures: two consecutive in one visit, then one in each of two later visits (more than
   1 day later), amplitudes 1, 0.5, 0.35, 0.25 of the first, every projected sky position stored; catalogue rows at
   bright-star mask edges. Any required artifact missing or unverified makes check 4 INVALID. PASS: no candidate in
   the artifact runs that is not one-to-one (position and motion) the same source as a baseline candidate, anywhere
   in the field, and 0 baseline candidates within 60 arcsec of Ed's flash. The flash field was inspected before
   (v2, v3), so it is a regression item, reported on its own line, outside the new held-out sky.
 5 Non-dwarf movers: the 6 final M-dwarf controls. Each needs a movers record within 6 arcsec with spectrum_valid.
   PASS: none called cold and at least 5 of 6 valid not_cold. None cold but fewer than 5 valid: INVALID.

Run (uv environment of detector_v3_fetch.py, plus matplotlib):
    python -I bake/detector_v4_eval.py psfcal | archcal     injection PSF / archive model from development data (before the freeze)
    python -I bake/detector_v4_eval.py base dev|final       baseline detector runs (final: also the flash regression field)
    python -I bake/detector_v4_eval.py plant dev|final      injected inputs and truth (final seed = detector freeze commit)
    python -I bake/detector_v4_eval.py runs dev|final       mover, artifact and null runs
    python -I bake/detector_v4_eval.py runs3 dev|final      v3's frozen detector on the same baseline and mover inputs (comparison)
    python -I bake/detector_v4_eval.py score dev|final      the table
    python -I bake/detector_v4_eval.py demo                 self-checks of the scoring (no data)
"""
import sys, os, csv, json, hashlib, subprocess, shutil, numpy as np
from concurrent.futures import ThreadPoolExecutor
from scipy import ndimage as ndi
from scipy.stats import beta, chi2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_v3_fetch as F

VERSION = 'eval-v4 (v3 b5f0c1b + 7b8147a + D5 repair + A10, A11, A14-A18)'
HERE = os.path.dirname(os.path.abspath(__file__))
V4 = os.environ.get('DET_V4_OUT', os.path.dirname(F.OUT) + '/detector-v4')
V4CACHE, RUNS, TRUTH = V4 + '/cache', V4 + '/runs', V4 + '/truth'
FINAL = json.load(open(HERE + '/detector_v4_fields.json')) if os.path.exists(HERE + '/detector_v4_fields.json') else None
DEV = json.load(open(HERE + '/detector_v4_dev.json')) if os.path.exists(HERE + '/detector_v4_dev.json') else None
V3_DETECTOR = os.environ.get('DET_V3_WT', os.path.dirname(V4) + '/wt-detector-v3') + '/bake/detector_v3.py'
V3_DETECTOR_SHA = '882d231c'                      # first 8 hex of sha256 of v3's frozen detector_v3.py (570e70f), checked before use
MJD_REF, MJD_CW = 61000.0, 57170.0
MATCH, SPEED, ANGLE, TOP, RECOVER, CAP = 6.0, 0.20, 15.0, 3, 0.80, 1.0        # v3's bars
MIN_AREA, W2_LIMIT, N_HELDOUT, N_CTRL = 5.5, 14.0, 12, 6
FROZEN_INVENTORY = dict(dwarf=13, y_extra=1, y_total=3, mdwarf=6, plane=1, blank=2)      # detector_v4_fields.json as committed in step 1 (8216043)
SPEED_BINS, W2_BINS, N_BIN = [0.3, 0.6, 1.2, 3.0], [11.5, 12.5, 13.5, 14.0, 14.5, 15.0, 15.5], 16
LIMIT_DEV = 0.90
ISOLATE, APART, EDGE = 12.0, 150.0, 60.0
NEAR_GLITCH, NEAR_FLASH = 20.0, 60.0
N_G1, N_G2, N_G3, N_G4 = 4, 3, 2, 3
PERSIST_AMP = (1.0, 0.5, 0.35, 0.25)
NULLS = [('shift', 90, 0), ('shift', -90, 0), ('shift', 0, 90), ('shift', 0, -90), ('reverse', 0, 0)]
P_ROW, ERR_INFLATE = 0.98, 1.3
ZP_W1, ZP_W2 = 309.540, 171.787
INJ_SPECTRA = HERE + '/detector_v3_inject_spectra.json'     # v3's injection spectra, unchanged (donors disjoint from every fitter template)
PSF_MODEL, ARCH_MODEL = HERE + '/detector_v4_inject_psf.json', HERE + '/detector_v4_archive_model.json'
BLUR_MAX, STAMP = 0.3, 7                          # px: PSF-mismatch challenge; stamp half width (15 x 15)
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 26, 27, 28, 29))
OMEGA = (6.15 / F.AS) ** 2
hsh = lambda s: hashlib.sha256(s.encode()).hexdigest()
fl = lambda v: float(v) if v not in ('', 'null', 'NaN', None) else float('nan')

def fields(which):
    return DEV['fields'] if which == 'dev' else FINAL['final']
def src(which, f):
    return f['cache'] if which == 'dev' else f"{V4CACHE}/{f['field']}"
def flash_field():
    return next(f for f in DEV['fields'] if f['kind'] == 'flash')
def seed_of(which):
    if which == 'dev': return 'dev-' + DEV['seed']
    c = subprocess.run(['git', '-C', HERE, 'log', '-1', '--format=%H', '--', 'detector_v4.py', 'detector_v4_frozen.json'], capture_output=True, text=True).stdout.strip()
    assert c and os.path.exists(HERE + '/detector_v4_frozen.json'), 'the detector is not frozen (commit detector_v4.py and detector_v4_frozen.json first)'
    assert not subprocess.run(['git', '-C', HERE, 'status', '--porcelain', '--', 'detector_v4.py', 'detector_v4_frozen.json', 'detector_v4_templates.json', 'detector_v4_eval.py'], capture_output=True, text=True).stdout.strip(), 'detector or evaluator files differ from the commit'
    return c
def run_dir(which, field, variant):
    return f"{RUNS}/{which}/{hsh(f'{seed_of(which)}:{field}:{variant}')[:12]}"
def sep_as(a, d, a2, d2):
    return float(np.hypot((a - a2) * np.cos(np.radians(d2)), d - d2) * 3600)
def motion_ok(pe, pn, te, tn):
    sp = np.hypot(pe, pn) / np.hypot(te, tn); ang = float(np.degrees(abs(np.arctan2(pe * tn - pn * te, pe * te + pn * tn))))
    return bool(1 - SPEED <= sp <= 1 + SPEED and ang <= ANGLE), float(sp), ang
def read_csv(path):
    return list(csv.DictReader(open(path)))
def write_csv(path, rows, cols):
    w = csv.DictWriter(open(path, 'w', newline=''), cols); w.writeheader(); w.writerows(rows)
def load(d, e):
    from astropy.io import fits
    from astropy.wcs import WCS
    z = np.load(f"{d}/{e['file']}"); return dict(img=z['img'].astype(np.float32), flg=z['flg'], x0=int(z['x0']), y0=int(z['y0']), hdr=str(z['hdr']), t=float(z['t']), w=WCS(fits.Header.fromstring(str(z['hdr']))))

# ---------- injection PSF (A11) ----------
_epsf, _pm = {}, {}
def gstamp(sig, dx, dy, h=STAMP):
    """Unit-integral circular Gaussian sampled at the pixel centres of a (2h+1)^2 stamp, source at (dx, dy) from the centre pixel."""
    J, I = np.mgrid[-h:h + 1, -h:h + 1]; return np.exp(-((I - dx) ** 2 + (J - dy) ** 2) / (2 * sig ** 2)) / (2 * np.pi * sig ** 2)
def model_stamp(det, xdet, ydet, dx, dy, sigma_b, wing, sigma_w, blur=0.0):
    """(2h+1)^2 image of a point source of unit flux: ePSF zone nearest (xdet, ydet), blurred by sqrt(sigma_b^2 + blur^2)
    native px, carrying (1 - wing) of the light, plus a Gaussian wing of width sigma_w carrying `wing` (light outside the
    stamp is lost, as for a real star)."""
    if det not in _epsf: z = np.load(f'{F.CACHE}/epsf/{det}.npz'); _epsf[det] = (z['xc'], z['yc'], z['psf'], int(z['oversample']))
    xc, yc, psf, ov = _epsf[det]; k = int(np.argmin((xc - xdet) ** 2 + (yc - ydet) ** 2)); n = (2 * STAMP + 1) * ov; p = np.zeros((n + ov, n + ov), np.float32); c0 = (p.shape[0] - psf.shape[1]) // 2
    p[c0:c0 + psf.shape[1], c0:c0 + psf.shape[2]] = psf[k]; s = float(np.hypot(sigma_b, blur))
    if s > 0: p = ndi.gaussian_filter(p, s * ov)
    c = c0 + (psf.shape[1] - 1) / 2
    J, I = np.mgrid[-STAMP:STAMP + 1, -STAMP:STAMP + 1]; core = np.clip(ndi.map_coordinates(p, [c + ov * (J - dy), c + ov * (I - dx)], order=1, cval=0), 0, None)
    return (1 - wing) * core / core.sum() + wing * gstamp(sigma_w, dx, dy)
def stamp(det, xdet, ydet, x, y, blur=0.0):
    """Injection stamp at cutout position (x, y). -> (stamp, xi, yi), stamp centred on pixel (xi, yi)."""
    if not _pm: _pm.update(json.load(open(PSF_MODEL))['detectors'])
    m = _pm[det]; xi, yi = int(round(x)), int(round(y))
    return model_stamp(det, xdet, ydet, x - xi, y - yi, m['sigma_b'], m['wing'], m['sigma_w'], blur), xi, yi

def psfcal():
    """Real stars on development exposures -> per detector, the blur and wing that make the injection PSF match their
    central-pixel fraction (peak pixel over the 15x15 total) and 7x7 fraction. Writes detector_v4_inject_psf.json."""
    import detector_v3 as D3
    out = dict(version=VERSION, sigma_w=2.5, detectors={}, fields=[]); meas = {k: [] for k in ('D1', 'D2', 'D3', 'D4', 'D5', 'D6')}
    for f in DEV['fields'][:31:3]:                       # every third development field (11 of 31)
        d = f['cache']; E = json.load(open(d + '/exposures.json')); G = D3.read_cat(d)[0]; out['fields'].append(f['field'])
        sel = G[(G[:, 4] > 10.5) & (G[:, 4] < 16.0) & (np.hypot(G[:, 2], G[:, 3]) < 50)]; allg = G[G[:, 4] < 20]
        iso = [q for q in sel if (((allg[:, 0] - q[0]) * np.cos(np.radians(q[1]))) ** 2 + (allg[:, 1] - q[1]) ** 2 < (40 / 3600) ** 2).sum() == 1]
        rng = np.random.default_rng(int(hsh(f['field'])[:8], 16))
        for e in [E[i] for i in rng.permutation(len(E))[:240]] + [e for e in E if e['det'] in ('D5', 'D6')][:160]:
            a = load(d, e); dt = (a['t'] - 57388.5) / 365.25
            for q in iso:
                x, y = a['w'].all_world2pix(q[0] + q[2] * dt / 3.6e6 / np.cos(np.radians(q[1])), q[1] + q[3] * dt / 3.6e6, 0, quiet=True); x, y = float(x) - a['x0'], float(y) - a['y0']; xi, yi = int(round(x)), int(round(y))
                if not (13 <= xi < a['img'].shape[1] - 13 and 13 <= yi < a['img'].shape[0] - 13): continue
                box = a['img'][yi - 12:yi + 13, xi - 12:xi + 13]; fb = a['flg'][yi - 12:yi + 13, xi - 12:xi + 13]
                if (fb[5:20, 5:20] & BAD).any() or not np.isfinite(box).all(): continue
                r = np.hypot(*np.mgrid[-12:13, -12:13]); bg = np.median(box[(r >= 9) & (r <= 12)]); sg = 1.4826 * np.median(np.abs(box[(r >= 9) & (r <= 12)] - bg))
                c = box[5:20, 5:20] - bg; tot = c.sum()
                if tot < 100 * sg or (c > 0.5 * c.max()).sum() > 9: continue
                ys, xs = np.mgrid[-7:8, -7:8]; cx, cy = (c * xs).sum() / tot, (c * ys).sum() / tot
                if np.hypot(cx - (x - xi), cy - (y - yi)) > 0.5: continue
                meas[e['det']].append((c[7, 7] / tot, c[4:11, 4:11].sum() / tot, x - xi, y - yi, x + a['x0'], y + a['y0']))
        print(f['field'], {k: len(v) for k, v in meas.items()}, flush=True)
    for det, v in meas.items():
        v = np.array(v)[:400]; f1, f7 = float(np.median(v[:, 0])), float(np.median(v[:, 1])); best = None
        sub = v[np.random.default_rng(0).permutation(len(v))[:60]]
        for sb in np.arange(0, 0.81, 0.05):
            for w in np.arange(0, 0.161, 0.02):
                ms = np.array([(lambda s: (s[7, 7] / s.sum(), s[4:11, 4:11].sum() / s.sum()))(model_stamp(det, q[4], q[5], q[2], q[3], sb, w, out['sigma_w'])) for q in sub])
                m1, m7 = float(np.median(ms[:, 0])), float(np.median(ms[:, 1])); cost = ((m1 - f1) / f1) ** 2 + ((m7 - f7) / f7) ** 2
                if best is None or cost < best[0]: best = (cost, float(sb), float(w), m1, m7)
        zone = lambda m: float(np.median(v[m, 0])) if m.sum() >= 10 else None; rr = np.hypot(v[:, 4] - 1020, v[:, 5] - 1020)
        raw = np.array([(lambda s: s[7, 7] / s.sum())(model_stamp(det, q[4], q[5], q[2], q[3], 0, 0, 1)) for q in sub])
        out['detectors'][det] = dict(sigma_b=best[1], wing=best[2], sigma_w=out['sigma_w'], stars=int(len(v)), real_f1=f1, real_f7=f7, model_f1=best[3], model_f7=best[4], raw_epsf_f1=float(np.median(raw)),
                                     real_f1_inner=zone(rr < 600), real_f1_outer=zone(rr >= 600), real_f1_centred=zone(np.hypot(v[:, 2], v[:, 3]) < 0.25), real_f1_offcentre=zone(np.hypot(v[:, 2], v[:, 3]) >= 0.25))
        print(det, out['detectors'][det], flush=True)
    json.dump(out, open(PSF_MODEL, 'w'), indent=1)

# ---------- archive model for crowded plants (A10) ----------
def archcal():
    """Development catalogues: how CatWISE represents Gaia stars that sit 13 to 24 arcsec from a row 1 to 4 mag brighter,
    against isolated ones at the same predicted W2 (12.0 to 14.5). -> row rate, position and motion error scales, bias
    toward the neighbour, W2 offset. Writes detector_v4_archive_model.json."""
    from scipy.spatial import cKDTree
    acc = dict(iso=[], crowd=[]); fit = []
    per = []
    for f in DEV['fields']:
        d = f['cache']; G = read_csv(d + '/gaia.csv'); C = read_csv(d + '/catwise.csv')
        g = np.array([[fl(r['ra']), fl(r['dec']), fl(r['pmra']), fl(r['pmdec']), fl(r['phot_g_mean_mag']), fl(r['bp_rp'])] for r in G]); g = g[np.isfinite(g).all(1)]
        c = np.array([[fl(r['ra_pm']), fl(r['dec_pm']), fl(r['sigra_pm']), fl(r['sigdec_pm']), fl(r['pmra']), fl(r['pmdec']), fl(r['sigpmra']), fl(r['sigpmdec']), fl(r['w2mpro_pm'])] for r in C])
        c = c[np.isfinite(c[:, [0, 1, 8]]).all(1)]
        dt = (MJD_CW - 57388.5) / 365.25; ga, gd = g[:, 0] + g[:, 2] * dt / 3.6e6 / np.cos(np.radians(g[:, 1])), g[:, 1] + g[:, 3] * dt / 3.6e6
        gx, gy = F.tan(ga, gd, f['ra'], f['dec']); cx, cy = F.tan(c[:, 0], c[:, 1], f['ra'], f['dec']); tc = cKDTree(np.c_[cx, cy]); tg = cKDTree(np.c_[gx, gy])
        dd, jj = tc.query(np.c_[gx, gy]); m = dd < 2.0
        ox, oy = np.median(cx[jj[m]] - gx[m]), np.median(cy[jj[m]] - gy[m]); gx, gy = gx + ox, gy + oy; dd, jj = tc.query(np.c_[gx, gy]); m = dd < 2.0
        iso_g = np.array([len(tg.query_ball_point([gx[i], gy[i]], 6.0)) == 1 for i in range(len(gx))])
        fit.append(np.c_[g[m & iso_g, 4], g[m & iso_g, 5], c[jj[m & iso_g], 8]])
        per.append((f['field'], gx, gy, g, c, cx, cy, tc, dd, jj, iso_g))
    fit = np.concatenate(fit); ok = (fit[:, 2] > 10) & (fit[:, 2] < 15) & (fit[:, 1] > 0.3) & (fit[:, 1] < 3.5); P = np.polyfit(fit[ok, 1], fit[ok, 0] - fit[ok, 2], 3)
    res = fit[ok, 0] - fit[ok, 2] - np.polyval(P, fit[ok, 1]); sig_pred = float(1.4826 * np.median(np.abs(res)))
    for name, gx, gy, g, c, cx, cy, tc, dd, jj, iso_g in per:
        w2p = g[:, 4] - np.polyval(P, g[:, 5])
        for i in np.nonzero((w2p > 12.0) & (w2p < 14.5) & (g[:, 5] > 0.3) & (g[:, 5] < 3.5) & iso_g & (np.hypot(g[:, 2], g[:, 3]) < 50))[0]:
            own = jj[i] if dd[i] < 2.0 else -1; near = [k for k in tc.query_ball_point([gx[i], gy[i]], 24.0) if k != own]
            d_ = np.array([np.hypot(cx[k] - gx[i], cy[k] - gy[i]) for k in near]); w_ = np.array([c[k, 8] for k in near])
            if (d_ < 12).any(): continue
            nb = [k for k, s, w in zip(near, d_, w_) if 13 <= s <= 24 and w2p[i] - 4 <= w <= w2p[i] - 1 and w >= 8.5]
            others = [k for k, s, w in zip(near, d_, w_) if s >= 12 and k not in nb]
            kind = 'crowd' if len(nb) == 1 else 'iso' if (not nb and not (d_ < 24).any()) else None
            if kind is None: continue
            rec = dict(found=own >= 0, w2p=float(w2p[i]))
            if own >= 0:
                k = own; ux, uy = ((cx[nb[0]] - gx[i]), (cy[nb[0]] - gy[i])) if nb else (0.0, 0.0); un = np.hypot(ux, uy) or 1.0
                rx, ry = cx[k] - gx[i], cy[k] - gy[i]; pe, pn = c[k, 4] - g[i, 2] / 1000, c[k, 5] - g[i, 3] / 1000
                rec.update(zr=[rx / c[k, 2], ry / c[k, 3]], zp=[pe / c[k, 6], pn / c[k, 7]], radial=float((rx * ux + ry * uy) / un), pm_radial=float((pe * ux + pn * uy) / un), dmag=float(c[k, 8] - w2p[i]))
            acc[kind].append(rec)
    S = {}
    for kind, L in acc.items():
        fnd = [r for r in L if r['found']]; zr = np.abs(np.concatenate([r['zr'] for r in fnd])); zp = np.abs(np.concatenate([r['zp'] for r in fnd]))
        S[kind] = dict(n=len(L), rate=len(fnd) / max(len(L), 1), pos_p68=float(np.percentile(zr, 68.3)), pm_p68=float(np.percentile(zp[np.isfinite(zp)], 68.3)), radial_mean=float(np.mean([r['radial'] for r in fnd])),
                       radial_sd=float(np.std([r['radial'] for r in fnd])), pm_radial_mean=float(np.mean([r['pm_radial'] for r in fnd])), dmag_median=float(np.median([r['dmag'] for r in fnd])))
    out = dict(version=VERSION, w2_from_gaia=dict(poly_bp_rp=P.tolist(), sigma=sig_pred, note='W2 = G - poly(BP-RP)'), summary=S,
               crowd_model=dict(row_prob=float(min(P_ROW, P_ROW * S['crowd']['rate'] / S['iso']['rate'])), pos_scale=float(max(1.0, S['crowd']['pos_p68'] / S['iso']['pos_p68'])), pm_scale=float(max(1.0, S['crowd']['pm_p68'] / S['iso']['pm_p68'])),
                                bias_arcsec=S['crowd']['radial_mean'] - S['iso']['radial_mean'], pm_bias=S['crowd']['pm_radial_mean'] - S['iso']['pm_radial_mean'], dmag=S['crowd']['dmag_median'] - S['iso']['dmag_median']),
               note='crowded plants: row withheld with 1 - row_prob; donor errors x ERR_INFLATE x scale; position (and motion) shifted toward the neighbour by the bias; W2 offset dmag')
    json.dump(out, open(ARCH_MODEL, 'w'), indent=1); print(json.dumps(out, indent=1))

# ---------- spectra and injection ----------
def spectrum_fn(S, name, tilt, ch4):
    lam = np.array(S['lam']); s = np.array(S['spectra'][name]) * (lam / 4.5) ** tilt; s = np.where((lam >= 2.9) & (lam <= 3.7), s * ch4, s)
    return lambda l: np.interp(l, lam, s), float(s[(lam >= 4.0) & (lam <= 5.0)].mean()), float(s[(lam >= 2.8) & (lam <= 3.9)].mean())

def inject(src_, dst, E, adds):
    """Copy a field's exposures from src_ to dst, adding sources. adds: [dict(kind='mover', cid, ra, dec, pme, pmn, plx,
    mjy45, spec, blur) | dict(kind='stamp'|'pixel', cid, obs, det, ra, dec, snr) | dict(kind='detpix', cid, obs, det,
    xdet, ydet, amp)]. -> (log of every component addition: cid, obs, det, x, y (cutout), tot, kind; and per mover the
    exposures it touched and how many of them had flagged pixels within 2 px)"""
    S = json.load(open(INJ_SPECTRA)); os.makedirs(dst + '/exp', exist_ok=True)
    fn = {i: spectrum_fn(S, *a['spec']) for i, a in enumerate(adds) if a['kind'] == 'mover'}
    def one(e):
        a = load(src_, e); img = a['img'].copy(); n = 0; sig = 1.4826 * np.nanmedian(np.abs(img - np.nanmedian(img))); log = []
        for i, q in enumerate(adds):
            if q['kind'] == 'mover':
                ra, dec = F.track(q['ra'], q['dec'], q['pme'], q['pmn'], q['plx'], a['t'], MJD_REF); x, y = a['w'].all_world2pix(ra, dec, 0, quiet=True); x, y = float(x[0]) - a['x0'], float(y[0]) - a['y0']
                if not (STAMP <= x < img.shape[1] - STAMP - 1 and STAMP <= y < img.shape[0] - STAMP - 1): continue
                lam = float(F.wave(e['det'])(np.array([[y + a['y0'], x + a['x0']]]))[0]); f, m45, _ = fn[i]; tot = q['mjy45'] * f(lam) / m45 / (1e9 * OMEGA)
            elif q['obs'] != e['obs'] or q['det'] != e['det']: continue
            elif q['kind'] == 'detpix': x, y = q['xdet'] - a['x0'], q['ydet'] - a['y0']; tot = q['amp']
            else: x, y = a['w'].all_world2pix(q['ra'], q['dec'], 0, quiet=True); x, y = float(x) - a['x0'], float(y) - a['y0']; tot = q['snr'] * 3 * sig
            if not (STAMP <= x < img.shape[1] - STAMP - 1 and STAMP <= y < img.shape[0] - STAMP - 1): continue
            xi, yi = int(round(x)), int(round(y))
            if q['kind'] == 'pixel': img[yi, xi] += tot
            else: s, xi, yi = stamp(e['det'], x + a['x0'], y + a['y0'], x, y, q.get('blur', 0.0)); img[yi - STAMP:yi + STAMP + 1, xi - STAMP:xi + STAMP + 1] += tot * s
            n += 1; log.append(dict(cid=q['cid'], kind=q['kind'], obs=e['obs'], det=e['det'], file=e['file'], x=float(xi) if q['kind'] == 'pixel' else float(x), y=float(yi) if q['kind'] == 'pixel' else float(y), tot=float(tot) if q['kind'] != 'pixel' else float(tot), t=a['t'],
                                    flagged=bool((a['flg'][yi - 2:yi + 3, xi - 2:xi + 3] & BAD).any()), sky=[float(v) for v in a['w'].all_pix2world(x + a['x0'], y + a['y0'], 0)] if q['kind'] != 'mover' else None))
        f_ = f"{dst}/{e['file']}"
        if n: np.savez_compressed(f_, img=img, flg=a['flg'], x0=a['x0'], y0=a['y0'], hdr=a['hdr'], t=a['t'])
        elif not os.path.exists(f_): os.symlink(os.path.realpath(f"{src_}/{e['file']}"), f_)
        return log
    with ThreadPoolExecutor(8) as ex: L = [l for ls in ex.map(one, E) for l in ls]
    return L

def verify(src_, dst, L):
    """D5 / A15: re-read every written component and check its pixel difference. -> {cid: [True/False per addition]}"""
    out = {}
    for l in L:
        e = dict(file=l['file']); a, b = load(src_, e), load(dst, e); xi, yi = int(round(l['x'])), int(round(l['y'])); h = STAMP
        dd = (b['img'] - a['img'])[yi - h:yi + h + 1, xi - h:xi + h + 1].astype(float); s = dd.sum(); Y, X = np.mgrid[yi - h:yi + h + 1, xi - h:xi + h + 1]
        ok = bool(np.isfinite(s) and abs(s - l['tot']) <= 0.02 * abs(l['tot']) + 1e-9 and s > 0 and np.hypot((dd * X).sum() / s - l['x'], (dd * Y).sum() / s - l['y']) <= 0.6 + (STAMP if l['kind'] == 'mover' else 0))
        out.setdefault(l['cid'], []).append(ok)
    return out

def link_rest(s, dst, skip=()):
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(s):
        if f not in skip and f != 'exp' and not os.path.exists(f'{dst}/{f}'): os.symlink(os.path.realpath(f'{s}/{f}'), f'{dst}/{f}')
    if 'exp' not in skip and not os.path.exists(dst + '/exp'): os.symlink(os.path.realpath(s + '/exp'), dst + '/exp')

# ---------- catalogue rows ----------
def synth_row(rng, cw, ra, dec, pme, pmn, w1, w2, crowd=None):
    """One synthetic CatWISE2020 row (v3's donor method). crowd = (archive crowd_model, unit vector east/north toward
    the neighbour): errors scaled, position and motion biased toward the neighbour, W2 offset (A10)."""
    ok = [r for r in cw if r['nb'] == '1' and np.isfinite(fl(r['w2mpro_pm'])) and np.isfinite(fl(r['sigpmra'])) and np.isfinite(fl(r['w1mpro_pm']))]
    dn = dict(sorted(ok, key=lambda r: abs(fl(r['w2mpro_pm']) - w2))[int(rng.integers(5))]); cd = np.cos(np.radians(dec))
    ps, ms, bias, pbias, dmag, u = (crowd[0]['pos_scale'], crowd[0]['pm_scale'], crowd[0]['bias_arcsec'], crowd[0]['pm_bias'], crowd[0]['dmag'], crowd[1]) if crowd else (1, 1, 0, 0, 0, (0, 0))
    g = lambda k, s=1.0: fl(dn[k]) * ERR_INFLATE * s
    a, d = ra + (rng.normal(0, g('sigra_pm', ps)) + bias * u[0]) / 3600 / cd, dec + (rng.normal(0, g('sigdec_pm', ps)) + bias * u[1]) / 3600
    me, mn = pme + rng.normal(0, g('sigpmra', ms)) + pbias * u[0], pmn + rng.normal(0, g('sigpmdec', ms)) + pbias * u[1]
    dt = (fl(dn['meanobsmjd']) - MJD_CW) / 365.25; s1 = float(np.clip(fl(dn['w1sigmpro_pm']) * 10 ** (0.4 * (w1 - fl(dn['w1mpro_pm']))), 0.02, 9)) if np.isfinite(fl(dn['w1sigmpro_pm'])) else 9.0
    hh, dd = a / 15, abs(d); name = 'J%02d%02d%05.2f%s%02d%02d%04.1f' % (int(hh), int(hh * 60 % 60), hh * 3600 % 60, '+' if d >= 0 else '-', int(dd), int(dd * 60 % 60), dd * 3600 % 60)
    for k in ('sigra_pm', 'sigdec_pm'): dn[k] = '%.4f' % (fl(dn[k]) * ps)
    for k in ('sigpmra', 'sigpmdec'): dn[k] = '%.4f' % (fl(dn[k]) * ms)
    dn.update(source_name=name, source_id=dn['source_id'].split('-')[0] + '-%06d' % rng.integers(100000, 999999), ra_pm='%.7f' % a, dec_pm='%.7f' % d, pmra='%.5f' % me, pmdec='%.5f' % mn,
              ra='%.7f' % (a + me * dt / 3600 / cd), dec='%.7f' % (d + mn * dt / 3600), w2mpro_pm='%.3f' % (w2 + dmag + rng.normal(0, fl(dn['w2sigmpro_pm']))), par_pm='', par_pmsig='',
              w1mpro_pm='%.3f' % (w1 + rng.normal(0, min(s1, 0.5))) if s1 < 0.5 else '', w1sigmpro_pm='%.3f' % s1 if s1 < 0.5 else '', w1snr_pm='%.1f' % (1.0857 / s1))
    return dn

def near_any(ra, dec, rows, r_as, ka='ra', kd='dec', cond=None):
    return any(sep_as(ra, dec, fl(r[ka]), fl(r[kd])) < r_as for r in rows if abs(fl(r[kd]) - dec) * 3600 < r_as and (cond is None or cond(r)))

class Usable:
    def __init__(self, out_json):
        o = json.load(open(out_json)); z = np.load(os.path.dirname(out_json) + '/' + o['usable']['file']); self.ok, self.pix, self.ra0, self.dec0 = z['ok'], float(z['pix']), float(z['ra0']), float(z['dec0'])
    def at(self, ra, dec):
        x, y = F.tan(ra, dec, self.ra0, self.dec0); N = self.ok.shape[0]; ix, iy = int(round(float(x) / self.pix + (N - 1) / 2)), int(round(float(y) / self.pix + (N - 1) / 2))
        return bool(0 <= ix < N and 0 <= iy < N and self.ok[iy, ix])

# ---------- plant ----------
def plant(which):
    S = json.load(open(INJ_SPECTRA)); FL = fields(which); seed = seed_of(which); rng = np.random.default_rng(int(hsh(seed)[:12], 16)); os.makedirs(f'{TRUTH}/{which}', exist_ok=True)
    AM = json.load(open(ARCH_MODEL))['crowd_model']; CR = FINAL['crowding']; SRC = {f['field']: src(which, f) for f in FL}
    U = {f['field']: Usable(f"{run_dir(which, f['field'], 'base')}/out.json") for f in FL if os.path.exists(f"{run_dir(which, f['field'], 'base')}/out.json")}
    CW = {n: read_csv(f'{SRC[n]}/catwise.csv') for n in U}; TM = {n: read_csv(f'{SRC[n]}/twomass.csv') for n in U}
    P = {f['field']: dict(movers=[], glitches=[], rejected=dict(usable=0, isolated=0, apart=0, neighbour=0), placement_failures=[]) for f in FL}; names = sorted(U)
    taken = {f['field']: [(f['target']['ra'], f['target']['dec'])] if f.get('target') else [] for f in FL}
    cid = iter(range(10 ** 6))
    def draw(n):
        f = next(f for f in FL if f['field'] == n); half = F.SIZE * 1800 - EDGE
        x, y = rng.uniform(-half, half, 2); ra, dec = (float(v) for v in F.untan(x, y, f['ra'], f['dec']))
        if not U[n].at(ra, dec): return None, 'usable'
        if any(sep_as(ra, dec, a, d) < APART for a, d in taken[n]): return None, 'apart'
        return (ra, dec), None
    def motion(mu, w2):
        pa = rng.uniform(0, 2 * np.pi); plx = 0.0 if rng.random() < 0.25 else float(rng.uniform(0, 0.25))
        spec = (sorted(S['spectra'])[int(rng.integers(len(S['spectra'])))], float(rng.uniform(-0.3, 0.3)), float(np.exp(rng.uniform(np.log(0.5), np.log(2.0))))); _, m45, m33 = spectrum_fn(S, *spec)
        mjy = ZP_W2 * 1e3 * 10 ** (-0.4 * w2); return mu * np.sin(pa), mu * np.cos(pa), plx, spec, mjy, -2.5 * np.log10(mjy * m33 / m45 / 1e3 / ZP_W1)
    def legacy(n, mu, w2):
        pos, why = draw(n)
        if not pos: return None, why
        pme, pmn, plx, spec, mjy, w1 = motion(mu, w2); ra, dec = pos; a15, d15 = (float(v[0]) for v in F.track(ra, dec, pme, pmn, 0.0, MJD_CW, MJD_REF))
        if near_any(a15, d15, CW[n], ISOLATE, 'ra_pm', 'dec_pm') or near_any(ra, dec, CW[n], ISOLATE, 'ra_pm', 'dec_pm', lambda r: fl(r['w2mpro_pm']) < w2 + 1.0): return None, 'isolated'
        return dict(kind='mover', ra=ra, dec=dec, pme=float(pme), pmn=float(pmn), plx=plx, w2=float(w2), w1=float(w1), mjy45=float(mjy), spec=spec, cw=(a15, d15), crowd=False, blur=float(rng.uniform(0, BLUR_MAX))), None
    def crowd(n, mu, w2):
        nbs = [r for r in CW[n] if w2 - CR['contrast_mag'][1] <= fl(r['w2mpro_pm']) <= w2 - CR['contrast_mag'][0] and fl(r['w2mpro_pm']) >= CR['neighbour_w2_min']]
        if not nbs: return None, 'neighbour'
        r = nbs[int(rng.integers(len(nbs)))]; sep = rng.uniform(*CR['sep_ref_arcsec']); th = rng.uniform(0, 2 * np.pi); pme_n, pmn_n = (fl(r['pmra']) if np.isfinite(fl(r['pmra'])) else 0.0), (fl(r['pmdec']) if np.isfinite(fl(r['pmdec'])) else 0.0)
        na, nd = (float(v[0]) for v in F.track(fl(r['ra_pm']), fl(r['dec_pm']), pme_n, pmn_n, 0.0, MJD_REF, MJD_CW)); ra, dec = na + sep * np.sin(th) / 3600 / np.cos(np.radians(nd)), nd + sep * np.cos(th) / 3600
        if not U[n].at(ra, dec): return None, 'usable'
        if any(sep_as(ra, dec, a, d) < CR['apart_arcsec'] for a, d in taken[n]): return None, 'apart'
        pme, pmn, plx, spec, mjy, w1 = motion(mu, w2); a15, d15 = (float(v[0]) for v in F.track(ra, dec, pme, pmn, 0.0, MJD_CW, MJD_REF))
        if sep_as(a15, d15, fl(r['ra_pm']), fl(r['dec_pm'])) < CR['sep_catwise_min_arcsec']: return None, 'neighbour'
        other = lambda q: q is not r
        if near_any(a15, d15, [q for q in CW[n] if other(q)], CR['isolate_arcsec'], 'ra_pm', 'dec_pm') or near_any(ra, dec, [q for q in CW[n] if other(q)], CR['isolate_arcsec'], 'ra_pm', 'dec_pm', lambda q: fl(q['w2mpro_pm']) < w2 + 1.0): return None, 'isolated'
        u = np.array([(na - ra) * np.cos(np.radians(dec)), nd - dec]); u = u / np.hypot(*u)
        return dict(kind='mover', ra=ra, dec=dec, pme=float(pme), pmn=float(pmn), plx=plx, w2=float(w2), w1=float(w1), mjy45=float(mjy), spec=spec, cw=(a15, d15), crowd=True, blur=float(rng.uniform(0, BLUR_MAX)),
                    neighbour=dict(w2=fl(r['w2mpro_pm']), sep_ref=float(sep), sep_catwise=sep_as(a15, d15, fl(r['ra_pm']), fl(r['dec_pm'])), unit=[float(u[0]), float(u[1])])), None
    k = 0
    for maker, sb, wb, nper, tag in ((legacy, SPEED_BINS, W2_BINS, N_BIN, 'm'), (crowd, CR['speed_bins'], CR['w2_bins'], CR['n_per_bin'], 'c')):
        for si in range(len(sb) - 1):
            for wi in range(len(wb) - 1):
                got = tries = 0
                while got < nper and tries < 6000:
                    n = names[k % len(names)]; k += 1; tries += 1
                    m, why = maker(n, float(np.exp(rng.uniform(np.log(sb[si]), np.log(sb[si + 1])))), float(rng.uniform(wb[wi], wb[wi + 1])))
                    if not m: P[n]['rejected'][why] += 1; continue
                    m.update(id=f'{n}-{tag}{sum(q["crowd"] == m["crowd"] for q in P[n]["movers"]) + 1:02d}', cid=next(cid), speed_bin=si, w2_bin=wi, row=bool(rng.random() < (AM['row_prob'] if m['crowd'] else P_ROW)))
                    P[n]['movers'].append(m); taken[n].append((m['ra'], m['dec'])); got += 1
    # artifacts (placed only where the input covers them on unflagged pixels; attempts recorded)
    _meta = {}
    def meta(d, e):
        """Cutout origin, WCS and the mask of unusable pixels (flagged BAD or not finite) of one exposure, cached."""
        k = (d, e['file'])
        if k not in _meta:
            a = load(d, e); _meta[k] = dict(x0=a['x0'], y0=a['y0'], w=a['w'], flagged=(a['flg'] & BAD) != 0, nonfinite=~np.isfinite(a['img']), img=None)
        return _meta[k]
    def ok_at(m, xi, yi):
        H, W = m['flagged'].shape
        return bool(STAMP + 2 <= xi < W - STAMP - 2 and STAMP + 2 <= yi < H - STAMP - 2 and not m['flagged'][yi - 3:yi + 4, xi - 3:xi + 4].any() and not m['nonfinite'][yi - STAMP:yi + STAMP + 1, xi - STAMP:xi + STAMP + 1].any())
    def covered(d, e, ra, dec):
        m = meta(d, e); x, y = m['w'].all_world2pix(ra, dec, 0, quiet=True); return ok_at(m, int(round(float(x) - m['x0'])), int(round(float(y) - m['y0'])))
    for n in names:
        d = SRC[n]; E = json.load(open(d + '/exposures.json')); E56 = sorted([e for e in E if e['det'] in ('D5', 'D6')], key=lambda e: e['t']); E6 = [e for e in E56 if e['det'] == 'D6']
        ps = [q for q in F.passes([e['t'] for e in E6]) if len(q) >= 6]; first = [e for e in E6 if ps[0][0] <= e['t'] <= ps[0][-1]]; last = [e for e in E6 if e['t'] >= ps[-1][0]];      # passes the detector can use (6 or more D6 exposures)
        G = P[n]['glitches']; fail = P[n]['placement_failures']
        def comp(ra, dec, t):
            mu = float(np.exp(rng.uniform(np.log(0.3), np.log(3.0)))); pa = rng.uniform(0, 2 * np.pi); pme, pmn = mu * np.sin(pa), mu * np.cos(pa); dt = (MJD_REF - t) / 365.25
            ra_r, dec_r = ra + pme * dt / 3600 / np.cos(np.radians(dec)), dec + pmn * dt / 3600; a15, d15 = (float(v[0]) for v in F.track(ra_r, dec_r, pme, pmn, 0.0, MJD_CW, MJD_REF))
            return dict(ra=float(ra_r), dec=float(dec_r), pme=float(pme), pmn=float(pmn), w2=float(rng.uniform(12.0, 14.5)), cw=(a15, d15))
        def pick_exp(pool, ra, dec, tries=40):
            for i in rng.permutation(len(pool))[:tries]:
                if covered(d, pool[i], ra, dec): return pool[i]
            return None
        for j in range(N_G1 + N_G2):
            paired = j >= N_G1; done = False
            for att in range(60):
                pos, why = draw(n)
                if not pos: continue
                e = pick_exp(first if paired else E56, *pos)
                if e is None: fail.append(dict(type='pair' if paired else 'single', why='no covering unflagged exposure', at=pos)); continue
                kind = str(rng.choice(['stamp', 'pixel'])); snr = float(np.exp(rng.uniform(np.log(10), np.log(200)))); c = comp(*pos, e['t'])
                adds = [dict(kind=kind, cid=next(cid), obs=e['obs'], det=e['det'], ra=pos[0], dec=pos[1], snr=snr)]
                if paired:
                    e2 = None
                    for i in rng.permutation(len(last))[:40]:
                        a2, d2 = (float(v[0]) for v in F.track(c['ra'], c['dec'], c['pme'], c['pmn'], 0.0, last[i]['t'], MJD_REF))
                        if covered(d, last[i], a2, d2): e2 = last[i]; break
                    if e2 is None: fail.append(dict(type='pair', why='second end not covered', at=pos)); continue
                    adds.append(dict(kind=kind, cid=next(cid), obs=e2['obs'], det=e2['det'], ra=a2, dec=d2, snr=snr))
                taken[n].append(pos); G.append(dict(gid=f'{n}-g{len(G) + 1:02d}', type='pair' if paired else 'single', adds=adds, comp=c, at=[(q['ra'], q['dec']) for q in adds] + [(c['ra'], c['dec'])])); done = True; break
            if not done: fail.append(dict(type='pair' if paired else 'single', why='gave up after 60 attempts'))
        for j in range(N_G3):                    # persistence: one D6 detector pixel, two consecutive exposures, then two later visits
            done = False
            for att in range(80):
                runs_ = [i for i in range(len(E6) - 1) if E6[i + 1]['t'] - E6[i]['t'] < 0.02]
                if not runs_: break
                i = runs_[int(rng.integers(len(runs_)))]; a = load(d, E6[i])
                if min(a['img'].shape) < 60: fail.append(dict(type='persistence', why='first exposure cutout too small')); continue
                xd, yd = a['x0'] + rng.uniform(20, a['img'].shape[1] - 20), a['y0'] + rng.uniform(20, a['img'].shape[0] - 20)
                def onpix(e):
                    m = meta(d, e); return ok_at(m, int(round(xd - m['x0'])), int(round(yd - m['y0'])))
                if not (onpix(E6[i]) and onpix(E6[i + 1])): fail.append(dict(type='persistence', why='first visit pixel flagged or off')); continue
                later, t_last = [], E6[i + 1]['t'] + 1.0
                for e in E6[i + 2:]:
                    if e['t'] > t_last and onpix(e): later.append(e); t_last = e['t'] + 1.0
                    if len(later) == 2: break
                if len(later) < 2: fail.append(dict(type='persistence', why='pixel not covered in two later visits')); continue
                seq = [E6[i], E6[i + 1]] + later; amp0 = float(np.exp(rng.uniform(np.log(30), np.log(300)))) * 3 * 1.4826 * float(np.nanmedian(np.abs(a['img'] - np.nanmedian(a['img']))))
                adds = [dict(kind='detpix', cid=next(cid), obs=e['obs'], det='D6', xdet=float(xd), ydet=float(yd), amp=amp0 * PERSIST_AMP[q]) for q, e in enumerate(seq)]
                ra, dec = (float(v) for v in a['w'].all_pix2world(xd, yd, 0)); c = comp(ra, dec, E6[i]['t'])
                G.append(dict(gid=f'{n}-g{len(G) + 1:02d}', type='persistence', adds=adds, comp=c, at=[(ra, dec), (c['ra'], c['dec'])], schedule=[e['obs'] for e in seq])); done = True; break
            if not done: fail.append(dict(type='persistence', why='gave up'))
        bright = sorted([r for r in TM[n] if fl(r['k_m']) < 9.5], key=lambda r: fl(r['k_m']))
        for j in range(min(N_G4, len(bright))):
            r = bright[int(rng.integers(len(bright)))]; rad = (20 + 25 * max(9 - fl(r['k_m']), 0)) * rng.uniform(0.6, 1.3); th = rng.uniform(0, 2 * np.pi)
            ra, dec = fl(r['ra']) + rad * np.sin(th) / 3600 / np.cos(np.radians(fl(r['dec']))), fl(r['dec']) + rad * np.cos(th) / 3600; c = comp(ra, dec, MJD_REF)
            G.append(dict(gid=f'{n}-g{len(G) + 1:02d}', type='mask_edge', adds=[], comp=c, star_k=fl(r['k_m']), at=[(ra, dec)]))
        P[n]['required_artifacts'] = N_G1 + N_G2 + N_G3 + min(N_G4, len(bright)); _meta.clear()
    cols = list(next(iter(CW.values()))[0].keys()) if CW else []
    def write(n):
        s_ = SRC[n]; E = json.load(open(s_ + '/exposures.json')); rr = np.random.default_rng(int(hsh(seed + n)[:12], 16)); T = P[n]
        d = run_dir(which, n, 'mov'); shutil.rmtree(d, ignore_errors=True); L = inject(s_, d, E, T['movers'])
        for m in T['movers']:
            mine = [l for l in L if l['cid'] == m['cid']]; m['exposures_added'] = len(mine); m['flagged_exposures'] = sum(l['flagged'] for l in mine)
        rows = list(CW[n]) + [synth_row(rr, CW[n], *m['cw'], m['pme'], m['pmn'], m['w1'], m['w2'], (AM, m['neighbour']['unit']) if m['crowd'] else None) for m in T['movers'] if m['row']]; rows.sort(key=lambda r: fl(r['dec']))
        write_csv(d + '/catwise.csv', rows, cols); link_rest(s_, d, ('catwise.csv', 'exp')); T['mover_pixels_added'] = len(L)
        d = run_dir(which, n, 'gli'); shutil.rmtree(d, ignore_errors=True); L = inject(s_, d, E, [a for g in T['glitches'] for a in g['adds']]); V = verify(s_, d, L)
        for g in T['glitches']:
            for a in g['adds']:
                a['verified'] = bool(V.get(a['cid'])) and all(V[a['cid']]); a['sky'] = [l['sky'] for l in L if l['cid'] == a['cid']]
            g['verified'] = all(a['verified'] for a in g['adds']); g['at'] = g['at'] + [tuple(s) for a in g['adds'] for s in a['sky']]
        rows = list(CW[n]) + [synth_row(rr, CW[n], *g['comp']['cw'], g['comp']['pme'], g['comp']['pmn'], g['comp']['w2'] + 2.5, g['comp']['w2']) for g in T['glitches']]; rows.sort(key=lambda r: fl(r['dec']))
        write_csv(d + '/catwise.csv', rows, cols); link_rest(s_, d, ('catwise.csv', 'exp'))
        for g in T['glitches']: g['row_written'] = True
        for i, (kind, de, dn) in enumerate(NULLS):
            d = run_dir(which, n, f'null{i}'); shutil.rmtree(d, ignore_errors=True); rows = []
            for r in CW[n]:
                r = dict(r)
                if kind == 'shift':
                    for ka, kd in (('ra', 'dec'), ('ra_pm', 'dec_pm')): r[ka] = '%.7f' % (fl(r[ka]) + de / 3600 / np.cos(np.radians(fl(r[kd])))); r[kd] = '%.7f' % (fl(r[kd]) + dn / 3600)
                else:
                    for k_ in ('pmra', 'pmdec'): r[k_] = '%.5f' % (-fl(r[k_])) if np.isfinite(fl(r[k_])) else r[k_]
                rows.append(r)
            os.makedirs(d, exist_ok=True); write_csv(d + '/catwise.csv', rows, cols); link_rest(s_, d, ('catwise.csv',))
        json.dump(T, open(f'{TRUTH}/{which}/{n}.json', 'w'), indent=1, default=float)
        print(n, len(T['movers']), 'movers', len(T['glitches']), 'artifacts', sum(g.get('verified', True) for g in T['glitches']), 'verified', T['rejected'], len(T['placement_failures']), 'placement failures', flush=True)
    with ThreadPoolExecutor(3) as ex: list(ex.map(write, names))

# ---------- running ----------
def detect(d, det=None, out='out.json', env=None):
    if os.path.exists(f'{d}/{out}'): return 0
    r = subprocess.run([sys.executable, '-I', det or HERE + '/detector_v4.py', 'run', d, f'{d}/{out}'], capture_output=True, text=True, env=dict(os.environ, **(env or {})))
    open(f"{d}/{out.replace('.json', '')}.log", 'w').write(f'rc {r.returncode}\n' + r.stdout + r.stderr); return r.returncode
def valid_fields(which):
    return [f for f in fields(which) if os.path.exists(src(which, f) + '/manifest.json')]
def base(which):
    todo = []
    for f in fields(which):
        if not os.path.exists(src(which, f) + '/manifest.json'): print(f['field'], 'no manifest: INVALID field'); continue
        d = run_dir(which, f['field'], 'base'); link_rest(src(which, f), d); todo.append(d)
    if which == 'final': d = run_dir('final', 'flash', 'base'); link_rest(flash_field()['cache'], d); todo.append(d)
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(detect, todo))
    print('baseline runs, return codes', rc)
def runs(which, variants=None):
    ds = [run_dir(which, f['field'], v) for f in fields(which) for v in (variants or ['mov', 'gli'] + [f'null{i}' for i in range(len(NULLS))]) if os.path.exists(f"{TRUTH}/{which}/{f['field']}.json")]
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(detect, ds))
    print(len(ds), 'runs, non-zero return codes:', sum(r != 0 for r in rc))
def runs3(which, variants=('base', 'mov')):
    """v3's frozen detector on the same baseline and mover inputs (comparison only)."""
    assert hsh(open(V3_DETECTOR).read())[:8] == V3_DETECTOR_SHA, "v3's detector file differs from its freeze"
    ds = [run_dir(which, f['field'], v) for f in valid_fields(which) for v in variants if os.path.exists(run_dir(which, f['field'], v))]
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(lambda d: detect(d, V3_DETECTOR, 'out_v3.json', dict(DET_V3_OUT=V4 + '/v3cmp')), ds))
    print(len(ds), 'v3 runs, non-zero return codes:', sum(r != 0 for r in rc))

# ---------- score ----------
def one_to_one(cands, truths, key=lambda t: (t['ra'], t['dec']), motion=False):
    """Greedy nearest matching within MATCH arcsec (and, with motion=True, only pairs whose motion agrees). -> {truth: cand}"""
    pairs = sorted((sep_as(c['ra'], c['dec'], *key(t)), i, j) for j, c in enumerate(cands) for i, t in enumerate(truths) if abs(c['dec'] - key(t)[1]) * 3600 < MATCH
                   and (not motion or motion_ok(c['pm_e'], c['pm_n'], t['pme'] if 'pme' in t else t['pm_e'], t['pmn'] if 'pmn' in t else t['pm_n'])[0]))
    out, used = {}, set()
    for s, i, j in pairs:
        if s <= MATCH and i not in out and j not in used: out[i] = j; used.add(j)
    return out
def output(which, field, variant, name='out.json'):
    """-> (out dict or None, status 'ok' | 'missing' | 'crashed')"""
    d = run_dir(which, field, variant); f = f'{d}/{name}'
    if os.path.exists(f): return json.load(open(f)), 'ok'
    lg = f"{d}/{name.replace('.json', '')}.log"
    return None, ('crashed' if os.path.exists(lg) else 'missing')
def ci90(k, n):
    return (float(beta.ppf(0.05, k, n - k + 1)) if k else 0.0, float(beta.ppf(0.95, k + 1, n - k)) if k < n else 1.0) if n else (0.0, 1.0)

def plant_grid(PL, sb, wb, crowd):
    ns, nw = len(sb) - 1, len(wb) - 1
    return [[[p['found'] for p in PL if p['crowd'] == crowd and p['speed_bin'] == s and p['w2_bin'] == w] for w in range(nw)] for s in range(ns)]

def score(which, name='out.json'):
    FL = fields(which); V = valid_fields(which); vn = {f['field'] for f in V}; rows = []; detail = dict(seed=seed_of(which), evaluator=VERSION, detector_output=name)
    B = {f['field']: output(which, f['field'], 'base', name) for f in V}; T = {f['field']: json.load(open(f'{TRUTH}/{which}/{f["field"]}.json')) for f in V if os.path.exists(f'{TRUTH}/{which}/{f["field"]}.json')}
    base_bad = sorted(n for n, (o, s) in B.items() if o is None); truth_bad = sorted(n for n in vn if n not in T); detail['truth_missing'] = truth_bad; detail['invalid_fields'] = sorted(f['field'] for f in FL if f['field'] not in vn); detail['base_runs_missing'] = base_bad
    if which == 'final':
        inv = dict(dwarf=sum(f['kind'] == 'dwarf' for f in FL), y_extra=sum(f.get('extra') == 'Y' for f in FL), y_total=sum(f['kind'] == 'dwarf' and f['target']['spt'] >= 30 for f in FL), mdwarf=sum(f['kind'] == 'mdwarf' for f in FL),
                   plane=sum(f['kind'] == 'plane' for f in FL), blank=sum(f['kind'] == 'blank' for f in FL))
        assert inv == FROZEN_INVENTORY, f'final inventory differs from the frozen selection: {inv}'
        detail['inventory'] = inv
    # 1 held-out dwarfs
    H = []
    for f in FL:
        if f['kind'] != 'dwarf': continue
        t = f['target']; r = dict(field=f['field'], name=t['name'], stratum=t.get('stratum'), extra=f.get('extra'), spt=t.get('spt_text'), sptnum=t.get('spt'), pm=t['pm'], w2=t['w2'])
        if f['field'] not in vn: r.update(outcome='INVALID', why='inputs unavailable (no manifest)'); H.append(r); continue
        o, st = B[f['field']]
        if o is None: r.update(outcome='RUN ' + st.upper(), why='baseline run ' + st); H.append(r); continue
        m = one_to_one(o['candidates'], [t])
        if 0 in m:
            c = o['candidates'][m[0]]; ok, sp, ang = motion_ok(c['pm_e'], c['pm_n'], t['pme'], t['pmn'])
            r.update(rank=m[0] + 1, n_candidates=len(o['candidates']), speed_ratio=sp, angle=ang, pm_measured=float(np.hypot(c['pm_e'], c['pm_n'])), path=c.get('path'), id=c.get('id'),
                     outcome='recovered' if ok and m[0] < TOP else 'missed', why='' if ok and m[0] < TOP else ('motion off' if not ok else 'rank'))
        else:
            mv = one_to_one(o['movers'], [t]); q = o['movers'][mv[0]] if 0 in mv else None
            r.update(outcome='missed', n_candidates=len(o['candidates']), why=(f"mover record: stage {q['stage']}, verdict {q['verdict']}, path {q.get('path')}" if q else 'no mover record at its position'))
        H.append(r)
    v = [r for r in H if r['outcome'] in ('recovered', 'missed')]; k = sum(r['outcome'] == 'recovered' for r in v); n = len(v); ci = ci90(k, n); runbad = [r for r in H if r['outcome'].startswith('RUN')]
    rows.append(('1 held-out T and Y dwarfs', f'at least {RECOVER:.0%} recovered (top {TOP}, motion within {SPEED:.0%} and {ANGLE:.0f} deg)', f'{k} of {n} ({len(H) - n - len(runbad)} inputs unavailable, {len(runbad)} runs missing)', f'{ci[0]:.2f} to {ci[1]:.2f} (90%)',
                 'INVALID' if (runbad or n < (N_HELDOUT if which == 'final' else 4)) else 'PASS' if k / n >= RECOVER else 'FAIL'))
    Y = [r for r in H if (r.get('sptnum') or 0) >= 30]
    rows.append(('1Y real Y dwarfs (claim, not gating)', 'every real Y target recovered', f"{sum(r['outcome'] == 'recovered' for r in Y)} of {len(Y)}: " + ', '.join(f"{r['name']} {r['outcome']}" for r in Y), '',
                 'claim holds' if Y and all(r['outcome'] == 'recovered' for r in Y) else 'claim does not hold')); detail['heldout'] = H
    # 2 plants
    PL, mov_bad = [], []
    for n_, t in T.items():
        o, st = output(which, n_, 'mov', name)
        if o is None: mov_bad.append(n_)
        m = one_to_one(o['candidates'], t['movers']) if o else {}
        for i, p in enumerate(t['movers']):
            c = o['candidates'][m[i]] if i in m else None; ok = bool(c and motion_ok(c['pm_e'], c['pm_n'], p['pme'], p['pmn'])[0]); mv = one_to_one(o['movers'], [p]) if o and not ok else {}
            PL.append(dict(id=p['id'], crowd=p['crowd'], speed_bin=p['speed_bin'], w2_bin=p['w2_bin'], w2=p['w2'], mu=float(np.hypot(p['pme'], p['pmn'])), plx=p['plx'], row=p['row'], spec=p['spec'][0], blur=p.get('blur'),
                           flagged_exposures=p.get('flagged_exposures'), exposures_added=p.get('exposures_added'), neighbour=p.get('neighbour'), found=ok, path=c.get('path') if c else None,
                           why='' if ok else ('no detector output' if not o else 'candidate with wrong motion' if c else (f"stage {o['movers'][mv[0]]['stage']}, verdict {o['movers'][mv[0]]['verdict']}" if 0 in mv else 'no mover record'))))
    detail['mover_runs_missing'] = sorted(mov_bad)
    grid = plant_grid(PL, SPEED_BINS, W2_BINS, False); ns, nw = len(SPEED_BINS) - 1, len(W2_BINS) - 1
    pooled = [sum(sum(grid[s][w]) for s in range(ns)) / max(1, sum(len(grid[s][w]) for s in range(ns))) for w in range(nw)]
    lim_dev = W2_BINS[0]
    for w in range(nw):
        if pooled[w] >= LIMIT_DEV: lim_dev = W2_BINS[w + 1]
        else: break
    lim = W2_LIMIT; above = [(s, w) for s in range(ns) for w in range(nw) if W2_BINS[w + 1] <= lim + 1e-9]
    cells = {f'{SPEED_BINS[s]}-{SPEED_BINS[s + 1]} x {W2_BINS[w]}-{W2_BINS[w + 1]}': f'{sum(grid[s][w])}/{len(grid[s][w])}' for s in range(ns) for w in range(nw)}
    tot = [x for s, w in above for x in grid[s][w]]; full = all(len(grid[s][w]) == N_BIN for s, w in above); okb = all(sum(grid[s][w]) >= RECOVER * len(grid[s][w]) for s, w in above) and bool(tot) and sum(tot) >= RECOVER * len(tot)
    worst = min(((sum(grid[s][w]) / max(1, len(grid[s][w])), f'{SPEED_BINS[s]}-{SPEED_BINS[s + 1]} arcsec/yr, W2 {W2_BINS[w]}-{W2_BINS[w + 1]}') for s, w in above), default=(0, 'none'))
    rep = [p for p in PL if not p['crowd'] and p['w2'] <= lim and p['row']]; rej = {k_: sum(t['rejected'][k_] for t in T.values()) for k_ in ('usable', 'isolated', 'apart', 'neighbour')}
    rows.append(('2 legacy plants above the limit', f'every speed x flux bin brighter than W2 {lim} at least {RECOVER:.0%}, and pooled', f'{sum(tot)} of {len(tot)} pooled; worst bin {worst[0]:.0%} ({worst[1]}); with a CatWISE row: {sum(p["found"] for p in rep)} of {len(rep)}',
                 f'rejected draws {rej}', 'INVALID' if (not above or not full or mov_bad or truth_bad) else 'PASS' if okb else 'FAIL'))
    CR = FINAL['crowding']; cg = plant_grid(PL, CR['speed_bins'], CR['w2_bins'], True); ct = [x for r_ in cg for c_ in r_ for x in c_]; cci = ci90(sum(ct), len(ct))
    cfull = all(len(c_) == CR['n_per_bin'] for r_ in cg for c_ in r_); cok = sum(ct) >= CR['gate'] * len(ct) and all(sum(c_) >= CR['gate_per_bin'] for r_ in cg for c_ in r_)
    ccells = {f"{CR['speed_bins'][s]}-{CR['speed_bins'][s + 1]} x {CR['w2_bins'][w]}-{CR['w2_bins'][w + 1]}": f'{sum(cg[s][w])}/{len(cg[s][w])}' for s in range(len(cg)) for w in range(len(cg[0]))}
    crep = [p for p in PL if p['crowd'] and p['row']]
    rows.append(('2C crowding challenge (separate, not gating)', f"{CR['gate']:.0%} pooled and {CR['gate_per_bin']} of {CR['n_per_bin']} per bin", f'{sum(ct)} of {len(ct)} pooled; worst bin {min(sum(c_) for r_ in cg for c_ in r_) if ct else 0} of {CR["n_per_bin"]}; with a CatWISE row: {sum(p["found"] for p in crep)} of {len(crep)}',
                 f'{cci[0]:.2f} to {cci[1]:.2f} (90%)', 'INVALID' if (not cfull or mov_bad or truth_bad) else 'PASS' if cok else 'FAIL'))
    detail['plants'] = dict(limit_w2=lim, proposed_limit_dev_rule=lim_dev, cells=cells, crowd_cells=ccells, pooled_by_w2=dict(zip([f'{a}-{b}' for a, b in zip(W2_BINS[:-1], W2_BINS[1:])], pooled)), list=PL)
    # 3 false candidates
    UC = [r for r in read_csv(F.CACHE + '/ucs/UltracoolSheet-Main.csv') if fl(r['sptnum_formula']) >= 20 and r['ra_20250703_formula'] not in ('', 'NaN')]
    def verified(c):
        for r in UC:
            if abs(fl(r['dec_20250703_formula']) - c['dec']) > 0.01: continue
            pe, pn = fl(r['pmra_formula']) / 1000, fl(r['pmdec_formula']) / 1000; dt = (MJD_REF - 60859.0) / 365.25
            if sep_as(c['ra'], c['dec'], fl(r['ra_20250703_formula']) + pe * dt / 3600 / np.cos(np.radians(c['dec'])), fl(r['dec_20250703_formula']) + pn * dt / 3600) <= MATCH and np.isfinite(pe) and motion_ok(c['pm_e'], c['pm_n'], pe, pn)[0]: return r['name']
        return None
    false, area, plane_area, per = [], 0.0, 0.0, {}
    for f in V:
        o, st = B[f['field']]
        if o is None: per[f['field']] = dict(area=0.0, note='baseline run ' + st); continue
        a = o['usable']['area_sqdeg']; area += a; plane_area += a if f['kind'] == 'plane' or (which == 'dev' and f['kind'] == 'barnard') else 0; fc = []
        ex = one_to_one(o['candidates'], [f['target']], motion=True) if f['kind'] == 'dwarf' else {}
        for j, c in enumerate(o['candidates']):
            if j in ex.values(): continue
            nm = verified(c)
            if nm and not any(v_['name'] == nm and v_['field'] == f['field'] for v_ in per.get('verified_dwarfs', [])): per.setdefault('verified_dwarfs', []).append(dict(field=f['field'], name=nm)); continue
            fc.append(dict(field=f['field'], ra=c['ra'], dec=c['dec'], pm=float(np.hypot(c['pm_e'], c['pm_n'])), score=c.get('score'), id=c.get('id'), path=c.get('path')))
        false += fc; per[f['field']] = dict(area=a, false=len(fc), kind=f['kind'], excluded_area=o['usable'].get('excluded_sqdeg'))
    ub = float(chi2.ppf(0.95, 2 * (len(false) + 1)) / 2 / area) if area > 0 else float('inf'); nul = {}
    for i, (kind, de, dn) in enumerate(NULLS):
        os_ = [output(which, f['field'], f'null{i}', name)[0] for f in V if f['field'] in T]
        nul[f'{kind} {de} {dn}'] = dict(candidates=sum(len(o['candidates']) for o in os_ if o), runs=sum(o is not None for o in os_), missing=sum(o is None for o in os_),
                                        spectrum_stage_by_path={p: sum(1 for o in os_ if o for m in o['movers'] if m['stage'] == 'spectrum' and p in (m.get('path') or ['seed'])) for p in ('seed', 'proposal')},
                                        movers_by_path={p: sum(1 for o in os_ if o for m in o['movers'] if p in (m.get('path') or ['seed'])) for p in ('seed', 'proposal')})
    need_area = MIN_AREA if which == 'final' else 3.0
    res3 = 'INVALID' if base_bad else 'FAIL' if (len(false) and float(chi2.ppf(0.95, 2 * (len(false) + 1)) / 2 / max(area, need_area)) >= CAP) else 'INVALID' if (area < need_area or plane_area <= 0.05) else 'PASS' if ub < CAP else 'FAIL'
    rows.append(('3 false candidates', f'95% upper bound under {CAP} per sq deg over at least {need_area} usable sq deg incl. a |b| 10-20 field', f'{len(false)} in {area:.2f} usable sq deg ({plane_area:.2f} in the plane field); nulls: ' + ', '.join(f"{k_}: {v_['candidates']}" for k_, v_ in nul.items()),
                 f'upper bound {ub:.2f} per sq deg', res3)); detail['false'] = dict(list=false, area=area, plane_area=plane_area, per_field=per, nulls=nul)
    # 4 artifacts
    hits, n_art, unver, fails, short, gli_bad, near_m = [], 0, [], [], [], [], 0
    for n_, t in T.items():
        o, st = output(which, n_, 'gli', name); b = B[n_][0]
        if o is None: gli_bad.append(n_); continue
        if len(t['glitches']) < t['required_artifacts']: short.append(n_)
        fails += [dict(field=n_, **f_) for f_ in t['placement_failures']]
        n_art += len(t['glitches']); unver += [g['gid'] for g in t['glitches'] if g['type'] != 'mask_edge' and not g.get('verified')]
        bc = (b or {}).get('candidates', []); same = one_to_one(o['candidates'], bc, motion=True)
        for j, c in enumerate(o['candidates']):
            if j in same.values(): continue
            near = [g['gid'] for g in t['glitches'] if any(sep_as(c['ra'], c['dec'], a, d) <= NEAR_GLITCH for a, d in g['at'])]
            hits.append(dict(field=n_, ra=c['ra'], dec=c['dec'], id=c.get('id'), near_artifacts=near, path=c.get('path')))
        near_m += sum(any(sep_as(m['ra'], m['dec'], a, d) <= NEAR_GLITCH for g in t['glitches'] for a, d in g['at']) for m in o['movers'])
    flash = 'not in this set'
    if which == 'final' or any(f['kind'] == 'flash' for f in V):
        ff = flash_field(); d = ff['cache']; E = json.load(open(d + '/exposures.json')); e = next((e for e in E if e['obs'] == ff['flash']['obs'] and e['det'] == ff['flash']['det']), None); flash = 'INVALID: exposure not in the inputs'
        ob = output('final', 'flash', 'base', name)[0] if which == 'final' else B.get(ff['field'], (None,))[0]
        if e and ob is not None:
            a = load(d, e); x, y = a['w'].all_world2pix(ff['flash']['ra'], ff['flash']['dec'], 0, quiet=True); x, y = int(round(float(x))) - a['x0'], int(round(float(y))) - a['y0']
            pk = float(np.nanmax(a['img'][y - 2:y + 3, x - 2:x + 3]) - np.nanmedian(a['img'])); sg = float(1.4826 * np.nanmedian(np.abs(a['img'] - np.nanmedian(a['img'])))); fc = [c for c in ob['candidates'] if sep_as(c['ra'], c['dec'], ff['flash']['ra'], ff['flash']['dec']) <= NEAR_FLASH]
            flash = f'present ({pk / sg:.0f} sigma peak), {len(fc)} baseline candidates within {NEAR_FLASH:.0f} arcsec' if pk > 5 * sg else f'INVALID: no 5 sigma peak ({pk / sg:.1f})'; hits += [dict(field='flash', type='flash', ra=c['ra'], dec=c['dec']) for c in fc]
        elif ob is None: flash = 'INVALID: flash baseline run missing'
    bad4 = bool(truth_bad or gli_bad or unver or short or n_art == 0 or 'INVALID' in flash)
    rows.append(('4 artifacts', '0 new candidates in the artifact runs (anywhere) and 0 at the flash', f"{len(hits)} unexplained candidates on {n_art} artifacts ({sum(len(g['adds']) for t in T.values() for g in t['glitches'])} components; {len(unver)} unverified; {len(fails)} placement attempts rejected; {near_m} mover records of any verdict near them)", '',
                 'FAIL' if hits else 'INVALID' if bad4 else 'PASS'))
    rows.append(('4F flash regression (inspected before)', '0 baseline candidates within 60 arcsec of the flash', flash, '', 'FAIL' if any(h_.get('type') == 'flash' for h_ in hits) else 'INVALID' if 'INVALID' in flash else 'PASS' if 'present' in flash else 'n/a'))
    detail['artifacts'] = dict(hits=hits, n=n_art, unverified=unver, placement_failures=fails, short_fields=short, runs_missing=gli_bad, flash=flash)
    # 5 controls
    C = []
    for f in V:
        if f['kind'] not in ('mdwarf', 'barnard'): continue
        t = f['target']; o, st = B[f['field']]; mv = one_to_one(o['movers'], [t]) if o else {}; q = o['movers'][mv[0]] if 0 in mv else None; cold = bool(o and one_to_one(o['candidates'], [t]))
        C.append(dict(field=f['field'], kind=f['kind'], name=t['name'], pm=float(np.hypot(t['pme'], t['pmn'])), cold=cold, stage=q['stage'] if q else ('no mover record' if o else 'baseline run ' + st), verdict=q['verdict'] if q else None,
                      valid=bool(q and q.get('spectrum_valid') and q['verdict'] == 'not_cold'), pm_measured=float(np.hypot(q['pm_e'], q['pm_n'])) if q else None, path=q.get('path') if q else None,
                      dchi2=(q.get('spectrum') or {}).get('dchi2') if q else None, share=(q.get('spectrum') or {}).get('dwarf_share_45') if q else None))
    g = [c for c in C if c['kind'] == 'mdwarf']; nc, nv = sum(c['cold'] for c in g), sum(c['valid'] for c in g); need = 5 if which == 'final' else max(1, len(g) - 1)
    rows.append(('5 non-dwarf movers', f'0 called cold and at least {need} of {len(g)} with a valid non-methane verdict', f'{nc} cold, {nv} of {len(g)} valid not_cold', '',
                 'FAIL' if nc else 'INVALID' if any(c['stage'].startswith('baseline run') for c in g) else 'PASS' if nv >= need else 'INVALID')); detail['controls'] = C
    table = '| check | bar | measured | interval or note | result |\n|---|---|---|---|---|\n' + '\n'.join('| ' + ' | '.join(r) + ' |' for r in rows)
    tag = '' if name == 'out.json' else '_' + name.replace('.json', '')
    os.makedirs(f'{V4}/eval_{which}{tag}', exist_ok=True); open(f'{V4}/eval_{which}{tag}/table.md', 'w').write(table + '\n'); json.dump(dict(rows=rows, detail=detail), open(f'{V4}/eval_{which}{tag}/eval.json', 'w'), indent=1, default=float)
    print(table); print('legacy by bin:', cells); print('crowd by bin:', ccells); print('development limit rule would give', lim_dev)
    for r in H: print(' ', r)
    for c in C: print(' ', c)
    return rows

def demo():
    """Self-checks (A17): matching, motion-aware exemption, duplicates, missing runs."""
    assert motion_ok(1.0, 0.0, 1.1, 0.1)[0] and not motion_ok(1.0, 0.0, 1.3, 0.0)[0] and not motion_ok(1.0, 0.0, 0.9, 0.4)[0]
    t = [dict(ra=10.0, dec=0.0), dict(ra=10.001, dec=0.0)]; c = [dict(ra=10.0004, dec=0.0), dict(ra=10.0011, dec=0.0)]; assert one_to_one(c, t) == {1: 1, 0: 0}
    tt = [dict(ra=10.0, dec=0.0, pme=1.0, pmn=0.0)]; cc = [dict(ra=10.0, dec=0.0, pm_e=-1.0, pm_n=0.0), dict(ra=10.0003, dec=0.0, pm_e=1.05, pm_n=0.0)]
    assert one_to_one(cc, tt, motion=True) == {0: 1}, 'exemption must follow motion'                    # wrong-motion candidate is not exempt
    assert one_to_one(cc + [dict(cc[1])], tt, motion=True) == {0: 1}, 'a duplicate gets no second exemption'
    assert ci90(12, 12)[0] > 0.77 and abs(chi2.ppf(0.95, 2) / 2 - 2.996) < 1e-3
    g = gstamp(1.0, 0.3, -0.2, 10); assert abs(g.sum() - 1) < 1e-3
    m = model_stamp('D6', 1000, 1000, 0.2, -0.3, 0.3, 0.05, 2.5); assert 0.97 < m.sum() <= 1.0 and m.argmax() == (2 * STAMP + 1) * STAMP + STAMP, 'injection stamp centred and normalised'
    assert sum(1 for f in FINAL['final'] if f['kind'] == 'dwarf') == FROZEN_INVENTORY['dwarf']
    print('ok')

if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'demo': demo()
    elif c in ('psfcal', 'archcal'): dict(psfcal=psfcal, archcal=archcal)[c]()
    elif c == 'score': score(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'out.json')
    elif c == 'runs': runs(sys.argv[2], sys.argv[3].split(',') if len(sys.argv) > 3 else None)
    elif c == 'runs3': runs3(sys.argv[2], sys.argv[3].split(',') if len(sys.argv) > 3 else ('base', 'mov'))
    else: dict(base=base, plant=plant)[c](sys.argv[2])
