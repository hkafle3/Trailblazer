"""Evaluator for bake/detector_v3.py (slow cold movers, SPHEREx + CatWISE). FROZEN in its own commit before the
detector existed; every bar and number below was fixed then. Development fields may be scored as often as needed;
final fields are scored once.

How the detector is called (it gets ordinary input files and nothing else):
    python -I bake/detector_v3.py run <field_dir> <out.json>
  <field_dir> is in the format of detector_v3_fetch.py. Injected data are written by THIS file into copies of the
  exposure files and of catwise.csv; directory names are hashes; truth stays under truth/ and is never passed on.
  out.json must hold:
    movers     every SPHEREx source that entered a motion fit: {ra, dec (at MJD 61000), pm_e, pm_n (arcsec/yr, east and
               north), stage (last stage reached), verdict ('cold', 'not_cold' or 'insufficient'), spectrum_valid (bool:
               the template stage ran on valid data), score}
    candidates the movers called cold, best first (rank 1 first)
    usable     {file: npz beside out.json with ok (bool N x N, [iy, ix], x east, y north), pix (arcsec), ra0, dec0;
               area_sqdeg}: the sky this run could have found a candidate in (coverage, astrometry, spectrum, mask
               and edge rules all applied)

CHECKS (PASS, FAIL or INVALID; an INVALID check is never a pass)
 1 Held-out T dwarfs (bake/detector_v3_fields.json, kind dwarf). A target is recovered if a candidate lies within 6
   arcsec of it at MJD 61000 (one to one), is in the top 3 of its field, and has speed within 20% and direction
   within 15 deg of the literature motion. PASS: at least 80% of the targets. A target whose field has no manifest
   is INVALID and leaves the denominator (reported); fewer than 8 valid targets make the check INVALID. The exact
   count and a 90% Clopper-Pearson interval are reported.
 2 Planted methane dwarfs, written into every covered exposure of all six detectors through the exposure's own
   wavelength at that pixel and the measured ePSF, moving with proper motion and parallax, plus one synthetic
   CatWISE row each (I1, I2). Bins: speed 0.3-0.6, 0.6-1.2, 1.2-3.0 arcsec/yr x W2 11.5-12.5, 12.5-13.5, 13.5-14,
   14-14.5, 14.5-15, 15-15.5 mag; 16 eligible plants per bin. Flux unit: W2 Vega mag = -2.5 log10(mean f_nu over
   4.0 to 5.0 um / 171.787 Jy). Recovered = a candidate one-to-one within 6 arcsec at MJD 61000 with motion within 20%
   and 15 deg. The limit is set on DEVELOPMENT plants only: the faint edge of the faintest W2 bin such that it and
   every brighter bin recover at least 90% pooled over speed; it is written to bake/detector_v3_frozen.json with the
   detector freeze. PASS: every speed x flux bin brighter than the limit recovers at least 80% (13 of 16) and so does
   the pooled set. All eligible plants count, whatever happened to them. Recovery is conditional on the archive row
   existing (2% of rows are withheld at random and stay in the denominator). Plants are eligible only inside the
   baseline run's usable area and in the isolated-source domain (no real CatWISE row within 12 arcsec of the 2015.4
   position, none brighter than the plant's W2 + 1 within 12 arcsec of the 2026 position); rejected draws are counted.
 3 False candidates: every baseline candidate in the final fields that is not a held-out target and not an
   UltracoolSheet T or Y dwarf matched in position (6 arcsec) and motion (20%, 15 deg). Known non-dwarfs count.
   Usable area = sum of the baseline usable maps (fields do not overlap). PASS: one-sided 95% Poisson upper bound on
   the rate under 1.0 per sq deg, with at least 3.0 usable sq deg including a field at |b| 10 to 20; with less area
   the check is INVALID (or FAIL if the bound cannot be met anyway). Diagnostic nulls, no bar: CatWISE shifted by
   90 arcsec east, west, north, south (4 runs) and CatWISE motions reversed in sign (1 run).
 4 Artifacts, in a run with glitches only: single-exposure glitches (hot pixel or PSF shaped) in D5/D6 each with a
   synthetic CatWISE mover whose track passes through it; pairs (first and last pass) on such a track; persistence
   (a decaying PSF at one fixed detector pixel over four consecutive D6 exposures) with a CatWISE mover at the first;
   synthetic CatWISE movers at bright-star mask edges with nothing planted in pixels; Ed's flash (checked to be
   present in the inputs). PASS: 0 candidates within 20 arcsec of any of them that the baseline run did not have,
   and 0 baseline candidates within 60 arcsec of the flash. Flash exposure missing: that item is INVALID.
 5 Non-dwarf movers: the final M-dwarf controls (kind mdwarf). Each needs a movers record within 6 arcsec with
   spectrum_valid true. PASS: none is called cold and at least 5 of 6 have a valid not_cold verdict. None cold but
   fewer than 5 valid: INVALID. Barnard's Star (development) is reported, not gated.

Run (inside the uv environment of detector_v3_fetch.py, plus matplotlib):
    python -I bake/detector_v3_eval.py spectra            injection spectra from four development dwarfs (once, before the freeze)
    python -I bake/detector_v3_eval.py base dev|final     baseline detector runs
    python -I bake/detector_v3_eval.py plant dev|final    write injected inputs and truth (final seed = detector freeze commit)
    python -I bake/detector_v3_eval.py runs dev|final     mover, glitch and null runs
    python -I bake/detector_v3_eval.py score dev|final    the table
"""
import sys, os, io, csv, json, hashlib, subprocess, shutil, numpy as np
from concurrent.futures import ThreadPoolExecutor
from scipy import ndimage as ndi
from scipy.stats import beta, chi2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_v3_fetch as F

HERE = os.path.dirname(os.path.abspath(__file__))
FIELDS = json.load(open(HERE + '/detector_v3_fields.json')) if os.path.exists(HERE + '/detector_v3_fields.json') else None
RUNS, TRUTH = F.OUT + '/runs', F.OUT + '/truth'
MJD_REF, MJD_CW = 61000.0, 57170.0
MATCH, SPEED, ANGLE, TOP, RECOVER, CAP, MIN_AREA = 6.0, 0.20, 15.0, 3, 0.80, 1.0, 3.0          # frozen
SPEED_BINS, W2_BINS, N_BIN = [0.3, 0.6, 1.2, 3.0], [11.5, 12.5, 13.5, 14.0, 14.5, 15.0, 15.5], 16
LIMIT_DEV = 0.90
ISOLATE, APART, EDGE = 12.0, 150.0, 60.0      # arcsec
NEAR_GLITCH, NEAR_FLASH = 20.0, 60.0
N_G1, N_G2, N_G3, N_G4 = 4, 3, 2, 3           # per field: single glitches, pairs, persistence trails, mask-edge rows
NULLS = [('shift', 90, 0), ('shift', -90, 0), ('shift', 0, 90), ('shift', 0, -90), ('reverse', 0, 0)]
P_ROW, ERR_INFLATE = 0.98, 1.3                # chance a plant gets its CatWISE row; factor on the donor row's quoted errors
ZP_W1, ZP_W2 = 309.540, 171.787               # Jy
INJ_FROM = ['PSO J043.5395+02.3995', '2MASSI J0937347+293142', 'WISE J004945.61+215120.0', '2MASS J11145133-2618235']   # never used as fitter templates
OMEGA = (6.15 / F.AS) ** 2                    # sr per detector pixel (nominal scale; distortion changes it by a few percent)
hsh = lambda s: hashlib.sha256(s.encode()).hexdigest()
fl = lambda v: float(v) if v not in ('', 'null', 'NaN', None) else float('nan')

def fields(which):
    return FIELDS['dev'] if which == 'dev' else FIELDS['final']
def seed_of(which):
    if which == 'dev': return 'dev-' + FIELDS['seed']
    c = subprocess.run(['git', '-C', HERE, 'log', '-1', '--format=%H', '--', 'detector_v3.py', 'detector_v3_frozen.json'], capture_output=True, text=True).stdout.strip()
    assert c and os.path.exists(HERE + '/detector_v3_frozen.json'), 'the detector is not frozen (commit detector_v3.py and detector_v3_frozen.json first)'
    assert not subprocess.run(['git', '-C', HERE, 'status', '--porcelain', '--', 'detector_v3.py', 'detector_v3_frozen.json', 'detector_v3_templates.json'], capture_output=True, text=True).stdout.strip(), 'detector files differ from the freeze commit'
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

# ---------- pixels: photometry for the injection spectra, and the injection itself ----------
def load(d, e):
    from astropy.io import fits
    from astropy.wcs import WCS
    z = np.load(f"{d}/{e['file']}"); return dict(img=z['img'].astype(np.float32), flg=z['flg'], x0=int(z['x0']), y0=int(z['y0']), hdr=str(z['hdr']), t=float(z['t']), w=WCS(fits.Header.fromstring(str(z['hdr']))))

def box_flux(img, x, y):
    """5x5 pixel sum minus the median of the 13x13 frame around it. None off the image or on bad pixels. (Evaluator's
    own crude photometry, used only to build injection spectra.)"""
    xi, yi = int(round(float(x))), int(round(float(y)))
    if not (7 <= xi < img.shape[1] - 7 and 7 <= yi < img.shape[0] - 7): return None
    c = img[yi - 2:yi + 3, xi - 2:xi + 3]; b = img[yi - 6:yi + 7, xi - 6:xi + 7].copy(); b[3:10, 3:10] = np.nan
    return float((c - np.nanmedian(b)).sum()) if np.isfinite(c).all() else None

LAM = np.round(np.concatenate([np.arange(0.76, 2.40, 0.03), np.arange(2.42, 3.80, 0.06), np.arange(3.82, 5.01, 0.04)]), 3)
def spectra():
    """Injection spectra: 5x5 box photometry of four development dwarfs in every exposure, median in LAM bins, relative
    f_nu (negative medians set to 0). Written to bake/detector_v3_inject_spectra.json."""
    out = dict(lam=LAM.tolist(), spectra={}, note='relative f_nu on lam (um); built by detector_v3_eval.py spectra from development fields')
    for f in FIELDS['dev']:
        t = f['target']
        if t['name'] not in INJ_FROM: continue
        d = f"{F.CACHE}/{f['field']}"; E = json.load(open(d + '/exposures.json')); lam, flx = [], []
        for e in E:
            a = load(d, e); ra, dec = F.track(t['ra'], t['dec'], t['pme'], t['pmn'], (t.get('plx_mas') or 0) / 1000 if np.isfinite(t.get('plx_mas') or 0) else 0, a['t'], MJD_REF)
            x, y = a['w'].all_world2pix(ra, dec, 0, quiet=True); x, y = float(x[0]) - a['x0'], float(y[0]) - a['y0']; v = box_flux(a['img'], x, y)
            if v is not None: lam.append(float(F.wave(e['det'])(np.array([[y + a['y0'], x + a['x0']]]))[0])); flx.append(v)
        lam, flx = np.array(lam), np.array(flx); edges = np.r_[LAM[0] - 0.015, (LAM[1:] + LAM[:-1]) / 2, LAM[-1] + 0.02]
        s = np.array([np.median(flx[(lam >= a) & (lam < b)]) if ((lam >= a) & (lam < b)).any() else np.nan for a, b in zip(edges[:-1], edges[1:])])
        s = np.interp(LAM, LAM[np.isfinite(s)], s[np.isfinite(s)]); s = np.clip(s, 0, None); out['spectra'][t['name']] = (s / s[(LAM >= 4.0) & (LAM <= 5.0)].mean()).round(4).tolist()
        print(t['name'], len(lam), 'samples; J/H/3.3/4.1 =', [round(float(np.interp(v, LAM, out['spectra'][t['name']])), 2) for v in (1.27, 1.58, 3.3, 4.1)])
    json.dump(out, open(HERE + '/detector_v3_inject_spectra.json', 'w'))

_epsf = {}
def stamp(det, xdet, ydet, x, y):
    """7x7 native-pixel image (sum 1) of a point source at cutout position (x, y), from the cached ePSF zone nearest the
    detector position. -> (stamp, xi, yi) with the stamp centred on pixel (xi, yi).
    ponytail: normalised over 7x7, so the few percent of light in the far wings is folded in; fine for faint sources."""
    if det not in _epsf: z = np.load(f'{F.CACHE}/epsf/{det}.npz'); _epsf[det] = (z['xc'], z['yc'], z['psf'], int(z['oversample']))
    xc, yc, psf, ov = _epsf[det]; k = int(np.argmin((xc - xdet) ** 2 + (yc - ydet) ** 2)); xi, yi = int(round(x)), int(round(y)); c = (psf.shape[1] - 1) / 2
    J, I = np.mgrid[-3:4, -3:4]; s = ndi.map_coordinates(psf[k], [c + ov * (yi + J - y), c + ov * (xi + I - x)], order=1, cval=0); s = np.clip(s, 0, None)
    return s / s.sum(), xi, yi

def spectrum_fn(S, name, tilt, ch4):
    """Perturbed injection spectrum: relative f_nu(lam), tilted by (lam/4.5)^tilt, 2.9 to 3.7 um scaled by ch4."""
    lam = np.array(S['lam']); s = np.array(S['spectra'][name]) * (lam / 4.5) ** tilt; s = np.where((lam >= 2.9) & (lam <= 3.7), s * ch4, s)
    return lambda l: np.interp(l, lam, s), float(s[(lam >= 4.0) & (lam <= 5.0)].mean()), float(s[(lam >= 2.8) & (lam <= 3.9)].mean())

def inject(src, dst, E, adds):
    """Copy a field's exposures from src to dst, adding sources. adds: [dict(kind='mover', ra, dec, pme, pmn, plx, mjy45, spec=(name, tilt, ch4))
    | dict(kind='stamp'|'pixel', obs, det, ra, dec, snr) | dict(kind='detpix', obs, det, xdet, ydet, snr)]. -> rows of what was added."""
    S = json.load(open(HERE + '/detector_v3_inject_spectra.json')); os.makedirs(dst + '/exp', exist_ok=True); log = []
    fn = {i: spectrum_fn(S, *a['spec']) for i, a in enumerate(adds) if a['kind'] == 'mover'}
    def one(e):
        a = load(src, e); img = a['img'].copy(); n = 0; sig = 1.4826 * np.nanmedian(np.abs(img - np.nanmedian(img)))
        for i, q in enumerate(adds):
            if q['kind'] == 'mover':
                ra, dec = F.track(q['ra'], q['dec'], q['pme'], q['pmn'], q['plx'], a['t'], MJD_REF); x, y = a['w'].all_world2pix(ra, dec, 0, quiet=True); x, y = float(x[0]) - a['x0'], float(y[0]) - a['y0']
                if not (4 <= x < img.shape[1] - 4 and 4 <= y < img.shape[0] - 4): continue
                lam = float(F.wave(e['det'])(np.array([[y + a['y0'], x + a['x0']]]))[0]); f, m45, _ = fn[i]; tot = q['mjy45'] * f(lam) / m45 / (1e9 * OMEGA)       # MJy/sr summed over pixels
            elif q['obs'] != e['obs'] or q['det'] != e['det']: continue
            elif q['kind'] == 'detpix': x, y = q['xdet'] - a['x0'], q['ydet'] - a['y0']; tot = q['snr'] * 3 * sig
            else:
                x, y = a['w'].all_world2pix(q['ra'], q['dec'], 0, quiet=True); x, y = float(x) - a['x0'], float(y) - a['y0']; tot = q['snr'] * 3 * sig
            if not (4 <= x < img.shape[1] - 4 and 4 <= y < img.shape[0] - 4): continue
            if q['kind'] == 'pixel': img[int(round(y)), int(round(x))] += tot
            else: s, xi, yi = stamp(e['det'], x + a['x0'], y + a['y0'], x, y); img[yi - 3:yi + 4, xi - 3:xi + 4] += tot * s
            n += 1
            if q['kind'] != 'mover':
                ra, dec = a['w'].all_pix2world(x + a['x0'], y + a['y0'], 0); log.append(dict(i=i, obs=e['obs'], det=e['det'], ra=float(ra), dec=float(dec), t=a['t']))
        f_ = f"{dst}/{e['file']}"
        if n: np.savez_compressed(f_, img=img, flg=a['flg'], x0=a['x0'], y0=a['y0'], hdr=a['hdr'], t=a['t'])
        elif not os.path.exists(f_): os.symlink(os.path.realpath(f"{src}/{e['file']}"), f_)
        return n
    with ThreadPoolExecutor(8) as ex: n = list(ex.map(one, E))
    return log, int(np.sum(n))

def link_rest(src, dst, skip=()):
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(src):
        if f not in skip and f != 'exp' and not os.path.exists(f'{dst}/{f}'): os.symlink(os.path.realpath(f'{src}/{f}'), f'{dst}/{f}')
    if 'exp' not in skip and not os.path.exists(dst + '/exp'): os.symlink(os.path.realpath(src + '/exp'), dst + '/exp')

# ---------- catalogue rows ----------
def synth_row(rng, cw, ra, dec, pme, pmn, w1, w2):
    """One synthetic CatWISE2020 row for a source at (ra, dec) at MJD 57170 moving (pme, pmn) arcsec/yr: a real row of
    similar W2 from the same field donates its error columns and flags; position, motion and magnitudes are drawn
    around the truth with those errors times ERR_INFLATE."""
    ok = [r for r in cw if r['nb'] == '1' and np.isfinite(fl(r['w2mpro_pm'])) and np.isfinite(fl(r['sigpmra'])) and np.isfinite(fl(r['w1mpro_pm']))]
    dn = dict(sorted(ok, key=lambda r: abs(fl(r['w2mpro_pm']) - w2))[int(rng.integers(5))]); g = lambda k: fl(dn[k]) * ERR_INFLATE; cd = np.cos(np.radians(dec))
    a, d = ra + rng.normal(0, g('sigra_pm')) / 3600 / cd, dec + rng.normal(0, g('sigdec_pm')) / 3600; me, mn = pme + rng.normal(0, g('sigpmra')), pmn + rng.normal(0, g('sigpmdec'))
    dt = (fl(dn['meanobsmjd']) - MJD_CW) / 365.25; s1 = float(np.clip(fl(dn['w1sigmpro_pm']) * 10 ** (0.4 * (w1 - fl(dn['w1mpro_pm']))), 0.02, 9)) if np.isfinite(fl(dn['w1sigmpro_pm'])) else 9.0
    hh, dd = a / 15, abs(d); name = 'J%02d%02d%05.2f%s%02d%02d%04.1f' % (int(hh), int(hh * 60 % 60), hh * 3600 % 60, '+' if d >= 0 else '-', int(dd), int(dd * 60 % 60), dd * 3600 % 60)
    dn.update(source_name=name, source_id=dn['source_id'].split('-')[0] + '-%06d' % rng.integers(100000, 999999), ra_pm='%.7f' % a, dec_pm='%.7f' % d, pmra='%.5f' % me, pmdec='%.5f' % mn,
              ra='%.7f' % (a + me * dt / 3600 / cd), dec='%.7f' % (d + mn * dt / 3600), w2mpro_pm='%.3f' % (w2 + rng.normal(0, fl(dn['w2sigmpro_pm']))), par_pm='', par_pmsig='',
              w1mpro_pm='%.3f' % (w1 + rng.normal(0, min(s1, 0.5))) if s1 < 0.5 else '', w1sigmpro_pm='%.3f' % s1 if s1 < 0.5 else '', w1snr_pm='%.1f' % (1.0857 / s1))
    return dn

def near_any(ra, dec, rows, r_as, ka='ra', kd='dec', cond=None):
    return any(sep_as(ra, dec, fl(r[ka]), fl(r[kd])) < r_as for r in rows if abs(fl(r[kd]) - dec) * 3600 < r_as and (cond is None or cond(r)))

class Usable:
    def __init__(self, out_json):
        o = json.load(open(out_json)); z = np.load(os.path.dirname(out_json) + '/' + o['usable']['file']); self.ok, self.pix, self.ra0, self.dec0 = z['ok'], float(z['pix']), float(z['ra0']), float(z['dec0']); self.area = float(self.ok.sum() * (self.pix / 3600) ** 2)
    def at(self, ra, dec):
        x, y = F.tan(ra, dec, self.ra0, self.dec0); N = self.ok.shape[0]; ix, iy = int(round(float(x) / self.pix + (N - 1) / 2)), int(round(float(y) / self.pix + (N - 1) / 2))
        return bool(0 <= ix < N and 0 <= iy < N and self.ok[iy, ix])

# ---------- plant: truth, injected inputs ----------
def plant(which):
    S = json.load(open(HERE + '/detector_v3_inject_spectra.json')); FL = fields(which); seed = seed_of(which); rng = np.random.default_rng(int(hsh(seed)[:12], 16)); os.makedirs(f'{TRUTH}/{which}', exist_ok=True)
    U = {f['field']: Usable(f"{run_dir(which, f['field'], 'base')}/out.json") for f in FL if os.path.exists(f"{run_dir(which, f['field'], 'base')}/out.json")}
    CW = {n: read_csv(f'{F.CACHE}/{n}/catwise.csv') for n in U}; TM = {n: read_csv(f'{F.CACHE}/{n}/twomass.csv') for n in U}
    P = {f['field']: dict(movers=[], glitches=[], rejected=dict(usable=0, isolated=0, apart=0)) for f in FL}; names = sorted(U)
    taken = {f['field']: [(f['target']['ra'], f['target']['dec'])] if f.get('target') else [] for f in FL}
    def draw(n, w2, need_usable=True):
        """A position in field n: inside the patch margin, usable, isolated, apart from everything already there."""
        f = next(f for f in FL if f['field'] == n); half = f['size'] * 1800 - EDGE if 'size' in f else F.SIZE * 1800 - EDGE
        x, y = rng.uniform(-half, half, 2); ra, dec = (float(v) for v in F.untan(x, y, f['ra'], f['dec']))
        if need_usable and not U[n].at(ra, dec): return None, 'usable'
        if any(sep_as(ra, dec, a, d) < APART for a, d in taken[n]): return None, 'apart'
        return (ra, dec), None
    def mover(n, mu, w2):
        pos, why = draw(n, w2)
        if not pos: return None, why
        pa = rng.uniform(0, 2 * np.pi); pme, pmn = mu * np.sin(pa), mu * np.cos(pa); plx = 0.0 if rng.random() < 0.25 else float(rng.uniform(0, 0.25))
        spec = (INJ_FROM[int(rng.integers(len(INJ_FROM)))], float(rng.uniform(-0.3, 0.3)), float(np.exp(rng.uniform(np.log(0.5), np.log(2.0))))); _, m45, m33 = spectrum_fn(S, *spec)
        ra, dec = pos; a15, d15 = (float(v[0]) for v in F.track(ra, dec, pme, pmn, 0.0, MJD_CW, MJD_REF)); mjy = ZP_W2 * 1e3 * 10 ** (-0.4 * w2); w1 = -2.5 * np.log10(mjy * m33 / m45 / 1e3 / ZP_W1)
        if near_any(a15, d15, CW[n], ISOLATE, 'ra_pm', 'dec_pm') or near_any(ra, dec, CW[n], ISOLATE, 'ra_pm', 'dec_pm', lambda r: fl(r['w2mpro_pm']) < w2 + 1.0): return None, 'isolated'
        return dict(kind='mover', ra=ra, dec=dec, pme=float(pme), pmn=float(pmn), plx=plx, w2=float(w2), w1=float(w1), mjy45=float(mjy), spec=spec, cw=(a15, d15)), None
    # check 2 plants: bins in turn, fields in rotation
    k = 0
    for si in range(len(SPEED_BINS) - 1):
        for wi in range(len(W2_BINS) - 1):
            got = 0; tries = 0
            while got < N_BIN and tries < 4000:
                n = names[k % len(names)]; k += 1; tries += 1
                m, why = mover(n, float(np.exp(rng.uniform(np.log(SPEED_BINS[si]), np.log(SPEED_BINS[si + 1])))), float(rng.uniform(W2_BINS[wi], W2_BINS[wi + 1])))
                if not m: P[n]['rejected'][why] += 1; continue
                m.update(id=f'{n}-m{len(P[n]["movers"]) + 1:02d}', speed_bin=si, w2_bin=wi, row=bool(rng.random() < P_ROW)); P[n]['movers'].append(m); taken[n].append((m['ra'], m['dec'])); got += 1
    # check 4 artifacts
    for n in names:
        d = f'{F.CACHE}/{n}'; E = json.load(open(d + '/exposures.json')); E56 = sorted([e for e in E if e['det'] in ('D5', 'D6')], key=lambda e: e['t']); E6 = [e for e in E56 if e['det'] == 'D6']
        ps = F.passes([e['t'] for e in E6]); first = [e for e in E6 if e['t'] <= ps[0][-1]]; last = [e for e in E6 if e['t'] >= ps[-1][0]]; G = P[n]['glitches']
        def comp(ra, dec, t):
            """A CatWISE mover whose track passes (ra, dec) at time t."""
            mu = float(np.exp(rng.uniform(np.log(0.3), np.log(3.0)))); pa = rng.uniform(0, 2 * np.pi); pme, pmn = mu * np.sin(pa), mu * np.cos(pa); dt = (MJD_REF - t) / 365.25
            ra_r, dec_r = ra + pme * dt / 3600 / np.cos(np.radians(dec)), dec + pmn * dt / 3600; a15, d15 = (float(v[0]) for v in F.track(ra_r, dec_r, pme, pmn, 0.0, MJD_CW, MJD_REF))
            return dict(ra=float(ra_r), dec=float(dec_r), pme=float(pme), pmn=float(pmn), w2=float(rng.uniform(12.0, 14.5)), cw=(a15, d15))
        for j in range(N_G1 + N_G2):
            for _ in range(200):
                pos, why = draw(n, 13.0)
                if pos: break
            if not pos: continue
            taken[n].append(pos); paired = j >= N_G1; e = first[int(rng.integers(len(first)))] if paired else E56[int(rng.integers(len(E56)))]; kind = str(rng.choice(['stamp', 'pixel'])); snr = float(np.exp(rng.uniform(np.log(10), np.log(200))))
            c = comp(*pos, e['t']); adds = [dict(kind=kind, obs=e['obs'], det=e['det'], ra=pos[0], dec=pos[1], snr=snr)]
            if paired:
                e2 = last[int(rng.integers(len(last)))]; a2, d2 = (float(v[0]) for v in F.track(c['ra'], c['dec'], c['pme'], c['pmn'], 0.0, e2['t'], MJD_REF)); adds.append(dict(kind=kind, obs=e2['obs'], det=e2['det'], ra=a2, dec=d2, snr=snr))
            G.append(dict(type='pair' if paired else 'single', adds=adds, comp=c, at=[(q['ra'], q['dec']) for q in adds] + [(c['ra'], c['dec'])]))
        for j in range(N_G3):                                             # persistence: one detector pixel, four consecutive D6 exposures
            runs = [i for i in range(len(E6) - 3) if E6[i + 3]['t'] - E6[i]['t'] < 0.02]
            if not runs: break
            i = runs[int(rng.integers(len(runs)))]; a = load(d, E6[i]); xd, yd = a['x0'] + rng.uniform(20, a['img'].shape[1] - 20), a['y0'] + rng.uniform(20, a['img'].shape[0] - 20); snr = float(np.exp(rng.uniform(np.log(30), np.log(300))))
            ra, dec = (float(v) for v in a['w'].all_pix2world(xd, yd, 0)); c = comp(ra, dec, E6[i]['t'])
            G.append(dict(type='persistence', adds=[dict(kind='detpix', obs=E6[i + q]['obs'], det='D6', xdet=float(xd), ydet=float(yd), snr=snr * 0.5 ** q) for q in range(4)], comp=c, at=[(ra, dec), (c['ra'], c['dec'])]))
        bright = sorted([r for r in TM[n] if fl(r['k_m']) < 9.5], key=lambda r: fl(r['k_m']))
        for j in range(min(N_G4, len(bright))):                           # a CatWISE mover whose 2026 position sits at a bright star's mask edge
            r = bright[int(rng.integers(len(bright)))]; rad = (20 + 25 * max(9 - fl(r['k_m']), 0)) * rng.uniform(0.6, 1.3); th = rng.uniform(0, 2 * np.pi)
            ra, dec = fl(r['ra']) + rad * np.sin(th) / 3600 / np.cos(np.radians(fl(r['dec']))), fl(r['dec']) + rad * np.cos(th) / 3600; c = comp(ra, dec, MJD_REF)
            G.append(dict(type='mask_edge', adds=[], comp=c, star_k=fl(r['k_m']), at=[(ra, dec)]))
    # write inputs
    cols = list(next(iter(CW.values()))[0].keys()) if CW else []
    def write(n):
        src = f'{F.CACHE}/{n}'; E = json.load(open(src + '/exposures.json')); rr = np.random.default_rng(int(hsh(seed + n)[:12], 16)); T = P[n]
        d = run_dir(which, n, 'mov'); shutil.rmtree(d, ignore_errors=True); _, T['mover_pixels_added'] = inject(src, d, E, T['movers'])
        rows = list(CW[n]) + [synth_row(rr, CW[n], *m['cw'], m['pme'], m['pmn'], m['w1'], m['w2']) for m in T['movers'] if m['row']]; rows.sort(key=lambda r: fl(r['dec']))
        write_csv(d + '/catwise.csv', rows, cols); link_rest(src, d, ('catwise.csv', 'exp'))
        d = run_dir(which, n, 'gli'); shutil.rmtree(d, ignore_errors=True); adds = [a for g in T['glitches'] for a in g['adds']]; log, T['glitch_pixels_added'] = inject(src, d, E, adds)
        for g in T['glitches']: g['seen_in_inputs'] = sum(any(l['obs'] == a['obs'] and l['det'] == a['det'] for l in log) for a in g['adds'])
        rows = list(CW[n]) + [synth_row(rr, CW[n], *g['comp']['cw'], g['comp']['pme'], g['comp']['pmn'], g['comp']['w2'] + 2.5, g['comp']['w2']) for g in T['glitches']]; rows.sort(key=lambda r: fl(r['dec']))
        write_csv(d + '/catwise.csv', rows, cols); link_rest(src, d, ('catwise.csv', 'exp'))
        for i, (kind, de, dn) in enumerate(NULLS):
            d = run_dir(which, n, f'null{i}'); shutil.rmtree(d, ignore_errors=True); rows = []
            for r in CW[n]:
                r = dict(r)
                if kind == 'shift':
                    for ka, kd in (('ra', 'dec'), ('ra_pm', 'dec_pm')): r[ka] = '%.7f' % (fl(r[ka]) + de / 3600 / np.cos(np.radians(fl(r[kd])))); r[kd] = '%.7f' % (fl(r[kd]) + dn / 3600)
                else:
                    for k_ in ('pmra', 'pmdec'): r[k_] = '%.5f' % (-fl(r[k_])) if np.isfinite(fl(r[k_])) else r[k_]
                rows.append(r)
            os.makedirs(d, exist_ok=True); write_csv(d + '/catwise.csv', rows, cols); link_rest(src, d, ('catwise.csv',))
        json.dump(T, open(f'{TRUTH}/{which}/{n}.json', 'w'), indent=1); print(n, len(T['movers']), 'movers', len(T['glitches']), 'artifacts', T['rejected'], flush=True)
    for n in names: write(n)

# ---------- running the detector ----------
def detect(d):
    if os.path.exists(d + '/out.json'): return 0
    r = subprocess.run([sys.executable, '-I', HERE + '/detector_v3.py', 'run', d, d + '/out.json'], capture_output=True, text=True)
    open(d + '/detector.log', 'w').write(r.stdout + r.stderr); return r.returncode

def base(which):
    for f in fields(which):
        n = f['field']; d = run_dir(which, n, 'base')
        if not os.path.exists(f'{F.CACHE}/{n}/manifest.json'): print(n, 'no manifest: INVALID field'); continue
        link_rest(f'{F.CACHE}/{n}', d)
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(detect, [run_dir(which, f['field'], 'base') for f in fields(which) if os.path.exists(f"{F.CACHE}/{f['field']}/manifest.json")]))
    print('baseline runs, return codes', rc)

def runs(which):
    ds = [run_dir(which, f['field'], v) for f in fields(which) for v in ['mov', 'gli'] + [f'null{i}' for i in range(len(NULLS))] if os.path.exists(f"{TRUTH}/{which}/{f['field']}.json")]
    with ThreadPoolExecutor(4) as ex: rc = list(ex.map(detect, ds))
    print(len(ds), 'runs, non-zero return codes:', sum(r != 0 for r in rc))

# ---------- score ----------
def one_to_one(cands, truths, key=lambda t: (t['ra'], t['dec'])):
    """Greedy nearest matching within MATCH arcsec. -> {truth index: candidate index}"""
    pairs = sorted((sep_as(c['ra'], c['dec'], *key(t)), i, j) for j, c in enumerate(cands) for i, t in enumerate(truths) if abs(c['dec'] - key(t)[1]) * 3600 < MATCH)
    out, used = {}, set()
    for s, i, j in pairs:
        if s <= MATCH and i not in out and j not in used: out[i] = j; used.add(j)
    return out

def score(which):
    FL = fields(which); R = {}; rows = []; detail = dict(seed=seed_of(which))
    get = lambda n, v: (json.load(open(f'{run_dir(which, n, v)}/out.json')) if os.path.exists(f'{run_dir(which, n, v)}/out.json') else None)
    B = {f['field']: get(f['field'], 'base') for f in FL}; T = {f['field']: json.load(open(f'{TRUTH}/{which}/{f["field"]}.json')) for f in FL if os.path.exists(f'{TRUTH}/{which}/{f["field"]}.json')}
    # 1 held-out dwarfs
    H = []
    for f in FL:
        if f['kind'] != 'dwarf': continue
        t = f['target']; o = B[f['field']]; r = dict(field=f['field'], name=t['name'], stratum=t.get('stratum'), pm=t['pm'], w2=t['w2'], spt=t.get('spt_text'))
        if o is None: r.update(outcome='INVALID', why='no baseline output (field missing or detector failed)'); H.append(r); continue
        m = one_to_one(o['candidates'], [t]); mv = one_to_one(o['movers'], [t])
        if 0 in m:
            c = o['candidates'][m[0]]; ok, sp, ang = motion_ok(c['pm_e'], c['pm_n'], t['pme'], t['pmn']); r.update(rank=m[0] + 1, n_candidates=len(o['candidates']), speed_ratio=sp, angle=ang, pm_measured=float(np.hypot(c['pm_e'], c['pm_n'])),
                                                                                                             outcome='recovered' if ok and m[0] < TOP else 'missed', why='' if ok and m[0] < TOP else ('motion off' if not ok else 'rank'))
        else:
            q = o['movers'][mv[0]] if 0 in mv else None; r.update(outcome='missed', n_candidates=len(o['candidates']), why=(f"mover record: stage {q['stage']}, verdict {q['verdict']}" if q else 'no mover record at its position'))
        H.append(r)
    v = [r for r in H if r['outcome'] != 'INVALID']; k = sum(r['outcome'] == 'recovered' for r in v); n = len(v)
    ci = (float(beta.ppf(0.05, k, n - k + 1)) if k else 0.0, float(beta.ppf(0.95, k + 1, n - k)) if k < n else 1.0) if n else (0, 1)
    rows.append(('1 held-out T dwarfs', f'at least {RECOVER:.0%} recovered (top {TOP}, motion within {SPEED:.0%} and {ANGLE:.0f} deg)', f'{k} of {n} ({len(H) - n} invalid)', f'{ci[0]:.2f} to {ci[1]:.2f} (90%)',
                 'INVALID' if n < 8 else 'PASS' if k / n >= RECOVER else 'FAIL')); detail['heldout'] = H
    # 2 plants
    PL = []
    for n_, t in T.items():
        o = get(n_, 'mov')
        m = one_to_one(o['candidates'], t['movers']) if o else {}
        for i, p in enumerate(t['movers']):
            c = o['candidates'][m[i]] if i in m else None; ok = bool(c and motion_ok(c['pm_e'], c['pm_n'], p['pme'], p['pmn'])[0])
            mv = one_to_one(o['movers'], [p]) if o and not ok else {}
            PL.append(dict(id=p['id'], speed_bin=p['speed_bin'], w2_bin=p['w2_bin'], w2=p['w2'], mu=float(np.hypot(p['pme'], p['pmn'])), plx=p['plx'], row=p['row'], spec=p['spec'][0], found=ok,
                           why='' if ok else ('no detector output' if not o else 'candidate with wrong motion' if c else (f"stage {o['movers'][mv[0]]['stage']}, verdict {o['movers'][mv[0]]['verdict']}" if 0 in mv else 'no mover record'))))
    ns, nw = len(SPEED_BINS) - 1, len(W2_BINS) - 1; grid = [[[p['found'] for p in PL if p['speed_bin'] == s and p['w2_bin'] == w] for w in range(nw)] for s in range(ns)]
    pooled = [sum(sum(grid[s][w]) for s in range(ns)) / max(1, sum(len(grid[s][w]) for s in range(ns))) for w in range(nw)]
    if which == 'dev':
        lim = W2_BINS[0]
        for w in range(nw):
            if pooled[w] >= LIMIT_DEV: lim = W2_BINS[w + 1]
            else: break
        detail['proposed_limit_w2'] = lim
    else: lim = json.load(open(HERE + '/detector_v3_frozen.json'))['w2_limit']
    above = [(s, w) for s in range(ns) for w in range(nw) if W2_BINS[w + 1] <= lim + 1e-9]; cells = {f'{SPEED_BINS[s]}-{SPEED_BINS[s + 1]} x {W2_BINS[w]}-{W2_BINS[w + 1]}': f'{sum(grid[s][w])}/{len(grid[s][w])}' for s in range(ns) for w in range(nw)}
    tot = [x for s, w in above for x in grid[s][w]]; full = all(len(grid[s][w]) == N_BIN for s, w in above); okb = all(sum(grid[s][w]) >= RECOVER * len(grid[s][w]) for s, w in above) and bool(tot) and sum(tot) >= RECOVER * len(tot)
    worst = min(((sum(grid[s][w]) / max(1, len(grid[s][w])), f'{SPEED_BINS[s]}-{SPEED_BINS[s + 1]} arcsec/yr, W2 {W2_BINS[w]}-{W2_BINS[w + 1]}') for s, w in above), default=(0, 'none'))
    rows.append(('2 planted dwarfs above the limit', f'every speed x flux bin brighter than W2 {lim} at least {RECOVER:.0%}, and pooled', f'{sum(tot)} of {len(tot)} pooled; worst bin {worst[0]:.0%} ({worst[1]})',
                 f"rejected draws: {{k: sum(t['rejected'][k] for t in T.values()) for k in ('usable', 'isolated', 'apart')}}".replace('{{', '').replace('}}', '') if False else str({k_: sum(t['rejected'][k_] for t in T.values()) for k_ in ('usable', 'isolated', 'apart')}),
                 'INVALID' if (not above or not full) else 'PASS' if okb else 'FAIL')); detail['plants'] = dict(limit_w2=lim, cells=cells, pooled_by_w2=dict(zip([f'{a}-{b}' for a, b in zip(W2_BINS[:-1], W2_BINS[1:])], pooled)), list=PL)
    # 3 false candidates
    UC = [r for r in read_csv(F.CACHE + '/ucs/UltracoolSheet-Main.csv') if fl(r['sptnum_formula']) >= 20 and r['ra_20250703_formula'] not in ('', 'NaN')]
    def verified(c):
        for r in UC:
            if abs(fl(r['dec_20250703_formula']) - c['dec']) > 0.01: continue
            pe, pn = fl(r['pmra_formula']) / 1000, fl(r['pmdec_formula']) / 1000; dt = (MJD_REF - 60859.0) / 365.25
            if sep_as(c['ra'], c['dec'], fl(r['ra_20250703_formula']) + pe * dt / 3600 / np.cos(np.radians(c['dec'])), fl(r['dec_20250703_formula']) + pn * dt / 3600) <= MATCH and np.isfinite(pe) and motion_ok(c['pm_e'], c['pm_n'], pe, pn)[0]: return r['name']
        return None
    false, area, plane_area, per = [], 0.0, 0.0, {}
    for f in FL:
        o = B[f['field']]
        if o is None: per[f['field']] = dict(area=0.0, note='no output'); continue
        a = o['usable']['area_sqdeg']; area += a; plane_area += a if f['kind'] == 'plane' or (which == 'dev' and f['kind'] == 'barnard') else 0; fc = []
        for c in o['candidates']:
            if f['kind'] == 'dwarf' and sep_as(c['ra'], c['dec'], f['target']['ra'], f['target']['dec']) <= MATCH: continue
            nm = verified(c)
            if nm: per.setdefault('verified_dwarfs', []).append(dict(field=f['field'], name=nm)); continue
            fc.append(dict(field=f['field'], ra=c['ra'], dec=c['dec'], pm=float(np.hypot(c['pm_e'], c['pm_n'])), score=c.get('score'), id=c.get('id')))
        false += fc; per[f['field']] = dict(area=a, false=len(fc), kind=f['kind'])
    ub = float(chi2.ppf(0.95, 2 * (len(false) + 1)) / 2 / area) if area > 0 else float('inf'); nul = {}
    for i, (kind, de, dn) in enumerate(NULLS):
        os_ = [get(f['field'], f'null{i}') for f in FL]; nul[f'{kind} {de} {dn}'] = dict(candidates=sum(len(o['candidates']) for o in os_ if o), runs=sum(o is not None for o in os_))
    rows.append(('3 false candidates', f'95% upper bound under {CAP} per sq deg over at least {MIN_AREA} usable sq deg incl. a |b| 10-20 field', f'{len(false)} in {area:.2f} usable sq deg ({plane_area:.2f} in the plane field); nulls: ' + ', '.join(f"{k_}: {v_['candidates']}" for k_, v_ in nul.items()),
                 f'upper bound {ub:.2f} per sq deg', 'FAIL' if (len(false) and ub >= CAP and area >= MIN_AREA) or float(chi2.ppf(0.95, 2 * (len(false) + 1)) / 2 / max(area, MIN_AREA)) >= CAP and len(false) > 0 else 'INVALID' if (area < MIN_AREA or plane_area <= 0.05) else 'PASS' if ub < CAP else 'FAIL'))
    detail['false'] = dict(list=false, area=area, per_field=per, nulls=nul)
    # 4 artifacts
    hits, n_art, unseen, movs = [], 0, 0, 0
    for n_, t in T.items():
        o = get(n_, 'gli'); b = B[n_]
        if not o: detail.setdefault('artifact_runs_missing', []).append(n_); continue
        for g in t['glitches']:
            n_art += 1; unseen += g['type'] != 'mask_edge' and g.get('seen_in_inputs', 0) < len(g['adds'])
            near = lambda c: any(sep_as(c['ra'], c['dec'], a, d) <= NEAR_GLITCH for a, d in g['at'])
            hits += [dict(field=n_, type=g['type'], ra=c['ra'], dec=c['dec']) for c in o['candidates'] if near(c) and not any(sep_as(c['ra'], c['dec'], q['ra'], q['dec']) <= MATCH for q in (b or {}).get('candidates', []))]
            movs += sum(near(c) for c in o['movers'])
    fli = next((f for f in FL if f['kind'] == 'flash'), None); flash = 'not in this set'
    if fli:
        d = f"{F.CACHE}/{fli['field']}"; E = json.load(open(d + '/exposures.json')) if os.path.exists(d + '/exposures.json') else []; e = next((e for e in E if e['obs'] == fli['flash']['obs'] and e['det'] == fli['flash']['det']), None); flash = 'INVALID: exposure not in the inputs'
        if e:
            a = load(d, e); x, y = a['w'].all_world2pix(fli['flash']['ra'], fli['flash']['dec'], 0, quiet=True); x, y = int(round(float(x))) - a['x0'], int(round(float(y))) - a['y0']
            if 3 <= x < a['img'].shape[1] - 3 and 3 <= y < a['img'].shape[0] - 3:
                pk = float(np.nanmax(a['img'][y - 2:y + 3, x - 2:x + 3]) - np.nanmedian(a['img'])); sg = float(1.4826 * np.nanmedian(np.abs(a['img'] - np.nanmedian(a['img'])))); fc = [c for v_ in ('base', 'gli') for c in ((get(fli['field'], v_) or {}).get('candidates', [])) if sep_as(c['ra'], c['dec'], fli['flash']['ra'], fli['flash']['dec']) <= NEAR_FLASH]
                flash = f'present ({pk / sg:.0f} sigma peak in its exposure), {len(fc)} candidates within {NEAR_FLASH:.0f} arcsec' if pk > 5 * sg else f'INVALID: no {5} sigma peak at its position in the exposure ({pk / sg:.1f})'; hits += [dict(field=fli['field'], type='flash', ra=c['ra'], dec=c['dec']) for c in fc]
    rows.append(('4 artifacts', '0 candidates on planted glitches, persistence, mask-edge rows, or the flash', f'{len(hits)} candidates on {n_art} artifacts ({movs} mover records of any verdict near them; {unseen} artifacts not fully inside the inputs); flash: {flash}', '',
                 'FAIL' if hits else 'INVALID' if (n_art == 0 or 'INVALID' in flash or detail.get('artifact_runs_missing')) else 'PASS')); detail['artifacts'] = dict(hits=hits, n=n_art, flash=flash)
    # 5 non-dwarf controls
    C = []
    for f in FL:
        if f['kind'] not in ('mdwarf', 'barnard'): continue
        t = f['target']; o = B[f['field']]; mv = one_to_one(o['movers'], [t]) if o else {}; q = o['movers'][mv[0]] if 0 in mv else None; cold = bool(o and one_to_one(o['candidates'], [t]))
        C.append(dict(field=f['field'], kind=f['kind'], name=t['name'], pm=float(np.hypot(t['pme'], t['pmn'])), cold=cold, stage=q['stage'] if q else 'no mover record', verdict=q['verdict'] if q else None,
                      valid=bool(q and q.get('spectrum_valid') and q['verdict'] == 'not_cold'), pm_measured=float(np.hypot(q['pm_e'], q['pm_n'])) if q else None))
    g = [c for c in C if c['kind'] == 'mdwarf']; nc, nv = sum(c['cold'] for c in g), sum(c['valid'] for c in g); need = 5 if which == 'final' else max(1, len(g))
    rows.append(('5 non-dwarf movers', f'0 called cold and at least {need} of {len(g)} with a valid non-methane verdict', f'{nc} cold, {nv} of {len(g)} valid not_cold' + ''.join(f"; {c['name']}: {c['stage']}, {c['verdict']}" for c in C if c['kind'] == 'barnard'), '',
                 'FAIL' if nc else 'PASS' if nv >= need else 'INVALID')); detail['controls'] = C
    table = '| check | bar | measured | interval or note | result |\n|---|---|---|---|---|\n' + '\n'.join('| ' + ' | '.join(r) + ' |' for r in rows)
    os.makedirs(f'{F.OUT}/eval_{which}', exist_ok=True); open(f'{F.OUT}/eval_{which}/table.md', 'w').write(table + '\n'); json.dump(dict(rows=rows, detail=detail), open(f'{F.OUT}/eval_{which}/eval.json', 'w'), indent=1, default=float)
    print(table); print('recovery by bin (speed x W2):'); [print(' ', k_, v_) for k_, v_ in cells.items()]
    if which == 'dev': print('proposed W2 limit from development plants:', detail['proposed_limit_w2'])
    for r in H: print(' ', r)
    for c in C: print(' ', c)

def demo():
    """Self-check of the scoring pieces (no data needed)."""
    assert motion_ok(1.0, 0.0, 1.1, 0.1)[0] and not motion_ok(1.0, 0.0, 1.3, 0.0)[0] and not motion_ok(1.0, 0.0, 0.9, 0.4)[0]
    t = [dict(ra=10.0, dec=0.0), dict(ra=10.001, dec=0.0)]; c = [dict(ra=10.0004, dec=0.0), dict(ra=10.0011, dec=0.0)]; assert one_to_one(c, t) == {1: 1, 0: 0}
    assert one_to_one([dict(ra=10.0005, dec=0.0)], t) in ({0: 0}, {1: 0}) and abs(chi2.ppf(0.95, 2) / 2 - 2.996) < 1e-3
    print('ok')

if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'demo': demo()
    elif c == 'spectra': spectra()
    else: dict(base=base, plant=plant, runs=runs, score=score)[c](sys.argv[2])
