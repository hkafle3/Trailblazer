"""Cold slow-mover detector, phase 2 (offline). Looks for nearby cold brown dwarfs in SPHEREx L2 images of one sky patch:
objects that shift between the six-month survey passes (proper motion) AND are much brighter near 4.5 microns than
near 3.3 microns (methane absorption). It is given a patch centre and size and nothing else: no target list.

Method
  1. prep   : list the D6 (4.4 to 5.0 um) and D4 (2.4 to 3.8 um) exposures over the patch, read only the patch's pixels
              (S3 range reads), cache them.
  2. stack  : subtract each exposure's background, resample onto one north-up grid (3.08 arcsec pixels), and take the
              per-pixel clipped mean of all exposures of one survey pass (epoch): values far from the pixel's median
              are dropped first, so a flash or cosmic ray in one exposure cannot survive. Two stacks per epoch: "4.5" = all of
              D6, "3.3" = D4 pixels whose wavelength is 3.1 to 3.6 um (each pixel's wavelength from web/data/wavemaps.json).
  3. find   : peaks of 5 sigma in the 4.5 stack of each epoch, sub-pixel centroids, positions tied to Gaia DR3
              (moved to the epoch with Gaia's own proper motions) by an affine fit; if Gaia cannot be reached, to epoch 1.
  4. move   : pair every two passes at least 0.4 yr apart (closest pairs first, so a star pairs with itself), turn each
              shift into arcsec per year with an error taken from the scatter of the patch's own stars, confirm in the
              other passes. A pair half a year apart also carries the parallax shift, so its speed is less certain.
  5. colour : forced photometry at 4.5 and 3.3; the ratio is compared with the patch's own stars. A candidate is
              a 5 sigma mover of 0.5 to 12 arcsec/yr whose lower-limit ratio is at least 1.5 times the stars'.
Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp --with matplotlib \
       python -I bake/detector_cold.py prep|run <name> <ra> <dec> <size_deg> [label]
     python -I bake/detector_cold.py publish <name> ...        (writes web/data/candidates.json from finished runs)
"""
import sys, os, re, json, time, io, csv, shutil, datetime, warnings, numpy as np, requests
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from astropy.io import fits
from astropy.wcs import WCS
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from scipy.interpolate import RegularGridInterpolator
warnings.simplefilter('ignore')

VERSION = 'cold-2026-11-15c'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
API = 'https://comet-hunt.comet-hunt.workers.dev/api/images'
OUT = os.environ.get('DET_COLD_OUT', '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector-cold')
CACHE = OUT + '/cache'
PIX, OPIX = 6.16, 3.08                       # arcsec: SPHEREx pixel, stack pixel
AS = 206264.806
MJY = 1e9 * (OPIX / AS) ** 2                 # (MJy/sr summed over stack pixels) -> mJy
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 25, 27, 28, 29))   # as phase 1: never 19 OUTLIER or 21 SOURCE
GROW = (1 << 1) | (1 << 26)                  # OVERFLOW and BLOOM, grown by 3 px
BAND33 = (3.1, 3.6)                          # um, the methane band inside D4
EPOCH_GAP, MIN_EXP, MIN_N = 60.0, 6, 3       # days that split survey passes; exposures a pass needs; looks a stack pixel needs
BASE_MIN = 0.4                               # years between two passes that are compared (was 0.7 and first-to-last only in run 1)
AP = 3                                       # aperture radius, stack pixels (9.2 arcsec)
SNR_MIN = 5.0
MU_MIN, MU_MAX, SIG_MIN = 0.5, 12.0, float(os.environ.get('DET_COLD_SIG', 5.0))   # arcsec/yr range of a candidate; significance of the shift (the env override is for labelled what-if runs only)
MU_LIST = 0.25                               # movers down to this are listed (not candidates) for the Gaia comparison
FLUX_RATIO = 2.5                             # first/last epoch brightness may differ by this (stacks sample different wavelengths)
COLOUR_MIN = 1.5                             # lower-limit 4.5/3.3 ratio, in units of the patch's stars
year = lambda mjd: 2000.0 + (np.asarray(mjd) - 51544.5) / 365.25


def tan(ra, dec, ra0, dec0):
    a, d, a0, d0 = (np.radians(v) for v in (ra, dec, ra0, dec0)); c = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    return AS * np.cos(d) * np.sin(a - a0) / c, AS * (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / c
def untan(x, y, ra0, dec0):
    x, y, a0, d0 = np.asarray(x) / AS, np.asarray(y) / AS, np.radians(ra0), np.radians(dec0)
    r = np.hypot(x, y); c = np.arctan(r); r = np.where(r == 0, 1e-12, r)
    d = np.arcsin(np.cos(c) * np.sin(d0) + y * np.sin(c) * np.cos(d0) / r)
    return np.degrees(a0 + np.arctan2(x * np.sin(c), r * np.cos(d0) * np.cos(c) - y * np.sin(d0) * np.sin(c))) % 360, np.degrees(d)


# ---------- 1. prep ----------
def prep(name, ra, dec, size, label=None):
    d = f'{CACHE}/{name}'; os.makedirs(d, exist_ok=True); half = size * 1800 + 40; ims = {}
    edge = np.linspace(-half, half, 9); bx = np.concatenate([edge, edge, 0 * edge - half, 0 * edge + half]); by = np.concatenate([0 * edge - half, 0 * edge + half, edge, edge])
    bra, bdec = untan(bx, by, ra, dec)
    def get(a):
        det, e = a; f = f"{d}/{det}_{e['obs']}.npz"
        if os.path.exists(f): return True
        for k in range(4):
            try:
                h = fits.open(S3 + e['key'], use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 20}); hd = h['IMAGE'].header
                x, y = WCS(hd).all_world2pix(bra, bdec, 0, quiet=True); x0, x1, y0, y1 = (int(np.clip(v, 0, 2040)) for v in (x.min() - 8, x.max() + 9, y.min() - 8, y.max() + 9))
                if x1 - x0 < 16 or y1 - y0 < 16: return False
                np.savez(f, img=np.asarray(h['IMAGE'].section[y0:y1, x0:x1], np.float32), flg=np.asarray(h['FLAGS'].section[y0:y1, x0:x1]).astype(np.int32),
                         x0=x0, y0=y0, hdr=hd.tostring(), t=float(hd.get('MJD-AVG', e['t']))); return True
            except Exception as err: last = err; time.sleep(2)
        print('FAILED', det, e['obs'], repr(last)); return False
    for det in ('D6', 'D4'):
        L = requests.get(API, params=dict(ra=ra, dec=dec, det=det), timeout=120).json()['images']
        with ThreadPoolExecutor(12) as ex: ok = list(ex.map(get, [(det, e) for e in L]))
        ims[det] = [e for e, k in zip(L, ok) if k]
    json.dump(dict(name=name, label=label or name, ra=ra, dec=dec, size=size, images=ims), open(f'{d}/patch.json', 'w'))
    print(name, {k: len(v) for k, v in ims.items()}, flush=True)


# ---------- 2. stack ----------
def mesh(a, B):
    """Clipped median and robust sigma of a in BxB blocks, smoothly scaled back up to a's shape."""
    H, W = a.shape; h, w = -(-H // B), -(-W // B); p = np.full((h * B, w * B), np.nan, np.float32); p[:H, :W] = a
    m = p.reshape(h, B, w, B).transpose(0, 2, 1, 3).reshape(h, w, B * B)
    med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2)
    for _ in range(2):
        m = np.where(np.abs(m - med[:, :, None]) > 2.5 * sd[:, :, None], np.nan, m)
        med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2) / 0.9
    fill = lambda g: np.where(np.isfinite(g), g, np.nanmedian(g))
    return tuple(ndi.zoom(fill(g), B, order=1, mode='nearest')[:H, :W] for g in (med, sd))

_wave = {}
def wave(det):
    if det not in _wave:
        m = json.load(open(ROOT + '/web/data/wavemaps.json'))[det]      # lam[iy][ix] on 1-based detector pixels
        _wave[det] = RegularGridInterpolator((np.array(m['y'], float) - 1, np.array(m['x'], float) - 1), np.array(m['lam']), bounds_error=False, fill_value=None)
    return _wave[det]

def resample(a):
    """One cached exposure -> (surface brightness, wavelength) on the patch grid; nan where masked or off the detector.
    a['inj'] (evaluator only): [(ra, dec, sum in MJy/sr over detector pixels, 'psf' or 'pixel')] added to the pixels first."""
    z = np.load(a['path']); img = z['img'].astype(np.float32).copy(); flg = z['flg']; x0, y0 = int(z['x0']), int(z['y0']); w = WCS(fits.Header.fromstring(str(z['hdr'])))
    for ra, dec, s, kind in a.get('inj') or []:
        x, y = (float(v) for v in w.all_world2pix(ra, dec, 0, quiet=True)); x -= x0; y -= y0; xi, yi = int(round(x)), int(round(y))
        if not (3 <= xi < img.shape[1] - 3 and 3 <= yi < img.shape[0] - 3): continue
        if kind == 'pixel': img[yi, xi] += s
        else:   # ponytail: a round Gaussian (FWHM 1.3 px) stands in for the PSF; use the file's EPSF table if planted fluxes must be exact
            Y, X = np.mgrid[yi - 3:yi + 4, xi - 3:xi + 4]; g = np.exp(-((X - x) ** 2 + (Y - y) ** 2) / (2 * 0.55 ** 2)); img[yi - 3:yi + 4, xi - 3:xi + 4] += s * g / g.sum()
    bad = ~np.isfinite(img) | ((flg & BAD) != 0) | ndi.binary_dilation((flg & GROW) != 0, iterations=3)
    bg, _ = mesh(np.where(bad, np.nan, img), 16)
    val = np.where(bad, 0, img - bg).astype(np.float32); N = a['N']; g = (np.arange(N) - (N - 1) / 2) * OPIX
    ra, dec = untan(*np.meshgrid(g, g), a['ra'], a['dec']); x, y = w.all_world2pix(ra.ravel(), dec.ravel(), 0, quiet=True, detect_divergence=False)
    c = [y.reshape(N, N) - y0, x.reshape(N, N) - x0]
    wt = ndi.map_coordinates((~bad).astype(np.float32), c, order=1, cval=0); v = ndi.map_coordinates(val, c, order=1, cval=0)
    out = np.where(wt > 0.95, v / np.maximum(wt, 1e-6), np.nan).astype(np.float32)
    return out, wave(a['det'])(np.stack([y, x], 1)).reshape(N, N).astype(np.float32)

def combine(cube):
    """Per-pixel mean of the exposures after dropping any value far from the per-pixel median (4 sigma of that exposure's
    noise plus half the median itself, since a real source changes with wavelength). Run 1 used the plain median, which
    is about 20% noisier; a one-exposure flash or cosmic ray is still dropped."""
    med = np.nanmedian(cube, 0); sd = np.array([1.4826 * np.nanmedian(np.abs(c - np.nanmedian(c))) for c in cube])[:, None, None]
    return np.nanmean(np.where(np.abs(cube - med) <= 4 * sd + 0.5 * np.abs(med), cube, np.nan), 0)

def stack(name, inj=None):
    """-> patch dict, epochs [dict(t, n, obs, s45, n45, s33, n33)] (stacks in MJy/sr, x east, y north)."""
    P = json.load(open(f'{CACHE}/{name}/patch.json')); N = int(round(P['size'] * 3600 / OPIX)); P['N'] = N; R = {}
    for det in ('D6', 'D4'):
        E = sorted(P['images'][det], key=lambda e: e['t'])
        with ProcessPoolExecutor(8) as ex:
            res = list(ex.map(resample, [dict(path=f"{CACHE}/{name}/{det}_{e['obs']}.npz", det=det, N=N, ra=P['ra'], dec=P['dec'], inj=(inj or {}).get((det, e['obs']))) for e in E]))
        R[det] = (E, res)
    E6, r6 = R['D6']; groups = [[0]]
    for i in range(1, len(E6)): (groups[-1].append(i) if E6[i]['t'] - E6[i - 1]['t'] < EPOCH_GAP else groups.append([i]))
    E4, r4 = R['D4']; t4 = np.array([e['t'] for e in E4]); eps = []
    for g in groups:
        if len(g) < MIN_EXP: continue
        t = [E6[i]['t'] for i in g]; cube = np.array([r6[i][0] for i in g]); n45 = np.isfinite(cube).sum(0)
        k4 = np.nonzero((t4 > min(t) - 30) & (t4 < max(t) + 30))[0]
        c4 = np.array([np.where((r4[i][1] >= BAND33[0]) & (r4[i][1] <= BAND33[1]), r4[i][0], np.nan) for i in k4]) if len(k4) else np.full((1, N, N), np.nan, np.float32)
        n33 = np.isfinite(c4).sum(0)
        eps.append(dict(t=float(np.mean(t)), n=len(g), obs=E6[g[0]]['obs'], obs_all=[E6[i]['obs'] for i in g], t0=float(min(t)), t1=float(max(t)), s45=np.where(n45 >= MIN_N, combine(cube), np.nan), n45=n45,
                        s33=np.where(n33 >= MIN_N, combine(c4), np.nan), n33=n33))
    return P, eps


# ---------- 3. find ----------
_K = (np.hypot(*np.mgrid[-AP:AP + 1, -AP:AP + 1]) <= AP + 0.2).astype(np.float32)
def maps(img):
    """Aperture-sum map with the local background removed, and its noise map."""
    ok = np.isfinite(img); ap = ndi.convolve(np.where(ok, img, 0).astype(np.float32), _K, mode='constant')
    ap[ndi.convolve(ok.astype(np.float32), _K, mode='constant') < 0.9 * _K.sum()] = np.nan
    bg, sd = mesh(ap, 64); return ap - bg, sd

def centroid(img, x, y):
    """Gaussian-windowed centroid (sigma 1.5 stack px), a few passes."""
    H, W = img.shape
    for _ in range(8):
        xi, yi = int(round(x)), int(round(y))
        if not (5 <= xi < W - 5 and 5 <= yi < H - 5): break
        c = np.clip(np.nan_to_num(img[yi - 4:yi + 5, xi - 4:xi + 5]), 0, None); Y, X = np.mgrid[yi - 4:yi + 5, xi - 4:xi + 5]
        wgt = c * np.exp(-((X - x) ** 2 + (Y - y) ** 2) / (2 * 1.5 ** 2)); s = wgt.sum()
        if s <= 0: break
        dx, dy = 2 * (wgt * (X - x)).sum() / s, 2 * (wgt * (Y - y)).sum() / s; x += dx; y += dy
        if abs(dx) + abs(dy) < 1e-3: break
    return x, y

def catalogue(ep):
    ap, sd = maps(ep['s45']); snr = ap / sd; ep['ap45'], ep['sd45'] = ap, sd; ep['ap33'], ep['sd33'] = maps(ep['s33'])
    pk = (snr >= SNR_MIN) & (ap == ndi.maximum_filter(np.nan_to_num(ap, nan=-1e9), 7)); yy, xx = np.nonzero(pk); N = ap.shape[0]
    xy = np.array([centroid(ep['s45'], float(x), float(y)) for x, y in zip(xx, yy)]).reshape(-1, 2)
    keep = (np.hypot(xy[:, 0] - xx, xy[:, 1] - yy) < 2.5) if len(xy) else np.zeros(0, bool)      # a centroid that walked off is a blend or an edge
    g = lambda v: (v - (N - 1) / 2) * OPIX
    return dict(x=g(xy[keep, 0]), y=g(xy[keep, 1]), f=ap[yy, xx][keep], snr=snr[yy, xx][keep])

def forced(ep, band, x, y):
    """Aperture flux and its sigma (MJy/sr sums) at tangent-plane positions (arcsec)."""
    N = ep['ap45'].shape[0]; c = [np.atleast_1d(y) / OPIX + (N - 1) / 2, np.atleast_1d(x) / OPIX + (N - 1) / 2]
    f = ndi.map_coordinates(np.nan_to_num(ep['ap' + band], nan=0), c, order=1, cval=0); s = ndi.map_coordinates(ep['sd' + band], c, order=1, mode='nearest')
    ok = ndi.map_coordinates(np.isfinite(ep['ap' + band]).astype(np.float32), c, order=1, cval=0) > 0.999   # all four pixels it interpolates between (review of 4ddce47: zero-filled mask edges faked a low flux)
    return np.where(ok, f, np.nan), np.where(ok, s, np.nan)

def gaia(P):
    """Gaia DR3 stars over the patch (cached). None if the archive cannot be reached."""
    f = f"{CACHE}/{P['name']}/gaia.csv"
    if not os.path.exists(f):
        r = P['size'] * 0.75
        q = ("SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE phot_g_mean_mag < 19 AND pmra IS NOT NULL AND "
             f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {P['ra']}, {P['dec']}, {r}))")
        cols = ('source_id', 'ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag'); txt = None
        for url, fmt in (('https://gaia.aip.de/tap/sync', 'votable'), ('https://gea.esac.esa.int/tap-server/tap/sync', 'csv')):   # the AIP mirror first: ESA hung on 2026-11-15
            try:
                t = requests.post(url, data=dict(REQUEST='doQuery', LANG='ADQL', FORMAT=fmt, QUERY=q), timeout=90).text
                if fmt == 'csv' and t.startswith('source_id'): txt = t
                elif 'QUERY_STATUS" value="OK"' in t and 'OVERFLOW' not in t:
                    txt = ','.join(cols) + '\n' + '\n'.join(','.join(re.findall(r'<TD>(.*?)</TD>', r)) for r in re.findall(r'<TR>(.*?)</TR>', t, re.S)) + '\n'
            except Exception: pass
            if txt: break
        if not txt: return None
        open(f, 'w').write(txt)
    rows = list(csv.DictReader(open(f)))
    return {k: np.array([float(r[k]) for r in rows]) for k in ('ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag')} | dict(id=[r['source_id'] for r in rows])

def gaia_at(G, P, t):
    """Gaia positions at MJD t on the patch's tangent plane (arcsec)."""
    dt = float(year(t)) - 2016.0
    return tan(G['ra'] + G['pmra'] * dt / 3.6e6 / np.cos(np.radians(G['dec'])), G['dec'] + G['pmdec'] * dt / 3.6e6, P['ra'], P['dec'])

def anchor(C, rx, ry):
    """Affine fit of catalogue C onto reference positions (clipped), applied in place. Returns (stars used, rms arcsec)."""
    k = np.nonzero(C['snr'] > 10)[0]
    if len(k) < 10 or len(rx) < 10: return 0, None
    d, j = cKDTree(np.c_[rx, ry]).query(np.c_[C['x'][k], C['y'][k]]); ok = d < 4
    for _ in range(3):
        if ok.sum() < 10: return 0, None
        A = np.c_[np.ones(ok.sum()), C['x'][k][ok], C['y'][k][ok]]; cx = np.linalg.lstsq(A, rx[j][ok], rcond=None)[0]; cy = np.linalg.lstsq(A, ry[j][ok], rcond=None)[0]
        B = np.c_[np.ones(len(k)), C['x'][k], C['y'][k]]; r = np.hypot(B @ cx - rx[j], B @ cy - ry[j]); rms = float(np.sqrt(np.mean(r[ok] ** 2))); ok = (d < 4) & (r < max(2.5 * rms, 0.3))
    B = np.c_[np.ones(len(C['x'])), C['x'], C['y']]; C['x'], C['y'] = B @ cx, B @ cy
    return int(ok.sum()), rms


# ---------- 4 and 5. move, colour ----------
def pair(a, b, R):
    """Closest pairs first, each source used once, brightness within FLUX_RATIO. -> index arrays into a and b."""
    if not len(a['x']) or not len(b['x']): return np.zeros(0, int), np.zeros(0, int)
    m = cKDTree(np.c_[a['x'], a['y']]).sparse_distance_matrix(cKDTree(np.c_[b['x'], b['y']]), R, output_type='ndarray'); m = m[np.argsort(m['v'])]
    ua, ub, I, J = set(), set(), [], []
    for i, j, _ in m:
        if i in ua or j in ub or not 1 / FLUX_RATIO <= a['f'][i] / b['f'][j] <= FLUX_RATIO: continue
        ua.add(i); ub.add(j); I.append(i); J.append(j)
    return np.array(I, int), np.array(J, int)

def search(name, inj=None):
    """The whole search on one prepared patch. -> result dict (movers, candidates, numbers), epochs (with stacks)."""
    P, eps = stack(name, inj); out = dict(name=name, label=P['label'], ra=P['ra'], dec=P['dec'], size=P['size'], version=VERSION, area_sqdeg=P['size'] ** 2,
                                          epochs=[dict(t=e['t'], year=float(year(e['t'])), exposures=e['n']) for e in eps], movers=[], candidates=[], note='')
    if len(eps) < 2 or year(eps[-1]['t']) - year(eps[0]['t']) < BASE_MIN:
        out['note'] = 'fewer than two survey passes far enough apart'; return out, eps
    G = gaia(P); C = [catalogue(e) for e in eps]; out['anchor'] = []
    for i, (e, c) in enumerate(zip(eps, C)):
        ref = gaia_at(G, P, e['t']) if G else (C[0]['x'], C[0]['y']); n, rms = anchor(c, *ref) if (G or i) else (len(c['x']), 0.0)
        out['anchor'].append(dict(frame='Gaia DR3' if G else 'first epoch', stars=n, rms_arcsec=rms, sources=len(c['x'])))
    good = [i for i, q in enumerate(out['anchor']) if q['stars'] > 0]; eps, C = [eps[i] for i in good], [C[i] for i in good]      # a pass that could not be tied to the frame is not used
    for i, q in enumerate(out['anchor']): out['epochs'][i]['used'] = i in good
    if len(eps) < 2 or year(eps[-1]['t']) - year(eps[0]['t']) < BASE_MIN:
        out['note'] = 'fewer than two registered survey passes far enough apart'; return out, eps
    yr = np.array([float(year(e['t'])) for e in eps]); dt = yr[-1] - yr[0]; a, b = C[0], C[-1]                      # first and last pass: the error model and the star colours
    I, J = pair(a, b, MU_MAX * dt + 3); dx, dy = b['x'][J] - a['x'][I], b['y'][J] - a['y'][I]; d = np.hypot(dx, dy); q = 1 / a['snr'][I] ** 2 + 1 / b['snr'][J] ** 2
    st = d < 2; mad = lambda v: 1.4826 * np.median(np.abs(v - np.median(v))) if len(v) > 20 else None                 # error model from the patch's own stars
    br = mad(np.r_[dx[st & (q < 2 / 50 ** 2)], dy[st & (q < 2 / 50 ** 2)]]); fa = st & (q > 1 / 12 ** 2); sf = mad(np.r_[dx[fa], dy[fa]])
    A = (br / np.sqrt(2)) if br else 0.3; Bq = np.sqrt(max(sf ** 2 - 2 * A ** 2, 1.0) / np.median(q[fa])) if sf else 6.0
    sig1 = lambda snr: np.hypot(A, Bq / snr); out['error_model'] = dict(floor_arcsec=float(A), per_snr_arcsec=float(Bq), pairs=int(len(I)), static=int(st.sum()))
    # colour reference: bright, still stars of this patch
    def colour(xs, ys):
        f45, v45, f33, v33 = 0.0, 0.0, 0.0, 0.0
        for e, x, y in zip(eps, xs, ys):
            f, s = forced(e, '45', x, y); g, u = forced(e, '33', x, y)
            f45 = f45 + np.nan_to_num(f / s ** 2); v45 = v45 + np.nan_to_num(1 / s ** 2); f33 = f33 + np.nan_to_num(g / u ** 2); v33 = v33 + np.nan_to_num(1 / u ** 2)
        with np.errstate(all='ignore'): return f45 / v45, 1 / np.sqrt(v45), f33 / v33, 1 / np.sqrt(v33)
    f45, s45, f33, s33 = colour([a['x'][I]] * len(eps), [a['y'][I]] * len(eps)); ref = st & (f45 / s45 > 30) & (f33 / s33 > 10)
    rstar = float(np.median(f45[ref] / f33[ref])) if ref.sum() >= 10 else None; out['star_ratio'] = rstar; out['star_ratio_n'] = int(ref.sum())
    out['star_ratio_scatter'] = float(mad(np.log10(f45[ref] / f33[ref])) or 0) if rstar else None
    used = set()                                                        # every pair of passes at least BASE_MIN apart, longest first; a detection joins one mover
    for e0, e1 in sorted(((u, v) for u in range(len(eps)) for v in range(u + 1, len(eps)) if yr[v] - yr[u] >= BASE_MIN), key=lambda p: yr[p[0]] - yr[p[1]]):
      a, b = C[e0], C[e1]; dt = yr[e1] - yr[e0]; I, J = pair(a, b, MU_MAX * dt + 3); dx, dy = b['x'][J] - a['x'][I], b['y'][J] - a['y'][I]; d = np.hypot(dx, dy)
      for n in np.nonzero(d / np.sqrt(sig1(a['snr'][I]) ** 2 + sig1(b['snr'][J]) ** 2) >= SIG_MIN)[0]:
          i, j = I[n], J[n]; pts = [(yr[e0], a['x'][i], a['y'][i], a['snr'][i], a['f'][i], e0, int(i)), (yr[e1], b['x'][j], b['y'][j], b['snr'][j], b['f'][j], e1, int(j))]; looks, ok = 2, True
          for m in set(range(len(eps))) - {e0, e1}:                       # other passes: on the line (parallax allowed), or no look
              fr = (yr[m] - yr[e0]) / dt; px, py = a['x'][i] + fr * dx[n], a['y'][i] + fr * dy[n]; ff, fs = forced(eps[m], '45', px, py)
              if not np.isfinite(ff[0]): continue
              c = C[m]; r = np.hypot(c['x'] - px, c['y'] - py) if len(c['x']) else np.array([9e9]); k = int(np.argmin(r))
              if r[k] <= 3 * sig1(c['snr'][k]) + 1.0: pts.append((yr[m], c['x'][k], c['y'][k], c['snr'][k], c['f'][k], m, k)); looks += 1
              elif 0.5 * (a['f'][i] + b['f'][j]) / fs[0] >= 6: ok = False; looks += 1        # it should have been there
          if not ok or used & {(p[5], p[6]) for p in pts}: continue
          pts.sort(); t, x, y, s = (np.array([p[k] for p in pts]) for k in range(4)); w = 1 / sig1(s); M = np.c_[np.ones(len(t)), t - t.mean()] * w[:, None]
          cx, cy = np.linalg.lstsq(M, x * w, rcond=None)[0], np.linalg.lstsq(M, y * w, rcond=None)[0]; mu = float(np.hypot(cx[1], cy[1]))
          tw = (t * w ** 2).sum() / (w ** 2).sum(); sfit = float(mu * np.sqrt((w ** 2 * (t - tw) ** 2).sum()))      # speed over its own error, from every pass in the fit
          if mu < MU_LIST or sfit < SIG_MIN: continue
          rms = float(np.sqrt(np.mean((cx[0] + cx[1] * (t - t.mean()) - x) ** 2 + (cy[0] + cy[1] * (t - t.mean()) - y) ** 2)))
          ex, ey = [cx[0] + cx[1] * (v - t.mean()) for v in yr], [cy[0] + cy[1] * (v - t.mean()) for v in yr]; c45, e45, c33, e33 = (float(v[0]) for v in colour(ex, ey))
          r_lo = c45 / (max(c33, 0) + 2 * e33) if np.isfinite(c33) and np.isfinite(e33) else None; vs = r_lo / rstar if r_lo is not None and rstar else None
          ra, dec = untan(x, y, P['ra'], P['dec']); mv = dict(
              mu=mu, mu_east=float(cx[1]), mu_north=float(cy[1]), pa=float(np.degrees(np.arctan2(cx[1], cy[1])) % 360), sigma=sfit, pair_sigma=float(d[n] / np.sqrt(sig1(a['snr'][i]) ** 2 + sig1(b['snr'][j]) ** 2)),
              shift_arcsec=float(d[n]), rms=rms, n_seen=len(pts), n_looks=looks, f45_mjy=c45 * MJY, e45_mjy=e45 * MJY, f33_mjy=None if r_lo is None else c33 * MJY, e33_mjy=None if r_lo is None else e33 * MJY,
              ratio=(c45 / c33 if r_lo is not None and c33 > 0 else None), ratio_lo=r_lo, ratio_vs_stars=vs, cold=bool(vs is not None and vs >= COLOUR_MIN),
              baseline_yr=float(t.max() - t.min()), ep=[p[5] for p in pts], ra=float(ra[0]), dec=float(dec[0]), xy=[[float(u), float(v)] for u, v in zip(x, y)],
              detections=[dict(t=eps[p[5]]['t'], ra=float(r_), dec=float(d_), det='D6', flux_mjy=float(p[4] * MJY), snr=float(p[3]), obs=eps[p[5]]['obs'], stacked=eps[p[5]]['n'], t_first=eps[p[5]]['t0'], t_last=eps[p[5]]['t1'], exposures=eps[p[5]]['obs_all']) for p, r_, d_ in zip(pts, ra, dec)])
          if G:                                                           # the Gaia star under the first-epoch position, if any
              gx, gy = gaia_at(G, P, eps[pts[0][5]]['t']); r = np.hypot(gx - x[0], gy - y[0]); k = int(np.argmin(r))
              if r[k] < 4: mv['gaia'] = dict(id=G['id'][k], pmra=float(G['pmra'][k]) / 1000, pmdec=float(G['pmdec'][k]) / 1000, g=float(G['phot_g_mean_mag'][k]))
          mv['score'] = round(0.5 * min(mv['sigma'] / 15, 1) + 0.5 * min((vs or 0) / 6, 1), 3); out['movers'].append(mv); used |= {(p[5], p[6]) for p in pts}
    out['movers'].sort(key=lambda m: -m['score'])
    out['candidates'] = [m for m in out['movers'] if m['cold'] and MU_MIN <= m['mu'] <= MU_MAX]
    return out, eps


# ---------- label, evidence, output ----------
def simbad(m):
    """Name of a catalogued object with a matching proper motion near a mover (SIMBAD), else None. Looked up from the mover's own position."""
    q = ("SELECT main_id, ra, dec, pmra, pmdec FROM basic WHERE pmra IS NOT NULL AND pmdec IS NOT NULL AND "
         f"CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {m['ra']}, {m['dec']}, 0.06)) = 1")
    rows = []
    for host in ('simbad.harvard.edu', 'simbad.cds.unistra.fr'):        # the Harvard mirror first: CDS was down on 2026-11-15
        try:
            t = requests.post(f'https://{host}/simbad/sim-tap/sync', data=dict(REQUEST='doQuery', LANG='ADQL', FORMAT='csv', QUERY=q), timeout=40).text
            if t.startswith('main_id'): rows = list(csv.DictReader(io.StringIO(t))); break
        except Exception: pass
    for r in rows:
        try: e, n = float(r['pmra']) / 1000, float(r['pmdec']) / 1000
        except ValueError: continue
        ang = np.degrees(abs(np.arctan2(m['mu_east'] * n - m['mu_north'] * e, m['mu_east'] * e + m['mu_north'] * n)))
        if np.hypot(e, n) > 0.2 and 0.7 <= m['mu'] / np.hypot(e, n) <= 1.3 and ang <= 30: return r['main_id'].strip('"').strip()
    return None

def strip(path, m, P, eps):
    """Evidence: first and last 4.5 um stacks side by side with the shift marked, the 3.3 um stack, and the two fluxes."""
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    s33 = np.nanmean([e['s33'] for e in eps], 0); eps = [eps[k] for k in m['ep']]; N = P['N']; H = 13; (xa, ya), (xb, yb) = m['xy'][0], m['xy'][-1]; px = lambda v: v / OPIX + (N - 1) / 2; cx, cy = int(round(px((xa + xb) / 2))), int(round(px((ya + yb) / 2)))
    def cut(im):
        o = np.full((2 * H + 1, 2 * H + 1), np.nan); y0, y1, x0, x1 = max(cy - H, 0), min(cy + H + 1, N), max(cx - H, 0), min(cx + H + 1, N)
        o[y0 - cy + H:y1 - cy + H, x0 - cx + H:x1 - cx + H] = im[y0:y1, x0:x1]; return o
    fig, ax = plt.subplots(1, 4, figsize=(9.6, 2.9), facecolor='#0b0d12', gridspec_kw=dict(width_ratios=[1, 1, 1, 0.8]))
    ref = cut(eps[0]['s45']); s = 1.4826 * np.nanmedian(np.abs(ref - np.nanmedian(ref))) + 1e-9; vmax = max(8 * s, 0.9 * np.nanmax(cut(eps[-1]['s45'])[H - 3:H + 4, H - 3:H + 4]))
    for q, (im, lab) in zip(ax, [(eps[0]['s45'], f"4.5 um, {year(eps[0]['t']):.2f}"), (eps[-1]['s45'], f"4.5 um, {year(eps[-1]['t']):.2f}"), (s33, '3.3 um, all passes')]):
        q.imshow(cut(im), origin='lower', cmap='gray', vmin=-2 * s, vmax=vmax, interpolation='nearest'); q.invert_xaxis(); q.set_xticks([]); q.set_yticks([]); q.set_title(lab, color='#ddd', fontsize=9)
        for (x, y), col in (((xa, ya), '#5fe0ad'), ((xb, yb), '#ffb000')): q.add_patch(plt.Circle((px(x) - cx + H, px(y) - cy + H), 2.2, fill=False, lw=1.1, color=col))
        q.annotate('', xy=(px(xb) - cx + H, px(yb) - cy + H), xytext=(px(xa) - cx + H, px(ya) - cy + H), arrowprops=dict(arrowstyle='->', color='#ffb000', lw=1))
    q = ax[3]; q.set_facecolor('#0b0d12'); f33 = m['f33_mjy'] or 0
    q.bar(['3.3 um', '4.5 um'], [f33, m['f45_mjy']], yerr=[m['e33_mjy'] or 0, m['e45_mjy']], color=['#6aa9ff', '#ff7a59'], ecolor='#ddd', capsize=3)
    q.tick_params(colors='#ddd', labelsize=8); q.set_ylabel('mJy', color='#ddd', fontsize=8); [sp.set_color('#555') for sp in q.spines.values()]
    q.set_title(f"ratio at least {m['ratio_lo']:.1f}\n({m['ratio_vs_stars']:.1f} x a star's)", color='#ddd', fontsize=8)
    fig.suptitle(f"{m['id']}  moved {m['shift_arcsec']:.1f} arcsec in {year(eps[-1]['t']) - year(eps[0]['t']):.2f} yr = {m['mu']:.2f} arcsec/yr toward PA {m['pa']:.0f}   (green: first, amber: last; east left, {2 * H * OPIX / 60:.1f} arcmin wide)", color='#fff', fontsize=8.5)
    fig.tight_layout(); fig.savefig(path, dpi=120, facecolor=fig.get_facecolor()); plt.close(fig)

def run(name, ra=None, dec=None, size=None, label=None):
    """Real search of a prepared patch: cold_<name>.json and one strip per candidate."""
    t0 = time.time(); out, eps = search(name); P = dict(N=int(round(out['size'] * 3600 / OPIX))); os.makedirs(f'{OUT}/strips', exist_ok=True)
    for n, m in enumerate(out['candidates']):
        m['id'] = f'{name}-{n + 1:02d}'; m['known_name'] = simbad(m); strip(f"{OUT}/strips/{m['id']}.png", m, P, eps)
    json.dump(out, open(f'{OUT}/cold_{name}.json', 'w'), indent=1)
    print(name, 'epochs', [(round(e['year'], 2), e['exposures']) for e in out['epochs']], 'anchor', out.get('anchor'), 'error', out.get('error_model'), 'star ratio', out.get('star_ratio'), out.get('star_ratio_n'),
          'movers', len(out['movers']), 'candidates', [(m['id'], round(m['mu'], 2), round(m['pa']), round(m['ratio_vs_stars'], 1), m['known_name']) for m in out['candidates']], out['note'], f'{time.time() - t0:.0f}s', flush=True)
    return out

def publish(names, fname='candidates.json', sdir='candidates'):
    """web/data/candidates.json in the app's contract, from finished real runs. Planted objects never reach this file."""
    cands, regions = [], []; os.makedirs(f'{ROOT}/web/data/{sdir}', exist_ok=True)
    for f in os.listdir(f'{ROOT}/web/data/{sdir}'): os.remove(f'{ROOT}/web/data/{sdir}/{f}')
    for name in names:
        o = json.load(open(f'{OUT}/cold_{name}.json')); regions.append(dict(name=o['label'], ra=o['ra'], dec=o['dec'], radius_deg=round(o['size'] / 2, 3)))
        for m in o['candidates']:
            cid = f"{'K' if m['known_name'] else 'C'}-{len(cands) + 1:04d}"; shutil.copy(f"{OUT}/strips/{m['id']}.png", f'{ROOT}/web/data/{sdir}/{cid}.png')
            cands.append(dict(id=cid, score=m['score'], verdict='known' if m['known_name'] else 'worth_reporting', known_name=m['known_name'], detections=m['detections'],
                              track=dict(rate_arcsec_hr=round(m['mu'] / 8766, 6), pa_deg=round(m['pa'], 1), rms_arcsec=round(m['rms'], 2), distance_guess='nearby (cold)'),
                              checks=dict(n_photos=m['n_seen'], n_total=m['n_looks'], other_detector=bool(m['f33_mjy'] and m['f33_mjy'] > 3 * m['e33_mjy']), flagged=False, skybot_match=False,
                                          colour_ratio=round(m['ratio_lo'], 2), colour_ratio_vs_stars=round(m['ratio_vs_stars'], 2), colour_is_lower_limit=True, flux_45_mjy=round(m['f45_mjy'], 3), flux_33_mjy=round(m['f33_mjy'], 3),
                                          motion_arcsec_yr=round(m['mu'], 2), motion_east=round(m['mu_east'], 2), motion_north=round(m['mu_north'], 2), motion_sigma=round(m['sigma'], 1)),
                              strip=f'data/{sdir}/{cid}.png', region=o['label']))
    val = json.load(open(f'{OUT}/eval.json'))['validation'] if os.path.exists(f'{OUT}/eval.json') else {}
    json.dump(dict(generated=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), detector_version=VERSION, regions=regions, validation=val, candidates=cands),
              open(f'{ROOT}/web/data/{fname}', 'w'), indent=1)
    print('wrote', len(cands), 'candidates')

if __name__ == '__main__':
    c, a = sys.argv[1], sys.argv[2:]
    if c == 'publish': publish(a)
    elif c == 'prep': prep(a[0], float(a[1]), float(a[2]), float(a[3]), a[4] if len(a) > 4 else None)
    else: run(a[0])
