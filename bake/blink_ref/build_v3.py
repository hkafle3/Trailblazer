"""Blink reference v3 for J053604.34-063439.0: v2 (Codex plan review findings 1-6, 10) plus display-only matching of the
large-scale background between epochs, a background-match check and an unmatched-background mutation (Ed, 2026-11-18).
Method, per band (2MASS Ks, AllWISE W1, AllWISE W2) against SPHEREx 2025-26:
  1. Band synthesis: every SPHEREx exposure is resampled to one north-up 2" grid with its own wavelength at every grid
     pixel (web/data/wavemaps.json). Samples are averaged in wavelength bins, then the bins are combined with the survey's
     response curve (SVO filter service; energy counters weighted R/lam^2, photon counters R/lam, i.e. mean f_nu).
     Spectral coverage is bounded: interior gaps of one bin and one bin at either end may be interpolated; a pixel is
     valid only if every bin is filled and the directly covered weight is at least MIN_COVERED.
  2. Old survey: native image(s) on the same grid with validity masks (WISE coverage >= 5 frames; 2MASS tiles brought to
     one zero point and mosaicked). Masks are carried through every smoothing (normalised convolution).
  3. PSF matching measured per band: Gaussian FWHM fitted to isolated bright stars in both images; the sharper image is
     convolved to the broader; then FWHM and an encircled-energy profile check.
  4. Calibrate once on the 12 arcmin field (even-ranked qualified stars), validate on the odd-ranked held-out stars, then
     crop 3 arcmin for display without re-scaling, with one shared stretch, and measure again from the written PNGs.
  5. Mutation tests: swapped bands, W2 without D6, an altered display scale and clipped 2MASS coverage must all FAIL.
Run (from phase2-plan/): ../detector-decade/py.sh scripts/build_v3.py"""
import json, os, re, hashlib, copy
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from astropy.time import Time
from scipy.ndimage import map_coordinates, gaussian_filter, maximum_filter, median_filter
from scipy.interpolate import RegularGridInterpolator
from scipy.optimize import curve_fit
from PIL import Image
import warnings; warnings.simplefilter('ignore', FITSFixedWarning)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW, OUT = HERE + '/raw_v2', HERE + '/stills_v3'
LC = '/Users/edkiboma/Projects/comet-hunt-work/lead-check/cache/L1'
WAVE = '/Users/edkiboma/Projects/comet-hunt/web/data/wavemaps.json'
os.makedirs(OUT, exist_ok=True)
RA, DEC = 84.01808, -6.5775
PIX, N, CROP = 2.0, 361, 91          # 2" grid: 361 px = 12.03 arcmin calibration field, 91 px = 3.03 arcmin display crop
BAD = sum(1 << b for b in [0, 1, 2, 6, 9, 10, 11, 15, 17, 25, 27, 28, 29])   # web/live/cutout.js BAD
SPX_RANGE = (0.75, 5.0)
# pre-registered thresholds (set before the first v2 run)
MIN_COVERED, MIN_STARS, SCATTER_CAP, VAL_MED_TOL = 0.70, 20, 0.10, 0.05
FWHM_TOL, EE_TOL, ALIGN_MED, ALIGN_P90, LEAD_SHIFT, FOOTPRINT, DISPLAY_TOL = 0.10, 0.05, 1.5, 5.0, 1.5, 0.98, 0.10
AP, AN = 1.0, (2.0, 3.0)        # photometry aperture and sky annulus, in units of the matched FWHM
EXPECT = {'W2': dict(min_ratio=1.5, min_z=5.0), 'W1': dict(min_ratio=1.2, min_z=3.0), 'Ks': dict(max_dev=0.15, max_z=3.0)}
D2R = np.pi / 180
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()

def grid_world():
    c = (N - 1) / 2; iy, ix = np.mgrid[0:N, 0:N]
    x = -(ix - c) * PIX / 3600 * D2R; y = (iy - c) * PIX / 3600 * D2R
    rho = np.hypot(x, y); rho[rho == 0] = 1e-12; cc = np.arctan(rho); s, co = np.sin(cc), np.cos(cc); d0 = DEC * D2R
    dec = np.arcsin(co * np.sin(d0) + y * s * np.cos(d0) / rho)
    ra = RA * D2R + np.arctan2(x * s, rho * np.cos(d0) * co - y * np.sin(d0) * s)
    return ra / D2R, dec / D2R
GRA, GDEC = grid_world(); C0 = (N - 1) // 2

def to_grid(img, valid, wcs, x0=0, y0=0):
    """bilinear resample of img and its validity mask; a grid pixel is valid only if all 4 source pixels are"""
    px, py = wcs.all_world2pix(GRA, GDEC, 0); px, py = px - x0, py - y0
    v = map_coordinates(np.where(valid, img, 0.0), [py, px], order=1, mode='constant', cval=0.0)
    m = map_coordinates(valid.astype(float), [py, px], order=1, mode='constant', cval=0.0) > 0.999
    return np.where(m, v, np.nan), m, px, py

def msmooth(img, m, sigma):
    """normalised convolution: smooth only valid pixels; a pixel stays valid if its kernel saw >= 99% valid weight"""
    if sigma <= 0: return img, m
    w = gaussian_filter(m.astype(float), sigma); s = gaussian_filter(np.where(m, img, 0.0), sigma)
    ok = w > 0.99
    return np.where(ok, s / np.where(ok, w, 1), np.nan), ok

# ---------------- response curves ----------------
def rsr(name):
    t = open(f'{RAW}/rsr_{name}.xml').read()
    det = int(re.search(r'name="DetectorType" value="(\d)"', t).group(1))
    v = np.array([float(x) for x in re.findall(r'<TD>([^<]+)</TD>', t.split('<TABLEDATA>')[1])]).reshape(-1, 2)
    lam, R = v[:, 0] / 1e4, np.clip(v[:, 1], 0, None)
    return lam, R / lam ** (1 if det == 1 else 2), det          # mean-f_nu weight per unit wavelength

waves = json.load(open(WAVE)); _W = {}
def wave(det):
    if det not in _W:
        m = waves[det]; _W[det] = RegularGridInterpolator((np.array(m['y'], float) - 1, np.array(m['x'], float) - 1), np.array(m['lam']), bounds_error=False, fill_value=None)
    return _W[det]

def synth(dets, filt, label):
    """SPHEREx picture in the survey band, per-pixel wavelengths, response-weighted; returns image, mask, metadata"""
    lam_r, w_r, det_type = rsr(filt)
    lo, hi = lam_r[w_r > 0.01 * w_r.max()][[0, -1]]
    lo_s, hi_s = max(lo, SPX_RANGE[0]), min(hi, SPX_RANGE[1])
    out_frac = 1 - np.trapezoid(w_r[(lam_r >= lo_s) & (lam_r <= hi_s)], lam_r[(lam_r >= lo_s) & (lam_r <= hi_s)]) / np.trapezoid(w_r, lam_r)
    res = 40 if hi_s < 3.82 else 60                               # bins about one SPHEREx resolution element wide
    edges = [lo_s]
    while edges[-1] < hi_s: edges.append(edges[-1] * (1 + 1 / res))
    edges = np.array(edges); edges[-1] = hi_s; nb = len(edges) - 1
    fine = np.linspace(lo_s, hi_s, 4000); wf = np.interp(fine, lam_r, w_r)
    wb = np.array([np.trapezoid(wf[(fine >= edges[i]) & (fine <= edges[i + 1])], fine[(fine >= edges[i]) & (fine <= edges[i + 1])]) for i in range(nb)])
    wb /= wb.sum()
    S = np.zeros((nb, N, N)); Cn = np.zeros((nb, N, N)); used = []
    for e in json.load(open(f'{LC}/exposures.json')):
        if e['det'] not in dets: continue
        a = np.load(f"{LC}/{e['file']}"); w = WCS(fits.Header.fromstring(str(a['hdr'])))
        img = a['img'].astype(float); valid = np.isfinite(img) & ((a['flg'] & BAD) == 0)
        g, m, px, py = to_grid(img, valid, w, int(a['x0']), int(a['y0']))
        if m.sum() < 50: continue
        lam = wave(e['det'])(np.stack([py[m] + int(a['y0']), px[m] + int(a['x0'])], 1))
        b = np.searchsorted(edges, lam) - 1; ok = (b >= 0) & (b < nb)
        if not ok.any(): continue
        med = float(np.nanmedian(g)); g = g - med                    # per-exposure background (zodiacal light) offset
        iy, ix = np.nonzero(m)
        np.add.at(S, (b[ok], iy[ok], ix[ok]), g[m][ok]); np.add.at(Cn, (b[ok], iy[ok], ix[ok]), 1)
        used.append(dict(key=e['key'], det=e['det'], mjd=e['t'], file_sha256=sha(f"{LC}/{e['file']}"), bg_median=med, grid_fraction=float(m.mean()),
                         at_lead=bool(m[C0, C0]) and 0 <= (np.searchsorted(edges, float(wave(e['det'])([[py[C0, C0] + int(a['y0']), px[C0, C0] + int(a['x0'])]])[0])) - 1) < nb))
    has = Cn > 0; mean = np.where(has, S / np.maximum(Cn, 1), np.nan)
    covered = (wb[:, None, None] * has).sum(0)
    # bounded fill: one-bin interior gaps (neighbour mean) and one bin at either end (copy)
    filled = mean.copy()
    for i in range(nb):
        gap = ~has[i]
        if 0 < i < nb - 1:
            f = gap & has[i - 1] & has[i + 1]; filled[i][f] = (mean[i - 1][f] + mean[i + 1][f]) / 2
        elif i == 0: f = gap & has[1]; filled[0][f] = mean[1][f]
        else: f = gap & has[nb - 2]; filled[nb - 1][f] = mean[nb - 2][f]
    allb = np.isfinite(filled).all(0); m = allb & (covered >= MIN_COVERED)
    img = np.where(m, (wb[:, None, None] * np.nan_to_num(filled)).sum(0), np.nan)
    lead_used = [u for u in used if u['at_lead']]
    meta = dict(detectors=list(dets), response=f'SVO {filt.replace("_", "/", 1)} (DetectorType {det_type})', band_um=[round(lo, 3), round(hi, 3)],
                synth_range_um=[round(lo_s, 3), round(hi_s, 3)], response_weight_outside_spherex=round(float(out_frac), 3), bins=nb,
                covered_weight_at_lead=round(float(covered[C0, C0]), 3), exposures_used=len(used), exposures_at_lead=len(lead_used),
                dates_at_lead=[Time(min(u['mjd'] for u in lead_used), format='mjd').iso[:10], Time(max(u['mjd'] for u in lead_used), format='mjd').iso[:10]] if lead_used else None,
                valid_fraction=round(float(m.mean()), 4), inputs=used, _cube=(mean, has, edges, wb))
    return img, m, meta

# ---------------- old surveys ----------------
def old_wise(band):
    h = fits.open(f'{RAW}/allwise_{band}_int.fits')[0]; cov = fits.open(f'{RAW}/allwise_{band}_cov.fits')[0].data
    valid = np.isfinite(h.data) & (cov >= 5)
    g, m, px, py = to_grid(h.data.astype(float), valid, WCS(h.header))
    g = g - np.nanmedian(g)
    cl = map_coordinates(cov, [[py[C0, C0]], [px[C0, C0]]], order=1)[0]
    hd = h.header
    return g, m, dict(survey='AllWISE Atlas', band_header=f"BAND {hd['BAND']}", band=f"W{hd['BAND']}", dates=[hd['DATEOBS1'][:10], hd['DATEOBS2'][:10]],
                      mid=hd['MIDOBS'][:10], coverage_frames_at_lead=round(float(cl), 1), valid_fraction=round(float(m.mean()), 4),
                      inputs=[dict(file=f'allwise_{band}_{k}.fits', sha256=sha(f'{RAW}/allwise_{band}_{k}.fits')) for k in ('int', 'cov')])

def old_2mass(only=None):
    files = sorted(f for f in os.listdir(RAW) if f.startswith('2mass_Ks_') and (only is None or only in f))
    ZREF = None; S = np.zeros((N, N)); Cn = np.zeros((N, N)); dates = set(); at_lead = []
    for f in files:
        h = fits.open(f'{RAW}/{f}')[0]; hd = h.header; img = h.data.astype(float)
        ZREF = ZREF or hd['MAGZP']
        img = img * 10 ** (0.4 * (ZREF - hd['MAGZP']))            # one zero point for every tile
        valid = np.isfinite(img)
        img, valid = msmooth(img, valid, 0.85)                       # anti-alias 1" pixels before the 2" grid
        g, m, _, _ = to_grid(img, valid, WCS(hd))
        g = g - np.nanmedian(g)                                      # each tile's own sky level
        S += np.where(m, g, 0); Cn += m; dates.add('20' + '-'.join([hd['ORDATE'][:2], hd['ORDATE'][2:4], hd['ORDATE'][4:]]))
        if m[C0, C0]: at_lead.append(f)
    m = Cn > 0
    return np.where(m, S / np.maximum(Cn, 1), np.nan), m, dict(survey='2MASS All-Sky Atlas', band_header='FILTER k', band='Ks', dates=sorted(dates),
               tiles=files, tiles_at_lead=at_lead, valid_fraction=round(float(m.mean()), 4), inputs=[dict(file=f, sha256=sha(f'{RAW}/{f}')) for f in files])

# ---------------- stars, PSF, photometry ----------------
def g2(xy, a, x0, y0, s, b):
    x, y = xy; return (a * np.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * s * s)) + b).ravel()

def fit(img, iy, ix, r=6):
    sl = img[iy - r:iy + r + 1, ix - r:ix + r + 1]
    if sl.shape == (2 * r + 1, 2 * r + 1) and np.isfinite(sl).all():   # remove a plane fitted to the box edge (nebula gradient)
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]; e = (np.abs(yy) == r) | (np.abs(xx) == r)
        A_ = np.c_[np.ones(e.sum()), xx[e], yy[e]]; c_ = np.linalg.lstsq(A_, sl[e], rcond=None)[0]
        sl = sl - (c_[0] + c_[1] * xx + c_[2] * yy)
    if sl.shape != (2 * r + 1, 2 * r + 1) or not np.isfinite(sl).all(): return None
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    try:
        p, _ = curve_fit(g2, (xx, yy), sl.ravel(), p0=[sl[r, r], 0, 0, 2, 0], maxfev=4000)
    except Exception: return None
    if p[0] <= 0 or not 0.5 < abs(p[3]) < 8 or abs(p[1]) > 2 or abs(p[2]) > 2: return None
    return dict(fwhm=2.355 * abs(p[3]) * PIX, x=ix + p[1], y=iy + p[2])

def noise(img):
    d = img[np.isfinite(img)]; d = d - np.median(d); return 1.4826 * np.median(np.abs(d))

def peaks(img, nsig=20):
    """local maxima of the image minus a 30" median background (the nebula), above nsig times that residual's noise"""
    hp = img - median_filter(np.nan_to_num(img, nan=np.nanmedian(img)), size=15)
    z = np.where(np.isfinite(img), hp, -np.inf); mx = maximum_filter(z, size=7)
    iy, ix = np.nonzero((z == mx) & (z > nsig * noise(hp)))
    o = np.argsort(-img[iy, ix]); return list(zip(iy[o], ix[o]))

def phot(img, m, y, x, F):
    """aperture 1 FWHM radius (94% of a Gaussian), sky annulus 2-3 FWHM (median); None unless every pixel used is valid"""
    r, ri, ro = AP * F / PIX, AN[0] * F / PIX, AN[1] * F / PIX
    yy, xx = np.mgrid[0:N, 0:N]; d = np.hypot(yy - y, xx - x)
    ap, an = d < r, (d >= ri) & (d < ro)
    if ro > min(x, y, N - 1 - x, N - 1 - y) or not (m[ap].all() and m[an].all()): return None
    sky = np.median(img[an]); sd = 1.4826 * np.median(np.abs(img[an] - sky))
    f = float(np.sum(img[ap] - sky)); return dict(flux=f, snr=f / (sd * np.sqrt(ap.sum())) if sd > 0 else np.inf)

def ee(img, y, x, F):
    yy, xx = np.mgrid[0:N, 0:N]; d = np.hypot(yy - y, xx - x)
    sky = np.median(img[(d >= AN[0] * F / PIX) & (d < AN[1] * F / PIX)])
    return np.sum(img[d < 0.6 * F / PIX] - sky) / np.sum(img[d < 1.5 * F / PIX] - sky)

def fwhm_of(img, pk):
    fs = [f['fwhm'] for f in (fit(img, iy, ix) for iy, ix in pk[:40]) if f]
    return float(np.median(fs)) if fs else np.nan, len(fs)

# ---------------- one pair ----------------
BG_BLOCK, BG_MED, BG_RMS = 15, 0.05, 0.10   # 30" blocks; median and rms limits as a fraction of the background range
GRAIN_RATIO = 2.0

def starmask(imgs, F):
    """True within 2.5 FWHM of any detected peak (5 sigma above the local nebula) in either image, and around the lead"""
    yy, xx = np.mgrid[0:N, 0:N]; m = np.hypot(yy - C0, xx - C0) < 4 * F / PIX
    for im in imgs:
        for iy, ix in peaks(im, 5): m |= np.hypot(yy - iy, xx - ix) < 2.5 * F / PIX
    return m

def bgmodel(img, smask):
    """large-scale background: star-masked 30" block medians, normalised-smoothed over 1 block, bilinear back to the grid"""
    nb = N // BG_BLOCK; a = np.where(smask | ~np.isfinite(img), np.nan, img)[:nb * BG_BLOCK, :nb * BG_BLOCK].reshape(nb, BG_BLOCK, nb, BG_BLOCK)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore'); blk = np.nanmedian(a, axis=(1, 3))
    blk[np.isfinite(a).mean(axis=(1, 3)) < 0.3] = np.nan
    w = np.isfinite(blk).astype(float); sm = gaussian_filter(np.nan_to_num(blk) * w, 1) / np.maximum(gaussian_filter(w, 1), 1e-6)
    c = (np.arange(N) + 0.5) / BG_BLOCK - 0.5; cy, cx = np.meshgrid(c, c, indexing='ij')
    return map_coordinates(sm, [cy, cx], order=1, mode='nearest'), blk

def bgdiff(ow, sw, smask):
    """star-masked large-scale background of the two displayed frames over the 3' crop: median and rms difference,
    as fractions of the SPHEREx crop background's p5-p95 range"""
    h0 = (N - CROP) // 2; sl = slice(h0, h0 + CROP)
    bo, _ = bgmodel(ow, smask); bs, _ = bgmodel(sw, smask)
    d = (bs - bo)[sl, sl]; rng = float(np.percentile(bs[sl, sl], 95) - np.percentile(bs[sl, sl], 5))
    if not np.isfinite(d).all() or not rng > 0: return dict(median_diff=None, rms_diff=None, range=None, **{'pass': False})
    md, rms = float(np.median(d)) / rng, float(np.sqrt(np.mean(d ** 2))) / rng
    return dict(median_diff=round(md, 3), rms_diff=round(rms, 3), range=round(rng, 4), **{'pass': bool(abs(md) <= BG_MED and rms <= BG_RMS)})

def pair(name, old, sp, meta_sp, display_scale_error=1.0, write=True, match_bg=True):
    o, mo, meta_o = old; s, ms = sp
    pk = [p for p in peaks(s, 10) if min(p) > 12 and max(p) < N - 13]
    Fo, no = fwhm_of(o, pk); Fs, ns = fwhm_of(s, pk)
    k = np.sqrt(abs(Fo ** 2 - Fs ** 2)) / 2.355 / PIX
    if Fo < Fs: o, mo = msmooth(o, mo, k)
    else: s, ms = msmooth(s, ms, k)
    Fo2, _ = fwhm_of(o, pk); Fs2, _ = fwhm_of(s, pk); F = max(Fo2, Fs2)
    # qualified stars
    allpk = peaks(s, 5)
    quals = []
    for iy, ix in pk:
        if np.hypot(iy - C0, ix - C0) < AN[1] * F / PIX: continue
        fo, fs = fit(o, iy, ix), fit(s, iy, ix)
        if not fo or not fs or abs(fo['fwhm'] / Fo2 - 1) > 0.25 or abs(fs['fwhm'] / Fs2 - 1) > 0.25: continue
        po, ps = phot(o, mo, fs['y'], fs['x'], F), phot(s, ms, fs['y'], fs['x'], F)
        if not po or not ps or po['snr'] < 30 or ps['snr'] < 30: continue
        near = [q for q in allpk if 0 < np.hypot(q[0] - iy, q[1] - ix) < 2 * F / PIX and s[q] > 0.05 * s[iy, ix]]   # nothing above 5% inside the aperture's reach
        if near: continue
        quals.append(dict(y=fs['y'], x=fs['x'], po=po['flux'], ps=ps['flux'], off=np.hypot(fs['x'] - fo['x'], fs['y'] - fo['y']) * PIX,
                          ee_o=ee(o, fs['y'], fs['x'], F), ee_s=ee(s, fs['y'], fs['x'], F)))
    quals.sort(key=lambda q: -q['ps'])
    cal, val = quals[0::2], quals[1::2]
    scale = float(np.median([q['ps'] / q['po'] for q in cal])) if cal else np.nan
    rv = np.array([q['ps'] / (q['po'] * scale) for q in val]) if val else np.array([np.nan])
    sig = 1.4826 * float(np.median(np.abs(rv - np.median(rv))))
    fl_o, fl_s = fit(o, C0, C0, 6), fit(s, C0, C0, 6)
    lo_ph, ls_ph = phot(o, mo, C0, C0, F), phot(s, ms, C0, C0, F)
    R = ls_ph['flux'] / (lo_ph['flux'] * scale) if lo_ph and ls_ph else np.nan
    z = (R - 1) / sig if sig > 0 else np.nan
    offs = np.array([q['off'] for q in quals]) if quals else np.array([np.nan])
    band = name
    checks = {
        'finite': bool(np.isfinite([R, z, scale, sig, F]).all()),
        'band_match': meta_o['band'] == meta_sp['band_label'],
        'old_footprint': meta_o['valid_fraction'] >= FOOTPRINT and bool(mo[C0, C0]),
        'spherex_footprint': meta_sp['valid_fraction'] >= FOOTPRINT,
        'spectral_coverage_at_lead': meta_sp['covered_weight_at_lead'] >= MIN_COVERED,
        'qualified_stars': len(quals) >= MIN_STARS,
        'validation_median': bool(abs(np.median(rv) - 1) <= VAL_MED_TOL),
        'field_scatter_cap': sig <= SCATTER_CAP,
        'psf_fwhm_match': bool(abs(Fo2 / Fs2 - 1) <= FWHM_TOL),
        'psf_profile_match': bool(abs(np.median([q['ee_o'] - q['ee_s'] for q in quals]) if quals else 1) <= EE_TOL),
        'alignment': bool(np.median(offs) <= ALIGN_MED and np.percentile(offs, 90) <= ALIGN_P90),
        'lead_same_place': bool(fl_o and fl_s and np.hypot(fl_o['x'] - fl_s['x'], fl_o['y'] - fl_s['y']) * PIX <= LEAD_SHIFT),
    }
    ex = EXPECT[band]
    checks['lead_expectation'] = bool(R >= ex['min_ratio'] and z >= ex['min_z']) if 'min_ratio' in ex else bool(abs(R - 1) <= ex['max_dev'] and abs(z) < ex['max_z'])
    # display: one shared stretch on the calibrated wide images; the 3' crop is an exact sub-array of the wide display.
    # Invalid pixels are drawn in MASK colour, never filled. Both are written as PNGs, read back, decoded and measured.
    MASK = (20, 40, 110)
    ow, sw = o * scale * display_scale_error, s
    # display-only background matching: the large-scale (star-masked, 30" block median, smoothed) background of the
    # old frame is mapped onto the SPHEREx frame's by a robust linear fit over the 12' field. Stars and small-scale
    # nebula keep their own pixels; photometry above used local annuli on the unmodified images.
    smask = starmask([o, s], F)
    bo, bo_blk = bgmodel(ow, smask); bs, bs_blk = bgmodel(sw, smask)
    ok_b = np.isfinite(bo_blk) & np.isfinite(bs_blk); xb, yb = bo_blk[ok_b], bs_blk[ok_b]
    if ok_b.sum() >= 10:
        keep = np.ones(len(xb), bool)
        for _ in range(3):
            a_fit, c_fit = np.polyfit(xb[keep], yb[keep], 1); r_ = yb - (a_fit * xb + c_fit); sd = 1.4826 * np.median(np.abs(r_[keep] - np.median(r_[keep]))); keep = np.abs(r_) < 3 * sd
        corr = float(np.corrcoef(xb, yb)[0, 1])
    else: a_fit, c_fit, corr = 1.0, 0.0, float('nan')
    bg_before = bgdiff(ow, sw, smask); lin = None; ow_unmatched = ow.copy()
    if match_bg and ok_b.sum() >= 10:
        ow1 = ow + (a_fit - 1) * bo + c_fit; lin = bgdiff(ow1, sw, smask)
        if lin['pass']: ow = ow1; method = 'linear fit of old background onto SPHEREx background'
        else:                                                              # pre-declared fallback: one common large-scale background
            ow = ow - bo + bs
            for _ in range(3):                                             # block medians are not linear: converge onto bs
                d_, _ = bgmodel(ow, smask); ow = ow - (d_ - bs)
            method = 'common large-scale background (SPHEREx), fallback'
    else: method = 'none'
    bg_after = bgdiff(ow, sw, smask)
    def grain(im):   # small-scale texture left after the large-scale background, star-masked, robust sigma / crop range
        b_, _ = bgmodel(im, smask); h0 = (N - CROP) // 2; sl_ = slice(h0, h0 + CROP); v = (im - b_)[sl_, sl_][~smask[sl_, sl_]]; v = v[np.isfinite(v)]
        return float(1.4826 * np.median(np.abs(v - np.median(v))))
    g_o, g_s = grain(ow), grain(sw); rng_ = bg_after['range'] or float('nan')
    bginfo = dict(method=method, fit_scale=round(float(a_fit), 3), fit_offset=round(float(c_fit), 4), block_corr=round(corr, 3),
                  before=bg_before, after_linear=lin, after=bg_after, grain_old=round(g_o / rng_, 3), grain_spherex=round(g_s / rng_, 3), threshold=dict(median_diff=BG_MED, rms_diff=BG_RMS, unit='fraction of the SPHEREx crop background range p5-p95'))
    h0 = (N - CROP) // 2; sl = slice(h0, h0 + CROP); c3 = slice(C0 - 3, C0 + 4)
    # pre-declared grain rule: when one frame's small-scale noise is over GRAIN_RATIO times the other's, the shared
    # stretch floor rises to the matched background + 3 x the larger grain, so neither frame shows texture below noise
    bs_c = bgmodel(sw, smask)[0][(N - CROP) // 2:(N + CROP) // 2, (N - CROP) // 2:(N + CROP) // 2]
    grain_rule = max(g_o, g_s) / max(min(g_o, g_s), 1e-12) > GRAIN_RATIO
    lo = float(np.median(bs_c) + 3 * max(g_o, g_s)) if grain_rule else float(np.nanpercentile(sw[sl, sl], 5))
    bginfo['grain_rule_applied'] = bool(grain_rule)
    hi = 1.15 * float(max(np.nanmax(ow[c3, c3]), np.nanmax(sw[c3, c3])))
    A = np.arcsinh(10)
    def enc(a):
        g = np.round(255 * np.clip(np.arcsinh(np.clip((np.nan_to_num(a, nan=lo) - lo) / (hi - lo), 0, None) * 10) / A, 0, 1)).astype(np.uint8)
        rgb = np.repeat(g[..., None], 3, 2); rgb[~np.isfinite(a)] = MASK; return rgb[::-1, ::-1]      # north up, east left
    def dec(path):
        u = np.array(Image.open(path).convert('RGB'))[::-1, ::-1].astype(float)
        grey = (u[..., 0] == u[..., 1]) & (u[..., 1] == u[..., 2])
        return np.where(grey, np.sinh(u[..., 0] / 255 * A) / 10 * (hi - lo) + lo, np.nan), (~grey).sum()
    tag = f'{name}' + ('' if write else '_mut')
    paths = {k: f'{OUT}/{k}_{tag}.png' for k in ('old', 'spherex', 'old_wide', 'spherex_wide')}
    Image.fromarray(enc(ow[sl, sl])).save(paths['old']); Image.fromarray(enc(sw[sl, sl])).save(paths['spherex'])
    Image.fromarray(enc(ow)).save(paths['old_wide']); Image.fromarray(enc(sw)).save(paths['spherex_wide'])
    do, mo_n = dec(paths['old']); ds, ms_n = dec(paths['spherex']); dow, _ = dec(paths['old_wide']); dsw, _ = dec(paths['spherex_wide'])
    def dphot(img, y, x):
        n = img.shape[0]; r, ri, ro = AP * F / PIX, AN[0] * F / PIX, AN[1] * F / PIX; yy, xx = np.mgrid[0:n, 0:n]; d = np.hypot(yy - y, xx - x)
        use = (d < ro)
        if ro > min(x, y, n - 1 - x, n - 1 - y) or not np.isfinite(img[use]).all(): return None
        return np.sum(img[d < r] - np.median(img[(d >= ri) & (d < ro)]))
    Rd = dphot(ds, CROP // 2, CROP // 2) / dphot(do, CROP // 2, CROP // 2)
    # field stars read back from the wide display: only stars below the stretch top in both frames (not clipped)
    yy, xx = np.mgrid[0:N, 0:N]
    unclipped = [q for q in quals if max(np.nanmax(ow[int(q['y']) - 2:int(q['y']) + 3, int(q['x']) - 2:int(q['x']) + 3]), np.nanmax(sw[int(q['y']) - 2:int(q['y']) + 3, int(q['x']) - 2:int(q['x']) + 3])) < 0.9 * hi]
    fr = [a / b for a, b in ((dphot(dsw, q['y'], q['x']), dphot(dow, q['y'], q['x'])) for q in unclipped) if a is not None and b]
    lead_mask = np.hypot(yy - C0, xx - C0) < AN[1] * F / PIX
    checks['display_frames_differ'] = bool(np.nanmean(np.abs(do - ds)) > 0)
    checks['display_no_hidden_gaps'] = bool(mo_n == (~np.isfinite(ow[sl, sl])).sum() and ms_n == (~np.isfinite(sw[sl, sl])).sum() and np.isfinite(ow[lead_mask]).all() and np.isfinite(sw[lead_mask]).all())
    checks['display_crop_is_subarray'] = bool(np.array_equal(np.array(Image.open(paths['spherex'])), np.array(Image.open(paths['spherex_wide']))[::-1, ::-1][sl, sl][::-1, ::-1]) and
                                            np.array_equal(np.array(Image.open(paths['old'])), np.array(Image.open(paths['old_wide']))[::-1, ::-1][sl, sl][::-1, ::-1]))
    checks['display_lead_ratio'] = bool(abs(Rd / R - 1) <= DISPLAY_TOL)
    checks['display_field_ratio'] = bool(len(fr) >= 10 and abs(np.median(fr) - 1) <= DISPLAY_TOL)
    checks['display_background_match'] = bool(bg_after['pass'])
    # the same comparison in displayed grey levels (0-255, after the shared asinh stretch), which is what the eye sees
    def grey(a): return enc(a)[::-1, ::-1][..., 0].astype(float)
    def gdiff(a):
        ga, gs = grey(a), grey(sw); ga[~np.isfinite(a)] = np.nan; gs[~np.isfinite(sw)] = np.nan
        bga, _ = bgmodel(ga, smask); bgs_, _ = bgmodel(gs, smask); d = (bgs_ - bga)[sl, sl]
        return dict(median=round(float(np.nanmedian(d)), 1), rms=round(float(np.sqrt(np.nanmean(d ** 2))), 1))
    bginfo['grey_levels'] = dict(before=gdiff(ow_unmatched), after=gdiff(ow))
    if not write:
        for v in paths.values(): os.remove(v)
    po_path, ps_path = paths['old'], paths['spherex']
    rep = dict(pair=f"{meta_o['survey']} {meta_o['band']} vs SPHEREx", passed=all(checks.values()), checks=checks,
               lead_ratio=round(float(R), 3), lead_mag_change=round(float(-2.5 * np.log10(R)), 3) if R > 0 else None,
               field_scatter_robust_sigma=round(sig, 3), lead_z_vs_field=round(float(z), 1), qualified_stars=len(quals), calibration_stars=len(cal), validation_stars=len(val),
               validation_median=round(float(np.median(rv)), 3), scale=scale,
               fwhm_arcsec=dict(old_native=round(Fo, 2), spherex_native=round(Fs, 2), old_matched=round(Fo2, 2), spherex_matched=round(Fs2, 2)),
               ee_median_diff=round(float(np.median([q['ee_o'] - q['ee_s'] for q in quals])), 3) if quals else None,
               align_offset_arcsec=dict(median=round(float(np.median(offs)), 2), p90=round(float(np.percentile(offs, 90)), 2)),
               display=dict(crop_arcmin=round(CROP * PIX / 60, 2), stretch=dict(kind='asinh10', lo=lo, hi=hi), lead_ratio_from_png=round(float(Rd), 3),
                            masked_pixels_in_crop=dict(old=int(mo_n), spherex=int(ms_n)), field_stars_read_back=len(fr), field_ratio_from_png=round(float(np.median(fr)), 3) if fr else None),
               old=meta_o, spherex={k: v for k, v in meta_sp.items() if k not in ('inputs', '_cube')}, background=bginfo)
    if write:
        rep['spherex_inputs'] = meta_sp['inputs']
        frames = [(np.array(Image.open(po_path).convert('RGB')), f"{meta_o['survey']} {meta_o['band']}  {meta_o['dates'][0]}" + (f" to {meta_o['dates'][-1]}" if meta_o['dates'][-1] != meta_o['dates'][0] else '')),
                  (np.array(Image.open(ps_path).convert('RGB')), f"SPHEREx in {meta_o['band']}  {meta_sp['dates_at_lead'][0]} to {meta_sp['dates_at_lead'][1]}  ({meta_sp['exposures_at_lead']} exp)")]
        gif = []
        for im, t in frames:
            big = Image.fromarray(im).resize((CROP * 4, CROP * 4), Image.NEAREST)
            canvas = Image.new('RGB', (CROP * 4, CROP * 4 + 22), (0, 0, 0)); canvas.paste(big, (0, 22))
            from PIL import ImageDraw
            dr = ImageDraw.Draw(canvas); dr.text((6, 5), t, fill=(240, 235, 225))
            c = CROP * 2; rr = AP * F / PIX * 4; dr.ellipse([c - rr, 22 + c - rr, c + rr, 22 + c + rr], outline=(255, 160, 40))
            gif.append(canvas)
        gif[0].save(f'{OUT}/blink_{name}.gif', save_all=True, append_images=gif[1:], duration=900, loop=0)
        side = Image.new('RGB', (CROP * 8 + 10, CROP * 4 + 22)); side.paste(gif[0], (0, 0)); side.paste(gif[1], (CROP * 4 + 10, 0)); side.save(f'{OUT}/pair_{name}.png')
    return rep

PAIRS = {'Ks': (('D3',), '2MASS_2MASS.Ks'), 'W1': (('D4',), 'WISE_WISE.W1'), 'W2': (('D5', 'D6'), 'WISE_WISE.W2')}
cache = {}
def spx(band, dets=None):
    d, filt = PAIRS[band]; d = dets or d
    if (band, d) not in cache:
        img, m, meta = synth(d, filt, band); meta['band_label'] = band; cache[(band, d)] = (img, m, meta)
    return cache[(band, d)]
olds = {'Ks': old_2mass(), 'W1': old_wise('W1'), 'W2': old_wise('W2')}

report = {}
for band in ('Ks', 'W1', 'W2'):
    img, m, meta = spx(band)
    report[band] = r = pair(band, olds[band], (img, m), meta)
    print(band, 'PASS' if r['passed'] else 'FAIL', {k: v for k, v in r.items() if k in ('lead_ratio', 'lead_mag_change', 'field_scatter_robust_sigma', 'lead_z_vs_field', 'qualified_stars', 'validation_median', 'fwhm_arcsec', 'ee_median_diff', 'align_offset_arcsec')},
          'spx', {k: meta[k] for k in ('covered_weight_at_lead', 'exposures_at_lead', 'valid_fraction', 'response_weight_outside_spherex')}, 'old', olds[band][2]['valid_fraction'],
          'failed:', [k for k, v in r['checks'].items() if not v])
    # diagnosis: diffuse-light spectrum (bright minus faint star-masked nebula, per wavelength bin) and SPHEREx
    # per-exposure background offsets
    mean, has, edges, wb = meta['_cube']; smk = starmask([img], 10.0); bgs, _ = bgmodel(img, smk); free = ~smk & np.isfinite(bgs)
    hi_n, lo_n = free & (bgs > np.percentile(bgs[free], 80)), free & (bgs < np.percentile(bgs[free], 20))
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        neb = [float(np.nanmedian(mean[i][hi_n]) - np.nanmedian(mean[i][lo_n])) for i in range(len(mean))]
    r['nebula_spectrum'] = [dict(um=round(float(np.sqrt(edges[i] * edges[i + 1])), 3), bright_minus_faint=round(v, 4), response_weight=round(float(wb[i]), 3)) for i, v in enumerate(neb)]
    bgm = np.array([u['bg_median'] for u in meta['inputs']]); gf = np.array([u['grid_fraction'] for u in meta['inputs']])
    r['spherex_exposure_bg'] = dict(median=round(float(np.median(bgm)), 3), std=round(float(np.std(bgm)), 3), min=round(float(bgm.min()), 3), max=round(float(bgm.max()), 3),
                                    grid_fraction_median=round(float(np.median(gf)), 2), grid_fraction_min=round(float(gf.min()), 2))
    print('  background', r['background'], '\n  exposure bg', r['spherex_exposure_bg'], '\n  nebula', [(x['um'], x['bright_minus_faint']) for x in r['nebula_spectrum']])
json.dump(report, open(f'{OUT}/checks.json', 'w'), indent=1, default=float)

# mutation tests: each must make the evaluator FAIL
muts = {}
img, m, meta = spx('W2')
muts['swapped_bands (AllWISE W1 shown as the W2 pair)'] = pair('W2', olds['W1'], (img, m), meta, write=False)
img5, m5, meta5 = spx('W2', ('D5',))
muts['W2 without D6'] = pair('W2', olds['W2'], (img5, m5), meta5, write=False)
muts['display scale x1.15'] = pair('W2', olds['W2'], (img, m), meta, display_scale_error=1.15, write=False)
imgk, mk, metak = spx('Ks')
muts['unmatched background (display)'] = pair('W2', olds['W2'], (img, m), meta, write=False, match_bg=False)
muts['clipped 2MASS coverage (one tile, no mosaic)'] = pair('Ks', old_2mass(only='ki1030244'), (imgk, mk), metak, write=False)
mres = {k: dict(evaluator='FAIL' if not v['passed'] else 'PASS', failed_checks=[c for c, ok in v['checks'].items() if not ok], mutation_test='ok' if not v['passed'] else 'NOT CAUGHT') for k, v in muts.items()}
for k, v in mres.items(): print('MUTATION', k, v)
json.dump(mres, open(f'{OUT}/mutations.json', 'w'), indent=1)
