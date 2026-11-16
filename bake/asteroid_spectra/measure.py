"""A known asteroid's SPHEREx reflectance spectrum, stacked at its predicted positions, with null stacks.

Implements bake/asteroid_spectra/test.md (the frozen test) for the asteroids in OUTDIR/selection.json:
MOST exposures (from select.py) -> Horizons positions and geometry -> 360" cutouts -> forced ePSF photometry at the
asteroid and at three null positions -> star rejection (Gaia DR3, 2MASS) -> geometry and solar normalisation ->
per-burst rotation factors -> 102-channel stacks -> pass bars, a PNG and a JSON per asteroid.

Run: uv run -q --with astropy --with scipy --with matplotlib --with pillow --with reproject --with certifi \
       sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python -u bake/asteroid_spectra/measure.py OUTDIR SLOT [SLOT ...]'
"""
import csv, io, json, logging, math, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from flipbook import get   # retries IRSA's intermittent errors
from choose import most   # same MOST parsing as the selection

logging.getLogger("astropy").setLevel(logging.ERROR)   # SIP without "-SIP" in SPHEREx headers
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else None
SIZE = 360                         # cutout, arcsec
PIX = 6.15                         # arcsec
K = (PIX / 206265) ** 2 * 1e9      # MJy/sr per pixel -> mJy
R_FIT, R_IN, R_OUT = 3, 5, 9       # pixels
MASK = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 27, 28, 29))   # never bit 21 (SOURCE)
assert not MASK & (1 << 21)
BANDS = [(0.744, 1.116), (1.099, 1.651), (1.636, 2.421), (2.423, 3.822), (3.809, 4.420), (4.412, 5.002)]
THERMAL = 3.5                      # um
NULL_R = 50.0                      # arcsec
EXPECT = {"S": "S-like", "V": "S-like", "C": "C-like", "X": "C-like"}


# ---------- channels ----------

def channel(det, lam):
    """Global channel index 0-101 for an image on detector `det` (1-6) at wavelength `lam` (um)."""
    lo, hi = BANDS[det - 1]
    k = int(np.floor(17 * np.log(lam / lo) / np.log(hi / lo)))
    return 17 * (det - 1) + min(16, max(0, k))


CH_LAM = np.array([BANDS[c // 17][0] * (BANDS[c // 17][1] / BANDS[c // 17][0]) ** ((c % 17 + 0.5) / 17) for c in range(102)])
CH_WID = np.array([np.log(BANDS[c // 17][1] / BANDS[c // 17][0]) / 17 for c in range(102)])   # in ln(lambda)
assert channel(1, 0.744) == 0 and channel(1, 1.116) == 16 and channel(6, 5.0) == 101 and channel(6, 4.9) == 99 and channel(2, 1.10) == 17
assert abs(CH_LAM[0] - 0.7526) < 1e-3 and np.all(np.diff(CH_LAM[:17]) > 0)


# ---------- ephemeris ----------

def horizons(num, mjds, cache):
    """RA, Dec (deg), RA/Dec rates (arcsec/h), r, delta (au), phase (deg) seen from SPHEREx at each MJD."""
    f = cache / "horizons.json"
    have = json.loads(f.read_text()) if f.exists() else {}
    jds = [f"{m + 2400000.5:.6f}" for m in mjds]
    need = sorted(set(jds) - set(have))
    batches = [need[i:i + 40] for i in range(0, len(need), 40)]
    batches = [b2 for b in batches for b2 in ([b[:1], b[1:]] if len(b) == 2 else [b])]   # a two-time list reads as start, stop
    for batch in batches:
        p = {"format": "json", "COMMAND": f"'{num};'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
             "CENTER": "'500@-163182'", "TLIST": "'" + " ".join(batch) + "'", "TLIST_TYPE": "'JD'",
             "QUANTITIES": "'1,3,19,20,24'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'", "EXTRA_PREC": "'YES'"}
        text = json.loads(get("https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(p)).decode())["result"]
        assert "$$SOE" in text, text[-400:]
        lines = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
        assert len(lines) == len(batch), (len(lines), len(batch))
        for j, l in zip(batch, lines):
            v = [s.strip() for s in l.split(",")]
            have[j] = [float(v[3]), float(v[4]), float(v[5]), float(v[6]), float(v[7]), float(v[9]), float(v[11])]
        f.write_text(json.dumps(have))
    return [have[j] for j in jds]


# ---------- photometry ----------

def psf_fn(epsf):
    """Native-pixel PSF value at offsets (dx, dy) from the centre: the ePSF is pixel-convolved and 5x oversampled."""
    return lambda dx, dy: 25 * map_coordinates(epsf, [16 + 5 * np.asarray(dy), 16 + 5 * np.asarray(dx)], order=3, cval=0.0)


def phot(img, var, usable, P, x, y):
    """Forced PSF flux at (x, y): (mJy, noise mJy, reduced chi2) or None (too much masked, too little sky)."""
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - x, yy - y)
    fit, ring = r <= R_FIT, (r >= R_IN) & (r <= R_OUT) & usable
    if ring.sum() < 50 or fit.sum() < 20:
        return None
    m_all = P(xx[fit] - x, yy[fit] - y)
    good = usable[fit]
    if m_all[~good].sum() > 0.2 * m_all.sum() or good.sum() < 5:
        return None
    sky = float(np.median(img[ring]))
    sky_err = 1.2533 * 1.4826 * float(np.median(np.abs(img[ring] - sky))) / np.sqrt(ring.sum())
    m, d, w = m_all[good], img[fit][good] - sky, 1 / var[fit][good]
    a = float((w * m * m).sum())
    flux = float((w * m * d).sum()) / a
    chi2 = float((w * (d - flux * m) ** 2).sum()) / max(1, good.sum() - 1)
    noise = math.hypot(1 / math.sqrt(a), sky_err * float((w * m).sum()) / a) * max(1.0, math.sqrt(chi2))
    return flux * K, noise * K, chi2


def _check_phot():
    """A synthetic Gaussian star of 2 mJy on a flat sky with unit-ish noise is recovered, and its error is honest."""
    g = lambda dx, dy: np.exp(-(np.asarray(dx) ** 2 + np.asarray(dy) ** 2) / (2 * 0.6 ** 2)) / (2 * np.pi * 0.6 ** 2)
    rng = np.random.default_rng(1)
    yy, xx = np.indices((41, 41))
    fl = []
    for _ in range(300):
        img = 5 + (2 / K) * g(xx - 20.3, yy - 19.8) + rng.normal(0, 0.05, (41, 41))
        fl.append(phot(img, np.full((41, 41), 0.05 ** 2), np.ones((41, 41), bool), g, 20.3, 19.8))
    f = np.array([v[0] for v in fl]); e = np.array([v[1] for v in fl])
    assert abs(f.mean() - 2) < 3 * f.std() / np.sqrt(len(f)), f.mean()
    assert 0.85 < f.std() / e.mean() < 1.15, (f.std(), e.mean())
    usable = np.ones((41, 41), bool); usable[18:23, 18:23] = False
    assert phot(img, np.full((41, 41), 0.05 ** 2), usable, g, 20.3, 19.8) is None   # core masked


_check_phot()


def offsets(ra, dec, rate_ra, rate_dec):
    """The three null positions, 50 arcsec off: perpendicular both sides, and 45 degrees between motion and side 1."""
    m = np.array([rate_ra, rate_dec]) / (math.hypot(rate_ra, rate_dec) or 1)   # (east, north)
    p = np.array([-m[1], m[0]])
    out = []
    for v in (p, -p, (m + p) / math.sqrt(2)):
        e, n = NULL_R * v
        out.append((ra + e / 3600 / math.cos(math.radians(dec)), dec + n / 3600))
    return out


def measure(e, cache, num):
    """Cut out, reduce to a small FITS (the full cutout carries a 4 MB PSF table), measure asteroid and nulls."""
    f = cache / "img" / f"{e['obs']}_{e['det']}.fits"
    try:
        return _measure(e, f)
    except Exception as err:   # a broken download or file: this image is simply not measured
        print(f"  {e['obs']} {e['det']}: {str(err)[:100]}", flush=True)
        return dict(e, lam=np.nan, bw=np.nan, fwhm=np.nan, x=np.nan, y=np.nan, ast=None, nulls=[dict(m=None)] * 3, error=str(err)[:200])


def _measure(e, f):
    if not f.exists():
        data = get(f"https://irsa.ipac.caltech.edu/{e['uri']}?center={e['ra']},{e['dec']}&size={SIZE}arcsec")
        assert data[:6] == b"SIMPLE", data[:80]
        with fits.open(io.BytesIO(data)) as h:
            wa = WCS(h["IMAGE"].header, key="A")
            x, y = WCS(h["IMAGE"].header).world_to_pixel_values(e["ra"], e["dec"])
            dx, dy = wa.pixel_to_world_values(x, y)
            t = h["EPSF"].data
            j = int(np.argmin((t["XCENTER"] - dx) ** 2 + (t["YCENTER"] - dy) ** 2))
            ps = fits.ImageHDU(np.asarray(t["EPSF"][j], dtype=np.float64), name="PSF")
            ps.header["CWAVE"] = float(t["CWAVE"][j])
            fits.HDUList([fits.PrimaryHDU(), h["IMAGE"], h["FLAGS"], h["VARIANCE"], h["WCS-WAVE"], ps]).writeto(f, overwrite=True)
    with fits.open(f) as h:
        img = h["IMAGE"].data.astype(float)
        var = h["VARIANCE"].data.astype(float)
        flags = h["FLAGS"].data.astype(np.int64)
        usable = np.isfinite(img) & np.isfinite(var) & (var > 0) & ((flags & MASK) == 0)
        hdr = h["IMAGE"].header
        w = WCS(hdr)
        x, y = (float(v) for v in w.world_to_pixel_values(e["ra"], e["dec"]))
        spectral = WCS(hdr, fobj=h, key="W")
        spectral.sip = None   # IRSA: SIP distortion must be off for the spectral WCS
        lam, bw = (float(v) for v in spectral.pixel_to_world_values(x, y))
        P = psf_fn(h["PSF"].data)
        fwhm = float(hdr.get("PSF_FWHM", 8.0))
    res = dict(e, lam=lam, bw=bw, fwhm=fwhm, x=x, y=y)
    m = phot(img, var, usable, P, x, y)
    res["ast"] = list(m) if m else None
    yy, xx = np.indices(img.shape)
    u2 = usable & (np.hypot(xx - x, yy - y) > 5)   # the asteroid masked for the nulls
    res["nulls"] = []
    for nra, ndec in offsets(e["ra"], e["dec"], e["rate_ra"], e["rate_dec"]):
        nx, ny = (float(v) for v in w.world_to_pixel_values(nra, ndec))
        mm = phot(img, var, u2, P, nx, ny)
        res["nulls"].append(dict(ra=nra, dec=ndec, m=list(mm) if mm else None))
    return res


# ---------- stars ----------

def vizier(src, cols, ra, dec, rad):
    # the CfA mirror: on 2026-11-16 vizier.cds.unistra.fr answered every query with an HTML "unavailable" page
    url = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?" + urllib.parse.urlencode(
        {"-source": src, "-c": f"{ra:.6f} {dec:+.6f}", "-c.rs": f"{rad:.1f}", "-out": ",".join(cols), "-out.max": "unlimited"})
    rows, text = [], get(url).decode("latin-1")
    assert "#RESOURCE" in text and "VizieR" in text, f"not a VizieR answer: {text[:200]}"   # an error page is not "no stars"
    for l in text.splitlines():
        if not l.strip() or l.startswith("#"):
            continue
        v = l.split("\t")
        if len(v) != len(cols):
            continue
        try:
            rows.append([float(s) if s.strip() else np.nan for s in v])
        except ValueError:   # header and unit lines
            continue
    return np.array(rows).reshape(-1, len(cols))


def stars_near(ra, dec, mjd, cache, key):
    """Stars within 120" of (ra, dec) at date mjd: arrays ra, dec and AB magnitudes in G, J, H, Ks (nan if absent)."""
    f = cache / "stars" / f"{key}.json"
    if f.exists():
        return {k: np.array([np.nan if x is None else x for x in v], float) for k, v in json.loads(f.read_text()).items()}
    g = vizier("I/355/gaiadr3", ["RA_ICRS", "DE_ICRS", "pmRA", "pmDE", "Gmag"], ra, dec, 120)
    t = vizier("II/246/out", ["RAJ2000", "DEJ2000", "Jmag", "Hmag", "Kmag"], ra, dec, 120)
    yr = (mjd - 57388.5) / 365.25   # Gaia DR3 positions are for 2016.0
    gra = g[:, 0] + np.nan_to_num(g[:, 2]) * yr / 3.6e6 / np.cos(np.radians(g[:, 1]))
    gde = g[:, 1] + np.nan_to_num(g[:, 3]) * yr / 3.6e6
    S = dict(ra=list(gra), dec=list(gde), G=list(g[:, 4] + 0.12), J=[np.nan] * len(g), H=[np.nan] * len(g), K=[np.nan] * len(g))
    for r in t:
        d = np.hypot((np.array(S["ra"][:len(g)]) - r[0]) * np.cos(np.radians(dec)), np.array(S["dec"][:len(g)]) - r[1]) * 3600
        i = int(np.argmin(d)) if len(g) else -1
        mags = (r[2] + 0.91, r[3] + 1.39, r[4] + 1.85)   # 2MASS Vega -> AB
        if i >= 0 and d[i] < 2:
            S["J"][i], S["H"][i], S["K"][i] = mags
        else:
            for k, v in zip("ra dec G J H K".split(), (r[0], r[1], np.nan) + mags):
                S[k].append(v)
    S = {k: np.array(v, float) for k, v in S.items()}
    f.write_text(json.dumps({k: [None if not np.isfinite(x) else float(x) for x in v] for k, v in S.items()}))
    return {k: np.array([np.nan if x is None else x for x in v], float) for k, v in S.items()}


def star_flux(S, lam):
    """Each star's flux (mJy) at lam from its nearest catalogue band; Rayleigh-Jeans past Ks, flat f_nu from G alone."""
    lams = np.array([0.62, 1.235, 1.662, 2.159])
    m = np.stack([S["G"], S["J"], S["H"], S["K"]], 1)
    order = np.argsort(np.abs(np.log(lams / lam)))
    out = np.full(len(m), np.nan)
    for i in order:
        take = np.isnan(out) & np.isfinite(m[:, i])
        mag = m[take, i] + (5 * np.log10(lam / 2.159) if lams[i] == 2.159 and lam > 2.159 else 0.0)
        if lams[i] == 0.62 and lam > 2.159:
            mag = mag + 5 * np.log10(lam / 2.159)
        out[take] = 3631e3 * 10 ** (-0.4 * mag)
    return np.nan_to_num(out)


def contaminated(S, ra, dec, lam, fwhm, noise):
    if not len(S["ra"]):
        return False
    d = np.hypot((S["ra"] - ra) * np.cos(np.radians(dec)), S["dec"] - dec) * 3600
    F = star_flux(S, lam)
    s = fwhm / 2.355
    leak = (F * np.exp(-d ** 2 / (4 * s ** 2)))[d < R_IN * PIX].sum()
    ring = (d >= R_IN * PIX) & (d <= R_OUT * PIX) & (F > 10 * noise)
    return bool(leak > 0.3 * noise or ring.any())


# ---------- normalisation ----------

def sun():
    """Solar f_nu (arbitrary units) vs wavelength (um): CALSPEC STIS to 2.5 um, the Kurucz model beyond, joined at 2.4-2.5."""
    d = OUT / "cache" / "sun"
    s = fits.open(d / "sun_reference_stis_002.fits")[1].data
    k = fits.open(d / "sun_mod_001.fits")[1].data
    ws, fs = s["WAVELENGTH"] / 1e4, s["FLUX"]
    wk, fk = k["WAVELENGTH"] / 1e4, k["FLUX"]
    band = lambda w, lo, hi: (w >= lo) & (w <= hi)
    scale = np.median(fs[band(ws, 2.4, 2.5)]) / np.median(np.interp(ws[band(ws, 2.4, 2.5)], wk, fk))
    sel = band(wk, 2.5, 5.5)
    w = np.concatenate([ws[band(ws, 0.5, 2.5)], wk[sel]])
    fl = np.concatenate([fs[band(ws, 0.5, 2.5)], fk[sel] * scale])
    return w, fl * w ** 2   # f_lambda -> f_nu, up to a constant


def sun_at(SUN, lam, bw):
    w, fnu = SUN
    s = bw / 2.355
    sel = np.abs(w - lam) < 4 * s
    g = np.exp(-(w[sel] - lam) ** 2 / (2 * s ** 2))
    return float((g * fnu[sel]).sum() / g.sum())


def phase_hg(alpha, G):
    t = math.tan(math.radians(alpha) / 2)
    return (1 - G) * math.exp(-3.33 * t ** 0.63) + G * math.exp(-1.87 * t ** 1.22)


# ---------- stacking ----------

def wmean(v, e):
    """Inverse-variance mean and error; error scaled by sqrt(reduced chi2) when above 1 and n >= 3."""
    v, e = np.asarray(v, float), np.asarray(e, float)
    w = 1 / e ** 2
    m = float((w * v).sum() / w.sum())
    s = float(1 / math.sqrt(w.sum()))
    if len(v) >= 3:
        s *= max(1.0, math.sqrt(float((w * (v - m) ** 2).sum()) / (len(v) - 1)))
    return m, s


def stack(ch, v, e):
    out = {}
    for c in sorted(set(ch)):
        i = [k for k, x in enumerate(ch) if x == c]
        m, s = wmean([v[k] for k in i], [e[k] for k in i])
        out[c] = (m, s, len(i))
    return out


def bursts(t):
    """Burst label per image: chains of images less than 10 minutes apart."""
    order = np.argsort(t)
    lab, b, last = np.zeros(len(t), int), -1, None
    for i in order:
        if last is None or t[i] - last > 10 / 1440:
            b += 1
        lab[i], last = b, t[i]
    return lab


def rotation(R, sR, lam, ch, lab):
    """Per-burst factor A (test.md step 7). Returns A, sigma_A per image, and the rotation scatter used for the rest."""
    nb = lab.max() + 1
    A, sA, has = np.ones(nb), np.zeros(nb), np.zeros(nb, bool)
    refl = lam < THERMAL
    loglam = np.log(lam)
    wid = CH_WID[ch]
    for _ in range(5):
        Rc = R / A[lab]
        sRc = sR / A[lab]
        newA, newS, newH = np.ones(nb), np.zeros(nb), np.zeros(nb, bool)
        for k in range(nb):
            mem = np.where((lab == k) & refl & (R / sR >= 5))[0]
            q, sq = [], []
            for i in mem:
                o = np.where((lab != k) & refl & (np.abs(loglam - loglam[i]) <= 2 * wid[i]))[0]
                if not len(o):
                    continue
                S, sS = wmean(Rc[o], sRc[o])
                if S <= 0:
                    continue
                q.append(R[i] / S)
                sq.append(math.hypot(sR[i] / S, R[i] * sS / S ** 2))
            if q:
                newA[k], newS[k] = wmean(q, sq)
                newH[k] = True
        if newH.any():
            newA[newH] /= math.exp(np.mean(np.log(newA[newH])))
        A, sA, has = newA, newS, newH
    sig_rot = float(np.std(np.log(A[has]))) if has.sum() >= 4 else 0.10
    return A, sA, has, sig_rot


# ---------- the measures behind the bars ----------

def slope(lams, R, sR):
    """b / a (per um) and its error from a weighted straight-line fit a + b (lambda - 0.875)."""
    x = np.asarray(lams) - 0.875
    w = 1 / np.asarray(sR) ** 2
    Am = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]])
    cov = np.linalg.inv(Am)
    a, b = cov @ np.array([(w * R).sum(), (w * x * R).sum()])
    s = abs(b / a) * math.sqrt(cov[1, 1] / b ** 2 + cov[0, 0] / a ** 2 - 2 * cov[0, 1] / (a * b)) if b else math.sqrt(cov[1, 1]) / abs(a)
    return float(b / a), float(s)


assert abs(slope([0.75, 0.8, 0.9, 1.0], [1 + 0.2 * (l - 0.875) for l in (0.75, 0.8, 0.9, 1.0)], [0.01] * 4)[0] - 0.2) < 1e-9


def band_depth(st):
    """D = 1 - Rb / Rc (test.md bar d) from channel stacks {ch: (R, sR, n)}, with a Monte Carlo error."""
    def mean_in(lo, hi, draw):
        cs = [c for c in st if lo <= CH_LAM[c] <= hi and CH_LAM[c] < THERMAL]
        if not cs:
            return None
        return float(np.average([draw[c] for c in cs], weights=[1 / st[c][1] ** 2 for c in cs]))
    rng = np.random.default_rng(0)
    out = []
    for i in range(400):
        draw = {c: v[0] + (rng.normal(0, v[1]) if i else 0) for c, v in st.items()}
        b, c1, c2 = mean_in(0.88, 1.00, draw), mean_in(0.75, 0.80, draw), mean_in(1.45, 1.65, draw)
        if None in (b, c1, c2):
            return None, None
        rc = c1 + (c2 - c1) * (0.94 - 0.775) / (1.55 - 0.775)
        out.append(1 - b / rc)
    return float(out[0]), float(np.std(out[1:]))


# ---------- one asteroid ----------

def run(pick):
    num = pick["num"]
    cache = OUT / "cache" / f"a{num}"
    for d in ("img", "stars"):
        (cache / d).mkdir(parents=True, exist_ok=True)
    rows = {}
    for r in most(num):   # DR1 and QR3 only; DR1 first wins a duplicate
        rows.setdefault((r["observationid"], r["productid"]), r)
    rows = sorted(rows.values(), key=lambda r: float(r["mjd_start"]))
    mids = [(float(r["mjd_start"]) + float(r["mjd_end"])) / 2 for r in rows]
    eph = horizons(num, mids, cache)
    ex = [dict(obs=r["observationid"], det=r["productid"], uri=r["uri"], t=t, ra=p[0], dec=p[1], rate_ra=p[2], rate_dec=p[3],
               r=p[4], delta=p[5], alpha=p[6]) for r, t, p in zip(rows, mids, eph)]
    pts_f = cache / "points.json"
    if pts_f.exists():
        pts = json.loads(pts_f.read_text())
    else:
        with ThreadPoolExecutor(4) as pool:
            pts = list(pool.map(lambda e: measure(e, cache, num), ex))
        pts_f.write_text(json.dumps(pts))
    print(f"{pick['slot']} ({num}) {pick['name']}: {len(ex)} images, {sum(p['ast'] is not None for p in pts)} measurable", flush=True)

    # stars, one catalogue query per burst
    t = np.array([p["t"] for p in pts])
    lab = bursts(t)
    for k in range(lab.max() + 1):
        mem = [p for p, l in zip(pts, lab) if l == k]
        ra0, de0 = np.median([p["ra"] for p in mem]), np.median([p["dec"] for p in mem])
        S = stars_near(ra0, de0, mem[0]["t"], cache, f"burst{k}_{mem[0]['obs']}")
        for p in mem:
            p["star_ast"] = p["ast"] is not None and contaminated(S, p["ra"], p["dec"], p["lam"], p["fwhm"], p["ast"][1])
            for n in p["nulls"]:
                n["star"] = n["m"] is not None and contaminated(S, n["ra"], n["dec"], p["lam"], p["fwhm"], n["m"][1])

    # keep: measured, not star-contaminated
    keep = [p for p in pts if p["ast"] is not None and not p["star_ast"]]
    if not keep:   # nothing measurable (Vesta: every core masked): every bar fails
        none = dict(a=dict(channels_snr5=0, refl_channels_snr5=0, channels_with_data=0, pass_=False),
                    b=dict(null_channels=0, within3=0, broadband_z=[], pass_=False), c=None,
                    d=dict(D=None, sD=None, slope=[float("nan")] * 2, call=None, expected=EXPECT[pick["cx"]], pass_=False),
                    e=dict(single_snr_median=float("nan"), broadband_snr=float("nan"), **({"pass_": False} if pick["slot"] in ("F1", "F2") else {})),
                    spectrum=[], nulls=[[], [], []], rotation={})
        res = dict(slot=pick["slot"], num=num, name=pick["name"], cls=pick["cls"], src=pick["src"], cx=pick["cx"], pred_snr=pick["pred_snr"],
                   n_img=len(ex), n_measured=0, n_star_rejected=0, n_used=0, frozen=none, chain=none)
        (OUT / f"{pick['slot']}_{num}.json").write_text(json.dumps(res, indent=1))
        print(f"{pick['slot']} ({num}): nothing measurable", flush=True)
        return res
    G = float(pick["G"]) if pick.get("G") not in (None, "") else 0.15
    r0, d0, a0 = (float(np.median([p[k] for p in keep])) for k in ("r", "delta", "alpha"))
    SUN = sun()
    for p in keep:
        p["geo"] = (p["r"] * p["delta"] / (r0 * d0)) ** 2 * phase_hg(a0, G) / phase_hg(p["alpha"], G)
        p["sun"] = sun_at(SUN, p["lam"], p["bw"])
        p["ch"] = channel(int(p["det"][1]), p["lam"])
    lam = np.array([p["lam"] for p in keep])
    ch = np.array([p["ch"] for p in keep])
    tk = np.array([p["t"] for p in keep])
    geo = np.array([p["geo"] for p in keep])
    flux, sflux = np.array([p["ast"][0] for p in keep]) * geo, np.array([p["ast"][1] for p in keep]) * geo
    sunv = np.array([p["sun"] for p in keep])
    R, sR = flux / sunv, sflux / sunv

    # frozen method (test.md step 7): one factor per burst
    lab_k = bursts(tk)
    A, sA, has, sig_rot = rotation(R, sR, lam, ch, lab_k)
    Ai, sAi, hasi = A[lab_k], sA[lab_k], has[lab_k]
    frac_v1 = np.where(hasi, sAi / Ai, sig_rot)   # extra fractional error per image
    # after step 1 (not counted, see result.md): burst factors tied by spectral smoothness
    div2, frac2, info2 = chain(R, sR, ch, lab_k)
    gaia = gaia_spec(num)
    out = {}
    for name, div, frac in (("frozen", Ai, frac_v1), ("chain", div2, frac2)):
        out[name] = evaluate(pick, keep, R, sR, lam, ch, sunv, flux, sflux, div, frac, gaia)
    out["frozen"]["rotation"] = dict(n_bursts=int(lab_k.max() + 1), n_bursts_with_factor=int(has.sum()), sig_rot=sig_rot)
    out["chain"]["rotation"] = info2
    res = dict(slot=pick["slot"], num=num, name=pick["name"], cls=pick["cls"], src=pick["src"], cx=pick["cx"],
               pred_snr=pick["pred_snr"], n_img=len(ex), n_measured=sum(p["ast"] is not None for p in pts),
               n_star_rejected=sum(p["ast"] is not None and p["star_ast"] for p in pts), n_used=len(keep),
               geometry=dict(r=r0, delta=d0, alpha=a0, G=G), **out)
    (OUT / f"{pick['slot']}_{num}.json").write_text(json.dumps(res, indent=1, default=float))
    plot(res, gaia, OUT / f"{pick['slot']}_{num}.png")
    brief = lambda v: {k: v[k] for k in ("a", "b", "c", "d", "e", "rotation")}
    print(json.dumps(dict(slot=res["slot"], num=num, name=res["name"], cls=res["cls"], n_img=res["n_img"], n_used=res["n_used"],
                          frozen=brief(res["frozen"]), chain=brief(res["chain"])), default=float), flush=True)
    return res


def evaluate(pick, keep, R, sR, lam, ch, sunv, flux, sflux, div, frac, gaia):
    """Stacks, nulls and bars (a)-(e) for one way of dividing out rotation: image i is divided by div[i] and gets a
    fractional error frac[i] added."""
    Rc = R / div
    sRc = np.hypot(sR, np.abs(R) * frac) / div
    st = stack(list(ch), list(Rc), list(sRc))
    norm_ch = [c for c in st if 0.95 <= CH_LAM[c] <= 1.05]
    norm = wmean([st[c][0] for c in norm_ch], [st[c][1] for c in norm_ch])[0] if norm_ch else np.nan
    st_flux = stack(list(ch), list(flux / div), list(np.hypot(sflux, np.abs(flux) * frac) / div))
    nst, nbb = [], []
    for j in range(3):   # nulls: same images, same divisors
        use = [i for i, p in enumerate(keep) if p["nulls"][j]["m"] is not None and not p["nulls"][j]["star"]]
        v = np.array([keep[i]["nulls"][j]["m"][0] * keep[i]["geo"] / sunv[i] / div[i] for i in use])
        e = np.array([keep[i]["nulls"][j]["m"][1] * keep[i]["geo"] / sunv[i] / div[i] for i in use])
        nst.append(stack([int(ch[i]) for i in use], list(v), list(e)))
        bb = [k for k, i in enumerate(use) if lam[i] < 2.42]
        nbb.append(wmean(v[bb], e[bb]) if bb else (np.nan, np.nan))
    snr_ch = {c: v[0] / v[1] for c, v in st.items()}
    a_all = sum(s >= 5 for s in snr_ch.values())
    a_refl = sum(s >= 5 for c, s in snr_ch.items() if CH_LAM[c] < THERMAL)
    z = [v[0] / v[1] for s in nst for v in s.values()]
    z_ok = sum(abs(x) < 3 for x in z)
    bb_z = [m / s for m, s in nbb]
    b_pass = len(z) > 0 and z_ok >= 0.99 * len(z) and all(abs(x) < 3 for x in bb_z)
    in_s = [c for c in st if 0.75 <= CH_LAM[c] <= 1.0]
    sl = slope(CH_LAM[in_s], [st[c][0] for c in in_s], [st[c][1] for c in in_s]) if len(in_s) >= 3 else (np.nan, np.nan)
    c_res = None
    if gaia is not None:
        gs = gaia[(gaia[:, 0] >= 0.75) & (gaia[:, 0] <= 1.0) & (gaia[:, 3] == 0)]
        gsl = slope(gs[:, 0], gs[:, 1], gs[:, 2]) if len(gs) >= 3 else (np.nan, np.nan)
        dz = (sl[0] - gsl[0]) / math.hypot(sl[1], gsl[1])
        c_res = dict(spherex=sl, gaia=gsl, z=float(dz), pass_=bool(abs(dz) <= 2))
    D, sD = band_depth(st)
    call = None if D is None or not np.isfinite(sl[0]) else ("S-like" if D >= 0.05 and sl[0] < 0 else "C-like")
    short = [i for i, p in enumerate(keep) if p["det"] in ("D1", "D2", "D3")]
    snr1 = float(np.median([keep[i]["ast"][0] / keep[i]["ast"][1] for i in short])) if short else np.nan
    bbi = np.where(lam < 2.42)[0]
    bb = wmean(Rc[bbi], sRc[bbi]) if len(bbi) else (np.nan, np.nan)
    e = dict(single_snr_median=snr1, broadband_snr=float(bb[0] / bb[1]) if bb[1] else np.nan)
    if pick["slot"] in ("F1", "F2"):
        e["pass_"] = bool(snr1 < 3 and e["broadband_snr"] >= 5)
    return dict(a=dict(channels_snr5=int(a_all), refl_channels_snr5=int(a_refl), channels_with_data=len(st), pass_=bool(a_all >= 30)),
                b=dict(null_channels=len(z), within3=int(z_ok), broadband_z=[float(x) for x in bb_z], pass_=bool(b_pass)),
                c=c_res, d=dict(D=D, sD=sD, slope=sl, call=call, expected=EXPECT[pick["cx"]], pass_=call == EXPECT[pick["cx"]]),
                e=e, norm=norm,
                spectrum=[dict(ch=int(c), lam=float(CH_LAM[c]), R=v[0] / norm, sR=v[1] / norm, n=v[2], snr=v[0] / v[1],
                               flux_mJy=st_flux[c][0], sflux=st_flux[c][1]) for c, v in sorted(st.items())],
                nulls=[[dict(ch=int(c), lam=float(CH_LAM[c]), R=v[0] / norm, sR=v[1] / norm, z=v[0] / v[1], n=v[2])
                        for c, v in sorted(s.items())] for s in nst])


def chain(R, sR, ch, lab, sigma_pen=0.01):
    """Divisor per image = exp(a_b), one factor per burst, fitted jointly with a log spectrum s over the 102 channels:
    ln R_i = s[ch_i] + a[burst_i] on images with SNR >= 5, plus a weak smoothness term (s[c-1] - 2 s[c] + s[c+1]) /
    sigma_pen over channels in wavelength order, and sum(a) = 0. A burst is one rotation instant (paired detectors and
    its neighbours, minutes apart), so the shape inside a burst is rotation-free; bursts are tied only through the
    smoothness of the spectrum where their channels meet. A 1 um band changes the second difference by about 0.004 per
    channel; a 10% step between bursts by about 0.1, so steps go into a and bands stay in s.
    Bursts with no SNR >= 5 image keep factor 1 and get the spread of the fitted factors as a fractional error."""
    use = R / sR >= 5
    bs = sorted(set(lab[use]))
    if len(bs) < 2:
        return np.ones(len(R)), np.zeros(len(R)), dict(n_bursts=int(lab.max() + 1), n_fitted=len(bs), spread=0.0)
    bi = {b: k for k, b in enumerate(bs)}
    order = np.argsort(CH_LAM)
    nC, nB = 102, len(bs)
    rows, y, w = [], [], []
    for i in np.where(use)[0]:
        r = np.zeros(nC + nB); r[ch[i]] = 1; r[nC + bi[lab[i]]] = 1
        rows.append(r); y.append(math.log(R[i])); w.append(R[i] / sR[i])
    for k in range(1, nC - 1):
        r = np.zeros(nC + nB); r[order[k - 1]] = 1; r[order[k]] = -2; r[order[k + 1]] = 1
        rows.append(r); y.append(0.0); w.append(1 / sigma_pen)
    r = np.zeros(nC + nB); r[nC:] = 1
    rows.append(r); y.append(0.0); w.append(1e3)
    X, y, w = np.array(rows), np.array(y), np.array(w)
    Xw = X * w[:, None]
    cov = np.linalg.pinv(Xw.T @ Xw)
    sol = cov @ Xw.T @ (y * w)
    n_obs = int(use.sum())
    resid = (X @ sol - y)[:n_obs] * w[:n_obs]
    chi2 = float((resid ** 2).sum() / max(1, n_obs - nB))
    a, sa = sol[nC:], np.sqrt(np.diag(cov)[nC:]) * max(1.0, math.sqrt(chi2))
    spread = float(np.std(a))
    div, frac = np.ones(len(R)), np.full(len(R), spread)
    for i in range(len(R)):
        if lab[i] in bi:
            div[i], frac[i] = math.exp(a[bi[lab[i]]]), sa[bi[lab[i]]]
    return div, frac, dict(n_bursts=int(lab.max() + 1), n_fitted=nB, spread=spread, chi2=chi2, sigma_pen=sigma_pen)


def gaia_spec(num):
    f = OUT / "cache" / f"gaia_{num}.csv"
    if not f.exists():
        q = ("SELECT wavelength, reflectance_spectrum, reflectance_spectrum_err, reflectance_spectrum_flag "
             f"FROM gaiadr3.sso_reflectance_spectrum WHERE number_mp = {num} ORDER BY wavelength")
        f.write_bytes(get("https://gea.esac.esa.int/tap-server/tap/sync?" + urllib.parse.urlencode(
            {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q})))
    rows = list(csv.DictReader(io.StringIO(f.read_text())))
    if not rows:
        return None
    return np.array([[float(r["wavelength"]) / 1000, float(r["reflectance_spectrum"]), float(r["reflectance_spectrum_err"] or "nan"),
                      float(r["reflectance_spectrum_flag"] or 1)] for r in rows])


def plot(res, gaia, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fz, lc = res["frozen"], res["chain"]
    fig, ax = plt.subplots(3, 1, figsize=(9, 11.5), gridspec_kw=dict(height_ratios=[3, 2, 1.6]))
    for v, col, ecol, lab, off in ((fz, "#9aa5b1", "#c9d0d6", "frozen method (counted): one factor per burst", -0.004),
                                   (lc, "#1f4e8c", "#7f9cc4", "burst chain (after step 1, not counted)", 0.004)):
        rf = [s for s in v["spectrum"] if s["lam"] < THERMAL]
        ax[0].errorbar([s["lam"] + off for s in rf], [s["R"] for s in rf], [s["sR"] for s in rf], fmt="o", ms=3, color=col, ecolor=ecol, label=lab)
    rf = [s for s in lc["spectrum"] if s["lam"] < THERMAL]
    if gaia is not None:
        g = gaia[gaia[:, 3] == 0]
        ov = [s for s in rf if 0.75 <= s["lam"] <= 0.95 and s["sR"] > 0]
        scale = (np.average([s["R"] for s in ov], weights=[1 / s["sR"] ** 2 for s in ov]) / np.mean(np.interp([s["lam"] for s in ov], g[:, 0], g[:, 1]))) if ov else 1
        ax[0].errorbar(g[:, 0], g[:, 1] * scale, g[:, 2] * scale, fmt="s", ms=3, color="#c0392b", label="Gaia DR3, scaled to the burst-chain points at 0.75-0.95 um")
    ax[0].axhline(1, color="0.85", lw=0.8)
    ax[0].set_xlim(0.35 if gaia is not None else 0.7, THERMAL)
    ys = [s["R"] for v in (fz, lc) for s in v["spectrum"] if s["lam"] < THERMAL and s["snr"] >= 3]
    if ys:
        lo, hi = np.percentile(ys, [2, 98])
        ax[0].set_ylim(lo - 0.25 * (hi - lo) - 0.05, hi + 0.25 * (hi - lo) + 0.05)
    f = lambda d: "n/a" if d["D"] is None else f"{d['call']}, D={d['D']:.3f}+-{d['sD']:.3f}, slope {d['slope'][0]:+.2f}/um"
    ax[0].set_ylabel("reflectance (1 at 0.95-1.05 um)")
    ax[0].set_title(f"({res['num']}) {res['name']}: literature {res['cls']} ({res['src']}), {res['cx']} complex, expected {fz['d']['expected']}\n"
                    f"frozen: {f(fz['d'])}   |   chain: {f(lc['d'])}\n{res['n_used']} of {res['n_img']} images used, "
                    f"channels SNR>=5: {fz['a']['channels_snr5']} (frozen), {lc['a']['channels_snr5']} (chain)", fontsize=9)
    ax[0].legend(fontsize=7.5, loc="best")
    sp = lc["spectrum"]
    rf2 = [s for s in sp if s["lam"] < THERMAL]
    th = [s for s in sp if s["lam"] >= THERMAL]
    ax[1].errorbar([s["lam"] for s in rf2], [s["flux_mJy"] for s in rf2], [s["sflux"] for s in rf2], fmt="o", ms=3, color="#444", label="reflected light")
    ax[1].errorbar([s["lam"] for s in th], [s["flux_mJy"] for s in th], [s["sflux"] for s in th], fmt="o", ms=4, color="#d35400", label="thermal tail (beyond 3.5 um)")
    ax[1].set_yscale("symlog", linthresh=max(1e-3, float(np.median([s["sflux"] for s in sp]))))
    ax[1].set_ylabel(f"flux (mJy, burst chain) at r={res['geometry']['r']:.2f} au,\ndelta={res['geometry']['delta']:.2f} au, alpha={res['geometry']['alpha']:.0f} deg")
    ax[1].legend(fontsize=8)
    for j, (n, c) in enumerate(zip(fz["nulls"], ("#16a085", "#8e44ad", "#7f8c8d"))):
        ax[2].plot([s["lam"] for s in n], [s["z"] for s in n], "o", ms=2.5, color=c, label=f"null {j + 1}: broadband z {fz['b']['broadband_z'][j]:+.2f}")
    ax[2].axhline(3, color="r", lw=0.7, ls="--")
    ax[2].axhline(-3, color="r", lw=0.7, ls="--")
    ax[2].set_ylabel("null stack z (frozen)")
    ax[2].set_xlabel("wavelength (um)")
    ax[2].legend(fontsize=7, ncol=3)
    for a in ax[1:]:
        a.set_xlim(0.7, 5.05)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)

if __name__ == "__main__":
    if (OUT / "selection.json").exists():
        picks = {p["slot"]: p for f in ("selection.json", "selection_extra.json") if (OUT / f).exists()
                 for p in json.loads((OUT / f).read_text())}
    else:   # the selector is still searching later slots: its log holds the ones already chosen
        import ast
        picks = {l.split(" ", 1)[0]: ast.literal_eval(l.split(" ", 1)[1]) for l in (OUT / "select.log").read_text().splitlines()
                 if l[:2] in [s[:2] for s in sys.argv[2:]] and " {" in l}
    for s in sys.argv[2:]:
        run(picks[s])
