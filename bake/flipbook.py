"""Bake real SPHEREx flipbook frames for a few targets -> web/data/flip/<target>/.

One frame per survey visit. For every exposure on one detector we read the wavelength SPHEREx saw at the
target, pick one wavelength all visits cover, and median the nearest exposures, reprojected north up.
Then we measure the star's position per frame and fit its motion, and compare with Gaia DR3.
Run: uv run --with astropy --with reproject --with pillow python bake/flipbook.py [target ...]
IRSA is often busy during the hackathon, so every request retries with backoff
and raw cutouts are cached in bake/cache/.
"""
import base64, csv, io, json, logging, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

logging.getLogger("astropy").setLevel(logging.ERROR)  # SPHEREx headers carry SIP without "-SIP"; astropy warns per file

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "bake" / "cache"
OUT = ROOT / "web" / "data" / "flip"

# position at ~2026.0 (moving targets shifted from their catalog epoch by proper motion)
TARGETS = {
    "barnard": dict(name="Barnard's Star", ra=269.4463, dec=4.7671, det="D1", note="fastest-moving star in the sky, about 10.3 arcsec per year"),
    "rdra": dict(name="R Draconis", ra=248.1674, dec=66.7552, det="D2", note="Mira variable, brightness swings over about 245 days"),
    # the challenge gives its discovery-era position; it moves about 8.1 arcsec per year west, so about 2 arcmin by 2026
    "wise0855": dict(name="WISE 0855-0714", ra=133.7587, dec=-7.2421, det="D6", note="coldest known brown dwarf, faint except at long wavelengths",
                     gaia=False, ref=dict(pmra=-8110, pmdec=660, source="Luhman & Esplin 2016")),  # too faint for Gaia
    # J2000 position moved by its proper motion (about 4.7 arcsec per year) to 2026
    "epsindib": dict(name="Epsilon Indi B", ra=331.096, dec=-56.801, det="D5", note="pair of brown dwarfs orbiting Epsilon Indi"),
    "rwaur": dict(name="RW Aurigae", ra=76.9563, dec=30.4013, det="D2", note="young variable star with an irregular, dimming disk"),
}
PER_VISIT = 3      # exposures averaged per frame, the ones nearest the matched wavelength
MAX_PER_VISIT = 30 # exposures whose wavelength we read per visit (each cutout is about 4 MB)
SIZE_ARCSEC = 780  # cutout size: 12 arcmin frame plus margin
GRID = 144         # output frame is GRID x GRID pixels
PIX_ARCSEC = 5.0


def get(url, tries=50):  # about an hour of patience: IRSA's TAP was down for long stretches on 2026-11-14
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                data = r.read()
            if data[:30].startswith(b"Server busy") or b"Proxy Error" in data[:400]:
                raise IOError(data[:60])
            return data
        except Exception as e:
            # 2026-11-15: SIA answered an instant 502 to about 2 of 3 requests and the full answer (after ~21 s) to the
            # rest, so the first 20 retries of an instant 502 come quickly; after that, back off for long outages
            wait = 2 if i < 20 and "502" in str(e) else min(120, 4 * 2 ** i)
            print(f"  retry {i + 1}/{tries} in {wait}s: {str(e)[:80]}", flush=True)
            time.sleep(wait)
    raise IOError(f"gave up: {url[:120]}")


def images(t):
    # SIA, not TAP: on 2026-11-14 IRSA's TAP answered 502 for hours while SIA worked. SIA lags ingestion by
    # about a day (irsa-tutorials spherex_intro), which does not matter for a time-lapse.
    rows = {}
    for coll in ("spherex_dr1", "spherex_qr3"):
        url = "https://irsa.ipac.caltech.edu/SIA?" + urllib.parse.urlencode(
            {"COLLECTION": coll, "POS": f"CIRCLE {t['ra']} {t['dec']} 0.001", "RESPONSEFORMAT": "CSV"})
        for r in csv.DictReader(io.StringIO(get(url).decode())):
            if r["energy_bandpassname"] == f"SPHEREx-{t['det']}" and r["dataproduct_subtype"] == "science":
                rows.setdefault(r["obs_id"], r)   # DR1 first, so it wins over a QR3 copy of the same exposure
    return sorted(rows.values(), key=lambda r: float(r["t_min"]))


def visits(rows, gap=20):
    out = []
    for r in rows:
        if out and float(r["t_min"]) - float(out[-1][-1]["t_min"]) <= gap:
            out[-1].append(r)
        else:
            out.append([r])
    return out


def cutout(t, row):
    f = CACHE / (row["access_url"].rsplit("/", 1)[-1].replace(".fits", "") + f"_{t['ra']:.4f}_{t['dec']:.4f}_{SIZE_ARCSEC}.fits")  # size in the name: a new size must not reuse old cutouts
    if not f.exists():
        url = f"{row['access_url']}?center={t['ra']},{t['dec']}&size={SIZE_ARCSEC}arcsec"
        data = get(url)
        assert data[:6] == b"SIMPLE", data[:80]
        f.write_bytes(data)
    return f


def target_wcs(t):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [t["ra"], t["dec"]]
    w.wcs.crpix = [(GRID + 1) / 2, (GRID + 1) / 2]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    return w


def wave_at(t, f):
    """Wavelength and bandwidth (micrometres) SPHEREx saw at the target in one cutout (WCS-WAVE, key W)."""
    with fits.open(f) as h:
        x, y = WCS(h["IMAGE"].header).world_to_pixel_values(t["ra"], t["dec"])
        spectral = WCS(h["IMAGE"].header, fobj=h, key="W")
        spectral.sip = None   # IRSA: SIP distortion must be off for the spectral WCS (irsa-tutorials spherex_intro)
        lam, bw = spectral.pixel_to_world_values(x, y)
    return float(lam), float(bw)


def match(vs):
    """Pick the wavelength the most visits actually have (within one filter width), then up to PER_VISIT
    exposures near it per visit. Brightness differs by wavelength, so frames taken at different wavelengths
    would show fake change. A visit with nothing close keeps its single nearest exposure, marked unmatched."""
    tol = float(np.median([e["bw"] for v in vs for e in v]))
    near = lambda v, l0: [e for e in v if abs(e["lam"] - l0) <= tol]
    score = lambda l0: (sum(bool(near(v, l0)) for v in vs), -sum(min(abs(e["lam"] - l0) for e in v) for v in vs))
    lam0 = max((e["lam"] for v in vs for e in v), key=score)
    picked = [sorted(near(v, lam0), key=lambda e: abs(e["lam"] - lam0))[:PER_VISIT]
              or [min(v, key=lambda e: abs(e["lam"] - lam0))] for v in vs]
    return lam0, tol, picked


def frame(t, files):
    wout, stack = target_wcs(t), []
    for f in files:
        with fits.open(f) as h:
            img, hdr = h["IMAGE"].data.astype(float), h["IMAGE"].header
        # No flag masking: about 41% of pixels carry the SOURCE bit (a known star is there), so masking every
        # flag deleted the stars. The median across exposures below rejects one-off glitches instead.
        # ponytail: use the bad-pixel bits from the SPHEREx Explanatory Supplement (Table 16) if artifacts show
        arr, _ = reproject_interp((img, WCS(hdr)), wout, shape_out=(GRID, GRID))
        med = np.nanmedian(arr)
        mad = np.nanmedian(np.abs(arr - med)) * 1.4826 or 1.0
        stack.append((arr - med) / mad)
    return np.nanmedian(stack, axis=0)


def centroid(a, guess, r=3.0):
    """Flux-weighted centre (FITS x, y pixels) of the source nearest guess. A saturated core comes back
    as NaN, so NaNs inside the window count as the brightest value: the bright ring still centres it."""
    yy, xx = np.mgrid[: a.shape[0], : a.shape[1]]
    win = (xx - guess[0]) ** 2 + (yy - guess[1]) ** 2 <= r * r
    v = np.where(win, a, 0.0)
    sat = int(np.isnan(v[win]).sum())
    if sat > 0.5 * win.sum():   # core mostly saturated (R Draconis): its centre is the centre of the saturated blob
        blob = np.isnan(a) & ((xx - guess[0]) ** 2 + (yy - guess[1]) ** 2 <= (2 * r) ** 2)
        return (float(xx[blob].mean()), float(yy[blob].mean())), int(blob.sum())
    v = np.nan_to_num(v, nan=np.nanmax(v[win]) if np.isfinite(v[win]).any() else 0.0)
    v = np.clip(v - np.median(v[win]), 0, None)
    if v.sum() <= 0:
        return None, sat
    return (float((xx * v).sum() / v.sum()), float((yy * v).sum() / v.sum())), sat


def gaia_motion(t):
    """Gaia DR3 proper motion (mas/yr east, north) and 2016.0 position of the source at the target, or None.
    Brown dwarfs like WISE 0855 are too faint in visible light for Gaia, so None is a normal answer."""
    q = (f"SELECT ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE pmra IS NOT NULL "
         f"AND 1=CONTAINS(POINT(ra, dec), CIRCLE({t['ra']}, {t['dec']}, 0.04))")
    url = "https://gea.esac.esa.int/tap-server/tap/sync?" + urllib.parse.urlencode(
        dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q))
    best = None
    for r in csv.DictReader(io.StringIO(get(url).decode())):
        ra, dec, pmra, pmdec = (float(r[k]) for k in ("ra", "dec", "pmra", "pmdec"))
        dt = 10.0  # 2016.0 -> 2026.0, the epoch of TARGETS positions
        e = (ra - t["ra"]) * 3600 * np.cos(np.radians(dec)) + pmra / 1000 * dt
        n = (dec - t["dec"]) * 3600 + pmdec / 1000 * dt
        sep = float(np.hypot(e, n))
        if sep < 6 and (best is None or sep < best["sep"]):  # about 1 SPHEREx pixel: a background star must not pass
            best = dict(ra=ra, dec=dec, pmra=pmra, pmdec=pmdec, g=float(r["phot_g_mean_mag"] or 99), sep=round(sep, 1))
    return best


def offset_arcsec(t, x, y):
    """East and north offset (arcsec) of FITS pixel x, y from the target centre."""
    c = (GRID - 1) / 2
    return -(x - c) * PIX_ARCSEC, (y - c) * PIX_ARCSEC


def stretch(frames):
    allv = np.concatenate([f[np.isfinite(f)] for f in frames])
    lo, hi = np.percentile(allv, [5, 99.7])
    out = []
    for f in frames:
        v = np.arcsinh(np.clip((np.nan_to_num(f, nan=lo) - lo) / (hi - lo), 0, None) * 10) / np.arcsinh(10)
        out.append((np.clip(v, 0, 1) * 255).astype(np.uint8)[::-1])  # FITS row 0 is the bottom
    return out


def mjd_date(m):
    return time.strftime("%Y-%m-%d", time.gmtime((float(m) - 40587) * 86400))


def bake(key):
    t = dict(TARGETS[key], key=key)
    print(f"{key}: querying images on {t['det']}", flush=True)
    vs = visits(images(t))
    print(f"{key}: {sum(map(len, vs))} images in {len(vs)} visits; reading every exposure's wavelength", flush=True)
    with ThreadPoolExecutor(4) as pool:   # IRSA tolerates a few parallel cutouts; more triggers "Server busy"
        files = list(pool.map(lambda r: cutout(t, r), [r for v in vs for r in v[:MAX_PER_VISIT]]))
    it = iter(files)
    exp = [[dict(row=r, file=next(it)) for r in v[:MAX_PER_VISIT]] for v in vs]
    for v in exp:
        for e in v:
            e["lam"], e["bw"] = wave_at(t, e["file"])
    lam0, tol, picked = match(exp)
    raw = [frame(t, [e["file"] for e in v]) for v in picked]

    gaia = gaia_motion(t) if t.get("gaia", True) else None
    ref = t.get("ref")
    years = lambda mjd: 2000.0 + (float(mjd) - 51544.5) / 365.25
    meta, guess = [], None
    for v, a in zip(picked, raw):
        mjd = float(np.mean([float(e["row"]["t_min"]) for e in v]))
        pe = pn = None
        if gaia:   # Gaia's predicted position at this date, offset from the target centre
            dt = years(mjd) - 2016.0
            pe = (gaia["ra"] - t["ra"]) * 3600 * np.cos(np.radians(gaia["dec"])) + gaia["pmra"] / 1000 * dt
            pn = (gaia["dec"] - t["dec"]) * 3600 + gaia["pmdec"] / 1000 * dt
        elif ref:  # published motion, from the target's 2026.0 position in TARGETS
            dt = years(mjd) - 2026.0
            pe, pn = ref["pmra"] / 1000 * dt, ref["pmdec"] / 1000 * dt
        c0 = (GRID - 1) / 2
        guess = guess or ((c0 - pe / PIX_ARCSEC, c0 + pn / PIX_ARCSEC) if pe is not None else (c0, c0))
        pos, sat = centroid(a, guess)
        guess = pos or guess
        ts = [float(e["row"]["t_min"]) for e in v]   # v is sorted by wavelength, not time
        m = dict(start=mjd_date(min(ts)), end=mjd_date(max(ts)), mjd=round(mjd, 4),
                 year=round(years(mjd), 4), exposures=len(v), lam=round(float(np.mean([e["lam"] for e in v])), 4),
                 lam_spread=round(float(max(abs(e["lam"] - lam0) for e in v)), 4),
                 matched=bool(max(abs(e["lam"] - lam0) for e in v) <= tol),
                 bw=round(float(np.mean([e["bw"] for e in v])), 4), saturated_px=sat)
        if pos:
            m["x"], m["y"] = round(pos[0], 3), round(pos[1], 3)
            m["east"], m["north"] = (round(z, 2) for z in offset_arcsec(t, *pos))
        if pe is not None:
            m["pred_east"], m["pred_north"] = round(pe, 2), round(pn, 2)
        meta.append(m)
        print(f"  visit {m['start']}: {len(v)} exposures at {m['lam']} um (within {m['lam_spread']}), "
              f"star at east {m.get('east')} north {m.get('north')} arcsec, saturated px {sat}", flush=True)

    ok = [m for m in meta if "east" in m]
    motion = None
    if len(ok) >= 2:   # straight-line fit of measured position against time
        yr = np.array([m["year"] for m in ok])
        fe, fn = (np.polyfit(yr, [m[k] for m in ok], 1) for k in ("east", "north"))
        motion = dict(east=round(float(fe[0]), 2), north=round(float(fn[0]), 2), years=round(float(yr[-1] - yr[0]), 2))
        motion["total"] = round(float(np.hypot(motion["east"], motion["north"])), 2)
    d = OUT / key
    d.mkdir(parents=True, exist_ok=True)
    pngs = stretch(raw)
    allv = np.concatenate([f[np.isfinite(f)] for f in raw])
    lo, hi = (float(x) for x in np.percentile(allv, [5, 99.7]))
    for i, (a, png) in enumerate(zip(raw, pngs)):
        Image.fromarray(png, "L").save(d / f"f{i}.png")
        meta[i]["file"] = f"f{i}.png"
        # noise-unit pixels for the page (difference view, stretch), north up like the PNG, NaN kept
        meta[i]["data"] = base64.b64encode(a[::-1].astype("<f4").tobytes()).decode()
    (d / "manifest.json").write_text(json.dumps(dict(
        key=key, name=t["name"], ra=t["ra"], dec=t["dec"], detector=t["det"], note=t["note"], grid=GRID,
        arcsec_per_pixel=PIX_ARCSEC, lam0=round(lam0, 4), lam_tol=round(tol, 4), stretch=dict(lo=lo, hi=hi), motion=motion,
        gaia=None if not gaia else dict(pmra=round(gaia["pmra"], 1), pmdec=round(gaia["pmdec"], 1), g=gaia["g"],
                                        total=round(float(np.hypot(gaia["pmra"], gaia["pmdec"])) / 1000, 2)),
        ref=None if "ref" not in t else dict(t["ref"], total=round(float(np.hypot(t["ref"]["pmra"], t["ref"]["pmdec"])) / 1000, 2)),
        frames=meta), indent=1))
    print(f"{key}: wrote {len(meta)} frames at {lam0:.3f} um; measured motion {motion}; "
          f"Gaia {None if not gaia else (round(gaia['pmra']), round(gaia['pmdec']))} mas/yr", flush=True)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    for k in sys.argv[1:] or ["barnard", "rdra"]:
        try:
            bake(k)
        except Exception as e:
            print(f"{k}: FAILED {e}", flush=True)
