"""Detector v4 (offline): nearby cold brown dwarfs that move too slowly for SPHEREx alone. v3 (bake/detector_v3.py)
plus the v4 changes, each developed on development fields only (scratchpad detector-v4/result.md has the log):
  D2  archive proposals: a valid CatWISE mover (the same motion gates as v3) that no SPHEREx seed links to is measured
      at its motion-propagated position in every pass stack; the SPHEREx pixels set the position (the proposal is only
      a starting point, no prior on the target position), and the same link, motion and spectrum gates apply. AllWISE
      never proposes (B1). Every mover records its seed path ('seed', 'proposal').
  D3  joint local PSF fit for every SPHEREx pass position that enters a motion fit: the source and its neighbours (SPHEREx
      seeds and Gaia stars within R_NB, one physical source each) are fitted together on the pass stack with an
      empirical PSF measured on the field's own stars, a free background plane, neighbour positions held near their own
      peaks by a prior; position errors are the marginal errors with every neighbour parameter free, scaled and floored
      by the same fit run on the field's Gaia stars (and the pass tie is redone on those fitted positions).
  D4  methane templates and evidence statistic: two development donors added (WISE 2134-7137 T9 pec, WISE 0410+1502 Y0;
      smoothed, floored at zero), one common error vector for the nested comparison (A8), Q_MAX 8.
  Crowded spectra: when a neighbour can put light in the aperture, target and neighbours are fitted together in each
      exposure with per-detector PSFs from the field's own stars; PSF_SYS of the removed neighbour light is added to the
      error. Usable sky, thresholds of the motion stage and the ranking are v3's.
It reads one field directory (format: detector_v3_fetch.py), its own frozen templates, web/data/wavemaps.json and its
stage A cache (pixels and Gaia/2MASS only; every catalogue-driven stage is recomputed on every run). No truth.
Run: python -I bake/detector_v4.py run <field_dir> <out.json>
     python -I bake/detector_v4.py templates          (development donors only; writes detector_v4_templates.json)
     python -I bake/detector_v4.py plot <out.json> <png dir> [ra dec]
"""
import sys, os, json, csv, hashlib, pickle, warnings, numpy as np
from concurrent.futures import ProcessPoolExecutor
from astropy.io import fits
from astropy.wcs import WCS
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from scipy.optimize import nnls, least_squares
from scipy.stats import chi2 as chi2d
warnings.simplefilter('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector_v3_fetch as F
import detector_cold as d2                    # v2 plumbing reused: mesh, combine, maps, centroid

VERSION = 'v4-2026-11-16-frozen'
HERE = os.path.dirname(os.path.abspath(__file__))
V4OUT = os.environ.get('DET_V4_OUT', os.path.dirname(F.OUT) + '/detector-v4')
MJD_REF, MJD_CW, MJD_GAIA = 61000.0, 57170.0, 57388.5
OPIX, AS = d2.OPIX, F.AS
MJY_STACK = d2.MJY                            # (MJy/sr summed over stack pixels) -> mJy
MJY_PIX = 1e9 * (6.15 / AS) ** 2              # (MJy/sr summed over detector pixels) -> mJy
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 27, 28, 29))   # incl. 17 PERSIST, 22-24 GHOST, 25 STREAK, 27 SNOWBALL, 28 HALO, 29 SATELLITE_HALO; never 19 or 21 SOURCE
GROW = (1 << 1) | (1 << 26)                   # OVERFLOW and BLOOM, grown by 3 px
LAM45 = 4.0                                   # D5 pixels beyond this join the 4.5 um stack
MIN_EXP, MIN_N = 6, 3                         # exposures a pass needs; looks a stack pixel needs
SNR_SEED, SNR_PASS = 5.0, 4.0
BORDER = 40.0                                 # arcsec inside the patch edge that is not searched
R_AP = 1.75                                   # photometry aperture radius, detector pixels
MU_MIN, MU_MAX = 0.25, 3.3                    # arcsec/yr accepted (target range 0.3 to 3)
PLX_GRID = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3)
PM_FRAC = 0.05                                # fraction of the speed added to the CatWISE motion error (fast movers are smeared and split in CatWISE; measured on development dwarfs)
K_CW, K_DISP, P_MIN = 4.0, 3.5, 1e-3          # CatWISE motion significance; displacement significance; smallest acceptable fit and agreement probability
LINK_R, BLEND_R, BLEND_FLUX = 6.0, 9.0, 0.3
FLUX_LO, FLUX_HI = 0.35, 2.8                  # SPHEREx 4.5 um flux over the CatWISE W2 flux
D_MIN, Q_MAX, SN_MIN = 30.0, 8.0, 8.0         # spectrum: chi-square margin, dwarf chi-square per bin (v3: 5; 8 adopted on development, bright plants failed at q 5.2 to 5.8), total signal to noise
SHARE_MIN = 0.5                               # the dwarf templates must carry at least this share of the modelled 4 to 5 um light
CLIP = 8.0                                    # single-sample outlier cut, sigma (dropped samples are counted)
CAL_FLOOR = 0.15                              # fractional flux error added per bin (calibration, template mismatch)
# v4
USE_D2, USE_D3, COMMON_ERR = True, True, True
SEED_PATH = True                              # False only for the development diagnostic of the proposal path alone (A19)
R_FIT, R_NB, SIG_NB, PSF_H = 8.0, 13.0, 0.5, 10   # stack px: fit window radius, neighbour radius, neighbour position prior, PSF half size
NB_G = 17.0                                   # Gaia stars brighter than this that no seed covers are fitted as neighbours
MERGE_PX = 1.5                                # a seed or Gaia star this close to the target start is the target itself; a fitted target this close to a fitted neighbour is not a separate source
PSF_SYS = 0.2                                 # fractional error on the neighbour light removed by phot_psf (chosen on development crowding plants among 0, 0.05, 0.1, 0.2, 0.3)
CROWD_PHOT, NB_PHOT = True, 25.0              # neighbour-aware forced photometry when a neighbour within NB_PHOT arcsec can put light in the aperture
DUP_AS = 3.0                                  # movers this close at MJD 61000 with the same motion are one physical source
TEMPLATES = 'detector_v4_templates.json'
DWARF_USE = None                              # every dwarf in the frozen templates file (v3's T5, T6, T7, T8 and the v4 T9 pec and Y0 development donors, smoothed)
CFG = {}                                      # the development override (environment) was removed at the freeze
LAMT = np.round(np.concatenate([np.arange(0.775, 2.40, 0.05), np.arange(2.45, 3.80, 0.10), np.arange(3.85, 5.0, 0.075)]), 4)
EDGES = np.r_[0.75, (LAMT[1:] + LAMT[:-1]) / 2, 5.0]
fl = lambda v: float(v) if v not in ('', 'null', 'NaN', None) else float('nan')

# ---------- A. pixels ----------
_gs = {}
def ap_weights(fx, fy, r=R_AP):
    """Fraction of each pixel of a 7x7 box inside a circle of radius r centred (fx, fy) from the middle pixel's centre."""
    g = (np.arange(35) + 0.5) / 5 - 3.5; X, Y = np.meshgrid(g, g)
    return ((X - fx) ** 2 + (Y - fy) ** 2 <= r * r).reshape(7, 5, 7, 5).mean((1, 3)).astype(np.float32)
_K0 = ap_weights(0, 0); _ANN = (lambda r: (r >= 4) & (r <= 7))(np.hypot(*np.mgrid[-7:8, -7:8]))

def prep(args):
    """One exposure -> dict(img, bad, sub (background removed, nan where bad), sig_ap (noise of one aperture sum, MJy/sr),
    hdr, x0, y0, t, det, obs, shift (dx, dy px: measured star position minus WCS prediction), nstar)."""
    d, e, gaia = args; z = np.load(f"{d}/{e['file']}"); img = z['img'].astype(np.float32); flg = z['flg']; x0, y0, t = int(z['x0']), int(z['y0']), float(z['t']); hdr = str(z['hdr']); w = WCS(fits.Header.fromstring(hdr))
    bad = ~np.isfinite(img) | ((flg & BAD) != 0) | ndi.binary_dilation((flg & GROW) != 0, iterations=3)
    bg, _ = d2.mesh(np.where(bad, np.nan, img), 16); sub = np.where(bad, np.nan, img - bg).astype(np.float32)
    apm = ndi.convolve(np.nan_to_num(sub), _K0, mode='constant'); okm = ndi.convolve(bad.astype(np.float32), (_K0 > 0).astype(np.float32), mode='constant') == 0
    v = apm[okm]; sig = float(1.4826 * np.median(np.abs(v - np.median(v)))) if v.size > 200 else np.nan
    a = dict(img=img, bad=bad, sub=sub, sig_ap=sig, hdr=hdr, x0=x0, y0=y0, t=t, det=e['det'], obs=e['obs'], shift=(0.0, 0.0), nstar=0)
    if gaia is not None and len(gaia):
        dt = (t - MJD_GAIA) / 365.25; x, y = w.all_world2pix(gaia[:, 0] + gaia[:, 2] * dt / 3.6e6 / np.cos(np.radians(gaia[:, 1])), gaia[:, 1] + gaia[:, 3] * dt / 3.6e6, 0, quiet=True); off = []
        for xx, yy in zip(x - x0, y - y0):
            xi, yi = int(round(xx)), int(round(yy))
            if not (8 <= xi < img.shape[1] - 8 and 8 <= yi < img.shape[0] - 8) or bad[yi - 2:yi + 3, xi - 2:xi + 3].any(): continue
            c = sub[yi - 2:yi + 3, xi - 2:xi + 3]; s = c.sum()
            if s < 25 * sig: continue
            Y, X = np.mgrid[yi - 2:yi + 3, xi - 2:xi + 3]; off.append(((c * X).sum() / s - xx, (c * Y).sum() / s - yy))
        if len(off) >= 8: a['shift'] = tuple(float(v) for v in np.median(np.array(off), 0)); a['nstar'] = len(off)
    return a

def world2pix(a, ra, dec):
    """Sky -> cutout pixel of exposure a, with the exposure's own measured offset applied (M1)."""
    if 'w' not in a: a['w'] = WCS(fits.Header.fromstring(a['hdr']))
    x, y = a['w'].all_world2pix(ra, dec, 0, quiet=True); return np.asarray(x) - a['x0'] + a['shift'][0], np.asarray(y) - a['y0'] + a['shift'][1]

def phot(a, x, y, r=R_AP):
    """Aperture flux (mJy, no aperture correction) and its sigma at cutout pixel (x, y); nan if any pixel is missing."""
    xi, yi = int(round(float(x))), int(round(float(y))); img = a['img']
    if not (8 <= xi < img.shape[1] - 8 and 8 <= yi < img.shape[0] - 8) or not np.isfinite(a['sig_ap']): return np.nan, np.nan
    w = ap_weights(float(x) - xi, float(y) - yi, r)
    if a['bad'][yi - 3:yi + 4, xi - 3:xi + 4][w > 0].any(): return np.nan, np.nan
    ann = img[yi - 7:yi + 8, xi - 7:xi + 8][_ANN & ~a['bad'][yi - 7:yi + 8, xi - 7:xi + 8]]
    if ann.size < 40: return np.nan, np.nan
    return float((w * (img[yi - 3:yi + 4, xi - 3:xi + 4] - np.median(ann))).sum() * MJY_PIX), float(a['sig_ap'] * MJY_PIX)

def lam_at(a, x, y):
    return float(F.wave(a['det'])(np.array([[float(y) - a['shift'][1] + a['y0'], float(x) - a['shift'][0] + a['x0']]]))[0])

def resample(args):
    """One prepared exposure -> surface brightness on the patch grid (nan where masked, off the detector, or D5 short of LAM45)."""
    a, N, ra0, dec0 = args; g = (np.arange(N) - (N - 1) / 2) * OPIX; ra, dec = F.untan(*np.meshgrid(g, g), ra0, dec0); x, y = world2pix(a, ra.ravel(), dec.ravel()); c = [y.reshape(N, N), x.reshape(N, N)]
    bad = a['bad']; wt = ndi.map_coordinates((~bad).astype(np.float32), c, order=1, cval=0); v = ndi.map_coordinates(np.nan_to_num(a['sub']), c, order=1, cval=0)
    out = np.where(wt > 0.95, v / np.maximum(wt, 1e-6), np.nan).astype(np.float32)
    if a['det'] == 'D5': out[F.wave('D5')(np.stack([y - a['shift'][1] + a['y0'], x - a['shift'][0] + a['x0']], 1)).reshape(N, N) < LAM45] = np.nan
    return out

def affine(x, y, rx, ry):
    """Least-squares affine map (x, y) -> (rx, ry). -> 2x3 matrix."""
    A = np.c_[np.ones(len(x)), x, y]; return np.array([np.linalg.lstsq(A, rx, rcond=None)[0], np.linalg.lstsq(A, ry, rcond=None)[0]])
def apply(M, x, y):
    return M[0, 0] + M[0, 1] * x + M[0, 2] * y, M[1, 0] + M[1, 1] * x + M[1, 2] * y
def invert(M):
    L = np.linalg.inv(M[:, 1:]); return np.c_[-L @ M[:, 0], L]

def read_cat(d):
    """Catalogue adapters (M2). Gaia: ICRS at 2016.0, pm in mas/yr (pmra includes cos dec). CatWISE2020: ra_pm/dec_pm at MJD 57170,
    pmra/pmdec arcsec/yr (pmra includes cos dec), sig* in arcsec and arcsec/yr; rows without a W2 detection or a motion are dropped.
    2MASS: only the bright-star zones. AllWISE: positions at its own epoch, corroboration only."""
    rd = lambda n: list(csv.DictReader(open(f'{d}/{n}.csv')))
    G = np.array([[fl(r['ra']), fl(r['dec']), fl(r['pmra']), fl(r['pmdec']), fl(r['phot_g_mean_mag']), fl(r.get('bp_rp')), fl(r.get('pmra_error')), fl(r.get('pmdec_error'))] for r in rd('gaia')], float).reshape(-1, 8)
    C = np.array([[fl(r['ra_pm']), fl(r['dec_pm']), fl(r['sigra_pm']), fl(r['sigdec_pm']), fl(r['pmra']), fl(r['pmdec']), fl(r['sigpmra']), fl(r['sigpmdec']), fl(r['w1mpro_pm']), fl(r['w2mpro_pm']), fl(r['w2snr_pm']), fl(r['nb'])] for r in rd('catwise')], float).reshape(-1, 12)
    C = C[np.isfinite(C[:, [0, 1, 2, 3, 4, 5, 6, 7, 9]]).all(1) & (C[:, 10] >= 5)]
    T = np.array([[fl(r['ra']), fl(r['dec']), fl(r['k_m'])] for r in rd('twomass')], float).reshape(-1, 3)
    A = np.array([[fl(r['ra']), fl(r['dec']), fl(r['w2mpro']), fl(r['w1mjdmean'])] for r in rd('allwise')], float).reshape(-1, 4)
    return G, C, T, A

def stage_a(d):
    """Pixels -> everything the later stages need that comes from the stacks. Exposures are returned prepared."""
    P = json.load(open(d + '/field.json')); E = json.load(open(d + '/exposures.json')); G, C, T, A = read_cat(d); N = int(round(P['size'] * 3600 / OPIX)); g = (np.arange(N) - (N - 1) / 2) * OPIX
    ref = G[(G[:, 4] > 10.5) & (G[:, 4] < 17) & (np.hypot(G[:, 2], G[:, 3]) < 100)]
    with ProcessPoolExecutor(8) as ex: X = list(ex.map(prep, [(d, e, ref) for e in E], chunksize=8))
    out = dict(P=P, N=N, passes=[], note='', exposures=len(X), shifts={k: [float(np.median([np.hypot(*a['shift']) for a in X if a['det'] == k and a['nstar']] or [np.nan])), int(sum(a['det'] == k and a['nstar'] == 0 for a in X))] for k in ('D1', 'D2', 'D3', 'D4', 'D5', 'D6')})
    X6 = sorted([a for a in X if a['det'] == 'D6'], key=lambda a: a['t']); X5 = [a for a in X if a['det'] == 'D5']; groups = F.passes([a['t'] for a in X6]) if X6 else []
    usable = np.zeros((N, N), bool); xx, yy = np.meshgrid(g, g)
    if len([p for p in groups if len(p) >= MIN_EXP]) < 2: out['note'] = 'fewer than two survey passes'; out['usable'] = usable; return out, X
    stacks = []
    for p in groups:
        if len(p) < MIN_EXP: continue
        mem = [a for a in X6 if p[0] <= a['t'] <= p[-1]] + [a for a in X5 if p[0] - 20 <= a['t'] <= p[-1] + 20]
        with ProcessPoolExecutor(8) as ex: cube = np.array(list(ex.map(resample, [(dict(a, img=None), N, P['ra'], P['dec']) for a in mem], chunksize=4)))
        n = np.isfinite(cube).sum(0); s = np.where(n >= MIN_N, d2.combine(cube), np.nan); ap, sd = d2.maps(s); stacks.append(dict(t=float(np.mean([a['t'] for a in mem])), n_exp=len(mem), s=s, n=n, ap=ap, sd=sd)); del cube
    # all-pass stack: seeds
    wsum = np.nansum([np.where(np.isfinite(k['s']), k['n'], 0) for k in stacks], 0); sall = np.nansum([np.where(np.isfinite(k['s']), k['s'] * k['n'], 0) for k in stacks], 0) / np.maximum(wsum, 1); sall[wsum == 0] = np.nan
    apa, sda = d2.maps(sall); cand = []
    for ap, sd, s in [(apa, sda, sall)] + [(k['ap'], k['sd'], k['s']) for k in stacks]:
        snr = ap / sd; pk = (snr >= SNR_SEED) & (ap == ndi.maximum_filter(np.nan_to_num(ap, nan=-1e9), 7)); iy, ix = np.nonzero(pk)
        for x, y in zip(ix, iy):
            cx, cy = d2.centroid(s, float(x), float(y))
            if np.hypot(cx - x, cy - y) < 2.5 and not any(np.hypot(cx - q[0], cy - q[1]) < 2.0 for q in cand[-400:] if abs(q[1] - cy) < 2): cand.append((cx, cy))
    seeds = np.array(cand).reshape(-1, 2)
    if len(seeds):
        keep = np.ones(len(seeds), bool); tr = cKDTree(seeds)
        for i, j in sorted(tr.query_pairs(2.0)): keep[j] = keep[j] and not keep[i]
        seeds = seeds[keep]
    # per-pass positions, tied to Gaia (raw stack-pixel centroids kept for the D3 fits)
    S = dict(x=np.full((len(seeds), len(stacks)), np.nan), y=np.full((len(seeds), len(stacks)), np.nan), snr=np.full((len(seeds), len(stacks)), np.nan), f=np.full((len(seeds), len(stacks)), np.nan))
    S['px'], S['py'], S['seed_px'] = np.full_like(S['x'], np.nan), np.full_like(S['x'], np.nan), seeds
    S['ap_all'] = np.array([apa[int(round(y)), int(round(x))] if np.isfinite(apa[int(round(y)), int(round(x))]) else np.nan for x, y in seeds]) if len(seeds) else np.zeros(0)
    for j, k in enumerate(stacks):
        for i, (sx, sy) in enumerate(seeds):
            cx, cy = d2.centroid(k['s'], float(sx), float(sy)); xi, yi = int(round(cx)), int(round(cy))
            if np.hypot(cx - sx, cy - sy) >= 2.5 or not (5 <= xi < N - 5 and 5 <= yi < N - 5) or not np.isfinite(k['ap'][yi, xi]): continue
            S['px'][i, j], S['py'][i, j] = cx, cy
            S['x'][i, j], S['y'][i, j], S['snr'][i, j], S['f'][i, j] = (cx - (N - 1) / 2) * OPIX, (cy - (N - 1) / 2) * OPIX, k['ap'][yi, xi] / k['sd'][yi, xi], k['ap'][yi, xi] * MJY_STACK
        gx, gy = F.tan(ref[:, 0] + ref[:, 2] * (k['t'] - MJD_GAIA) / 365.25 / 3.6e6 / np.cos(np.radians(ref[:, 1])), ref[:, 1] + ref[:, 3] * (k['t'] - MJD_GAIA) / 365.25 / 3.6e6, P['ra'], P['dec'])
        ok = np.isfinite(S['x'][:, j]) & (S['snr'][:, j] > 10); info = dict(t=k['t'], year=float(F.year(k['t'])), exposures=k['n_exp'], stars=0, rms=None, used=False)
        if ok.sum() >= 15 and len(gx) >= 15:
            dd, jj = cKDTree(np.c_[gx, gy]).query(np.c_[S['x'][ok, j], S['y'][ok, j]]); m = dd < 5
            if m.sum() >= 15:
                M = affine(S['x'][ok, j][m], S['y'][ok, j][m], gx[jj][m], gy[jj][m]); rx, ry = apply(M, S['x'][ok, j], S['y'][ok, j]); r = np.hypot(rx - gx[jj], ry - gy[jj]); m = m & (r < 3)      # one pass without the gross mismatches, then the errors from everything matched
                M = affine(S['x'][ok, j][m], S['y'][ok, j][m], gx[jj][m], gy[jj][m]); rx, ry = apply(M, S['x'][:, j], S['y'][:, j]); S['x'][:, j], S['y'][:, j] = rx, ry
                dd, jj = cKDTree(np.c_[gx, gy]).query(np.c_[rx[ok], ry[ok]]); m = dd < 5; res = np.r_[rx[ok][m] - gx[jj][m], ry[ok][m] - gy[jj][m]]; sn = np.r_[S['snr'][ok, j][m], S['snr'][ok, j][m]]
                hi, lo = sn > 60, sn < 25; A_ = float(np.percentile(np.abs(res[hi]), 68.3)) if hi.sum() > 20 else 0.35; B_ = float(np.sqrt(max(np.percentile(np.abs(res[lo]), 68.3) ** 2 - A_ ** 2, 0.01)) * np.median(sn[lo])) if lo.sum() > 20 else 7.0
                info.update(stars=int(m.sum()), rms=float(np.sqrt(np.mean(res ** 2))), used=True, floor=max(A_, 0.15), per_snr=max(B_, 4.0), M=M.tolist(), Minv=invert(M).tolist())
        if not info['used']: S['x'][:, j] = np.nan
        out['passes'].append(info); usable_j = (k['n'] >= MIN_N) & np.isfinite(k['ap']) & info['used']; k['usable'] = usable_j
    # usable sky: two tied passes, methane-band and peak coverage, not near the edge or a bright star (v3's recipe, unchanged, A14)
    n33 = np.zeros((N, N), np.int16); step = 4; gs = g[::step]; ra_c, dec_c = F.untan(*np.meshgrid(gs, gs), P['ra'], P['dec'])
    for a in X:
        if a['det'] != 'D4': continue
        x, y = world2pix(a, ra_c.ravel(), dec_c.ravel()); xi, yi = np.round(x).astype(int), np.round(y).astype(int); inb = (xi >= 3) & (xi < a['img'].shape[1] - 3) & (yi >= 3) & (yi < a['img'].shape[0] - 3)
        lam = F.wave('D4')(np.stack([y + a['y0'], x + a['x0']], 1)); good = inb & (lam >= 3.1) & (lam <= 3.6); good[inb] &= ~a['bad'][yi[inb], xi[inb]]
        n33[::step, ::step] += good.reshape(len(gs), len(gs))
    n33 = ndi.maximum_filter(n33, step); px2 = (OPIX / 3600) ** 2
    inner = (np.abs(xx) < P['size'] * 1800 - BORDER) & (np.abs(yy) < P['size'] * 1800 - BORDER); two = np.sum([k['usable'] for k in stacks], 0) >= 2; d4 = n33 >= 3
    bright = np.ones((N, N), bool); bx, by = F.tan(T[:, 0], T[:, 1], P['ra'], P['dec'])
    for x, y, k_ in zip(bx, by, T[:, 2]):
        if k_ < 9: bright &= np.hypot(xx - x, yy - y) > 20 + 25 * (9 - k_)
    usable = inner & two & d4 & bright
    out['excluded_sqdeg'] = dict(border=float((~inner).sum() * px2), two_tied_passes=float((inner & ~two).sum() * px2), d4_coverage=float((inner & two & ~d4).sum() * px2), bright_star=float((inner & two & d4 & ~bright).sum() * px2))
    # D3: pixel noise, empirical PSF, and the joint-fit calibration on Gaia stars, per pass (pixels and Gaia only)
    gnb = G[(G[:, 4] < NB_G) & np.isfinite(G[:, 2]) & np.isfinite(G[:, 3])]; out['stacks'] = []; out['ref'], out['gnb'] = ref, gnb
    for j, k in enumerate(stacks):
        info = out['passes'][j]; st = dict(s=k['s'].astype(np.float32), n=k['n'].astype(np.int16))
        if info['used']:
            st.update(sig=pixel_sigma(k['s'], k['n'])); st['psf'], st['psf_stars'] = build_psf(st, S, j, P, ref, info, N)
            if st['psf'] is not None: st['cal'] = calibrate(st, S, j, P, ref, gnb, info, N, k['ap'])
        out['stacks'].append(st)
    out['dpsf'] = det_psfs(X, G, P)
    out.update(usable=usable, S=S, seeds=len(seeds)); return out, X

# ---------- D3: joint local PSF fit on a pass stack ----------
def pixel_sigma(s, n):
    """Noise of one stack pixel: robust scatter of the stack where coverage is typical, scaled by 1/sqrt(looks)."""
    ok = np.isfinite(s) & (n >= max(np.median(n[n > 0]), 1)); v = s[ok]; s0 = 1.4826 * np.median(np.abs(v - np.median(v))) if v.size > 1000 else np.nan
    return (s0 * np.sqrt(np.median(n[ok]) / np.maximum(n, 1))).astype(np.float32)

def to_px(info, N, x, y, which='M'):
    """Tied frame (arcsec) -> stack pixel, through the inverse of the pass tie ('M': centroid tie, 'M3': joint-fit tie)."""
    Mi = invert(np.array(info[which])); u, v = apply(Mi, np.asarray(x, float), np.asarray(y, float)); return u / OPIX + (N - 1) / 2, v / OPIX + (N - 1) / 2

def build_psf(st, S, j, P, ref, info, N):
    """Empirical pass-stack PSF ((2 PSF_H + 1)^2, sum 1): median of normalised, re-centred stamps of bright isolated seeds that
    are Gaia stars. -> (prefiltered spline coefficients, number of stars)"""
    s = st['s']; px, py = S['px'][:, j], S['py'][:, j]; ok = np.isfinite(px)
    if ok.sum() < 30: return None, 0
    tr = cKDTree(np.c_[px[ok], py[ok]]); idx = np.nonzero(ok)[0]; H = PSF_H; stamps = []
    gx, gy = F.tan(ref[:, 0] + ref[:, 2] * (info['t'] - MJD_GAIA) / 365.25 / 3.6e6 / np.cos(np.radians(ref[:, 1])), ref[:, 1] + ref[:, 3] * (info['t'] - MJD_GAIA) / 365.25 / 3.6e6, P['ra'], P['dec'])
    gpx, gpy = to_px(info, N, gx, gy); gt = cKDTree(np.c_[gpx, gpy])
    order = idx[np.argsort(-S['snr'][idx, j])]
    for i in order:
        if not (40 <= S['snr'][i, j] <= 2000) or len(tr.query_ball_point([px[i], py[i]], 9.0)) > 1 or not gt.query_ball_point([px[i], py[i]], 1.0): continue
        xi, yi = int(round(px[i])), int(round(py[i]))
        if not (H + 2 <= xi < N - H - 2 and H + 2 <= yi < N - H - 2): continue
        c = s[yi - H - 2:yi + H + 3, xi - H - 2:xi + H + 3].astype(float)
        if not np.isfinite(c).all(): continue
        r = np.hypot(*np.mgrid[-H - 2:H + 3, -H - 2:H + 3]); c = c - np.median(c[r > H]); c = ndi.shift(c, (yi - py[i], xi - px[i]), order=3, mode='nearest')[2:-2, 2:-2]
        if c.sum() <= 0: continue
        stamps.append(c / c.sum())
        if len(stamps) >= 60: break
    if len(stamps) < 10: return None, len(stamps)
    p = np.median(np.array(stamps), 0); p = p / p.sum(); return ndi.spline_filter(p, order=3).astype(float), len(stamps)

def neighbours(S, j, x0, y0, gpx, gpy, ggm, exclude=None):
    """Neighbour starts (stack px) within R_NB of (x0, y0): seeds (their pass-j centroid, else the all-pass position) and
    Gaia stars brighter than NB_G that no seed covers; anything within MERGE_PX of the start is the target itself."""
    sp = np.where(np.isfinite(S['px'][:, j])[:, None], np.c_[S['px'][:, j], S['py'][:, j]], S['seed_px'])
    d = np.hypot(sp[:, 0] - x0, sp[:, 1] - y0); m = (d <= R_NB) & (d > MERGE_PX)
    if exclude is not None: m[exclude] = False
    nb = list(sp[m])
    if gpx is not None:
        dg = np.hypot(gpx - x0, gpy - y0)
        for q in np.nonzero((dg <= R_NB) & (dg > MERGE_PX) & (ggm < NB_G))[0]:
            if np.hypot(sp[:, 0] - gpx[q], sp[:, 1] - gpy[q]).min(initial=99) > MERGE_PX: nb.append(np.array([gpx[q], gpy[q]]))
    return np.array(nb, float).reshape(-1, 2)

def jfit(st, x0, y0, nb):
    """Joint fit of a point source starting at (x0, y0) and the neighbours nb (stack px) on the pass stack: PSF positions
    (target free, neighbours with a SIG_NB prior on their start), fluxes and a background plane, all fitted together with
    an analytic Jacobian. Covariance from that Jacobian at the solution (every parameter free), scaled by the reduced
    chi-square when above 1. -> dict(x, y, sx, sy, f, sf (stack units), chi2r, sep (nearest fitted neighbour, px),
    moved (px), n_nb) or None"""
    s, sig, psf = st['s'], st['sig'], st['psf']; N = s.shape[0]; R = int(np.ceil(R_FIT)); xi, yi = int(round(x0)), int(round(y0))
    if not (R + 1 <= xi < N - R - 1 and R + 1 <= yi < N - R - 1): return None
    Y, X = np.mgrid[yi - R:yi + R + 1, xi - R:xi + R + 1]; win = (X - x0) ** 2 + (Y - y0) ** 2 <= R_FIT ** 2; d = s[Y, X]; w = 1 / sig[Y, X]; m = win & np.isfinite(d) & np.isfinite(w)
    if m.sum() < 0.6 * win.sum(): return None
    Xm, Ym, dm, wm = X[m].astype(float), Y[m].astype(float), d[m].astype(float), w[m].astype(float); ns = len(nb) + 1; p0 = np.r_[x0, y0, nb.ravel()]; k2 = 2 * ns; h = 0.01
    V = lambda px_, py_: ndi.map_coordinates(psf, [PSF_H + Ym - py_, PSF_H + Xm - px_], order=3, prefilter=False, cval=0.0)
    B = np.c_[np.ones_like(Xm), Xm - x0, Ym - y0]
    def parts(th):
        pos = p0 + th[:k2]; c = th[k2:]; Vs = [V(pos[2 * q], pos[2 * q + 1]) for q in range(ns)]; return pos, c, Vs
    def res(th):
        pos, c, Vs = parts(th); mod = sum(c[q] * Vs[q] for q in range(ns)) + B @ c[ns:]; return np.r_[(dm - mod) * wm, th[2:k2] / SIG_NB]
    def jac(th):
        pos, c, Vs = parts(th); J = np.zeros((len(dm) + k2 - 2, len(th)))
        for q in range(ns):
            J[:len(dm), 2 * q] = -c[q] * (V(pos[2 * q] + h, pos[2 * q + 1]) - V(pos[2 * q] - h, pos[2 * q + 1])) / (2 * h) * wm
            J[:len(dm), 2 * q + 1] = -c[q] * (V(pos[2 * q], pos[2 * q + 1] + h) - V(pos[2 * q], pos[2 * q + 1] - h)) / (2 * h) * wm
            J[:len(dm), k2 + q] = -Vs[q] * wm
        J[:len(dm), k2 + ns:] = -B * wm[:, None]; J[len(dm):, 2:k2] = np.eye(k2 - 2) / SIG_NB; return J
    A0 = np.c_[np.array([V(p0[2 * q], p0[2 * q + 1]) for q in range(ns)]).T, B]; c0 = np.linalg.lstsq(A0 * wm[:, None], dm * wm, rcond=None)[0]
    th0 = np.r_[np.zeros(k2), c0]; bd = np.r_[R_FIT, R_FIT, np.full(k2 - 2, 3.0), np.full(len(c0), np.inf)]
    try: sol = least_squares(res, th0, jac=jac, bounds=(-bd, bd), x_scale='jac', max_nfev=60)
    except Exception: return None
    th = sol.x; r = res(th)[:len(dm)]; J = jac(th)
    try: cov = np.linalg.inv(J.T @ J)
    except np.linalg.LinAlgError: return None
    chi2r = float((r ** 2).sum() / max(len(dm) - len(th), 1)); cov *= max(chi2r, 1.0); pos = p0 + th[:k2]
    sep = float(np.min(np.hypot(pos[2::2] - pos[0], pos[3::2] - pos[1]))) if ns > 1 else 99.0
    return dict(x=float(pos[0]), y=float(pos[1]), sx=float(np.sqrt(cov[0, 0])), sy=float(np.sqrt(cov[1, 1])), f=float(th[k2]), sf=float(np.sqrt(cov[k2, k2])), chi2r=chi2r, sep=sep, moved=float(np.hypot(pos[0] - x0, pos[1] - y0)), n_nb=ns - 1)

def gaia_px(info, P, ref, N):
    gx, gy = F.tan(ref[:, 0] + ref[:, 2] * (info['t'] - MJD_GAIA) / 365.25 / 3.6e6 / np.cos(np.radians(ref[:, 1])), ref[:, 1] + ref[:, 3] * (info['t'] - MJD_GAIA) / 365.25 / 3.6e6, P['ra'], P['dec'])
    return gx, gy

def calibrate(st, S, j, P, ref, gnb, info, N, ap):
    """Run the joint fit on Gaia stars of this pass: tie M3 (fitted position -> Gaia), position floor and error scale,
    tails by crowding, and the flux convention (aperture-map flux over PSF flux). Pixels and Gaia only."""
    gx, gy = gaia_px(info, P, ref, N); gpx, gpy = to_px(info, N, gx, gy); px, py = S['px'][:, j], S['py'][:, j]; ok = np.isfinite(px)
    if ok.sum() < 30: return None
    nx, ny = to_px(info, N, *gaia_px(info, P, gnb, N))
    tr = cKDTree(np.c_[px[ok], py[ok]]); idx = np.nonzero(ok)[0]; dd, jj = tr.query(np.c_[gpx, gpy]); rng = np.random.default_rng(j)
    cand = [q for q in rng.permutation(len(gx)) if dd[q] < MERGE_PX and 8 <= S['snr'][idx[jj[q]], j] <= 1500][:260]; rows = []
    for q in cand:
        i = idx[jj[q]]; nb = neighbours(S, j, px[i], py[i], nx, ny, gnb[:, 4], exclude=i); f = jfit(st, px[i], py[i], nb)
        if f is None or f['f'] <= 0 or f['moved'] > 2: continue
        brighter = any(S['ap_all'][idx[o]] > S['ap_all'][i] for o in tr.query_ball_point([px[i], py[i]], 30 / OPIX) if idx[o] != i) if np.isfinite(S['ap_all'][i]) else False
        xi_, yi_ = int(round(f['x'])), int(round(f['y'])); a_ = ap[yi_, xi_] if 0 <= xi_ < N and 0 <= yi_ < N else np.nan
        rows.append((f['x'], f['y'], f['sx'], f['sy'], f['f'] / f['sf'], gx[q], gy[q], brighter, a_ / f['f'] if f['f'] > 0 else np.nan))
    if len(rows) < 30: return None
    R_ = np.array(rows, float); X3, Y3 = (R_[:, 0] - (N - 1) / 2) * OPIX, (R_[:, 1] - (N - 1) / 2) * OPIX
    M = affine(X3, Y3, R_[:, 5], R_[:, 6]); rx, ry = apply(M, X3, Y3); m = np.hypot(rx - R_[:, 5], ry - R_[:, 6]) < 3; M = affine(X3[m], Y3[m], R_[m, 5], R_[m, 6]); rx, ry = apply(M, X3, Y3)
    res = np.r_[rx - R_[:, 5], ry - R_[:, 6]]; sfit = np.r_[R_[:, 2], R_[:, 3]] * OPIX; sn = np.r_[R_[:, 4], R_[:, 4]]; crowd = np.r_[R_[:, 7], R_[:, 7]] > 0
    hi = sn > 60; floor = max(float(np.percentile(np.abs(res[hi]), 68.3)) if hi.sum() > 20 else 0.35, 0.15); lo = sn < 40; scale = 1.0
    if lo.sum() > 20:
        for sc in np.arange(1.0, 6.01, 0.05):
            scale = float(sc)
            if np.percentile(np.abs(res[lo]) / np.hypot(floor, sc * sfit[lo]), 68.3) <= 1.0: break
    z = np.abs(res) / np.hypot(floor, scale * sfit); tail = lambda mm: float((z[mm] > 3).mean()) if mm.sum() else None
    return dict(M3=M.tolist(), floor=floor, scale=scale, stars=int(len(R_)), rms=float(np.sqrt(np.mean(res[np.abs(res) < 3] ** 2))), tail3_isolated=tail(~crowd), tail3_crowded=tail(crowd), n_crowded=int(crowd.sum() // 2),
                apc=float(np.nanmedian(R_[(R_[:, 4] > 20) & (R_[:, 7] == 0), 8])) if ((R_[:, 4] > 20) & (R_[:, 7] == 0)).sum() >= 10 else float(np.nanmedian(R_[:, 8])))

def measure(A, j, x0, y0, exclude=None):
    """One D3 pass measurement started at stack pixel (x0, y0). -> (x, y, sigma (arcsec, tied frame), snr, flux mJy in the
    aperture-map convention, fit) or None"""
    st = A['stacks'][j]; cal = st.get('cal')
    if cal is None or st.get('psf') is None: return None
    if 'gpx' not in st:
        G = A['gnb']; gx, gy = gaia_px(A['passes'][j], A['P'], G, A['N']); st['gpx'], st['gpy'] = to_px(A['passes'][j], A['N'], gx, gy); st['ggm'] = G[:, 4]
    nb = neighbours(A['S'], j, x0, y0, st['gpx'], st['gpy'], st['ggm'], exclude); f = jfit(st, x0, y0, nb)
    if f is None or not np.isfinite(f['sf']) or f['sf'] <= 0: return None
    N = A['N']; X3, Y3 = (f['x'] - (N - 1) / 2) * OPIX, (f['y'] - (N - 1) / 2) * OPIX; x, y = apply(np.array(cal['M3']), X3, Y3)
    sg = float(np.hypot(cal['floor'], cal['scale'] * OPIX * max(f['sx'], f['sy'])))
    return float(x), float(y), sg, f['f'] / f['sf'], f['f'] * MJY_STACK * cal['apc'], f

def cache_key(d):
    """Stage A depends on pixels, Gaia and 2MASS only (A18): CatWISE and AllWISE are not in the key because nothing in
    stage A reads them; every catalogue-driven stage runs fresh on every call."""
    h = hashlib.sha256((VERSION + repr((R_FIT, R_NB, SIG_NB, PSF_H, NB_G, MERGE_PX, PH))).encode())
    for f in ['field.json', 'exposures.json', 'gaia.csv', 'twomass.csv']: h.update(open(f'{d}/{f}', 'rb').read())
    for e in json.load(open(d + '/exposures.json')): p = os.path.realpath(f"{d}/{e['file']}"); st = os.stat(p); h.update(f'{p}:{st.st_size}:{st.st_mtime_ns}'.encode())
    return h.hexdigest()[:24]

# ---------- B. link and motion ----------
def tie_catwise(G, C, P):
    """CatWISE positions and motions against Gaia stars in this field: offsets to remove, a position floor, a motion-error scale."""
    gx, gy = F.tan(G[:, 0] + G[:, 2] * (MJD_CW - MJD_GAIA) / 365.25 / 3.6e6 / np.cos(np.radians(G[:, 1])), G[:, 1] + G[:, 3] * (MJD_CW - MJD_GAIA) / 365.25 / 3.6e6, P['ra'], P['dec']); cx, cy = F.tan(C[:, 0], C[:, 1], P['ra'], P['dec'])
    if len(gx) < 30 or len(cx) < 30: return None
    dd, jj = cKDTree(np.c_[gx, gy]).query(np.c_[cx, cy]); m = (dd < 1.5) & (C[:, 10] > 20) & (C[:, 11] == 1)
    if m.sum() < 30: return None
    ox, oy = float(np.median(cx[m] - gx[jj][m])), float(np.median(cy[m] - gy[jj][m])); r = np.r_[cx[m] - gx[jj][m] - ox, cy[m] - gy[jj][m] - oy]; q = np.r_[C[m, 2], C[m, 3]]
    floor = float(np.sqrt(max(np.percentile(np.abs(r), 68.3) ** 2 - np.median(q) ** 2, 0)))
    dpe, dpn = C[m, 4] - G[jj][m, 2] / 1000, C[m, 5] - G[jj][m, 3] / 1000; pe, pn = float(np.median(dpe)), float(np.median(dpn))
    scale = float(max(1.0, np.percentile(np.abs(np.r_[(dpe - pe) / C[m, 6], (dpn - pn) / C[m, 7]]), 68.3)))
    return dict(stars=int(m.sum()), offset=[ox, oy], floor=max(floor, 0.05), pm_offset=[pe, pn], pm_scale=scale)

def fit_track(t, x, y, s, cw):
    """Weighted fit of position + proper motion (+ parallax from the grid) to SPHEREx pass positions (t in MJD, x, y, s arcsec)
    and, if cw = (x, y, sx, sy, mue, mun, se, sn, pfe, pfn per pass), the CatWISE position at MJD_CW and motion.
    use: 'all', 'nopm' (leave the CatWISE motion out), 'static' (no motion). -> dict per use."""
    res = {}
    for use in ('all', 'nopm', 'static'):
        best = None
        for plx in PLX_GRID:
            rows, obs, sig = [], [], []
            for ti, xi, yi, si, fe, fn in zip(t, x, y, s, cw['pfe'], cw['pfn']):
                dt = (ti - MJD_CW) / 365.25; rows += [[1, 0, dt, 0], [0, 1, 0, dt]]; obs += [xi - plx * fe, yi - plx * fn]; sig += [si, si]
            rows += [[1, 0, 0, 0], [0, 1, 0, 0]]; obs += [cw['x'], cw['y']]; sig += [cw['sx'], cw['sy']]
            if use != 'nopm': rows += [[0, 0, 1, 0], [0, 0, 0, 1]]; obs += [cw['mue'], cw['mun']]; sig += [cw['se'], cw['sn']]
            A = np.array(rows, float); b = np.array(obs, float); w = 1 / np.array(sig, float)
            if use == 'static': A = A[:, :2]
            Aw = A * w[:, None]; cov = np.linalg.inv(Aw.T @ Aw); p = cov @ Aw.T @ (b * w); c2 = float((((A @ p) - b) * w) ** 2 @ np.ones(len(b)))
            if best is None or c2 < best['chi2']: best = dict(chi2=c2, p=p, cov=cov, plx=plx, dof=len(b) - A.shape[1])
        res[use] = best
    return res

def link(A, d):
    """SPHEREx sources (seed path, and D2 proposals for valid CatWISE movers no seed links to) x CatWISE rows -> movers,
    one per physical source, each with its stage and seed path. -> (movers, tie, path counts)"""
    P, S = A['P'], A['S']; G, C, T, AW = read_cat(d); tie = tie_catwise(G, C, P); passes = A['passes']; used = [j for j, p in enumerate(passes) if p['used']]; N = A['N']; usable = A['usable']
    stats = dict(seed_sources=0, d3_fallback=0, proposals=0, proposal_sources=0)
    if tie is None or len(used) < 2: return [], tie, stats
    cx, cy = F.tan(C[:, 0], C[:, 1], P['ra'], P['dec']); cx, cy = cx - tie['offset'][0], cy - tie['offset'][1]; mue, mun = C[:, 4] - tie['pm_offset'][0], C[:, 5] - tie['pm_offset'][1]
    se, sn = np.hypot(C[:, 6] * tie['pm_scale'], PM_FRAC * np.hypot(mue, mun)), np.hypot(C[:, 7] * tie['pm_scale'], PM_FRAC * np.hypot(mue, mun)); sx, sy = np.hypot(C[:, 2], tie['floor']), np.hypot(C[:, 3], tie['floor']); fw2 = 171787.0 * 10 ** (-0.4 * C[:, 9])
    valid = (np.hypot(mue, mun) >= MU_MIN) & (np.hypot(mue, mun) <= MU_MAX) & (np.sqrt((mue / se) ** 2 + (mun / sn) ** 2) >= K_CW)
    tm = float(np.mean([passes[j]['t'] for j in used])); dtm = (tm - MJD_CW) / 365.25; px, py = cx + mue * dtm, cy + mun * dtm; tree = cKDTree(np.c_[px, py])
    gx, gy = F.tan(G[:, 0] + G[:, 2] * (tm - MJD_GAIA) / 365.25 / 3.6e6 / np.cos(np.radians(G[:, 1])), G[:, 1] + G[:, 3] * (tm - MJD_GAIA) / 365.25 / 3.6e6, P['ra'], P['dec']); gtree = cKDTree(np.c_[gx, gy]) if len(gx) else None
    ax_, ay_ = F.tan(AW[:, 0], AW[:, 1], P['ra'], P['dec']) if len(AW) else (np.zeros(0), np.zeros(0))
    pf = [F.pfac(P['ra'], P['dec'], passes[j]['t']) for j in range(len(passes))]
    inmap = lambda x_, y_: (lambda ix, iy: 0 <= ix < N and 0 <= iy < N and usable[iy, ix])(int(round(x_ / OPIX + (N - 1) / 2)), int(round(y_ / OPIX + (N - 1) / 2)))
    def d3ok(m, x0, y0): return m is not None and m[3] >= SNR_PASS and m[5]['sep'] >= MERGE_PX and m[5]['moved'] * OPIX <= LINK_R
    sources, linked = [], set()
    for i in (range(len(S['x'])) if SEED_PATH else []):
        js = [j for j in used if np.isfinite(S['x'][i, j]) and S['snr'][i, j] >= SNR_PASS]
        if len(js) < 2: continue
        x, y, snr, f = S['x'][i, js], S['y'][i, js], S['snr'][i, js], S['f'][i, js]; s = np.array([np.hypot(passes[j]['floor'], passes[j]['per_snr'] / q) for j, q in zip(js, snr)])
        w = 1 / s ** 2; mx, my = float((x * w).sum() / w.sum()), float((y * w).sum() / w.sum())
        if not inmap(mx, my): continue
        near = [k_ for k_ in tree.query_ball_point([mx, my], LINK_R) if valid[k_]]
        if not near: continue
        linked |= set(near); src = dict(path='seed', js=js, x=x, y=y, s=s, snr=snr, f=f, near=near, d3=False)
        if USE_D3:
            got = []
            for j in used:
                x0, y0 = (S['px'][i, j], S['py'][i, j]) if np.isfinite(S['px'][i, j]) else tuple(S['seed_px'][i]); m = measure(A, j, x0, y0, exclude=i)
                if d3ok(m, x0, y0): got.append((j, m))
            if len(got) >= 2: src.update(js=[j for j, _ in got], x=np.array([m[0] for _, m in got]), y=np.array([m[1] for _, m in got]), s=np.array([m[2] for _, m in got]), snr=np.array([m[3] for _, m in got]), f=np.array([m[4] for _, m in got]), d3=True)
            else: stats['d3_fallback'] += 1
        sources.append(src); stats['seed_sources'] += 1
    if USE_D2:
        for k in np.nonzero(valid)[0]:
            if k in linked or not inmap(px[k], py[k]): continue
            stats['proposals'] += 1; got = []
            for j in used:
                cal = A['stacks'][j].get('cal')
                if cal is None: continue
                dt = (passes[j]['t'] - MJD_CW) / 365.25; u, v = apply(invert(np.array(cal['M3'])), cx[k] + mue[k] * dt, cy[k] + mun[k] * dt); x0, y0 = float(u) / OPIX + (N - 1) / 2, float(v) / OPIX + (N - 1) / 2
                m = measure(A, j, x0, y0)
                if d3ok(m, x0, y0): got.append((j, m))
            if len(got) < 2 or np.hypot.reduce([m[3] for _, m in got]) < SNR_SEED: continue
            x, y, s_ = np.array([m[0] for _, m in got]), np.array([m[1] for _, m in got]), np.array([m[2] for _, m in got]); w = 1 / s_ ** 2; mx, my = float((x * w).sum() / w.sum()), float((y * w).sum() / w.sum())
            near = sorted(set([int(k)] + [k_ for k_ in tree.query_ball_point([mx, my], LINK_R) if valid[k_]]))
            sources.append(dict(path='proposal', js=[j for j, _ in got], x=x, y=y, s=s_, snr=np.array([m[3] for _, m in got]), f=np.array([m[4] for _, m in got]), near=near, d3=True, row=int(k))); stats['proposal_sources'] += 1
    movers = []
    for src in sources:
        js, t, x, y, s, snr, near = src['js'], np.array([passes[j]['t'] for j in src['js']]), src['x'], src['y'], src['s'], src['snr'], src['near']
        w = 1 / s ** 2; mx, my = float((x * w).sum() / w.sum()), float((y * w).sum() / w.sum())
        f45 = float(np.nanmean(src['f'])); dt_ref = (MJD_REF - MJD_CW) / 365.25; tries = []
        gk = gtree.query_ball_point([mx, my], 2.5) if gtree is not None else []
        for k in near:
            s_cw = float(np.sqrt((mue[k] / se[k]) ** 2 + (mun[k] / sn[k]) ** 2)); cw = dict(x=cx[k], y=cy[k], sx=sx[k], sy=sy[k], mue=mue[k], mun=mun[k], se=se[k], sn=sn[k], pfe=[float(pf[j][0][0]) for j in js], pfn=[float(pf[j][1][0]) for j in js])
            fit = fit_track(t, x, y, s, cw); fa, fn_, fs = fit['all'], fit['nopm'], fit['static']; p = fa['p']; ra, dec = F.untan(p[0] + p[2] * dt_ref, p[1] + p[3] * dt_ref, P['ra'], P['dec']); mu = float(np.hypot(p[2], p[3]))
            s_disp = float(np.sqrt(fn_['p'][2:] @ np.linalg.inv(fn_['cov'][2:, 2:]) @ fn_['p'][2:])); dm = fn_['p'][2:] - np.array([mue[k], mun[k]]); agree = float(dm @ np.linalg.inv(fn_['cov'][2:, 2:] + np.diag([se[k] ** 2, sn[k] ** 2])) @ dm)
            m = dict(ra=float(ra), dec=float(dec), pm_e=float(p[2]), pm_n=float(p[3]), pm=mu, pm_sigma=float(np.sqrt(p[2:] @ np.linalg.inv(fa['cov'][2:, 2:]) @ p[2:])), plx_nuisance=fa['plx'], chi2=fa['chi2'], dof=fa['dof'], dchi2_static=fs['chi2'] - fa['chi2'],
                     s_catwise=s_cw, s_displacement=s_disp, agree_chi2=agree, pm_catwise=[float(mue[k]), float(mun[k])], pm_displacement=[float(v) for v in fn_['p'][2:]], w2=float(C[k, 9]), w1=float(C[k, 8]), f45_mjy=f45, flux_ratio=float(f45 / fw2[k]),
                     n_pass=len(js), snr=[float(v) for v in snr], xy=[[float(u), float(v)] for u, v in zip(x, y)], t=[float(v) for v in t], sig=[float(v) for v in s], cw_xy=[float(cx[k]), float(cy[k])], track=[float(v) for v in p], stage='motion', verdict='insufficient', spectrum_valid=False, score=0.0,
                     path=[src['path']], d3=src['d3'])
            m['gaia'] = [dict(g=float(G[q, 4]), bp_rp=float(G[q, 5]), pm=[float(G[q, 2]) / 1000, float(G[q, 3]) / 1000]) for q in gk]
            still = [q for q in gk if np.hypot(G[q, 2] / 1000 - p[2], G[q, 3] / 1000 - p[3]) > max(0.1, 0.3 * mu)]
            m['why'] = ('speed' if not MU_MIN <= mu <= MU_MAX else 'displacement' if s_disp < K_DISP else 'disagree' if chi2d.sf(agree, 2) < P_MIN else 'fit' if chi2d.sf(fa['chi2'], fa['dof']) < P_MIN
                        else 'flux' if not FLUX_LO <= m['flux_ratio'] <= FLUX_HI else 'static_gaia' if still else None)
            tries.append((k, m))
        good = [(k, m) for k, m in tries if m['why'] is None]; k, m = min(good or tries, key=lambda q: q[1]['chi2'] + q[1]['agree_chi2']); why = m.pop('why')
        same = lambda a_, b_: abs(np.hypot(*a_) / np.hypot(*b_) - 1) <= 0.3 and np.degrees(abs(np.arctan2(a_[0] * b_[1] - a_[1] * b_[0], a_[0] * b_[0] + a_[1] * b_[1]))) <= 20
        if why is None:
            frag = lambda k_: 0.6 <= np.hypot(mue[k_], mun[k_]) / np.hypot(mue[k], mun[k]) <= 2.0 and (mue[k_] * mue[k] + mun[k_] * mun[k]) >= np.cos(np.radians(30)) * np.hypot(mue[k_], mun[k_]) * np.hypot(mue[k], mun[k])
            c15 = cKDTree(np.c_[cx, cy]).query_ball_point([cx[k], cy[k]], 4.0) if mu > 0.8 else []
            split = set(k_ for k_ in list(tree.query_ball_point([mx, my], BLEND_R)) + c15 if frag(k_)) | {k}
            if any(not same((m2['pm_e'], m2['pm_n']), (m['pm_e'], m['pm_n'])) for _, m2 in good) or any(fw2[k_] >= BLEND_FLUX * fw2[k] for k_ in tree.query_ball_point([mx, my], BLEND_R) if k_ not in split): why = 'ambiguous'
            m['catwise_rows'] = len(split)
        for _, m2 in tries: m2.pop('why', None)
        m['allwise'] = bool(len(ax_) and (np.hypot(ax_ - (cx[k] + mue[k] * (55400 - MJD_CW) / 365.25), ay_ - (cy[k] + mun[k] * (55400 - MJD_CW) / 365.25)) < 3.0).any())
        m['stage'] = 'motion_rejected:' + why if why else 'spectrum'; m['catwise_row'] = int(k); movers.append(m)
    return dedup(movers), tie, stats

def dedup(movers):
    """One record per physical source (A17): movers within DUP_AS at MJD 61000 with the same motion (30% in speed, 20 deg)
    merge; the kept record prefers a passing motion stage, then the better fit; every path is kept."""
    same = lambda a, b: abs(np.hypot(a['pm_e'], a['pm_n']) / max(np.hypot(b['pm_e'], b['pm_n']), 1e-9) - 1) <= 0.3 and np.degrees(abs(np.arctan2(a['pm_e'] * b['pm_n'] - a['pm_n'] * b['pm_e'], a['pm_e'] * b['pm_e'] + a['pm_n'] * b['pm_n']))) <= 20
    key = lambda m: (m['stage'] != 'spectrum', m['chi2'] + m['agree_chi2']); out = []
    for m in sorted(movers, key=key):
        twin = next((o for o in out if np.hypot((m['ra'] - o['ra']) * np.cos(np.radians(o['dec'])), m['dec'] - o['dec']) * 3600 < DUP_AS and same(m, o)), None)
        if twin is None: out.append(m)
        else: twin['path'] = sorted(set(twin['path']) | set(m['path'])); twin['merged'] = twin.get('merged', 0) + 1
    return out

# ---------- C. spectrum ----------
_T = {}
def templates():
    if not _T: _T.update(json.load(open(HERE + '/' + TEMPLATES)))
    return _T

def spectrum(X, P, track, plx, nbs=None, dpsf=None):
    """Forced photometry along a fitted track in every exposure. -> samples array [lam, flux mJy, sigma, mjd]. With
    neighbours (nbs: sky tracks (ra, dec at MJD_GAIA, pme, pmn arcsec/yr)) and the per-detector PSFs, the target and the
    neighbours are fitted together in each exposure (phot_psf) instead of the plain aperture."""
    out = []
    for a in X:
        dt = (a['t'] - MJD_CW) / 365.25; fe, fn = F.pfac(P['ra'], P['dec'], a['t']); ra, dec = F.untan(track[0] + track[2] * dt + plx * fe[0], track[1] + track[3] * dt + plx * fn[0], P['ra'], P['dec'])
        x, y = world2pix(a, ra, dec)
        if nbs and dpsf and dpsf.get(a['det']) is not None:
            dtg = (a['t'] - MJD_GAIA) / 365.25; nx, ny = world2pix(a, np.array([q[0] + q[2] * dtg / 3600 / np.cos(np.radians(q[1])) for q in nbs]), np.array([q[1] + q[3] * dtg / 3600 for q in nbs]))
            f, s, nl = phot_psf(a, float(x), float(y), np.atleast_1d(nx), np.atleast_1d(ny), dpsf[a['det']])
        else: (f, s), nl = phot(a, x, y), 0.0
        if np.isfinite(f): out.append((lam_at(a, x, y), f, s, a['t'], nl))
    return np.array(out).reshape(-1, 5)

PH = 7                                        # per-detector PSF half size (native px)
def det_psfs(X, G, P):
    """Empirical PSF per detector ((2 PH + 1)^2, sum 1) from the field's own bright isolated Gaia stars over many exposures
    (independent of the SPHEREx ePSF table). One PSF per detector: its change with wavelength inside a detector is ignored."""
    st = G[(G[:, 4] > 11.5) & (G[:, 4] < 15.5) & (np.hypot(G[:, 2], G[:, 3]) < 100)]; allg = G[G[:, 4] < 19]; out = {}
    iso = np.array([((((allg[:, 0] - q[0]) * np.cos(np.radians(q[1]))) ** 2 + (allg[:, 1] - q[1]) ** 2) < (40 / 3600) ** 2).sum() == 1 for q in st], bool) if len(st) else np.zeros(0, bool); st = st[iso]
    for det in ('D1', 'D2', 'D3', 'D4', 'D5', 'D6'):
        E = [a for a in X if a['det'] == det]; E = [E[i] for i in np.random.default_rng(7).permutation(len(E))[:40]]; stamps = []; H = PH + 3
        for a in E:
            dt = (a['t'] - MJD_GAIA) / 365.25; x, y = world2pix(a, st[:, 0] + st[:, 2] * dt / 3.6e6 / np.cos(np.radians(st[:, 1])), st[:, 1] + st[:, 3] * dt / 3.6e6)
            for xx, yy in zip(np.atleast_1d(x), np.atleast_1d(y)):
                xi, yi = int(round(xx)), int(round(yy))
                if not (H + 1 <= xi < a['img'].shape[1] - H - 1 and H + 1 <= yi < a['img'].shape[0] - H - 1) or a['bad'][yi - H:yi + H + 1, xi - H:xi + H + 1].any(): continue
                c = a['img'][yi - H:yi + H + 1, xi - H:xi + H + 1].astype(float); r = np.hypot(*np.mgrid[-H:H + 1, -H:H + 1]); c = c - np.median(c[r > PH + 0.5])
                tot = c[3:-3, 3:-3].sum()
                if tot <= 0 or c[H, H] < 50 * a['sig_ap'] / 3: continue
                c = ndi.shift(c, (yi - yy, xi - xx), order=3, mode='nearest')[3:-3, 3:-3]; stamps.append(c / c.sum())
        out[det] = np.median(np.array(stamps), 0) / np.median(np.array(stamps), 0).sum() if len(stamps) >= 20 else None
        if out[det] is not None: out[det] = ndi.spline_filter(out[det], order=3)
    return out

def phot_psf(a, x, y, nx, ny, psf):
    """Target and neighbours fitted together (fixed positions, linear fluxes, local background removed as in phot) on a
    9 x 9 stamp. The target flux is returned in the aperture convention of phot (the PSF light inside the R_AP aperture),
    so the templates' aperture correction still applies. -> (mJy, sigma) or nan"""
    xi, yi = int(round(x)), int(round(y)); img = a['img']; h = 4
    if not (8 <= xi < img.shape[1] - 8 and 8 <= yi < img.shape[0] - 8) or not np.isfinite(a['sig_ap']): return np.nan, np.nan, 0.0
    w = ap_weights(x - xi, y - yi, R_AP)
    if a['bad'][yi - 3:yi + 4, xi - 3:xi + 4][w > 0].any(): return np.nan, np.nan, 0.0
    ann = img[yi - 7:yi + 8, xi - 7:xi + 8][_ANN & ~a['bad'][yi - 7:yi + 8, xi - 7:xi + 8]]
    if ann.size < 40: return np.nan, np.nan, 0.0
    Y, X = np.mgrid[yi - h:yi + h + 1, xi - h:xi + h + 1]; ok = ~a['bad'][yi - h:yi + h + 1, xi - h:xi + h + 1]; d = (img[yi - h:yi + h + 1, xi - h:xi + h + 1] - np.median(ann))[ok]
    ev = lambda px_, py_: ndi.map_coordinates(psf, [PH + Y[ok] - py_, PH + X[ok] - px_], order=3, prefilter=False, cval=0.0)
    near = [(u, v) for u, v in zip(nx, ny) if abs(u - x) <= h + PH and abs(v - y) <= h + PH]
    cols = [ev(x, y)] + [ev(u, v) for u, v in near] + [np.ones(ok.sum())]
    A = np.array(cols).T; c = np.linalg.lstsq(A, d, rcond=None)[0]
    try: cov = np.linalg.inv(A.T @ A)
    except np.linalg.LinAlgError: return np.nan, np.nan, 0.0
    sp = a['sig_ap'] / np.sqrt((_K0 ** 2).sum()); J, I = np.mgrid[-3:4, -3:4]; apv = lambda u, v: float((w * ndi.map_coordinates(psf, [PH + J + yi - v, PH + I + xi - u], order=3, prefilter=False, cval=0.0)).sum())
    e_ap = apv(x, y); nl = sum(max(c[1 + q], 0.0) * apv(u, v) for q, (u, v) in enumerate(near))       # neighbour light that the fit removed from the target aperture
    return float(c[0] * e_ap * MJY_PIX), float(np.sqrt(cov[0, 0]) * sp * e_ap * MJY_PIX), float(nl * MJY_PIX)

def crowd_neighbours(A, m, G):
    """Sky tracks of the sources that can put light in the target aperture: Gaia stars brighter than G 17 and SPHEREx
    seeds at least 0.3 times the target's 4.5 um flux, within NB_PHOT arcsec of the target at the mean pass epoch, never
    the target itself (6 arcsec) and one entry per physical source (a seed within 3 arcsec of a listed Gaia star is that star)."""
    P = A['P']; S = A['S']; dt = (np.mean(m['t']) - MJD_CW) / 365.25; tx, ty = m['track'][0] + m['track'][2] * dt, m['track'][1] + m['track'][3] * dt; nbs = []
    tg = (np.mean(m['t']) - MJD_GAIA) / 365.25; gx, gy = F.tan(G[:, 0] + G[:, 2] * tg / 3.6e6 / np.cos(np.radians(G[:, 1])), G[:, 1] + G[:, 3] * tg / 3.6e6, P['ra'], P['dec'])
    dg = np.hypot(gx - tx, gy - ty); sel = (dg > 6) & (dg < NB_PHOT) & (G[:, 4] < 17) & np.isfinite(G[:, 2]); keep = []
    for q in np.nonzero(sel)[0]: nbs.append((G[q, 0], G[q, 1], G[q, 2] / 1000, G[q, 3] / 1000)); keep.append((gx[q], gy[q]))
    sx, sy = np.nanmean(S['x'], 1), np.nanmean(S['y'], 1); f_t = m['f45_mjy'] / MJY_STACK
    for i in np.nonzero(np.isfinite(sx))[0]:
        dd = np.hypot(sx[i] - tx, sy[i] - ty)
        if 6 < dd < NB_PHOT and np.isfinite(S['ap_all'][i]) and S['ap_all'][i] >= 0.3 * f_t and all(np.hypot(sx[i] - u, sy[i] - v) > 3 for u, v in keep):
            ra, dec = F.untan(sx[i], sy[i], P['ra'], P['dec']); nbs.append((float(ra), float(dec), 0.0, 0.0))
    return nbs

def clean(sm, k=CLIP):
    """Drop single-exposure outliers (cosmic rays, glitches): a sample further than k sigma from the median of the other
    samples within 0.05 um (or the 4 nearest within 0.15 um where sampling is sparse), sigma = its own error plus
    CAL_FLOOR of that median. Samples with fewer than 3 such neighbours are kept. -> (kept samples, number dropped)"""
    if len(sm) < 4: return sm, 0
    o = np.argsort(sm[:, 0]); s = sm[o]; keep = np.ones(len(s), bool)
    lo, hi = np.searchsorted(s[:, 0], s[:, 0] - 0.05), np.searchsorted(s[:, 0], s[:, 0] + 0.05, 'right')
    for i in range(len(s)):
        nb = np.r_[s[lo[i]:i, 1], s[i + 1:hi[i], 1]]
        if len(nb) < 4:                                                  # sparse wavelengths: the 4 nearest samples within 0.15 um
            j = np.argsort(np.abs(s[:, 0] - s[i, 0]))[1:5]; nb = s[j[np.abs(s[j, 0] - s[i, 0]) <= 0.15], 1]
        if len(nb) >= 3: m = np.median(nb); keep[i] = abs(s[i, 1] - m) <= k * np.hypot(s[i, 2], CAL_FLOOR * m)
    return s[keep], int((~keep).sum())

def binned(sm, tsplit=None):
    """Samples -> per-bin weighted mean flux and sigma on LAMT, aperture-corrected (nan where a bin has no sample)."""
    T = templates(); apc = np.array(T['apcor']); f = np.full(len(LAMT), np.nan); s = np.full(len(LAMT), np.nan); b = np.digitize(sm[:, 0], EDGES) - 1
    for i in range(len(LAMT)):
        m = b == i
        if m.any(): w = 1 / sm[m, 2] ** 2; f[i] = (sm[m, 1] * w).sum() / w.sum() * apc[i]; s[i] = np.sqrt(1 / w.sum()) * apc[i]
    return f, s

def bb(T_, lam):
    x = 14387.8 / (lam * T_); return lam ** -3 / np.expm1(np.clip(x, 1e-6, 500))

def classify(sm, pass_t):
    """Template stage. -> dict(verdict, spectrum_valid, dchi2, chi2_dwarf, ...). Nested test: the alternative is every smooth
    explanation (field stars with a free brightness per pass, blackbodies, power laws, any non-negative mix); the dwarf model is
    the same plus the methane-dwarf templates (a dwarf blended with a star is still a dwarf). cold needs the dwarf templates to
    lower chi-square by D_MIN, carry at least SHARE_MIN of the 4 to 5 um light, fit acceptably, with real data in the trough,
    on the peak and short of 2.4 um."""
    T = templates(); res = dict(verdict='insufficient', spectrum_valid=False, n_samples=int(len(sm)))
    if sm.shape[1] > 4 and PSF_SYS > 0: sm = sm.copy(); sm[:, 2] = np.hypot(sm[:, 2], PSF_SYS * sm[:, 4])      # neighbour-fit systematic: a fixed fraction of the neighbour light removed from the aperture
    sm, res['clipped'] = clean(sm)
    if len(sm) < 20: res['why'] = 'fewer than 20 samples'; return res
    # bins per pass (so a star may change brightness between passes), then stacked into one data vector
    pid = np.argmin(np.abs(sm[:, 3][:, None] - np.array(pass_t)[None, :]), 1); fs, ss, col = [], [], []
    for j in range(len(pass_t)):
        if (pid == j).sum() == 0: continue
        f, s = binned(sm[pid == j]); ok = np.isfinite(f); fs.append(f[ok]); ss.append(s[ok]); col.append((j, np.nonzero(ok)[0]))
    f = np.concatenate(fs); s = np.concatenate(ss); idx = np.concatenate([c[1] for c in col]); pj = np.concatenate([np.full(len(c[1]), c[0]) for c in col]); lam = LAMT[idx]
    trough, peak, short = (lam >= 3.05) & (lam <= 3.65), (lam >= 4.0) & (lam <= 5.0), lam < 2.4; res.update(n_bins=int(len(f)), n_trough=int(trough.sum()), n_peak=int(peak.sum()), n_short=int(short.sum()))
    sn = float(np.sqrt(np.sum((f / s) ** 2))); res['sn'] = sn; fa, sa = binned(sm); res['bins'] = [[float(l), float(a), float(b)] for l, a, b in zip(LAMT, fa, sa) if np.isfinite(a)]
    if trough.sum() < 3 or peak.sum() < 6 or short.sum() < 10 or sn < SN_MIN: res['why'] = 'coverage or signal too low'; return res
    fref = np.concatenate([np.abs(ndi.median_filter(f[pj == j], 3, mode='nearest')) for j in sorted(set(pj), key=list(pj).index)])
    e_common = np.sqrt(s ** 2 + (CAL_FLOOR * fref) ** 2)               # A8: one error vector for every model (data-driven floor), so the nested comparison is a fixed-weight chi-square difference
    def fit(cols):
        A = np.array(cols).T
        if COMMON_ERR: c, r = nnls(A / e_common[:, None], f / e_common); return r ** 2, c, A @ c
        best = None
        for _ in range(2):                                              # v3: second pass errors include the calibration floor on the model
            e = np.sqrt(s ** 2 + (CAL_FLOOR * (A @ best[0] if best else np.abs(f))) ** 2); c, r = nnls(A / e[:, None], f / e); best = (c, r ** 2)
        return best[1], best[0], A @ best[0]
    names = [k for k in T['dwarf'] if DWARF_USE is None or k in DWARF_USE]; dw = [np.array(T['dwarf'][k])[idx] for k in names]; st = [np.array(t)[idx] for t in T['star'].values()]
    smooth = [bb(t_, lam) / bb(t_, 4.5) for t_ in (600, 800, 1000, 1300, 1700, 2200, 3000, 5000)] + [(lam / 4.5) ** a_ for a_ in (-2, -1, 0, 1, 2, 3)]
    var = [np.where(pj == j, t, 0) for t in st for j in sorted(set(pj))]
    nd = len(dw); c_d, a_d, m_d = fit(dw + var + smooth); c_a, a_a, m_a = fit(var + smooth); c_s, _, _ = fit(st)
    share = float((np.array(dw).T[peak] @ a_d[:nd]).sum() / max(m_d[peak].sum(), 1e-30)); res['dwarf_share_45'] = share
    res.update(chi2_dwarf=float(c_d), chi2_alt=float(c_a), chi2_star=float(c_s), dchi2=float(c_a - c_d), q_dwarf=float(c_d / max(len(f) - int((a_d > 0).sum()), 1)), dwarf_mix=dict(zip(names, [float(v) for v in a_d[:nd]])),
               trough_over_peak=float(np.average(f[trough], weights=1 / s[trough] ** 2) / np.average(f[peak], weights=1 / s[peak] ** 2)), spectrum_valid=True,
               model_dwarf=[[float(l), float(v)] for l, v in zip(lam, m_d)], model_alt=[[float(l), float(v)] for l, v in zip(lam, m_a)])
    if share < SHARE_MIN: res['verdict'] = 'not_cold'; res['why'] = 'dwarf light under half of the 4 to 5 um flux'; return res
    res['verdict'] = 'cold' if (res['dchi2'] >= D_MIN and res['q_dwarf'] <= Q_MAX) else 'not_cold' if (res['dchi2'] <= 0 or res['q_dwarf'] > Q_MAX) else 'insufficient'
    return res

# ---------- templates (development donors only) ----------
def build_templates():
    """v3's frozen templates (star templates and aperture correction unchanged) plus dwarf templates of the v4 candidate
    donors (development objects listed in detector_v4_dev.json), built by v3's procedure: literature track, forced
    photometry in every exposure, single-exposure outliers clipped, binned on LAMT, aperture corrected, mean 1 over 4 to
    5 um; a smoothed copy (3-bin median then 3-bin mean, floored at zero) of each is added for the development comparison (D4)."""
    T = json.load(open(HERE + '/detector_v3_templates.json')); D = json.load(open(HERE + '/detector_v4_dev.json')); ac = np.array(T['apcor']); prov = {}
    raw = lambda sm: (lambda b: np.array([np.average(sm[b == i, 1], weights=1 / sm[b == i, 2] ** 2) if (b == i).any() else np.nan for i in range(len(LAMT))]))(np.digitize(sm[:, 0], EDGES) - 1)
    fill = lambda v: np.interp(LAMT, LAMT[np.isfinite(v)], v[np.isfinite(v)]); norm = lambda v: v / v[(LAMT >= 4.0) & (LAMT <= 5.0)].mean()
    for name in D['donors']['fitter_v4_candidates']:
        f = next(f for f in D['fields'] if (f.get('target') or {}).get('name') == name); d = f['cache']; t = f['target']
        G = read_cat(d)[0]; ref = G[(G[:, 4] > 10.5) & (G[:, 4] < 17) & (np.hypot(G[:, 2], G[:, 3]) < 100)]
        with ProcessPoolExecutor(8) as ex: X = list(ex.map(prep, [(d, e, ref) for e in json.load(open(d + '/exposures.json'))], chunksize=8))
        sm = []
        for a in X:
            ra, dec = F.track(t['ra'], t['dec'], t['pme'], t['pmn'], (t['plx_mas'] if np.isfinite(t.get('plx_mas', np.nan)) else 0) / 1000, a['t'], MJD_REF); x, y = world2pix(a, ra[0], dec[0]); v, e_ = phot(a, x, y)
            if np.isfinite(v): sm.append((lam_at(a, x, y), v, e_, a['t']))
        c, ndrop = clean(np.array(sm)); r = raw(c); v = norm(fill(r) * ac); T['dwarf'][name] = v.round(4).tolist()
        T['dwarf'][name + ' (smoothed)'] = norm(np.clip(ndi.uniform_filter1d(ndi.median_filter(v, 3, mode='nearest'), 3, mode='nearest'), 0, None)).round(4).tolist()      # negative flux is noise: floored at 0 (no trough is invented, none is deepened below zero)
        prov[name] = dict(field=f['field'], spt=t.get('spt_text'), samples=len(sm), clipped=ndrop, bins_with_data=int(np.isfinite(r).sum()), sha256_of_samples=hashlib.sha256(np.array(sm).tobytes()).hexdigest()[:16])
        print(name, prov[name], flush=True)
    T['provenance'] = dict(base='detector_v3_templates.json sha256 ' + hashlib.sha256(open(HERE + '/detector_v3_templates.json', 'rb').read()).hexdigest(), v4_donors=prov,
                           note='dwarf templates of v3 (T5, T6, T7, T8 development dwarfs) plus v4 candidate donors (development objects only); star templates and apcor are v3\'s')
    json.dump(T, open(HERE + '/' + TEMPLATES, 'w')); print('dwarf', list(T['dwarf']))

# ---------- run ----------
def run(d, out_json):
    os.makedirs(V4OUT + '/stageA', exist_ok=True); ck = f'{V4OUT}/stageA/{cache_key(d)}.pkl'; X = None
    if os.path.exists(ck): A = pickle.load(open(ck, 'rb'))
    else:
        A, X = stage_a(d); pickle.dump(A, open(ck + '.tmp', 'wb')); os.replace(ck + '.tmp', ck)
    P, N = A['P'], A['N']; movers, tie, lstats = link(A, d) if 'S' in A else ([], None, {}); todo = [m for m in movers if m['stage'] == 'spectrum']
    if todo:
        if X is None:
            G = read_cat(d)[0]; ref = G[(G[:, 4] > 10.5) & (G[:, 4] < 17) & (np.hypot(G[:, 2], G[:, 3]) < 100)]
            with ProcessPoolExecutor(8) as ex: X = list(ex.map(prep, [(d, e, ref) for e in json.load(open(d + '/exposures.json'))], chunksize=8))
        pt = [p['t'] for p in A['passes'] if p['used']]; Gc = read_cat(d)[0]
        for m in todo:
            nbs = crowd_neighbours(A, m, Gc) if CROWD_PHOT else []; m['phot'] = 'psf' if nbs else 'aperture'; m['phot_neighbours'] = len(nbs)
            sm = spectrum(X, P, m['track'], m['plx_nuisance'], nbs, A.get('dpsf')); c = classify(sm, pt); m.update(verdict=c['verdict'], spectrum_valid=c['spectrum_valid'], spectrum=c)
            m['score'] = round(0.5 * min(max(c.get('dchi2', 0), 0) / 200, 1) + 0.5 * min(m['pm_sigma'] / 30, 1), 4) if c['verdict'] == 'cold' else 0.0
    movers.sort(key=lambda m: -m['score'])
    for i, m in enumerate(movers): m['id'] = f"{P['name']}-{i + 1:03d}"
    uf = os.path.basename(out_json).replace('.json', '') + '.usable.npz'; np.savez_compressed(os.path.dirname(os.path.abspath(out_json)) + '/' + uf, ok=A['usable'], pix=OPIX, ra0=P['ra'], dec0=P['dec'])
    d3 = [{k: v for k, v in (st.get('cal') or {}).items() if k != 'M3'} | dict(psf_stars=st.get('psf_stars')) for st in A.get('stacks', [])]
    out = dict(version=VERSION, config=dict(USE_D2=USE_D2, USE_D3=USE_D3, COMMON_ERR=COMMON_ERR, CROWD_PHOT=CROWD_PHOT, DWARF_USE=DWARF_USE, dev=CFG), field=P, passes=[{k: v for k, v in p.items() if k not in ('M', 'Minv')} for p in A['passes']], d3_calibration=d3, link=lstats,
               note=A['note'], exposures=A['exposures'], shifts=A.get('shifts'), seeds=A.get('seeds', 0), catwise_tie=tie,
               usable=dict(file=uf, area_sqdeg=float(A['usable'].sum() * (OPIX / 3600) ** 2), excluded_sqdeg=A.get('excluded_sqdeg')), movers=movers, candidates=[m for m in movers if m['verdict'] == 'cold' and m['stage'] == 'spectrum'])
    json.dump(out, open(out_json, 'w'), indent=1, default=float)
    print(P['name'], 'passes', [(round(p['year'], 2), p['exposures'], p['stars'], p.get('rms') and round(p['rms'], 2), p.get('floor') and round(p['floor'], 2), p.get('per_snr') and round(p['per_snr'], 1)) for p in A['passes']], 'seeds', A.get('seeds'), 'tie', tie,
          'usable', round(out['usable']['area_sqdeg'], 3), 'movers', len(movers), {s_: sum(m['stage'] == s_ for m in movers) for s_ in sorted({m['stage'] for m in movers})}, 'candidates', [(m['id'], round(m['pm'], 2), round(m['spectrum']['dchi2'])) for m in out['candidates']], A['note'], flush=True)

def plot(out_json, png_dir, which='candidates', near=None):
    """Minimal astrometry + spectrum figure per mover (candidates, or the mover nearest to near=(ra, dec))."""
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    o = json.load(open(out_json)); P = o['field']; os.makedirs(png_dir, exist_ok=True); done = []
    ms = o['candidates'] if near is None else sorted(o['movers'], key=lambda m: np.hypot((m['ra'] - near[0]) * np.cos(np.radians(near[1])), m['dec'] - near[1]))[:1]
    for m in ms:
        fig, ax = plt.subplots(1, 2, figsize=(11, 4.2)); q = ax[0]; cx, cy = m['cw_xy']; tr = m['track']; yr = lambda t: float(F.year(t))
        tt = np.linspace(MJD_CW, 61500, 50); q.plot(tr[0] + tr[2] * (tt - MJD_CW) / 365.25 - cx, tr[1] + tr[3] * (tt - MJD_CW) / 365.25 - cy, '-', color='#444', lw=1, label='fitted track (no parallax)')
        q.plot(m['pm_catwise'][0] * (tt - MJD_CW) / 365.25, m['pm_catwise'][1] * (tt - MJD_CW) / 365.25, '--', color='#c33', lw=1, label='CatWISE position carried by CatWISE motion')
        q.errorbar([0], [0], xerr=0.1, yerr=0.1, fmt='s', color='#c33', label='CatWISE 2015.4'); xy = np.array(m['xy'])
        q.errorbar(xy[:, 0] - cx, xy[:, 1] - cy, xerr=m['sig'], yerr=m['sig'], fmt='o', color='#06c', label='SPHEREx passes ' + ', '.join(f'{yr(t):.2f}' for t in m['t']))
        q.set_xlabel('east offset from the CatWISE position (arcsec)'); q.set_ylabel('north offset (arcsec)'); q.invert_xaxis(); q.set_aspect('equal', 'datalim'); q.legend(fontsize=7); q.grid(alpha=0.3)
        q.set_title(f"{m['pm']:.2f} arcsec/yr (CatWISE alone {np.hypot(*m['pm_catwise']):.2f}, displacement alone {np.hypot(*m['pm_displacement']):.2f}); {m['stage']}", fontsize=8)
        q = ax[1]; sp = m.get('spectrum') or {}
        if sp.get('bins'):
            b = np.array(sp['bins']); q.errorbar(b[:, 0], b[:, 1], yerr=b[:, 2], fmt='.', color='#222', lw=0.8, label='SPHEREx forced photometry (all passes)')
            for k, c, lab in (('model_dwarf', '#0a7', 'methane dwarf (+ any smooth blend), all passes'), ('model_alt', '#c60', 'best smooth alternative')):
                if sp.get(k): v = np.array(sp[k]); v = v[np.argsort(v[:, 0], kind='stable')]; q.plot(v[:, 0], v[:, 1], '-', color=c, lw=1, alpha=0.8, label=lab)
            q.axvspan(3.05, 3.65, color='#88f', alpha=0.12); q.axhline(0, color='#999', lw=0.5); q.legend(fontsize=7)
        q.set_xlabel('wavelength (um)'); q.set_ylabel('flux density (mJy)'); q.set_title(f"verdict {m['verdict']}; chi2 alt - dwarf = {sp.get('dchi2', float('nan')):.0f}; dwarf chi2/bin {sp.get('q_dwarf', float('nan')):.1f}; dwarf share 4-5 um {sp.get('dwarf_share_45', float('nan')):.2f}; W2 {m['w2']:.2f}", fontsize=8)
        fig.suptitle(f"{m['id']}  RA {m['ra']:.4f} Dec {m['dec']:.4f} (MJD 61000)", fontsize=9); fig.tight_layout(); f = f"{png_dir}/{m['id']}.png"; fig.savefig(f, dpi=110); plt.close(fig); done.append(f)
    return done

if __name__ == '__main__':
    if sys.argv[1] == 'run': run(sys.argv[2].rstrip('/'), sys.argv[3])
    elif sys.argv[1] == 'templates': build_templates()
    elif sys.argv[1] == 'plot': print(plot(sys.argv[2], sys.argv[3], near=(float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else None))
