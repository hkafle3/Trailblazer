"""Colors tab, the reference (Python). The page's Web Worker (web/live/colorsworker.js, math in web/live/colors.js) is held
to this file by web/tests/colors_parity.mjs; the science is held to the lead-check analysis by colors_eval.py (E1, E3).

What it computes for one star (one candidate position), from one field directory (catalogue CSVs plus SPHEREx cutouts):
  1. inputs: CatWISE2020, AllWISE, 2MASS PSC and Gaia DR3 (with phot_variable_flag) in a 0.275 deg cone; the SPHEREx
     cutouts are detector_v3_fetch's footprint (a 0.3 deg box plus 60 arcsec, plus 8 px), and only exposures with the
     star on them are used. The star is the catalogued component within 2 arcsec; its 2MASS match is AAA (Ks mode) or
     not (W1 mode).
  2. comparison stars: spectrum.py's rule (AAA, Ks within 1.5 mag and fainter than 9, one decade component, no CatWISE
     neighbour within 15 arcsec less than 2.5 mag fainter, colours within (0.12, 0.10, 0.10, 0.10) x s, s stepping
     1, 1.5, 2, 3, 5, 8 until 12 qualify). Two changes: Gaia DR3's VARIABLE flag replaces VSX, VarWISE and SIMBAD (they
     are not at IRSA), and a comparison whose 3 to 5 um flux moves between passes by over 3 sigma is dropped.
  3. photometry: detector_v4.prep exactly (BAD bits incl. 22-24, OVERFLOW and BLOOM grown 3 px, 16 px mesh background,
     aperture noise, Gaia shift); the per-detector PSF rule of phot_lead.psfs (20 isolated-star stamps or the detector is
     dropped), from every exposure rather than a random 60 (no random generator to port); the forced PSF fit is solved on a
     15 x 15 stamp around each measured star (that star, every component reaching the stamp, 8 px tile constants), not over
     the whole field.
  4. spectrum and fit: spectrum.py's binned(), passes by decade.pass_groups, template = per-bin median of flux / Ks flux
     (spread 1.4826 MAD, 5 stars a bin), star only (a) and star + blackbody (a, b, T on 200..2500 K by 10 K), the bare star
     and excess on the D1-D3 star-only scale aS.
  5. fingerprints with the thresholds of plan.md (rise, temperature, spikes, ice dips, seams), each inconclusive alone when
     its own data are missing, all inconclusive on a poor fit (chi2/dof over 3) or a saturated star.
  6. the 2000 and 2010 points: catalogue flux x the comparisons' median SPHEREx / catalogue ratio (extract.py's rule).

Run: python -I bake/colors_ref.py <field_dir> <ra> <dec> <out.json> [--rows measurements.npy]
Field dir: twomass.csv catwise.csv allwise.csv gaia.csv exposures.json exp/*.npz (detector_v3_fetch format).
"""
import sys, os, re, json, csv, numpy as np
from concurrent.futures import ProcessPoolExecutor
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AS = 206264.806
MJD_CW, MJD_GAIA = 57170.0, 57388.5
W1_MAX, W2_MAX, AW_BRIGHT, R_MERGE = 16.5, 16.0, 10.0, 6.0
PH, TILE = 7, 8
MJY_PIX = 1e9 * (6.15 / AS) ** 2
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 27, 28, 29))
GROW = (1 << 1) | (1 << 26)
SAT = (1 << 1) | (1 << 15)                    # OVERFLOW, NONLINEAR: the blink's saturation rule (3 x 3 core)
DETS = ('D1', 'D2', 'D3', 'D4', 'D5', 'D6')
EDGES = np.exp(np.arange(np.log(0.75), np.log(5.0) + 1e-9, 1 / 40.0)); EDGES[-1] = 5.0
CEN = np.sqrt(EDGES[1:] * EDGES[:-1])
DETEDGE = [1.10, 1.64, 2.42, 3.82, 4.42]
ZP = dict(J=1594e3, H=1024e3, K=666.7e3, W1=309.54e3, W2=171.79e3)
WIN = dict(J=(1.11, 1.39), H=(1.50, 1.80), K=(2.00, 2.31))
WL = dict(J=1.235, H=1.662, K=2.159, W1=3.35, W2=4.60)
STAR_R, VAR_R, CROWD_R, MIN_COMP = 2.0, 5.0, 15.0, 12
SCALES = (1.0, 1.5, 2.0, 3.0, 5.0, 8.0)
TGRID = np.arange(200, 2501, 10.0)
LINES = dict(spike=((3.29, 'PAH 3.29'), (4.05, 'Br alpha 4.05')), dip=((3.0, 'water ice 3.0'), (4.27, 'CO2 ice 4.27')))
SEAMS = (3.82, 4.42)
REQUIRED = dict(twomass=('designation', 'ra', 'dec', 'j_m', 'h_m', 'k_m', 'j_cmsig', 'h_cmsig', 'k_cmsig', 'ph_qual', 'jdate'),
                catwise=('source_name', 'source_id', 'ra', 'dec', 'ra_pm', 'dec_pm', 'pmra', 'pmdec', 'sigpmra', 'sigpmdec', 'w1mpro_pm', 'w1sigmpro_pm', 'w2mpro_pm', 'w2sigmpro_pm', 'nb', 'ab_flags', 'cc_flags'),
                allwise=('designation', 'ra', 'dec', 'w1mpro', 'w1sigmpro', 'w2mpro', 'w2sigmpro', 'nb', 'cc_flags', 'w1mjdmean', 'w2mjdmean'),
                gaia=('source_id', 'ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag', 'phot_variable_flag'),
                simbad=('main_id', 'otype', 'ra', 'dec'), vsx=('OID', 'Name', 'Type', 'RAJ2000', 'DEJ2000'))
# SIMBAD object types that make a star a known variable or young star (decade.py's VAR_OTYPE, the list lead-check used;
# matched as a substring of the type). Plan deviation 1.
VAR_OTYPE = re.compile(r'(V\*|Ir\*|Or\*|Er\*|RI\*|FU\*|Y\*O|Y\*\?|TT\*|Ae\*|pr\*|LP\*|Mi\*|RR\*|Ce\*|EB\*|El\*|dS\*|Ro\*|BY\*|RS\*|AGN|QSO|Sy1|Sy2|SyG|Bla|BLL|No\*|CV\*|SN\*|C\*|S\*|AB\*|OH\*|WR\*|bC\*|gD\*|Pu\*|HH|YSO|TTS|Ext|Be\*)')
# the self-check's systematic floor: fractional error added to each pass's 3 to 5 um band mean, calibrated by
# bake/colors_calib.py on quiet stars of SPOT2 and a27 only (plan deviation 1)
SYS_FLOOR = 0.0225                             # colors-build/ref/calib.json: 352 pass pairs of 122 quiet stars, robust spread 1.00 (3.17 without)
# the comparison-choice systematic: bootstrap resamplings of the comparison stars, seeded (mulberry32, shared with colors.js)
BOOT_N, BOOT_SEED = 200, 20261118
fl = lambda v: float(v) if v not in ('', 'null', 'NaN', 'nan', None) else float('nan')
mag2mjy = lambda m, b: ZP[b] * 10 ** (-0.4 * m)


class Refused(Exception):
    """An input this method cannot use (a catalogue missing a column): the result is inconclusive, never guessed."""


def read_vsx(path):
    """VizieR ASU-TSV: '#' comments, a header row, a units row and a dashes row, then tab-separated rows."""
    L = [l.rstrip('\n') for l in open(path) if l.strip() and not l.startswith('#')]
    if not L or not L[0].startswith('OID'): raise Refused('the vsx catalogue is not a VizieR table')
    head = [h.strip() for h in L[0].split('\t')]
    miss = [c for c in REQUIRED['vsx'] if c not in head]
    if miss: raise Refused(f'the vsx catalogue lacks {", ".join(miss)}')
    return [dict(zip(head, (v.strip() for v in l.split('\t')))) for l in L[3:]]


def read_csv(path, name):
    with open(path, newline='') as f: R = list(csv.DictReader(f))
    cols = set(R[0].keys()) if R else set(open(path).readline().strip().split(','))
    miss = [c for c in REQUIRED[name] if c not in cols]
    if miss: raise Refused(f'the {name} catalogue lacks {", ".join(miss)}')
    return R


def tan(ra, dec, ra0, dec0):
    a, d, a0, d0 = (np.radians(np.asarray(v, float)) for v in (ra, dec, ra0, dec0)); c = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    return AS * np.cos(d) * np.sin(a - a0) / c, AS * (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / c


def sep_as(ra1, dec1, ra2, dec2):
    a1, d1, a2, d2 = (np.radians(np.asarray(v, float)) for v in (ra1, dec1, ra2, dec2))
    return np.degrees(np.arccos(np.clip(np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(a1 - a2), -1, 1))) * 3600


# ---------- components: decade.components and decade.merge, unchanged ----------
def components(C, A, G):
    C = [r for r in C if fl(r['w1mpro_pm']) < W1_MAX or fl(r['w2mpro_pm']) < W2_MAX]
    ra = np.array([fl(r['ra_pm']) for r in C]); dec = np.array([fl(r['dec_pm']) for r in C])
    pme = np.array([fl(r['pmra']) for r in C]); pmn = np.array([fl(r['pmdec']) for r in C])
    spe = np.array([fl(r['sigpmra']) for r in C]); spn = np.array([fl(r['sigpmdec']) for r in C])
    with np.errstate(invalid='ignore', divide='ignore'):
        sig = np.hypot(pme / np.where(spe > 0, spe, np.inf), pmn / np.where(spn > 0, spn, np.inf))
    keep = np.nan_to_num(sig) > 3; pme = np.where(keep, pme, 0.0); pmn = np.where(keep, pmn, 0.0)
    gsrc = np.full(len(C), -1, np.int64)
    if G:
        g = np.array([[fl(r['ra']), fl(r['dec']), fl(r['pmra']), fl(r['pmdec'])] for r in G]); dt = (MJD_CW - MJD_GAIA) / 365.25
        gra = g[:, 0] + g[:, 2] * dt / 3.6e6 / np.cos(np.radians(g[:, 1])); gdec = g[:, 1] + g[:, 3] * dt / 3.6e6
        x0, y0 = tan(gra, gdec, ra.mean(), dec.mean()); x1, y1 = tan(ra, dec, ra.mean(), dec.mean())
        dd, j = cKDTree(np.c_[x0, y0]).query(np.c_[x1, y1])
        m = dd < 1.0; ra[m], dec[m], pme[m], pmn[m] = gra[j[m]], gdec[j[m]], g[j[m], 2] / 1000, g[j[m], 3] / 1000
        gsrc[m] = [int(G[k]['source_id']) for k in j[m]]
    out = dict(ra=ra, dec=dec, pme=pme, pmn=pmn, w1=np.array([fl(r['w1mpro_pm']) for r in C]), w2=np.array([fl(r['w2mpro_pm']) for r in C]),
               e1=np.array([fl(r['w1sigmpro_pm']) for r in C]), e2=np.array([fl(r['w2sigmpro_pm']) for r in C]), gaia=gsrc,
               name=np.array([r['source_name'] for r in C]), src=np.array(['cw'] * len(C)), sid=np.array([r['source_id'] for r in C]),
               nb=np.array([int(fl(r['nb'])) if r['nb'] else 1 for r in C]), ab=np.array([r['ab_flags'] or '00' for r in C]), cc=np.array([(r['cc_flags'] or '0000')[:2] for r in C]))
    aw = [r for r in A if fl(r['w1mpro']) < AW_BRIGHT]
    if aw:
        ax, ay = tan(np.array([fl(r['ra']) for r in aw]), np.array([fl(r['dec']) for r in aw]), ra.mean(), dec.mean())
        cx, cy = tan(out['ra'], out['dec'], ra.mean(), dec.mean()); dd, _ = cKDTree(np.c_[cx, cy]).query(np.c_[ax, ay])
        add = [r for r, q in zip(aw, dd) if q > 3.0]
        for k, v in dict(ra=[fl(r['ra']) for r in add], dec=[fl(r['dec']) for r in add], pme=[0.0] * len(add), pmn=[0.0] * len(add),
                         w1=[fl(r['w1mpro']) for r in add], w2=[fl(r['w2mpro']) for r in add], e1=[fl(r['w1sigmpro']) for r in add],
                         e2=[fl(r['w2sigmpro']) for r in add], gaia=[-1] * len(add), name=[r['designation'] for r in add], src=['aw'] * len(add),
                         sid=[r['designation'] for r in add], nb=[int(fl(r['nb'])) for r in add], ab=['00'] * len(add), cc=[(r['cc_flags'] or '0000')[:2] for r in add]).items():
            out[k] = np.concatenate([out[k], np.array(v, dtype=out[k].dtype)])
    return merge(out)


def merge(K):
    n = len(K['ra']); x, y = tan(K['ra'], K['dec'], K['ra'].mean(), K['dec'].mean()); par = np.arange(n)
    def root(i):
        while par[i] != i: par[i] = par[par[i]]; i = par[i]
        return i
    for i, j in sorted(cKDTree(np.c_[x, y]).query_pairs(R_MERGE)): par[root(i)] = root(j)
    r = np.array([root(i) for i in range(n)]); groups = {}
    for i in range(n): groups.setdefault(r[i], []).append(i)
    f = lambda m: np.where(np.isfinite(m), 10 ** (-0.4 * m), 0.0)
    F1, F2 = f(K['w1']), f(K['w2']); wt = np.where(F1 + F2 > 0, F1 + F2, 1e-12); out = {k: [] for k in list(K) + ['nmem', 'members']}
    for g in groups.values():
        g = np.array(g); b = g[np.argmax(wt[g])]
        for k in K: out[k].append(K[k][b])
        if len(g) > 1:
            out['ra'][-1] = float((K['ra'][g] * wt[g]).sum() / wt[g].sum()); out['dec'][-1] = float((K['dec'][g] * wt[g]).sum() / wt[g].sum())
            for m, e, FF in (('w1', 'e1', F1), ('w2', 'e2', F2)):
                tot = FF[g].sum(); out[m][-1] = -2.5 * np.log10(tot) if tot > 0 else np.nan
                out[e][-1] = float(np.sqrt(np.nansum((FF[g] * K[e][g]) ** 2)) / tot) if tot > 0 else np.nan
            out['nb'][-1] = max(1, int(K['nb'][g].max()) - (len(g) - 1))
        out['nmem'].append(len(g)); out['members'].append('|'.join(str(K['name'][i]) for i in g))
    return {k: np.array(v) for k, v in out.items()}


# ---------- pixels ----------
_wave = {}
def wave(det):
    """(y, x) 0-based detector pixels -> wavelength um: bilinear on web/data/wavemaps.json (detector_v3_fetch.wave)."""
    if det not in _wave:
        from scipy.interpolate import RegularGridInterpolator
        m = json.load(open(ROOT + '/web/data/wavemaps.json'))[det]
        _wave[det] = RegularGridInterpolator((np.array(m['y'], float) - 1, np.array(m['x'], float) - 1), np.array(m['lam']), bounds_error=False, fill_value=None)
    return _wave[det]


def mesh(a, B):
    """detector_cold.mesh: clipped median of BxB blocks, linearly scaled back up (background only)."""
    H, W = a.shape; h, w = -(-H // B), -(-W // B); p = np.full((h * B, w * B), np.nan, np.float32); p[:H, :W] = a
    m = p.reshape(h, B, w, B).transpose(0, 2, 1, 3).reshape(h, w, B * B)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2)
        for _ in range(2):
            m = np.where(np.abs(m - med[:, :, None]) > 2.5 * sd[:, :, None], np.nan, m)
            med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2) / 0.9
    g = np.where(np.isfinite(med), med, np.nanmedian(med))
    return ndi.zoom(g, B, order=1, mode='nearest')[:H, :W]


def ap_weights(fx, fy, r=1.75):
    g = (np.arange(35) + 0.5) / 5 - 3.5; X, Y = np.meshgrid(g, g)
    return ((X - fx) ** 2 + (Y - fy) ** 2 <= r * r).reshape(7, 5, 7, 5).mean((1, 3)).astype(np.float32)
_K0 = ap_weights(0, 0)


class Wcs:
    """astropy WCS of one exposure header (the cutout's own header text)."""
    def __init__(self, hdr):
        from astropy.io import fits
        from astropy.wcs import WCS
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore'); self.w = WCS(fits.Header.fromstring(hdr))
    def pix(self, ra, dec):
        x, y = self.w.all_world2pix(np.asarray(ra, float), np.asarray(dec, float), 0, quiet=True); return np.asarray(x), np.asarray(y)


def prep(e, gaia):
    """detector_v4.prep on one cutout: dict(img, bad, sub, sig_ap, x0, y0, t, det, shift, w)."""
    img = e['img'].astype(np.float32); flg = e['flg']; x0, y0, t = e['x0'], e['y0'], e['t']; w = Wcs(e['hdr'])
    bad = ~np.isfinite(img) | ((flg & BAD) != 0) | ndi.binary_dilation((flg & GROW) != 0, iterations=3)
    bg = mesh(np.where(bad, np.nan, img), 16); sub = np.where(bad, np.nan, img - bg).astype(np.float32)
    apm = ndi.convolve(np.nan_to_num(sub), _K0, mode='constant'); okm = ndi.convolve(bad.astype(np.float32), (_K0 > 0).astype(np.float32), mode='constant') == 0
    v = apm[okm]; sig = float(1.4826 * np.median(np.abs(v - np.median(v)))) if v.size > 200 else np.nan
    a = dict(img=img, bad=bad, sub=sub, flg=flg, sig_ap=sig, x0=x0, y0=y0, t=t, det=e['det'], obs=e['obs'], shift=(0.0, 0.0), nstar=0, w=w)
    if gaia is not None and len(gaia):
        dt = (t - MJD_GAIA) / 365.25; x, y = w.pix(gaia[:, 0] + gaia[:, 2] * dt / 3.6e6 / np.cos(np.radians(gaia[:, 1])), gaia[:, 1] + gaia[:, 3] * dt / 3.6e6); off = []
        for xx, yy in zip(x - x0, y - y0):
            if not (np.isfinite(xx) and np.isfinite(yy)): continue
            xi, yi = int(round(xx)), int(round(yy))
            if not (8 <= xi < img.shape[1] - 8 and 8 <= yi < img.shape[0] - 8) or bad[yi - 2:yi + 3, xi - 2:xi + 3].any(): continue
            c = sub[yi - 2:yi + 3, xi - 2:xi + 3].astype(np.float64); s = c.sum()
            if s < 25 * sig: continue
            Y, X = np.mgrid[yi - 2:yi + 3, xi - 2:xi + 3]; off.append(((c * X).sum() / s - xx, (c * Y).sum() / s - yy))
        if len(off) >= 8: a['shift'] = tuple(float(v) for v in np.median(np.array(off), 0)); a['nstar'] = len(off)
    return a


def sky_pos(K, t, idx=None):
    """Component sky positions at mjd t (decade.positions' motion)."""
    s = slice(None) if idx is None else idx
    dt = (t - MJD_CW) / 365.25
    return K['ra'][s] + K['pme'][s] * dt / 3600 / np.cos(np.radians(K['dec'][s])), K['dec'][s] + K['pmn'][s] * dt / 3600


def positions(K, a):
    ra, dec = sky_pos(K, a['t']); x, y = a['w'].pix(ra, dec)
    return x - a['x0'] + a['shift'][0], y - a['y0'] + a['shift'][1]


def psfs(X, K):
    """phot_lead.psfs' rule (W1 9 to 12, no CatWISE source brighter than W1 + 3 within 20 arcsec; median of normalised,
    recentred stamps; 20 stamps a detector or it is dropped), over every exposure. -> {det: spline coefficients or None, det_n}"""
    x, y = tan(K['ra'], K['dec'], K['ra'].mean(), K['dec'].mean()); tr = cKDTree(np.c_[x, y]); w1 = np.nan_to_num(K['w1'], nan=99)
    cand = np.nonzero((w1 > 9) & (w1 < 12))[0]
    iso = np.array([i for i in cand if all(j == i or w1[j] > w1[i] + 3 for j in tr.query_ball_point([x[i], y[i]], 20.0))], int); out = {}; H = PH + 3
    r = np.hypot(*np.mgrid[-H:H + 1, -H:H + 1])
    for det in DETS:
        stamps = []
        for a in [a for a in X if a['det'] == det]:
            px, py = positions(K, a)
            for i in iso:
                xx, yy = px[i], py[i]
                if not (np.isfinite(xx) and np.isfinite(yy)): continue
                xi, yi = int(round(xx)), int(round(yy))
                if not (H + 1 <= xi < a['img'].shape[1] - H - 1 and H + 1 <= yi < a['img'].shape[0] - H - 1) or a['bad'][yi - H:yi + H + 1, xi - H:xi + H + 1].any(): continue
                c = a['img'][yi - H:yi + H + 1, xi - H:xi + H + 1].astype(float); c = c - np.median(c[r > PH + 0.5])
                if c[3:-3, 3:-3].sum() <= 0 or c[H, H] < 30 * a['sig_ap'] / 3: continue
                c = ndi.shift(c, (yi - yy, xi - xx), order=3, mode='nearest')[3:-3, 3:-3]; stamps.append(c / c.sum())
        out[det + '_n'] = len(stamps)
        if len(stamps) < 20: out[det] = None; continue
        p = np.median(np.array(stamps), 0); p /= p.sum(); out[det] = ndi.spline_filter(p, order=3)
    return out


def robust_sigma(v):
    v = v[np.isfinite(v)]
    return float(1.4826 * np.median(np.abs(v - np.median(v)))) if v.size else np.nan


def stamp_fit(a, K, psf, meas):
    """Forced PSF photometry of the components `meas` in one prepared exposure, each on its own 15 x 15 stamp: that star,
    every component whose 15 x 15 PSF reaches the stamp, and one constant per 8 x 8 px tile, by linear least squares.
    -> list of (component, lambda um, flux mJy, sigma mJy, mjd)"""
    if not np.isfinite(a['sig_ap']): return []
    img = a['sub']; H, W = img.shape; good = np.isfinite(img) & ~a['bad']
    px, py = positions(K, a)
    inn = np.nonzero(np.isfinite(px) & np.isfinite(py) & (px > -3) & (px < W + 2) & (py > -3) & (py < H + 2))[0]
    if not len(inn): return []
    xi = np.full(len(px), -10 ** 6, np.int64); yi = xi.copy()
    xi[inn], yi[inn] = np.round(px[inn]).astype(np.int64), np.round(py[inn]).astype(np.int64)
    sp = robust_sigma(img[good].astype(np.float64))      # pixel noise of the background-removed exposure
    nxt = -(-W // TILE); out = []; innset = inn
    for q in meas:
        if not (np.isfinite(px[q]) and np.isfinite(py[q])): continue
        x0, y0 = int(xi[q]), int(yi[q])
        if not (2 <= x0 < W - 2 and 2 <= y0 < H - 2) or not good[y0 - 1:y0 + 2, x0 - 1:x0 + 2].all(): continue
        ys, xs = np.mgrid[max(0, y0 - PH):min(H, y0 + PH + 1), max(0, x0 - PH):min(W, x0 + PH + 1)]
        ok = good[ys, xs]; gy, gx = ys[ok], xs[ok]
        near = innset[(np.abs(xi[innset] - x0) <= 2 * PH) & (np.abs(yi[innset] - y0) <= 2 * PH)]
        near = np.r_[q, near[near != q]]
        cols = []
        for c in near:
            inb = (np.abs(gy - yi[c]) <= PH) & (np.abs(gx - xi[c]) <= PH)
            v = np.zeros(len(gy))
            if inb.any():
                v[inb] = ndi.map_coordinates(psf, [PH + gy[inb] - py[c], PH + gx[inb] - px[c]], order=3, prefilter=False, cval=0.0)
            v[np.abs(v) <= 1e-6] = 0.0
            cols.append(v)
        tid = (gy // TILE) * nxt + gx // TILE; ut, tcol = np.unique(tid, return_inverse=True)
        A = np.zeros((len(gy), len(near) + len(ut))); A[:, :len(near)] = np.array(cols).T; A[np.arange(len(gy)), len(near) + tcol] = 1.0
        b = img[gy, gx].astype(np.float64)
        N = A.T @ A; rhs = A.T @ b; dg = np.diag(N).copy(); live = np.nonzero(dg > 0)[0]
        if dg[0] <= 0: continue
        Nl = N[np.ix_(live, live)] + np.eye(len(live)) * 1e-9 * max(dg.max(), 1)
        try: inv = np.linalg.inv(Nl)
        except np.linalg.LinAlgError: continue
        sol = inv @ rhs[live]
        lam = float(wave(a['det'])(np.array([[py[q] - a['shift'][1] + a['y0'], px[q] - a['shift'][0] + a['x0']]]))[0])
        out.append((int(q), lam, float(sol[0] * MJY_PIX), float(np.sqrt(inv[0, 0]) * sp * MJY_PIX), float(a['t'])))
    return out


# ---------- spectrum (spectrum.py and decade.py rules) ----------
def binned(lam, f, s):
    """spectrum.py binned(): weighted means in lambda/40 bins, errors scaled by sqrt(reduced chi2) when over 1."""
    k = np.digitize(lam, EDGES) - 1; M = np.full(len(EDGES) - 1, np.nan); S = M.copy()
    for j in np.unique(k[(k >= 0) & (k < len(EDGES) - 1)]):
        m = (k == j) & np.isfinite(f) & np.isfinite(s) & (s > 0)
        if not m.any(): continue
        w = 1 / s[m] ** 2; mu = (w * f[m]).sum() / w.sum(); e = 1 / np.sqrt(w.sum())
        if m.sum() > 1: e *= max(1.0, np.sqrt(((f[m] - mu) ** 2 * w).sum() / (m.sum() - 1)))
        M[j], S[j] = mu, e
    return M, S


def pass_groups(t, gap=60.0):
    o = np.argsort(t, kind='stable'); ts = t[o]; cut = np.nonzero(np.diff(ts) > gap)[0] + 1; lab = np.zeros(len(t), int)
    lab[o] = np.repeat(np.arange(len(cut) + 1), np.diff(np.r_[0, cut, len(t)])); return lab


def band_mean(M, S, lo, hi):
    m = (CEN >= lo) & (CEN <= hi) & np.isfinite(M)
    if m.sum() < 0.6 * ((CEN >= lo) & (CEN <= hi)).sum() or not m.any(): return np.nan, np.nan
    return float(np.mean(M[m])), float(np.sqrt(np.sum(S[m] ** 2)) / m.sum())


def bnu(lam_um, T):
    x = 14387.77 / (lam_um * T); return 1 / (lam_um ** 3 * np.expm1(np.minimum(x, 700)))


# decade's W1/W2 synthesis (for the 2010 points' scale only): lambda/45 bins over 2.6 to 5 um, band curves from web/data/bands.json
DEDGES = 2.6 * (1 + 1 / 45.0) ** np.arange(0, 31); DEDGES[-1] = max(DEDGES[-1], 5.0)
_RSR = None
def rsr():
    global _RSR
    if _RSR is None:
        R = json.load(open(ROOT + '/web/data/bands.json')); _RSR = {}
        for b in ('W1', 'W2'):
            lam = np.array(R[b]['lam'], float); r = np.array(R[b]['r'], float); dl = np.gradient(lam); w = r / lam * dl; _RSR[b] = (lam, w / w.sum())
    return _RSR


def dbinned(lam, f, s):
    k = np.digitize(lam, DEDGES) - 1; C, M, S = [], [], []
    for j in range(len(DEDGES) - 1):
        m = k == j
        if m.sum() < 1: continue
        ff, ss, ll = f[m], s[m], lam[m]; w = 1 / ss ** 2; mu = (w * ff).sum() / w.sum(); e = 1 / np.sqrt(w.sum())
        if len(ff) > 1: e *= max(1.0, np.sqrt(((ff - mu) ** 2 * w).sum() / (len(ff) - 1)))
        C.append((w * ll).sum() / w.sum()); M.append(mu); S.append(e)
    return np.array(C), np.array(M), np.array(S)


def synth(c, mu, e, band, near=0.12):
    lam, w = rsr()[band]
    if len(c) < 2: return np.nan, 0.0
    o = np.argsort(c, kind='stable'); c, mu, e = c[o], mu[o], e[o]
    if band == 'W2':
        tail = c >= 4.8
        if tail.any():
            wt = 1 / e[tail] ** 2; c = np.r_[c, 5.6]; mu = np.r_[mu, (wt * mu[tail]).sum() / wt.sum()]; e = np.r_[e, 1 / np.sqrt(wt.sum())]
    alpha = np.array([np.interp(lam, c, np.eye(len(c))[i]) for i in range(len(c))]) @ w
    covered = np.min(np.abs(lam[:, None] - c[None, :]), 1) <= near
    if band == 'W2' and c[-1] == 5.6: covered |= lam > 5.0
    return float(alpha @ mu), float(w[covered].sum())


def band_limits(band):
    lam, w = rsr()[band]; cw = np.cumsum(w); return float(lam[np.searchsorted(cw, 0.01)]), min(float(lam[np.searchsorted(cw, 0.99)]), 5.0)


def wise_flux(lam, f, s, t, band):
    """decade.source_fluxes' band flux: mean over passes of the synthesised flux, passes with coverage >= 0.8 and no gap over 0.25 um."""
    sel = lam >= 2.4; lam, f, s, t = lam[sel], f[sel], s[sel], t[sel]
    if not len(t): return np.nan
    lab = pass_groups(t); P = []
    for k in np.unique(lab):
        m = lab == k; c, mu, e = dbinned(lam[m], f[m], s[m]); lo, hi = band_limits(band); inb = (c >= lo) & (c <= hi)
        if inb.sum() < 3: continue
        gap = np.diff(np.r_[lo, c[inb], hi]).max(); fx, cov = synth(c, mu, e, band)
        if cov >= 0.8 and gap <= 0.25: P.append(fx)
    return float(np.mean(P)) if P else np.nan


# ---------- one star ----------
def r4(v):
    return None if v is None or not np.isfinite(v) else float(f'{v:.6g}')


def inconclusive(state, reason, **more):
    return dict(v=1, method='colors-v1', state=state, reason=reason, **more)


def load_field(d):
    cats = {}
    for name in ('twomass', 'catwise', 'allwise', 'gaia', 'simbad', 'vsx'):
        p = f'{d}/{name}.tsv' if name == 'vsx' else f'{d}/{name}.csv'
        if not os.path.exists(p): raise Refused(f'the {name} catalogue is missing')
        cats[name] = read_vsx(p) if name == 'vsx' else read_csv(p, name)
    return cats


def known_variables(cats, kx, ky, ra0, dec0):
    """Components within 5 arcsec of a Gaia DR3 VARIABLE, a SIMBAD variable or young-star type, or any VSX star."""
    pts = [(r['ra'], r['dec']) for r in cats['gaia'] if r['phot_variable_flag'] == 'VARIABLE']
    pts += [(r['ra'], r['dec']) for r in cats['simbad'] if VAR_OTYPE.search(r['otype'] or '')]
    pts += [(r['RAJ2000'], r['DEJ2000']) for r in cats['vsx']]
    pts = [(fl(a), fl(b)) for a, b in pts if np.isfinite(fl(a)) and np.isfinite(fl(b))]
    if not pts: return np.zeros(len(kx), bool)
    vx, vy = tan([p[0] for p in pts], [p[1] for p in pts], ra0, dec0)
    return cKDTree(np.c_[vx, vy]).query(np.c_[kx, ky])[0] < VAR_R


def load_exposures(d):
    E = json.load(open(f'{d}/exposures.json')); out = []
    for e in E:
        z = np.load(f"{d}/{e['file']}")
        out.append(dict(obs=e['obs'], det=e['det'], key=e['key'], t=float(z['t']), x0=int(z['x0']), y0=int(z['y0']), hdr=str(z['hdr']), img=z['img'], flg=z['flg']))
    return out


def _prep(args): return prep(*args)
def _fit(args):
    a, K, psf, meas = args; return stamp_fit(a, K, psf, meas)


def build(cats, E, ra, dec, nproc=8):
    """-> (the Colors result for the star at (ra, dec), the measurements). E: cutouts (dict obs, det, key, t, x0, y0, hdr, img, flg)."""
    TM, CW, AW, GA = cats['twomass'], cats['catwise'], cats['allwise'], cats['gaia']
    K = components(CW, AW, GA); n = len(K['ra']); ra0, dec0 = K['ra'].mean(), K['dec'].mean()
    kx, ky = tan(K['ra'], K['dec'], ra0, dec0)
    # the star: the component within 2 arcsec of the spot
    d_star = sep_as(K['ra'], K['dec'], ra, dec); T = int(np.argmin(d_star))
    if not d_star[T] <= STAR_R: return inconclusive('no-star', 'no catalogued star within 2 arcsec of this spot')
    # 2MASS: each component's match within 2 arcsec (spectrum.py)
    tx, ty = tan([fl(r['ra']) for r in TM], [fl(r['dec']) for r in TM], ra0, dec0)
    dd, j = cKDTree(np.c_[tx, ty]).query(np.c_[kx, ky])
    tm = lambda key: np.array([fl(TM[q][key]) if d < STAR_R else np.nan for d, q in zip(dd, j)])
    J, Hm, Km = tm('j_m'), tm('h_m'), tm('k_m'); qual = np.array([TM[q]['ph_qual'] if d < STAR_R else 'XXX' for d, q in zip(dd, j)])
    # known variables (Gaia, SIMBAD, VSX); crowding: a CatWISE neighbour within 15 arcsec less than 2.5 mag fainter
    var = known_variables(cats, kx, ky, ra0, dec0)
    tr = cKDTree(np.c_[kx, ky]); w1 = np.nan_to_num(K['w1'], nan=99); w2 = K['w2']
    crowd = np.array([any(w1[q] < w1[i] + 2.5 for q in tr.query_ball_point([kx[i], ky[i]], CROWD_R) if q != i) for i in range(n)])
    NORM = 'K' if qual[T] == 'AAA' else 'W1'
    if NORM == 'K':
        col = lambda i: np.array([J[i] - Hm[i], Hm[i] - Km[i], Km[i] - w1[i], w1[i] - w2[i]]); tol = np.array([0.12, 0.10, 0.10, 0.10])
        base = (qual == 'AAA') & np.isfinite(Km) & (np.abs(Km - Km[T]) <= 1.5) & (Km > 9)
    else:
        col = lambda i: np.array([w1[i] - w2[i]]); tol = np.array([0.10])
        base = np.isfinite(w1) & np.isfinite(w2) & (np.abs(w1 - w1[T]) <= 1.0)
    base &= ~var & ~crowd & (K['nmem'] == 1) & (np.arange(n) != T)
    normflux = lambda i: mag2mjy(Km[i], 'K') if NORM == 'K' else mag2mjy(w1[i], 'W1')
    cand = np.nonzero(base)[0]
    # exposures with the star on them (WCS position, before the measured shift: decided before any pixel is read)
    on = []
    for e in E:
        w = Wcs(e['hdr']); s_ra, s_dec = sky_pos(K, e['t'], [T]); x, y = w.pix(s_ra, s_dec); x, y = float(x[0]) - e['x0'], float(y[0]) - e['y0']
        h, wd = e['img'].shape
        if np.isfinite(x) and np.isfinite(y) and 1 <= round(x) < wd - 1 and 1 <= round(y) < h - 1: on.append((e, int(round(x)), int(round(y))))
    if not on: return inconclusive('no-coverage', 'SPHEREx has no pictures of this star')
    nsat = sum(bool((e['flg'][y - 1:y + 2, x - 1:x + 2] & SAT).any()) for e, x, y in on)
    gref = np.array([[fl(r['ra']), fl(r['dec']), fl(r['pmra']), fl(r['pmdec']), fl(r['phot_g_mean_mag'])] for r in GA]).reshape(-1, 5)
    gref = gref[(gref[:, 4] > 10.5) & (gref[:, 4] < 17)]
    with ProcessPoolExecutor(nproc) as ex: X = list(ex.map(_prep, [(e, gref) for e, _, _ in on], chunksize=4))
    P = psfs(X, K)
    X = [a for a in X if P[a['det']] is not None]
    meas = [T] + [int(i) for i in cand]
    with ProcessPoolExecutor(nproc) as ex: R = list(ex.map(_fit, [({k: a[k] for k in ('sub', 'bad', 'sig_ap', 'x0', 'y0', 't', 'det', 'shift', 'w')}, K, P[a['det']], meas) for a in X], chunksize=2))
    rows = np.array([r for rr in R for r in rr], float).reshape(-1, 5)
    psf_n = {d: int(P[d + '_n']) for d in DETS}
    used = dict(exposures_listed=len(E), exposures_on_star=len(on), exposures_used=len(X), by_det={d: sum(a['det'] == d for a in X) for d in DETS},
                saturated=nsat, psf_stamps=psf_n, detectors_dropped=[d for d in DETS if P[d] is None])
    star = dict(name=str(K['name'][T]), ra=r4(float(K['ra'][T])), dec=r4(float(K['dec'][T])), sep_arcsec=r4(float(d_star[T])), norm=NORM,
                twomass=dict(J=r4(J[T]), H=r4(Hm[T]), K=r4(Km[T]), qual=str(qual[T])), catwise=dict(W1=r4(K['w1'][T]), W2=r4(K['w2'][T])))
    return spectrum_result(rows, T, cand, col, tol, normflux, NORM, star, used, K, TM, AW), rows


def per_source(rows, idx, passes):
    """spectrum.py per_source: binned spectra per pass ('0', '1', ...) and all passes. -> {i: {'all': (M, S), k: (M, S), 'raw': (lam, f, s, t)}}"""
    out = {}; comp = rows[:, 0].astype(int)
    for i in idx:
        m = comp == i
        if not m.any(): continue
        lam, f, s, t = rows[m, 1], rows[m, 2], rows[m, 3], rows[m, 4]
        ok = np.isfinite(f) & np.isfinite(s); lam, f, s, t = lam[ok], f[ok], s[ok], t[ok]
        R = {'all': binned(lam, f, s), 'raw': (lam, f, s, t)}
        p = np.array([int(np.argmin(np.abs(tt - passes))) for tt in t], int)
        for k in range(len(passes)): R[k] = binned(lam[p == k], f[p == k], s[p == k])
        out[i] = R
    return out


def moving(R, npass):
    """The self-check: the 3 to 5 um band mean of a comparison changes between two passes by over 3 sigma."""
    return any(abs(z) > 3 for z in pair_z(R, npass, SYS_FLOOR))


def pair_z(R, npass, floor):
    """Pass-to-pass changes of the 3 to 5 um band mean, in sigmas: statistical errors plus floor x flux, in quadrature."""
    v = [band_mean(*R[k], 3.0, 5.0) for k in range(npass)]
    v = [x for x in v if np.isfinite(x[0])]
    return [(a[0] - b[0]) / np.sqrt(a[1] ** 2 + b[1] ** 2 + floor ** 2 * (a[0] ** 2 + b[0] ** 2)) for q, a in enumerate(v) for b in v[q + 1:]]


def fit_pass(M, S, Tm, spread, nn, FK):
    ok = np.isfinite(M) & np.isfinite(Tm) & (nn >= 5) & (CEN >= 0.75)
    y = M[ok]; ph = Tm[ok] * FK; lam = CEN[ok]; sig = np.sqrt(S[ok] ** 2 + (spread[ok] * FK) ** 2)
    if len(y) < 4: return ok, None
    w = 1 / sig ** 2; a0 = (w * y * ph).sum() / (w * ph * ph).sum(); chi0 = float((((y - a0 * ph) / sig) ** 2).sum())
    best = None; prof = []
    for Td in TGRID:
        Bm = bnu(lam, Td) / bnu(4.6, Td); X = np.c_[ph, Bm] / sig[:, None]; NN = X.T @ X; c = np.linalg.solve(NN, X.T @ (y / sig))
        ch = float(((y / sig - X @ c) ** 2).sum()); prof.append(ch)
        if best is None or ch < best[0]: best = (ch, Td, c, np.linalg.inv(NN))
    prof = np.array(prof); ch1, Td, (a1, b1), cov = best
    inT = TGRID[prof <= ch1 + 1.0]
    return ok, dict(n=int(len(y)), a_star=float(a0), chi2_star=chi0, dof_star=int(len(y) - 1), a=float(a1), b=float(b1), b_err=float(np.sqrt(cov[1, 1])),
                    T=float(Td), T_1sigma=[float(inT.min()), float(inT.max())], chi2_star_dust=float(ch1), dof_star_dust=int(len(y) - 3),
                    _y=y, _sig=sig, _ph=ph, _lam=lam, _S=S[ok], _spread=spread[ok] * FK)


def spectrum_result(rows, T, cand, col, tol, normflux, NORM, star, used, K, TM, AW):
    res = dict(v=1, method='colors-v1', state='ok', reason='', star=star, data=used)
    st = rows[rows[:, 0] == T]
    if not len(st):
        res.update(state='inconclusive', reason='SPHEREx measured no colours of this star'); res['fingerprints'] = all_rows('inconclusive', res['reason']); return res
    t_all = np.sort(np.unique(st[:, 4])); g = pass_groups(t_all); passes = np.array([t_all[g == k].mean() for k in np.unique(g)])
    S = per_source(rows, [T] + list(cand), passes)
    npass = len(passes)
    ct = col(T); dc = np.array([np.abs(col(i) - ct) for i in cand]).reshape(len(cand), len(ct))
    mov = {int(i): moving(S[i], npass) if i in S else False for i in cand}
    for scale in SCALES:
        comp = [int(i) for i, d in zip(cand, dc) if (d <= tol * scale).all() and i in S and not mov[int(i)]]
        if len(comp) >= MIN_COMP: break
    within = [int(i) for i, d in zip(cand, dc) if (d <= tol * scale).all()]
    res['comparisons'] = dict(n=len(comp), scale=scale, names=[str(K['name'][i]) for i in comp], dropped_moving=[str(K['name'][i]) for i in within if mov.get(i)],
                              dropped_unmeasured=[str(K['name'][i]) for i in within if i not in S])
    res['passes_mjd'] = [float(p) for p in passes]
    res['saturation'] = dict(n=used['saturated'], of=used['exposures_on_star'])
    sat = 2 * used['saturated'] >= used['exposures_on_star'] and used['saturated'] > 0
    if len(comp) < MIN_COMP:
        res.update(state='inconclusive', reason=f'{len(comp)} clean comparison stars, {MIN_COMP} needed')
        res['fingerprints'] = all_rows('inconclusive', res['reason']); _sat(res, sat); return res
    FK = normflux(T)
    def template(pk):
        A = np.array([S[i][pk][0] / normflux(i) for i in comp])
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore'); Tm = np.nanmedian(A, 0); spread = 1.4826 * np.nanmedian(np.abs(A - Tm), 0)
        return Tm, spread, np.isfinite(A).sum(0)
    fits, curves = {}, []
    for pk in ['all'] + list(range(npass)):
        Tm, spread, nn = template(pk); M, Sg = S[T][pk]; ok, f = fit_pass(M, Sg, Tm, spread, nn, FK)
        key = str(pk)
        if f is None: fits[key] = None; curves.append(dict(key=key, mjd=None if pk == 'all' else float(passes[pk]), lam=[], mjy=[], err=[], fit=[])); continue
        fits[key] = {k: v for k, v in f.items() if not k.startswith('_')}
        fit = f['a'] * f['_ph'] + f['b'] * bnu(f['_lam'], f['T']) / bnu(4.6, f['T'])
        curves.append(dict(key=key, mjd=None if pk == 'all' else float(passes[pk]), lam=[r4(v) for v in f['_lam']], mjy=[r4(v) for v in f['_y']], err=[r4(v) for v in f['_S']],
                           fit=[r4(v) for v in fit], sigma=[r4(v) for v in f['_sig']]))
        if pk == 'all': keep = f
    res['fits'] = fits; res['passes'] = curves
    if fits['all'] is None:
        res.update(state='inconclusive', reason='SPHEREx measured too few colours of this star'); res['fingerprints'] = all_rows('inconclusive', res['reason']); _sat(res, sat); return res
    k_ = keep; lam = k_['_lam']; y = k_['_y']; ph = k_['_ph']; sig = k_['_sig']
    sel = lam < 2.42
    aS = float(np.sum(y[sel] * ph[sel] / sig[sel] ** 2) / np.sum(ph[sel] ** 2 / sig[sel] ** 2)) if NORM == 'K' and sel.any() else 1.0
    res['aS'] = aS
    res['bare'] = dict(lam=[r4(v) for v in lam], mjy=[r4(v) for v in aS * ph], spread=[r4(v) for v in aS * k_['_spread']])
    res['excess_46'] = float(fits['all']['b'] / np.interp(4.6, lam, aS * ph))
    res['comparison_systematic'] = comparison_systematic(S, T, comp, normflux, FK, NORM)
    ex = y / (aS * ph) - 1; exs = sig / (aS * ph); det_of = np.digitize(lam, DETEDGE)
    res['excess_by_detector'] = {f'D{d + 1}': dict(mean=float(np.average(ex[det_of == d], weights=1 / exs[det_of == d] ** 2)), err=float(1 / np.sqrt(np.sum(1 / exs[det_of == d] ** 2))),
                                                   n=int((det_of == d).sum())) for d in range(6) if (det_of == d).any()}
    F = fits['all']; mod = F['a'] * ph + F['b'] * bnu(lam, F['T']) / bnu(4.6, F['T']); r = (y - mod) / sig
    rs = (y - F['a_star'] * ph) / sig                                  # residuals from the star alone, for the seams
    res['fingerprints'] = fingerprints(lam, r, F, res['excess_by_detector'], NORM, rs, y / sig)
    res['old'] = old_points(S, comp, T, K, TM, AW)
    _sat(res, sat)
    return res


def mulberry32(seed):
    """The seeded generator colors.js shares (mulberry32): -> function giving floats in [0, 1)."""
    st = [seed & 0xffffffff]; M = 0xffffffff
    def rnd():
        st[0] = (st[0] + 0x6D2B79F5) & M; a = st[0]
        t = ((a ^ (a >> 15)) * (a | 1)) & M
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & M)) & M) ^ t
        return ((t ^ (t >> 14)) & M) / 4294967296
    return rnd


def comparison_systematic(S, T, comp, normflux, FK, NORM):
    """The all-pass fit redone on BOOT_N resamplings (with replacement) of the comparison stars: the spread of T and of the
    dust's share of the light at 4.6 um that the choice of comparisons alone makes (half the 16 to 84 percentile range)."""
    rnd = mulberry32(BOOT_SEED); n = len(comp); M, Sg = S[T]['all']; Ts, Xs = [], []
    A0 = np.array([S[i]['all'][0] / normflux(i) for i in comp])
    import warnings
    for _ in range(BOOT_N):
        A = A0[[int(rnd() * n) for _ in range(n)]]
        with warnings.catch_warnings():
            warnings.simplefilter('ignore'); Tm = np.nanmedian(A, 0); spread = 1.4826 * np.nanmedian(np.abs(A - Tm), 0)
        ok, f = fit_pass(M, Sg, Tm, spread, np.isfinite(A).sum(0), FK)
        if f is None: continue
        lam, y, ph, sig = f['_lam'], f['_y'], f['_ph'], f['_sig']; sel = lam < 2.42
        aS = float(np.sum(y[sel] * ph[sel] / sig[sel] ** 2) / np.sum(ph[sel] ** 2 / sig[sel] ** 2)) if NORM == 'K' and sel.any() else 1.0
        Ts.append(f['T']); Xs.append(f['b'] / np.interp(4.6, lam, aS * ph))
    if len(Ts) < BOOT_N // 2: return None
    pT, pX = np.percentile(Ts, [16, 50, 84]), np.percentile(Xs, [16, 50, 84])
    return dict(n=len(Ts), T=[float(v) for v in pT], T_sys=float((pT[2] - pT[0]) / 2), excess_46=[float(v) for v in pX], excess_46_sys=float((pX[2] - pX[0]) / 2))


def _sat(res, sat):
    if sat:
        why = f"too bright, saturated in {res['saturation']['n']} of {res['saturation']['of']} exposures"
        res['fingerprints'] = all_rows('inconclusive', why); res.update(state='inconclusive', reason=why)


ROWS = ('rise', 'temperature', 'spike', 'dip', 'seam')
def all_rows(verdict, reason):
    return {k: dict(verdict=verdict, reason=reason) for k in ROWS}


def fingerprints(lam, r, F, exd, NORM, rs, snr):
    """The verdicts, thresholds fixed in plan.md (deviation 2 for the seams). lam, r: the all-pass bins and their residuals
    from the star + dust fit (sigma); rs: residuals from the star alone; snr: flux over sigma per bin."""
    out = {}
    chi = F['chi2_star_dust'] / max(1, F['dof_star_dust'])
    if chi > 3:
        return all_rows('inconclusive', f'the best fit misses the colours (chi2 per point {chi:.1f}, 3 at most)')
    # seams first, on the star-only residuals: a jump there must not be read as dust
    vals, missing = {}, []
    for e in SEAMS:
        lo = (lam < e) & (lam > e - 0.25); hi = (lam > e) & (lam < e + 0.25)
        if lo.sum() < 2 or hi.sum() < 2: missing.append(e); continue
        jump = float(rs[hi].mean() - rs[lo].mean()); lim = float(3 * np.sqrt(1 / lo.sum() + 1 / hi.sum()))
        vals[str(e)] = dict(jump=jump, limit=lim, n=[int(lo.sum()), int(hi.sum())], sensitivity=float(lim / snr[hi].mean()))
    jumps = [e for e in SEAMS if str(e) in vals and abs(vals[str(e)]['jump']) >= vals[str(e)]['limit']]
    sens = max((v['sensitivity'] for v in vals.values()), default=None)
    if jumps: seam = dict(verdict='seen', reason='', steps=vals, sensitivity=sens)
    elif missing: seam = dict(verdict='inconclusive', reason=f'too few colours on both sides of {" and ".join(f"{e:.2f}" for e in missing)} um', steps=vals, sensitivity=sens)
    else: seam = dict(verdict='not seen', reason='', steps=vals, sensitivity=sens)
    n_lo, n_hi = int((lam < 2.42).sum()), int((lam >= 3.82).sum())
    dchi = F['chi2_star'] - F['chi2_star_dust']; nsig_b = F['b'] / F['b_err'] if F['b_err'] > 0 else 0.0
    if NORM != 'K':
        out['rise'] = dict(verdict='inconclusive', reason='no clean 2MASS Ks')
    elif jumps:
        out['rise'] = dict(verdict='inconclusive', reason=f'possible calibration jump at {" and ".join(f"{e:.2f}" for e in jumps)} um')
    elif n_lo < 5 or n_hi < 5:
        out['rise'] = dict(verdict='inconclusive', reason=f'too few colours: {n_lo} below 2.42 um and {n_hi} above 3.82 um, 5 each needed')
    else:
        flat = all(abs(exd[d]['mean']) <= 3 * exd[d]['err'] for d in ('D1', 'D2', 'D3') if d in exd)
        seen = dchi >= 25 and nsig_b >= 5 and flat
        out['rise'] = dict(verdict='seen' if seen else 'not seen', reason='', dchi2=float(dchi), b_sigma=float(nsig_b), flat_below=bool(flat))
    if out['rise']['verdict'] == 'seen':
        if F['T'] <= TGRID[0] or F['T'] >= TGRID[-1]: out['temperature'] = dict(verdict='inconclusive', reason='the temperature is at the edge of the 200 to 2500 K grid')
        else: out['temperature'] = dict(verdict='seen', reason='', T=F['T'], T_1sigma=F['T_1sigma'])
    elif out['rise']['verdict'] == 'inconclusive':
        out['temperature'] = dict(verdict='inconclusive', reason=out['rise']['reason'])
    else:
        out['temperature'] = dict(verdict='not seen', reason='no dust to measure')
    half = 1 / 80.0
    for kind, lines in LINES.items():
        vals, missing = {}, []
        for l0, lab in lines:
            k = np.nonzero(np.abs(np.log(lam / l0)) <= half)[0]
            if not len(k): missing.append(lab); continue
            vals[lab] = float(r[k[np.argmin(np.abs(np.log(lam[k] / l0)))]])
        seen = any((v >= 3 if kind == 'spike' else v <= -3) for v in vals.values())
        if seen: out[kind] = dict(verdict='seen', reason='', sigma=vals)
        elif missing: out[kind] = dict(verdict='inconclusive', reason=f'no SPHEREx colour at {" or ".join(m.split(" ", 1)[1] if " " in m else m for m in missing)} um', sigma=vals)
        else: out[kind] = dict(verdict='not seen', reason='', sigma=vals)
    out['seam'] = seam
    return out


def old_points(S, comp, T, K, TM, AW):
    """2MASS (2000) and AllWISE (2010) of the star on SPHEREx's scale: catalogue flux x median over the comparisons of
    (their SPHEREx band flux / their catalogue flux) (extract.py). J H K: top-hat band means; W1 W2: decade's synthesis."""
    ra, dec = K['ra'][T], K['dec'][T]
    def nearest(R, rk='ra', dk='dec'):
        if not R: return None
        d = sep_as([fl(r[rk]) for r in R], [fl(r[dk]) for r in R], ra, dec); i = int(np.argmin(d)); return R[i] if d[i] <= STAR_R else None
    t2, aw = nearest(TM), nearest(AW)
    ra0, dec0 = K['ra'].mean(), K['dec'].mean(); kx, ky = tan(K['ra'], K['dec'], ra0, dec0)
    tx, ty = tan([fl(r['ra']) for r in TM], [fl(r['dec']) for r in TM], ra0, dec0); dd, j = cKDTree(np.c_[tx, ty]).query(np.c_[kx, ky])
    mag = {b: np.array([fl(TM[q][f'{b.lower()}_m']) if d < STAR_R else np.nan for d, q in zip(dd, j)]) for b in ('J', 'H', 'K')}
    mag['W1'], mag['W2'] = K['w1'], K['w2']
    out = []
    for b in ('J', 'H', 'K', 'W1', 'W2'):
        row = t2 if b in WIN else aw
        if row is None: continue
        m0 = fl(row[f'{b.lower()}_m'] if b in WIN else row[f'{b.lower()}mpro']); e0 = fl(row[f'{b.lower()}_cmsig'] if b in WIN else row[f'{b.lower()}sigmpro'])
        if not np.isfinite(m0): continue
        ratios = []
        for i in comp:
            if b in WIN: v = band_mean(*S[i]['all'], *WIN[b])[0]
            else: lam, f, s, t = S[i]['raw']; v = wise_flux(lam, f, s, t, b)
            if np.isfinite(v) and np.isfinite(mag[b][i]) and v > 0: ratios.append(v / mag2mjy(mag[b][i], b))
        if len(ratios) < 5: continue
        k = float(np.median(ratios)); raw = mag2mjy(m0, b)
        if b in WIN: date = dict(jd=fl(row['jdate']))
        else: date = dict(mjd=[fl(row['w1mjdmean']), fl(row['w2mjdmean'])])
        out.append(dict(band=b, survey='2MASS' if b in WIN else 'WISE', lam=WL[b], mag=m0, mag_err=r4(e0), raw_mjy=r4(raw), scale=r4(k), n_comp=len(ratios),
                        mjy=r4(raw * k), err=r4(raw * k * 0.921 * e0) if np.isfinite(e0) else None, **date))
    return out


def clean(o):
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)): return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, np.bool_): return bool(o)
    return o


def run(d, ra, dec, rows_out=None):
    try: cats = load_field(d)
    except Refused as e: return inconclusive('inconclusive', f'the stored catalogue of this spot is damaged ({e})')
    out = build(cats, load_exposures(d), ra, dec)
    if isinstance(out, tuple):
        out, rows = out
        if rows_out: np.save(rows_out, rows)
    return clean(out)


if __name__ == '__main__':
    a = sys.argv[1:]
    res = run(a[0], float(a[1]), float(a[2]), rows_out=a[a.index('--rows') + 1] if '--rows' in a else None)
    json.dump(res, open(a[3], 'w'), indent=1)
    print(json.dumps({k: res.get(k) for k in ('state', 'reason', 'aS', 'comparisons', 'data')}, default=str)[:1500])
    for k, f in (res.get('fits') or {}).items():
        if f: print(k, 'n', f['n'], 'chi2 star', round(f['chi2_star'], 1), '/', f['dof_star'], 'star+dust', round(f['chi2_star_dust'], 1), '/', f['dof_star_dust'], 'T', f['T'], f['T_1sigma'], 'b', round(f['b'], 3), '+-', round(f['b_err'], 3), 'a', round(f['a'], 3))
    print(json.dumps(res.get('excess_by_detector')), json.dumps(res.get('fingerprints'))[:1500])
