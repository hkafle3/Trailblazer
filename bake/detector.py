"""Moving-object detector, phase 1 (offline). Finds dots that move in straight, steady tracks across SPHEREx L2 D1
exposures of one visit, rejects glitches and stationary sources, and labels SkyBoT objects as known.

Method (catalogue style, no image subtraction, because every exposure sees a sky position at a different wavelength):
  1. detect  : 5 sigma peaks in a 3x3 box on each background-subtracted exposure; each gets a reject reason or None
               ('flag' NASA mask, 'shape' single-pixel, 'persist' same detector pixel as a bright source just before,
               'star' the same sky position is bright in the stack of the other exposures, 'unverifiable' no other look)
  2. link    : survivors pair up inside a burst (exposures 2 minutes apart), bursts join into straight tracks fitted
               against the real times; 3+ distinct times, 5 to 300 arcsec/hr, motion of 2+ pixels, found in most photos
  3. label   : SkyBoT match -> known; D4 (same instant through the dichroic) is supporting evidence only
Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp --with matplotlib \
       python -I bake/detector.py prep|run <field>
"""
import sys, os, json, time, warnings, numpy as np, requests
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from astropy.io import fits
from astropy.wcs import WCS
from scipy import ndimage as ndi
warnings.simplefilter('ignore')

VERSION = 'phase1-2026-11-15'
S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
API = 'https://comet-hunt.comet-hunt.workers.dev/api/images'
OUT = os.environ.get('DET_OUT', '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector')
CACHE = OUT + '/cache'
FIELDS = {  # name: (label, ra, dec, obs that must be in the chosen visit or None)
    'ecliptic': ('Ecliptic field', 30.0, 12.2, None),
    'flash': ("Ed's flash field", 7.6317, 15.7040, '2026W01_2A_0524_3'),
    'barnard': ("Barnard's Star", 269.452, 4.693, None),
}
PIX = 6.16                                   # arcsec per pixel
JY = 1e6 * (PIX / 206264.806) ** 2           # (MJy/sr summed over pixels) -> Jy
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 25, 27, 28, 29))   # never 19 OUTLIER or 21 SOURCE
GROW = (1 << 1) | (1 << 26)                  # OVERFLOW and BLOOM: grown by 3 px
SNR_MIN, SHARP_MAX, SHARP_MIN = 5.0, 0.80, 0.20   # box SNR floor; brightest pixel / 3x3 sum: above = single-pixel hit, below = diffuse
STATIC_DT, STATIC_S, STATIC_R, STATIC_N = 0.1, 2.0, 0.15, 3   # days apart for a "different look"; stacked SNR and share of its own brightness that mark a stationary source
TOL = 4.5                                    # arcsec, allowed distance from the straight-line fit (0.73 px); 6.16 (1 px) for faint ones
tol = lambda snr: np.where(snr < 10, PIX, TOL)
RATE_MIN, RATE_MAX = 5.0, 300.0              # arcsec per hour
MOVE_MIN = 2 * PIX                           # arcsec of fitted motion needed to call it moving
FLUX_RATIO = 3.0                             # brightest burst / faintest burst allowed on one track
BURST_GAP, LINK_H, COMPLETE = 0.01, 96.0, 0.6   # days; hours between bursts that may link; share of photos it must show in
MAX_EXP = 40
mag = lambda s: 8.9 - 2.5 * np.log10(np.maximum(s, 1e-12) * JY)   # AB mag of a pixel-sum flux
unmag = lambda m: 10 ** ((8.9 - m) / 2.5) / JY


def tan(ra, dec, ra0, dec0):
    a, d, a0, d0 = (np.radians(v) for v in (ra, dec, ra0, dec0)); c = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    return 206264.806 * np.cos(d) * np.sin(a - a0) / c, 206264.806 * (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / c
def untan(x, y, ra0, dec0):
    x, y, a0, d0 = np.asarray(x) / 206264.806, np.asarray(y) / 206264.806, np.radians(ra0), np.radians(dec0)
    r = np.hypot(x, y); c = np.arctan(r); r = np.where(r == 0, 1e-12, r)
    d = np.arcsin(np.cos(c) * np.sin(d0) + y * np.sin(c) * np.cos(d0) / r)
    return np.degrees(a0 + np.arctan2(x * np.sin(c), r * np.cos(d0) * np.cos(c) - y * np.sin(d0) * np.sin(c))) % 360, np.degrees(d)


# ---------- data ----------
def images(field, det='D1'):
    _, ra, dec, _ = FIELDS[field]
    return requests.get(API, params=dict(ra=ra, dec=dec, det=det), timeout=120).json()['images']

def prep(field):
    """Pick one visit, cache IMAGE, FLAGS and the header of each D1 exposure in it."""
    must = FIELDS[field][3]; ims = images(field); vs = [[ims[0]]]
    for e in ims[1:]: (vs[-1].append(e) if e['t'] - vs[-1][-1]['t'] < 20 else vs.append([e]))
    v = next(v for v in vs if any(e['obs'] == must for e in v)) if must else max(vs, key=len)
    v = v[:MAX_EXP]; d = f'{CACHE}/{field}'; os.makedirs(d, exist_ok=True)
    def get(e):
        if os.path.exists(f"{d}/{e['obs']}.hdr"): return
        for k in range(4):
            try:
                h = fits.open(S3 + e['key'], use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 22})
                np.save(f"{d}/{e['obs']}.img.npy", np.asarray(h['IMAGE'].data, np.float32)); np.save(f"{d}/{e['obs']}.flg.npy", np.asarray(h['FLAGS'].data).astype(np.int32))
                open(f"{d}/{e['obs']}.hdr", 'w').write(h['IMAGE'].header.tostring()); return
            except Exception as err: last = err; time.sleep(2)
        print('FAILED', e['obs'], repr(last))
    with ThreadPoolExecutor(8) as ex: list(ex.map(get, v))
    v = [e for e in v if os.path.exists(f"{d}/{e['obs']}.hdr")]
    json.dump(v, open(f'{d}/visit.json', 'w')); print(field, len(v), 'exposures', v[0]['t'], v[-1]['t'])

def load(field):
    d = f'{CACHE}/{field}'; E = json.load(open(f'{d}/visit.json'))
    for e in E:
        h = fits.Header.fromstring(open(f"{d}/{e['obs']}.hdr").read()); e['w'] = WCS(h); e['t'] = float(h.get('MJD-AVG', e['t'])); e['path'] = f"{d}/{e['obs']}"
    E.sort(key=lambda e: e['t'])
    b = 0
    for i, e in enumerate(E):
        if i and e['t'] - E[i - 1]['t'] > BURST_GAP: b += 1
        e['burst'] = b
    return E


# ---------- 1. detect ----------
def psf_add(img, x, y, s, P):
    """Add a point source of pixel-sum flux s at (x, y). P is the effective PSF sampled 3x finer than a pixel."""
    xi, yi, R = int(round(x)), int(round(y)), P.shape[0] // 6
    for j in range(yi - R, yi + R + 1):
        for i in range(xi - R, xi + R + 1):
            a, b = int(round((j - y) * 3)) + P.shape[0] // 2, int(round((i - x) * 3)) + P.shape[0] // 2
            if 0 <= j < img.shape[0] and 0 <= i < img.shape[1] and 0 <= a < P.shape[0] and 0 <= b < P.shape[0]: img[j, i] += s * P[a, b]

def detect_one(a):
    """One exposure -> detections (x, y, box flux, box snr, sharpness, flagged) plus the box-SNR map for forced looks.
    a['inj'] (evaluator only) = dict(P=psf, psf=[(x, y, s)], pix=[(x, y, s, kind, flagged)]) is added to the ORIGINAL image."""
    img = np.load(a['path'] + '.img.npy').astype(np.float32); flg = np.load(a['path'] + '.flg.npy'); inj = a.get('inj')
    if inj:
        for x, y, s in inj['psf']: psf_add(img, x, y, s, inj['P'])
        for x, y, s, kind, flagged in inj['pix']:
            xi, yi = int(round(x)), int(round(y))
            if not (2 <= xi < 2037 and 2 <= yi < 2037): continue
            if kind == 'psf': psf_add(img, x, y, s, inj['P'])
            elif kind == 'pixel': img[yi, xi] += s
            else: img[yi:yi + 2, xi:xi + 2] += s / 4
            if flagged: flg[yi - 1:yi + 2, xi - 1:xi + 2] |= 1          # TRANSIENT, as the pipeline marks cosmic rays
    bad = ~np.isfinite(img) | ((flg & BAD) != 0) | ndi.binary_dilation((flg & GROW) != 0, iterations=3)
    m = np.where(bad, np.nan, img).reshape(51, 40, 51, 40).transpose(0, 2, 1, 3).reshape(51, 51, 1600)
    med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2)
    for _ in range(2):                                                 # clip sources out of the background mesh
        m = np.where(np.abs(m - med[:, :, None]) > 2.5 * sd[:, :, None], np.nan, m)
        med = np.nanmedian(m, axis=2); sd = 1.4826 * np.nanmedian(np.abs(m - med[:, :, None]), axis=2) / 0.9
    fill = lambda g: np.where(np.isfinite(g), g, np.nanmedian(g))
    bg, sig = (ndi.zoom(fill(g), 40, order=1, mode='nearest') for g in (med, sd))
    sub = np.where(np.isfinite(img), img - bg, 0).astype(np.float32)
    box = ndi.uniform_filter(sub, 3) * 9; bs = box / (3 * sig); bd = ndi.binary_dilation(bad, structure=np.ones((3, 3), bool))
    pk = (bs >= SNR_MIN) & (box == ndi.maximum_filter(box, 5)); pk[:3] = pk[-3:] = False; pk[:, :3] = pk[:, -3:] = False
    yy, xx = np.nonzero(pk); wgt = np.clip(sub, 0, None)
    w5 = lambda q: ndi.uniform_filter(q, 5)[yy, xx]
    gy, gx = np.mgrid[0:2040, 0:2040].astype(np.float32); s5 = w5(wgt) + 1e-9
    dets = dict(x=w5(wgt * gx) / s5, y=w5(wgt * gy) / s5, px=xx, py=yy, s=box[yy, xx], snr=bs[yy, xx],
                sharp=ndi.maximum_filter(sub, 3)[yy, xx] / box[yy, xx], flagged=bd[yy, xx], flags=np.bitwise_or.reduce([flg[yy + j, xx + i] for j in (-1, 0, 1) for i in (-1, 0, 1)]))
    return dets, np.where(bd, np.nan, bs).astype(np.float16), float(np.nanmedian(sd))

def sample(e, ra, dec):
    """Box SNR of exposure e at sky positions (nan where off the detector or masked); also the pixel position."""
    ra, dec = np.atleast_1d(ra).astype(float), np.atleast_1d(dec).astype(float); x, y = np.full(ra.shape, np.nan), np.full(ra.shape, np.nan)
    c = e['w'].wcs.crval; near = np.hypot(((ra - c[0] + 180) % 360 - 180) * np.cos(np.radians(c[1])), dec - c[1]) < 4      # far points make the SIP solver give up on all
    if near.any(): x[near], y[near] = e['w'].all_world2pix(ra[near], dec[near], 0, quiet=True, detect_divergence=False)
    xi, yi = np.rint(x), np.rint(y)
    ok = np.isfinite(x) & np.isfinite(y) & (xi >= 3) & (xi < 2037) & (yi >= 3) & (yi < 2037); v = np.full(np.shape(ra), np.nan, np.float32); inside = ok.copy()
    v[ok] = e['bs'][yi[ok].astype(int), xi[ok].astype(int)]
    return v, inside, x, y

def detect(field, inject=None):
    """All exposures -> E (with maps) and one table D of detections with a reject reason each."""
    E = load(field); ra0, dec0 = FIELDS[field][1:3]
    with ProcessPoolExecutor(6) as ex: R = list(ex.map(detect_one, [dict(path=e['path'], inj=inject(e) if inject else None) for e in E]))
    cols = {k: [] for k in ('x', 'y', 'px', 'py', 's', 'snr', 'sharp', 'flagged', 'flags', 'e')}
    for i, (e, (d, bs, sd)) in enumerate(zip(E, R)):
        e['bs'], e['sig'] = bs, sd
        for k in d: cols[k].append(d[k])
        cols['e'].append(np.full(len(d['x']), i))
    D = {k: np.concatenate(v) for k, v in cols.items()}; n = len(D['x'])
    D['ra'], D['dec'] = np.zeros(n), np.zeros(n)
    for i, e in enumerate(E):
        k = D['e'] == i; D['ra'][k], D['dec'][k] = e['w'].all_pix2world(D['x'][k], D['y'][k], 0)
    D['t'] = np.array([e['t'] for e in E])[D['e']]; D['xi'], D['eta'] = tan(D['ra'], D['dec'], ra0, dec0)
    why = np.full(n, '', object); why[(D['sharp'] > SHARP_MAX) | (D['sharp'] < SHARP_MIN)] = 'shape'; why[D['flagged']] = 'flag'
    for i, e in enumerate(E):                                          # persistence: bright or masked on the same pixels just before
        if i and e['burst'] == E[i - 1]['burst']:
            k = np.nonzero((D['e'] == i) & (why == ''))[0]; p = E[i - 1]['bs'][D['py'][k], D['px'][k]].astype(np.float32)
            _, _, x0, y0 = sample(E[i - 1], D['ra'][k], D['dec'][k])                        # only if the pointing moved: else it is the same sky
            why[k[(p > 100) & ~(np.hypot(x0 - D['x'][k], y0 - D['y'][k]) <= 3)]] = 'persist'
    live = np.nonzero(why == '')[0]; S = np.zeros(len(live)); N = np.zeros(len(live)); NB = np.zeros(len(live)); NI = np.zeros(len(live)); V = []
    for e in E:                                                        # the other looks at the same sky position
        v, inside, _, _ = sample(e, D['ra'][live], D['dec'][live]); far = np.abs(D['t'][live] - e['t']) > STATIC_DT; ok = far & np.isfinite(v)
        S += np.where(ok, np.clip(v, -5, 5), 0); N += ok; NB += far & inside & ~np.isfinite(v); NI += far & inside; V.append(np.where(ok, v, np.nan))
    med = np.nanmedian(np.array(V), axis=0) if len(live) else S       # typical brightness there in the other looks
    still = (S / np.sqrt(np.maximum(N, 1)) > STATIC_S) & (med >= STATIC_R * D['snr'][live])
    w = np.where(N < STATIC_N, 'unverifiable', np.where(still | (NB >= 0.5 * np.maximum(NI, 1)), 'star', ''))
    why[live] = w; D['why'] = why; D['stack'] = np.full(n, np.nan); D['stack'][live] = S / np.sqrt(np.maximum(N, 1))
    return E, D


# ---------- 2. link ----------
def fit(t, x, y):
    """Straight line through (t hr, x, y arcsec): returns t0, p0, v, max residual."""
    t0 = t.mean(); A = np.stack([np.ones(len(t)), t - t0], 1); cx, cy = np.linalg.lstsq(A, x, rcond=None)[0], np.linalg.lstsq(A, y, rcond=None)[0]
    r = np.hypot(A @ cx - x, A @ cy - y)
    return t0, np.array([cx[0], cy[0]]), np.array([cx[1], cy[1]]), r, float(np.sqrt((r ** 2).mean()))

def link(E, D, field, times=None):
    """Orphans -> tracks. times (optional) replaces the exposure times: the shuffled-time control."""
    ra0, dec0 = FIELDS[field][1:3]; te = np.array([e['t'] for e in E]) if times is None else np.asarray(times); order = np.argsort(te)
    burst = np.zeros(len(E), int); b = 0
    for a, c in zip(order[:-1], order[1:]):
        b += te[c] - te[a] > BURST_GAP; burst[c] = b
    o = np.nonzero(D['why'] == '')[0]; t = (te[D['e'][o]] - te.min()) * 24; x, y, ex = D['xi'][o], D['eta'][o], D['e'][o]; bo = burst[ex]; tl = tol(D['snr'][o]); fl = D['s'][o]
    lets = set()                                                       # tracklets: 2+ exposures of one burst on one line
    for bb in np.unique(bo):
        k = np.nonzero(bo == bb)[0]
        if len(np.unique(ex[k])) < 2: continue
        for i in k:
            for j in k[(t[k] > t[i]) & (np.hypot(x[k] - x[i], y[k] - y[i]) <= RATE_MAX * (t[k] - t[i]) + TOL)]:
                v = np.array([x[j] - x[i], y[j] - y[i]]) / (t[j] - t[i]); r = np.hypot(x[k] - x[i] - v[0] * (t[k] - t[i]), y[k] - y[i] - v[1] * (t[k] - t[i]))
                best = {}
                for q in k[r <= tl[k]]:
                    if ex[q] not in best or r[k == q][0] < best[ex[q]][0]: best[ex[q]] = (r[k == q][0], q)
                lets.add(tuple(sorted(q for _, q in best.values())))
    lets = [np.array(l) for l in lets if len(l) >= 2]; lt = np.array([t[l].mean() for l in lets]); lb = [bo[l[0]] for l in lets]
    seeds = [l for l in lets if len(l) >= 3]
    for a in range(len(lets)):
        for c in range(len(lets)):
            if lb[c] > lb[a] and lt[c] - lt[a] <= LINK_H:
                d = np.hypot(x[lets[c]].mean() - x[lets[a]].mean(), y[lets[c]].mean() - y[lets[a]].mean())
                if RATE_MIN * 0.8 <= d / (lt[c] - lt[a]) <= RATE_MAX * 1.2: seeds.append(np.concatenate([lets[a], lets[c]]))
    tracks = []; rej = [np.nonzero((D['e'] == i) & (D['why'] != ''))[0] for i in range(len(E))]
    for s in seeds:
        t0, p, v, rmax, rms = fit(t[s], x[s], y[s])
        if (rmax > tl[s]).any(): continue
        for _ in range(4):                                             # gather everything on the line, refit, and grow outward one window at a time
            k = np.nonzero((t >= t[s].min() - LINK_H) & (t <= t[s].max() + LINK_H))[0]
            r = np.hypot(x[k] - p[0] - v[0] * (t[k] - t0), y[k] - p[1] - v[1] * (t[k] - t0)); best = {}
            for q, rq in zip(k[r <= tl[k]], r[r <= tl[k]]):
                if ex[q] not in best or rq < best[ex[q]][0]: best[ex[q]] = (rq, q)
            s2 = np.array(sorted(q for _, q in best.values()))
            if len(s2) < 3: break
            grew = len(s2) > len(s); s = s2; t0, p, v, rmax, rms = fit(t[s], x[s], y[s])
            if not grew or (rmax > tl[s]).any(): break
        rate = float(np.hypot(*v)); span = t[s].max() - t[s].min(); fb = [np.median(fl[s][bo[s] == bb]) for bb in np.unique(bo[s])]
        if max(fb) > FLUX_RATIO * min(fb): continue                    # one object: its bursts may differ in brightness, but not wildly
        if (rmax > tl[s]).any() or len(s) < 3 or not RATE_MIN <= rate <= RATE_MAX or rate * span < MOVE_MIN: continue
        need = [i for i in range(len(E)) if t[s].min() - 1e-6 <= (te[i] - te.min()) * 24 <= t[s].max() + 1e-6]   # photos that should show it
        pr, pd = untan(p[0] + v[0] * ((te[need] - te.min()) * 24 - t0), p[1] + v[1] * ((te[need] - te.min()) * 24 - t0), ra0, dec0)
        px_, py_ = tan(pr, pd, ra0, dec0); cover = []
        for i, a, d, qx, qy in zip(need, pr, pd, px_, py_):            # a photo counts unless it is masked there or a rejected source sits on the spot
            if i in ex[s]: cover.append(i); continue
            rj = rej[i]; dd = np.hypot(D['xi'][rj] - qx, D['eta'][rj] - qy)
            blocked = ((dd < 2 * PIX) | ((dd < 5 * PIX) & (D['snr'][rj] > 10 * D['snr'][o[s]].mean()))).any()
            if not blocked and np.isfinite(sample(E[i], np.array([a]), np.array([d]))[0][0]): cover.append(i)
        if len(s) / max(len(cover), 1) < COMPLETE: continue
        u = v / rate; slow = False                                     # the motion inside each burst must agree with the track
        for bb in np.unique(bo[s]):
            q = s[bo[s] == bb]; want = rate * (t[q].max() - t[q].min())
            if want >= PIX and (x[q[-1]] - x[q[0]]) * u[0] + (y[q[-1]] - y[q[0]]) * u[1] < 0.5 * want: slow = True
        if slow: continue
        tracks.append(dict(idx=o[s].tolist(), n=len(s), n_total=len(cover), rate=rate, pa=float(np.degrees(np.arctan2(v[0], v[1])) % 360), rms=rms, rmax=float(rmax.max()),
                           span_h=float(span), t0=float(te.min() + t0 / 24), p=p.tolist(), v=v.tolist(), snr=float(np.mean(D['snr'][o[s]])), bursts=int(len(np.unique(bo[s])))))
    tracks.sort(key=lambda k: k['rms'] - k['n']); used, keep = set(), []                    # dedupe: a detection belongs to one track
    for k in tracks:
        if not used & set(k['idx']): keep.append(k); used |= set(k['idx'])
    return keep, dict(orphans=len(o), tracklets=len(lets), seeds=len(seeds), tracks_before_dedupe=len(tracks), tracks=len(keep))

def predict(k, t, field):
    """Sky position of track k at MJD t."""
    dt = (np.asarray(t) - k['t0']) * 24; return untan(k['p'][0] + k['v'][0] * dt, k['p'][1] + k['v'][1] * dt, *FIELDS[field][1:3])


# ---------- 3. label ----------
def skybot(E, field):
    """Known objects near each burst from SkyBoT (cached). Returns name -> dict(V, rate, list of (t, ra, dec) per exposure)."""
    d = f'{CACHE}/{field}/skybot'; os.makedirs(d, exist_ok=True); bursts = sorted({e['burst'] for e in E})
    def one(b):
        es = [e for e in E if e['burst'] == b]; t = float(np.mean([e['t'] for e in es])); f = f'{d}/burst{b:02d}.txt'
        ra, dec = es[0]['w'].all_pix2world(1020, 1020, 0)
        if not os.path.exists(f):
            for k in range(3):
                try:
                    r = requests.get('https://ssp.imcce.fr/webservices/skybot/api/conesearch.php', timeout=300, params={
                        '-ep': t + 2400000.5, '-ra': float(ra), '-dec': float(dec), '-rd': 2.7, '-mime': 'text', '-output': 'all', '-loc': '500', '-filter': 120, '-objFilter': '111', '-from': 'detector-eval'})
                    if r.ok and '# Num' in r.text or 'No solar system object' in r.text: open(f, 'w').write(r.text); break
                except Exception as err: pass
                time.sleep(3)
            else: return b, t, None
        rows = []
        for ln in open(f):
            c = [q.strip() for q in ln.split('|')]
            if ln.startswith('#') or len(c) < 12: continue
            h, m, s = map(float, c[2].split()); sg = -1 if c[3].startswith('-') else 1; dd, dm, ds = map(float, c[3].replace('+', '').replace('-', '').split())
            try: rows.append((c[1], 15 * (h + m / 60 + s / 3600), sg * (dd + dm / 60 + ds / 3600), float(c[5]), float(c[8]), float(c[9]), c[4]))
            except ValueError: pass
        return b, t, rows
    with ThreadPoolExecutor(3) as ex: res = list(ex.map(one, bursts))
    K = {}
    for b, tb, rows in res:
        for name, ra, dec, V, dra, ddec, cls in rows or []:
            o = K.setdefault(name, dict(V=V, rate=float(np.hypot(dra, ddec)), cls=cls, pos=[]))
            for i, e in enumerate(E):
                if e['burst'] == b:
                    dt = (e['t'] - tb) * 24; o['pos'].append((i, e['t'], ra + dra * dt / 3600 / np.cos(np.radians(dec)), dec + ddec * dt / 3600))
    return K, [b for b, _, rows in res if rows is None]

def depth(E, P):
    """5 sigma point-source depth (AB mag) from the measured noise and the PSF, not from what was found."""
    c = P.shape[0] // 2; frac = np.mean([P[c - 3 + a:c + 6 + a:3, c - 3 + b:c + 6 + b:3].sum() for a in (-1, 0, 1) for b in (-1, 0, 1)])
    return float(mag(SNR_MIN * 3 * np.median([e['sig'] for e in E]) / frac)), float(frac)

def expected(E, K, mlim, field):
    """The frozen list for check 1: SkyBoT objects on usable pixels at 3+ distinct times, in the rate range, above the depth.
    V - 0.3 is the assumed AB mag near 0.9 micron (solar colour). Every exclusion keeps its reason."""
    out = []
    for name, o in K.items():
        use = [(i, t, ra, dec) for i, t, ra, dec in o['pos'] if np.isfinite(sample(E[i], np.array([ra]), np.array([dec]))[0][0])]
        why = ('no magnitude given' if o['V'] <= 0 else 'fewer than 3 usable times' if len(use) < 3 else 'rate outside 5 to 300' if not RATE_MIN <= o['rate'] <= RATE_MAX
               else 'fainter than the depth' if o['V'] - 0.3 > mlim else '')
        out.append(dict(name=name, V=o['V'], rate=o['rate'], cls=o['cls'], n_times=len(use), eligible=why == '', excluded=why, pos=use))
    return out

def match_known(k, D, K, E):
    """Name of the SkyBoT object under 3+ of the track's detections (within 15 arcsec), else None."""
    best = (0, None)
    for name, o in K.items():
        pos = {i: (ra, dec) for i, _, ra, dec in o['pos']}; n = 0
        for q in k['idx']:
            if D['e'][q] in pos:
                ra, dec = pos[D['e'][q]]; n += np.hypot((ra - D['ra'][q]) * np.cos(np.radians(dec)), dec - D['dec'][q]) * 3600 < 15
        if n > best[0]: best = (n, name)
    return best[1] if best[0] >= min(3, k['n']) else None

_d4 = {}
def d4_cut(field, obs, ra, dec, H=10):
    """Cutout of the paired detector (D4, same instant) around a sky position, and its box SNR there. None if unavailable."""
    if field not in _d4: _d4[field] = {e['obs']: e for e in images(field, 'D4')}
    e = _d4[field].get(obs)
    if not e: return None
    try:
        h = fits.open(S3 + e['key'], use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 16}); x, y = (float(v) for v in WCS(h['IMAGE'].header).all_world2pix(ra, dec, 0)); xi, yi = int(round(x)), int(round(y))
        if not (H <= xi < 2040 - H and H <= yi < 2040 - H): return None
        im = np.array(h['IMAGE'].section[yi - H:yi + H + 1, xi - H:xi + H + 1], float); im -= np.nanmedian(im); sd = 1.4826 * np.nanmedian(np.abs(im))
        return im, float(np.nansum(im[H - 1:H + 2, H - 1:H + 2]) / (3 * sd))
    except Exception: return None

def cut(e, x, y, H=10):
    out = np.full((2 * H + 1, 2 * H + 1), np.nan)
    if not np.isfinite(x + y): return out
    im = np.load(e['path'] + '.img.npy', mmap_mode='r'); xi, yi = int(round(x)), int(round(y))
    y0, y1, x0, x1 = max(yi - H, 0), min(yi + H + 1, 2040), max(xi - H, 0), min(xi + H + 1, 2040)
    if y1 > y0 and x1 > x0: out[y0 - yi + H:y1 - yi + H, x0 - xi + H:x1 - xi + H] = im[y0:y1, x0:x1]
    return out - np.nanmedian(out)

def strip(path, title, panels):
    """panels: list of (label, D1 cutout, D4 cutout or None, ring offset (dx, dy) or None, found). One column per photo."""
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    n = len(panels); fig, ax = plt.subplots(2, n, figsize=(1.7 * n + 0.6, 4.1), squeeze=False, facecolor='#0b0d12')
    for j, (lab, a, b, ring, found) in enumerate(panels):
        for r, im in enumerate((a, b)):
            q = ax[r][j]; q.set_xticks([]); q.set_yticks([]); q.set_facecolor('#0b0d12')
            if im is not None and np.isfinite(im).any():
                s = 1.4826 * np.nanmedian(np.abs(im)) + 1e-9; q.imshow(im, origin='lower', cmap='gray', vmin=-2 * s, vmax=12 * s, interpolation='nearest')
                if ring is not None: q.add_patch(plt.Circle((im.shape[1] // 2 + ring[0], im.shape[0] // 2 + ring[1]), 2.6, fill=False, lw=1.2, color='#ffb000' if found or r else '#ff5050', ls='-' if found or r else ':'))
            else: q.text(0.5, 0.5, 'no data', color='#888', ha='center', va='center', transform=q.transAxes, fontsize=7)
            if r == 0: q.set_title(lab, color='#ddd', fontsize=7)
        ax[0][0].set_ylabel('D1', color='#ddd', fontsize=8); ax[1][0].set_ylabel('D4, same instant', color='#ddd', fontsize=8)
    fig.suptitle(title, color='#fff', fontsize=9); fig.tight_layout(); fig.savefig(path, dpi=110, facecolor=fig.get_facecolor()); plt.close(fig)

def track_strip(path, title, k, E, D, field, extra=0):
    """Evidence strip for a track: each photo that should show it (up to 10), the predicted spot ringed, D4 below."""
    t = np.array([e['t'] for e in E]); hit = {int(D['e'][q]): q for q in k['idx']}; ts = t[sorted(hit)]
    need = [i for i in range(len(E)) if ts.min() - 1e-6 <= t[i] <= ts.max() + 1e-6][:10]; ra, dec = predict(k, t[need], field); panels, d4s = [], []
    def one(a):
        i, r, d = a; _, _, x, y = sample(E[i], np.array([r]), np.array([d])); c4 = d4_cut(field, E[i]['obs'], r, d)
        return (f"{E[i]['obs'][-9:]}\n+{(t[i] - ts.min()) * 24:.2f} h", cut(E[i], x[0], y[0]), c4[0] if c4 else None, (x[0] - np.round(x[0]), y[0] - np.round(y[0])), i in hit), (c4[1] if c4 else None, i in hit)
    with ThreadPoolExecutor(8) as ex: res = list(ex.map(one, zip(need, ra, dec)))
    strip(path, title, [r[0] for r in res]); v = [s for s, h in (r[1] for r in res) if s is not None and h]
    return (float(np.sum(v) / np.sqrt(len(v))) if v else None)

def spot_strip(path, title, E, field, ra, dec, i_hit):
    """Evidence strip for one rejected detection: the photo it was in plus up to 7 other looks at the same sky spot."""
    looks = [i for i, e in enumerate(E) if sample(e, ra, dec)[1][0]]; looks = sorted(sorted(looks, key=lambda i: abs(i - i_hit))[:8])
    def one(i):
        _, _, x, y = sample(E[i], ra, dec); c4 = d4_cut(field, E[i]['obs'], ra, dec)
        return (f"{E[i]['obs'][-9:]}\n{(E[i]['t'] - E[i_hit]['t']) * 24:+.2f} h", cut(E[i], x[0], y[0]), c4[0] if c4 else None, (x[0] - np.round(x[0]), y[0] - np.round(y[0])), i == i_hit), (c4[1] if c4 else None, i == i_hit)
    with ThreadPoolExecutor(8) as ex: res = list(ex.map(one, looks))
    strip(path, title, [r[0] for r in res]); v = [s for s, h in (r[1] for r in res) if h]
    return v[0] if v else None

def star_psf(E, D):
    """Effective PSF from bright, clean, isolated field stars of the middle exposure, on a grid 3x finer than a pixel."""
    i = len(E) // 2; k = np.nonzero((D['e'] == i) & (D['snr'] > 60) & (D['snr'] < 1500) & ~D['flagged'] & (D['sharp'] < SHARP_MAX))[0]
    im = np.load(E[i]['path'] + '.img.npy'); R = 4; n = 3 * (2 * R + 1); acc, cnt = np.zeros((n, n)), np.zeros((n, n)); used = 0
    for q in k:
        x, y = D['x'][q], D['y'][q]; xi, yi = int(round(x)), int(round(y))
        if not (8 <= xi < 2032 and 8 <= yi < 2032) or np.sum(np.hypot(D['x'][k] - x, D['y'][k] - y) < 8) > 1: continue
        c = im[yi - 7:yi + 8, xi - 7:xi + 8].astype(float); c = c - np.nanmedian(c); core = c[7 - R:8 + R, 7 - R:8 + R]
        if not np.isfinite(core).all(): continue
        tot = core[R - 2:R + 3, R - 2:R + 3].sum(); used += 1
        for j in range(2 * R + 1):
            for l in range(2 * R + 1):
                a, b = int(round((yi - R + j - y) * 3)) + n // 2, int(round((xi - R + l - x) * 3)) + n // 2
                if 0 <= a < n and 0 <= b < n: acc[a, b] += core[j, l] / tot; cnt[a, b] += 1
    P = np.where(cnt > 0, acc / np.maximum(cnt, 1), 0); P = np.clip(ndi.uniform_filter(P, 2), 0, None); P /= P.sum() / 9
    return P, used

def guess(rate): return 'near-Earth' if rate > 120 else 'main belt' if rate >= 12 else 'beyond Jupiter'

def run(field):
    """Baseline run on real data: candidates_<field>.json, expected_<field>.json (frozen before linking), strips."""
    t0 = time.time(); E, D = detect(field); P, nstar = star_psf(E, D); mlim, frac = depth(E, P); np.save(f'{CACHE}/{field}/psf.npy', P)
    K, failed = skybot(E, field); X = expected(E, K, mlim, field)
    json.dump(dict(field=field, depth_ab=mlim, skybot_failed_bursts=failed, objects=X), open(f'{OUT}/expected_{field}.json', 'w'))   # frozen here
    tracks, st = link(E, D, field); rng = np.random.default_rng(1); _, sh = link(E, D, field, times=rng.permutation([e['t'] for e in E]))
    os.makedirs(f'{OUT}/strips', exist_ok=True); cands = []
    for n, k in enumerate(tracks):
        name = match_known(k, D, K, E); k['known'] = name; k['id'] = f"{field}-{n + 1:03d}"
        k['d4'] = track_strip(f"{OUT}/strips/{k['id']}.png", f"{k['id']}  {name or 'unmatched candidate'}  {k['rate']:.0f} arcsec/hr  PA {k['pa']:.0f}  {k['n']} of {k['n_total']} photos", k, E, D, field)
        k['score'] = round(float(0.4 * min(k['n'] / 6, 1) + 0.3 * min(k['snr'] / 15, 1) + 0.2 * (1 - k['rms'] / TOL) + 0.1 * bool(k['d4'] and k['d4'] >= 3)), 3)
        k['detections'] = [dict(t=float(D['t'][q]), ra=float(D['ra'][q]), dec=float(D['dec'][q]), det='D1', flux_mjy=float(D['s'][q] * JY * 1e3), snr=float(D['snr'][q]), obs=E[D['e'][q]]['obs'], flags=int(D['flags'][q])) for q in k['idx']]
        cands.append(k)
    stages = {w or 'orphan': int(np.sum(D['why'] == w)) for w in ('flag', 'shape', 'persist', 'star', 'unverifiable', '')}
    json.dump(dict(field=field, label=FIELDS[field][0], ra=FIELDS[field][1], dec=FIELDS[field][2], version=VERSION, exposures=len(E), bursts=len({e['burst'] for e in E}), depth_ab=mlim, psf_stars=nstar, psf_box_fraction=frac,
                   stage_counts=dict(detections=len(D['x']), **stages, **st), shuffled_time=sh, tracks=cands), open(f'{OUT}/candidates_{field}.json', 'w'), indent=1)
    print(field, 'exposures', len(E), 'depth', round(mlim, 2), 'psf stars', nstar, 'box frac', round(frac, 2), stages, st, 'shuffled', sh, 'known', sum(1 for k in cands if k['known']), 'eligible', sum(o['eligible'] for o in X), 'skybot failed', failed, f'{time.time() - t0:.0f}s')
    return E, D, K, X, tracks

if __name__ == '__main__':
    {'prep': prep, 'run': run}[sys.argv[1]](sys.argv[2])
