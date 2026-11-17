"""Real SPHEREx photos, motion and spectrum for a comet -> web/data/comets/<slug>/ (photos + comet.json).

A comet here is a list of SPHEREx exposures, each with the comet's exact position at that moment:
- 3I/ATLAS: IRSA's own list (https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/), 259 exposures.
- A known comet from bake/known_comets.py: IRSA's photo search along the comet's path during its brightest
  SPHEREx visit, every detector (D1-D6, so 0.75-5 um), with JPL Horizons giving the comet's position at each
  exposure's moment; we keep the exposures whose outline held the comet.
For each exposure we cut out a patch centred on the comet, measure its brightness in a circle minus the sky around
it, and read the wavelength SPHEREx saw there. Each exposure is a different wavelength, so together they are the
comet's spectrum. Comets are spread out (not points), so the circle is wide and every point carries its noise.

Run: uv run -q --with astropy --with pillow --with certifi --with reproject sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python -u bake/comet_spectrum.py "3I/ATLAS" "C/2025 R2 (SWAN)"'
Flags: --all-visits (every SPHEREx visit, how the known comets are published); --most (find exposures with IRSA's
moving-object search, one request per visit, instead of hundreds of SIA requests).
"""
import csv, functools, io, json, re, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from flipbook import get   # retries IRSA's intermittent errors

ROOT = Path(__file__).resolve().parent.parent
DOCS = "https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/"
MJD0 = 60789                     # coverage start, the day numbers in bake/known_comets.py count from here
SIZE = 600                       # cutout width, arcsec
R_AP, R_IN, R_OUT = 4, 9, 14     # aperture and sky annulus radii, pixels (SPHEREx pixels are 6.15 arcsec)
SR_PER_PIX = (6.15 / 206265) ** 2
# FLAGS bits that mean "this pixel's value is not trustworthy" (bit numbers from the FLAGS header, MP_*):
# transient, overflow, processing error, non-functional, missing data, hot, cold, nonlinear, persistence.
# OUTLIER (19) and SOURCE (21) are left alone: a moving comet's own coma trips both.
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17))
ALL_VISITS = "--all-visits" in sys.argv   # search every SPHEREx visit of a known comet, not just its brightest
# Find a known comet's candidate exposures with IRSA's moving-object search (MOST, one request per window) instead of
# SIA at its position every 6 hours (hundreds of requests). Same windows, same Horizons + outline check afterwards.
# Checked 2026-11-15 on C/2025 R2 (SWAN): MOST held all 269 of the SIA list's exposures, with the same file paths.
USE_MOST = "--most" in sys.argv


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def cache_dir(name):
    return ROOT / "bake" / "cache" / ("3iatlas" if name == "3I/ATLAS" else f"comets/{slug(name)}")


# ---------- which exposures held the comet ----------

def exposures_3iatlas(cache):
    """IRSA's list: one row per exposure with id, detector, time, comet position and image URL."""
    for name in ("obscore_3I_Atlas.vot", "3IATLASImages-curl.sh"):
        if not (cache / name).exists():
            (cache / name).write_bytes(get(DOCS + name))
    urls = re.findall(r"download_file '([^']+\.fits)'", (cache / "3IATLASImages-curl.sh").read_text())
    by_file = {u.rsplit("/", 1)[-1]: u for u in urls}
    rows = []
    for r in Table.read(cache / "obscore_3I_Atlas.vot"):
        det = str(r["spherex_detector"]).strip()
        det = det if det.startswith("D") else f"D{det}"
        url = next((u for f, u in by_file.items() if f.startswith(f"level2_{r['obs_id']}{det}_")), None)
        if url:
            rows.append(dict(obs=str(r["obs_id"]), det=det, t=float(r["t_min"]),
                             ra=float(r["comet_ra"]), dec=float(r["comet_dec"]), url=url))
    return sorted(rows, key=lambda e: e["t"])


def horizons_at(pdes, mjds):
    """The comet's RA, Dec (degrees) as SPHEREx saw it at each MJD, from JPL Horizons (batched). The observer is the
    spacecraft itself (Horizons body -163182), not Earth's centre: SPHEREx orbits ~650 km up, which shifts a comet
    0.26 AU away (C/2025 R2) by about 37 arcsec, more than the 25 arcsec measuring circle."""
    jds = [f"{m + 2400000.5:.6f}" for m in mjds]
    # each time once, in order: Horizons reads a two-time list as start and stop, and refuses two equal times (C/2024 G3's
    # last batch was one exposure seen by two detectors)
    uniq, pos = sorted(set(jds)), {}
    for i in range(0, len(uniq), 40):
        batch = uniq[i:i + 40]
        params = {"format": "json", "COMMAND": f"'DES={pdes};CAP;NOFRAG'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
                  "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@-163182'", "TLIST": "'" + " ".join(batch) + "'",
                  "TLIST_TYPE": "'JD'", "QUANTITIES": "'1'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'"}
        text = json.loads(get("https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)).decode()).get("result", "")
        assert "$$SOE" in text, f"Horizons gave no positions for {pdes}: {text[-500:]}"
        lines = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
        assert len(lines) == len(batch), f"Horizons returned {len(lines)} of {len(batch)} positions"
        pos.update(zip(batch, [(float(l.split(",")[3]), float(l.split(",")[4])) for l in lines]))
    return [pos[j] for j in jds]


@functools.lru_cache
def spkid(pdes):
    """JPL's SPK-ID for a comet designation (the comet itself, not a fragment), from the Small-Body Database."""
    return json.loads(get("https://ssd-api.jpl.nasa.gov/sbdb.api?" + urllib.parse.urlencode({"des": pdes})).decode())["object"]["spkid"]


def most_rows(pdes, a, b):
    """SPHEREx exposures whose outline MOST says the comet crossed between days a and b (since MJD0), as rows shaped
    like SIA's (the fields exposures_known reads), DR1 before QR3 so DR1 wins a duplicate."""
    day = lambda d: (datetime(1858, 11, 17) + timedelta(days=MJD0 + d)).strftime("%Y-%m-%d")
    # by NAIF ID (JPL's SPK-ID): MOST refuses a designation shared with fragments ("2023 R1" also matches C/2023 R1-B)
    url = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?" + urllib.parse.urlencode(
        {"catalog": "spherex", "input_type": "naifid_input", "obj_naifid": spkid(pdes),
         "obs_begin": day(np.floor(a)), "obs_end": day(np.ceil(b) + 1), "output_mode": "Brief"})
    lines = get(url).decode().splitlines()
    head = next((l for l in lines if l.startswith("|")), None)
    assert head, f"MOST answered without a table (an empty answer still has one): {lines[:5]}"
    named = next(l for l in lines if l.startswith("\\object_name"))
    assert f"({pdes})" in named or f"/{pdes})" in named, f"MOST found another object for {pdes}: {named}"
    bars = [i for i, ch in enumerate(head) if ch == "|"]
    cols = [head[i + 1:j].strip() for i, j in zip(bars, bars[1:])]
    out = []
    for l in lines:
        if l.startswith(("\\", "|")) or not l.strip():
            continue
        r = {k: l[i:j + 1].strip() for k, i, j in zip(cols, bars, bars[1:])}
        out.append(dict(obs_id=r["observationid"], energy_bandpassname="SPHEREx-" + r["productid"], t_min=r["mjd_start"],
                        t_max=r["mjd_end"], access_url="https://irsa.ipac.caltech.edu/" + r["uri"], dataproduct_subtype="science",
                        s_region="POLYGON ICRS " + " ".join(r[f"{x}{n}"] for n in range(1, 5) for x in ("ra", "dec"))))
    return sorted(out, key=lambda r: "/dr1/" not in r["access_url"])


def exposures_known(name, cache):
    """Every SPHEREx exposure (all detectors) that held a known comet during its brightest SPHEREx visit."""
    from known_comets import inside   # gnomonic point-in-outline, checked on import
    f = cache / ("exposures-all-visits.json" if ALL_VISITS else "exposures.json")
    if f.exists():
        return json.loads(f.read_text())
    c = next(k for k in json.loads((ROOT / "bake/cache/known_comets.json").read_text()) if k["name"] == name)
    days, track = np.array([r[0] for r in c["track"]]), c["track"]
    ra_u = np.degrees(np.unwrap(np.radians([r[1] for r in track])))
    mag = np.array([np.nan if r[3] is None else r[3] for r in track])
    shots = sorted(s["day"] for s in c["spherex"])
    visits = [[shots[0]]]   # photos less than 5 days after the previous one are one visit
    for d in shots[1:]:
        if d - visits[-1][-1] < 5:
            visits[-1].append(d)
        else:
            visits.append([d])
    if ALL_VISITS:   # every visit, a few days either side: more chances to land in D5 at 4.26 um
        windows = [(max(0.0, v[0] - 3), min(float(days[-1]), v[-1] + 3)) for v in visits]
    else:   # +-15 days around the visit when it was brightest: in one short visit the comet sits in only one pair of
        # detectors (D1 with D4, for example), so it takes the neighbouring days for it to cross D5 (CO2, 4.26 um)
        best = min(visits, key=lambda v: np.nanmin(np.interp(v, days, mag)))
        mid = (best[0] + best[-1]) / 2
        windows = [(max(0.0, mid - 15), min(float(days[-1]), mid + 15))]
    inwin = lambda t: any(a <= t <= b for a, b in windows)
    lo, hi = min(a for a, _ in windows), max(b for _, b in windows)
    rows = {}
    if USE_MOST:
        for a, b in windows:
            for r in most_rows(c["pdes"], a, b):
                t = float(r["t_min"]) - MJD0
                if inwin(t):
                    rows.setdefault((r["obs_id"], r["energy_bandpassname"]), r)
    for d in [] if USE_MOST else np.concatenate([np.arange(a, b + 0.01, 0.25) for a, b in windows]):   # search IRSA at the comet's position every 6 hours
        ra, dec = float(np.interp(d, days, ra_u)) % 360, float(np.interp(d, days, [r[2] for r in track]))
        for coll in ("spherex_dr1", "spherex_qr3"):
            url = "https://irsa.ipac.caltech.edu/SIA?" + urllib.parse.urlencode(
                {"COLLECTION": coll, "POS": f"CIRCLE {ra} {dec} 0.001", "RESPONSEFORMAT": "CSV", "MAXREC": "20000"})
            for r in csv.DictReader(io.StringIO(get(url).decode())):
                t = float(r["t_min"]) - MJD0
                if r["dataproduct_subtype"] == "science" and inwin(t):
                    rows.setdefault((r["obs_id"], r["energy_bandpassname"]), r)   # DR1 first, so it wins
    cand = sorted(rows.values(), key=lambda r: float(r["t_min"]))
    mid = lambda r: (float(r["t_min"]) + float(r["t_max"])) / 2 if r.get("t_max") else float(r["t_min"])   # middle of the exposure
    pos = horizons_at(c["pdes"], [mid(r) for r in cand])
    polys = np.array([[float(v) for v in r["s_region"].split()[2:10]] for r in cand])
    hit = inside(np.array([p[0] for p in pos]), np.array([p[1] for p in pos]), polys)
    out = [dict(obs=r["obs_id"], det=r["energy_bandpassname"].replace("SPHEREx-", ""), t=mid(r),
                ra=p[0], dec=p[1], url=r["access_url"]) for r, p, h in zip(cand, pos, hit) if h]
    f.write_text(json.dumps(out))
    print(f"  {name}: {'MOST' if USE_MOST else 'SIA'}, {len(windows)} window(s) MJD {lo + MJD0:.1f}-{hi + MJD0:.1f}, {len(cand)} candidate exposures, {len(out)} held the comet", flush=True)
    return out


# ---------- measuring ----------

def cutout(e, cache):
    f = cache / f"{e['obs']}_{e['det']}_{SIZE}.fits"
    if not f.exists():
        data = get(f"{e['url']}?center={e['ra']},{e['dec']}&size={SIZE}arcsec")
        assert data[:6] == b"SIMPLE", data[:80]
        f.write_bytes(data)
    return f


def aperture_pixels(x, y, r=R_AP):
    """How many whole pixels the measuring circle covers around (x, y), ignoring the cutout's edges."""
    xs, ys = np.meshgrid(np.arange(np.floor(x) - r - 1, np.ceil(x) + r + 2), np.arange(np.floor(y) - r - 1, np.ceil(y) + r + 2))
    return int((np.hypot(xs - x, ys - y) <= r).sum())


# the count ignores the cutout's edges: centred on a pixel, a 4-pixel circle covers 49 pixels at the edge or in the middle
assert aperture_pixels(10.0, 10.0) == aperture_pixels(0.0, 0.0) == 49 and aperture_pixels(3.3, 0.6) == aperture_pixels(53.3, 40.6)


def photometry(img, var, usable, x, y):
    """Circle-minus-ring brightness at (x, y): (flux mJy, noise mJy, share of light in the brightest pixel), or None
    when under 80% of the circle is usable. Missing or flagged pixels count as the circle's average."""
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - x, yy - y)
    ap, ring = (r <= R_AP) & usable, (r >= R_IN) & (r <= R_OUT) & usable
    full = aperture_pixels(x, y)   # the whole circle, even where it runs off the cutout
    if ap.sum() < 0.8 * full or ring.sum() < 50:
        return None
    sky = np.median(img[ring])
    sky_err = 1.2533 * np.std(img[ring]) / np.sqrt(ring.sum())
    fill = full / ap.sum()
    flux = (img[ap] - sky).sum() * fill * SR_PER_PIX * 1e9            # MJy/sr * sr -> mJy
    # flux is scaled by fill, so its variance scales by fill squared
    noise = np.sqrt((var[ap].sum() * fill ** 2 if var is not None else 0) + (full * sky_err) ** 2) * SR_PER_PIX * 1e9
    v = img[ap] - sky
    return float(flux), float(noise), float(v.max() / v.sum()) if v.sum() > 0 else 0.0


def _check_photometry():
    """Flat sky of 10 plus 2 per pixel inside the circle; unit variance everywhere."""
    img, var = np.full((40, 40), 10.0), np.ones((40, 40))
    yy, xx = np.indices(img.shape)
    img[np.hypot(xx - 20, yy - 20) <= R_AP] += 2.0
    usable = np.ones(img.shape, bool)
    k = SR_PER_PIX * 1e9
    flux, noise, _ = photometry(img, var, usable, 20.0, 20.0)
    assert abs(flux - 49 * 2 * k) < 1e-9 and abs(noise - np.sqrt(49) * k) < 1e-9, (flux, noise)
    usable[20, 16:20] = False                     # flag 4 of 49 pixels: same flux, noise grows by 49/45
    flux2, noise2, _ = photometry(img, var, usable, 20.0, 20.0)
    assert abs(flux2 - flux) < 1e-9 and abs(noise2 - np.sqrt(45) * 49 / 45 * k) < 1e-9, (flux2, noise2)
    assert photometry(img, var, np.ones(img.shape, bool), 1.0, 20.0) is None   # circle half off the image


_check_photometry()


def measure(e, cache):
    """Brightness (mJy) of the comet in a circle, minus the median sky in a ring, plus wavelength (um)."""
    with fits.open(cutout(e, cache)) as h:
        img = h["IMAGE"].data.astype(float)
        var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
        usable = np.isfinite(img) & ((h["FLAGS"].data.astype(np.int64) & BAD) == 0)
        w = WCS(h["IMAGE"].header)
        x, y = w.world_to_pixel_values(e["ra"], e["dec"])
        spectral = WCS(h["IMAGE"].header, fobj=h, key="W")
        spectral.sip = None   # IRSA: SIP distortion must be off for the spectral WCS
        lam, bw = spectral.pixel_to_world_values(x, y)
    m = photometry(img, var, usable, x, y)
    if m is None:
        return None   # comet near the cutout edge, or too many flagged pixels in the circle
    flux, noise, peak_frac = m
    # The coma spreads its light (brightest pixel holds 6-10%); a background star or hot pixel concentrates it
    # (25-99%), and a saturated or bad pixel shows up as a huge error. Checked by hand on 3I/ATLAS's August D5 points.
    ok = noise < 5 and not (flux > 3 * noise and peak_frac > 0.2)
    return dict(e, lam=float(lam), bw=float(bw), flux=float(flux), err=float(noise), x=float(x), y=float(y),
                peak_frac=peak_frac, ok=bool(ok))


# ---------- the CO2 verdict behind the page's badge ----------

CO2_BAND = (4.20, 4.32)                    # um, carbon dioxide's glow (4.26 um)
CO2_CONT = ((3.90, 4.15), (4.40, 4.70))    # um, nearby wavelengths with no strong gas line


def co2_verdict(points):
    """Is there carbon dioxide glow at 4.26 um? The median brightness in the CO2 band (4.20-4.32 um) against the
    continuum on BOTH sides of it (3.90-4.15 and 4.40-4.70 um), so a dust continuum that rises or falls across the band
    cannot pass for gas:
      continuum: the average of the two sides' medians; each side's noise is the larger of its points' error bars and
                 their spread, over the square root of that side's own count, and the two combine as an average does
      band:      the median of the band points, with noise from the root-mean-square of their error bars (cautious:
                 one large error bar counts fully); the spread inside the band is the line's own shape, not noise
      detected:  band exceeds continuum by more than 3 noise units
      quiet:     the comet is clearly seen nearby (continuum above 5 of its noise units) and the band is within 2
      unclear:   anything else, including under 2 band points or under 2 points on either side
    """
    band = [p for p in points if CO2_BAND[0] <= p["lam"] <= CO2_BAND[1]]
    sides = [[p for p in points if a <= p["lam"] <= b] for a, b in CO2_CONT]
    base = dict(n_band=len(band), n_cont=len(sides[0]) + len(sides[1]))
    if len(band) < 2 or min(len(sd) for sd in sides) < 2:
        return dict(base, state="unclear", why=f"{len(band)} measurements in the CO2 band, {len(sides[0])} below it and "
                                               f"{len(sides[1])} above; needs 2 in the band and 2 on each side")
    med = lambda ps: float(np.median([p["flux"] for p in ps]))
    def noise(sd):   # noise of one side's median
        f = np.array([p["flux"] for p in sd])
        spread = 1.4826 * float(np.median(np.abs(f - np.median(f))))
        return 1.2533 * max(float(np.median([p["err"] for p in sd])), spread) / np.sqrt(len(sd))
    level = (med(sides[0]) + med(sides[1])) / 2
    s_cont = 0.5 * float(np.hypot(noise(sides[0]), noise(sides[1])))
    s_band = 1.2533 * float(np.sqrt(np.mean([p["err"] ** 2 for p in band]))) / np.sqrt(len(band))
    excess, sigma = med(band) - level, float(np.hypot(s_band, s_cont))
    state = "detected" if excess > 3 * sigma else "quiet" if level > 5 * s_cont and abs(excess) < 2 * sigma else "unclear"
    return dict(base, state=state, band=round(med(band), 2), cont=round(level, 2), excess=round(excess, 2), sigma=round(sigma, 2))


def _check_co2_verdict():
    mk = lambda lam, f, e=0.5: dict(lam=lam, flux=f, err=e)
    cont = [mk(l, 10.0) for l in (3.95, 4.0, 4.05, 4.45, 4.5, 4.55)]
    assert co2_verdict(cont + [mk(4.24, 30), mk(4.27, 32)])["state"] == "detected"
    assert co2_verdict(cont + [mk(4.21, 14, 1), mk(4.23, 34, 1), mk(4.25, 68, 1), mk(4.29, 95, 1)])["state"] == "detected"   # line shape
    assert co2_verdict(cont + [mk(4.24, 10.1), mk(4.27, 9.9)])["state"] == "quiet"
    assert co2_verdict([mk(l, 0.1, 5) for l in (3.95, 4.0, 4.45, 4.5)] + [mk(4.24, 0.3, 5), mk(4.27, -0.2, 5)])["state"] == "unclear"
    assert co2_verdict(cont + [mk(4.24, 30)])["state"] == "unclear"   # one band point is not enough
    sloped = [mk(3.95, 20), mk(4.0, 20.5), mk(4.05, 21), mk(4.45, 30), mk(4.5, 30.5), mk(4.55, 31)]   # rising dust
    assert co2_verdict(sloped + [mk(4.24, 25.5), mk(4.27, 25.4)])["state"] == "quiet"
    # Codex review: a line-free rising spectrum seen only on the blue side must not read as gas
    rising = [mk(l, 2 * (l - 3.9), 0.2) for l in (3.95, 4.0, 4.05, 4.1, 4.15)]
    assert co2_verdict(rising + [mk(4.24, 2 * 0.34, 0.2), mk(4.28, 2 * 0.38, 0.2)])["state"] == "unclear"
    # one side with many points cannot lend its precision to a side with few
    lopsided = [mk(3.9 + 0.01 * i, 10, 1) for i in range(25)] + [mk(4.45, 8, 1), mk(4.5, 8, 1)]
    assert co2_verdict(lopsided + [mk(4.24, 10, 0.1), mk(4.27, 10, 0.1)])["state"] != "detected"
    # one large band error bar counts fully
    tight = [mk(l, 10, 0.1) for l in (3.95, 4.0, 4.05, 4.45, 4.5, 4.55)]
    assert co2_verdict(tight + [mk(4.23, 10.3, 0.1), mk(4.26, 10.3, 0.1), mk(4.29, 10.0, 4.9)])["state"] != "detected"


_check_co2_verdict()


def overall(verdicts):
    """One verdict for the page: detected if any month shows it, quiet if every decisive month is quiet."""
    states = [v["state"] for v in verdicts.values()]
    return "detected" if "detected" in states else "quiet" if "quiet" in states else "unclear"


# ---------- publishing ----------

def photo(p, path, cache, grid=96, pix=6.15):
    """A north-up PNG centred on the comet: the comet stays in the middle while the stars slide past."""
    from reproject import reproject_interp
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [p["ra"], p["dec"]]
    w.wcs.crpix = [(grid + 1) / 2, (grid + 1) / 2]
    w.wcs.cdelt = [-pix / 3600, pix / 3600]
    with fits.open(cutout(p, cache)) as h:
        a, _ = reproject_interp((h["IMAGE"].data, WCS(h["IMAGE"].header)), w, shape_out=(grid, grid))
    v = a[np.isfinite(a)]
    c = grid // 2   # scale to the comet's own centre, not the brightest star, so a faint coma still shows
    lo, hi = np.percentile(v, 20), np.nanmax(a[c - 2:c + 3, c - 2:c + 3])
    g = np.arcsinh(np.clip((np.nan_to_num(a, nan=lo) - lo) / (hi - lo), 0, None) * 8) / np.arcsinh(8)
    Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8)[::-1]).save(path)   # FITS rows run bottom-up


def motion(rows):
    """Speed (arcsec/hour) and compass direction across the sky, from the first and last positions."""
    a, b = rows[0], rows[-1]
    dra = (((b["ra"] - a["ra"]) + 180) % 360 - 180) * np.cos(np.radians((a["dec"] + b["dec"]) / 2)) * 3600
    ddec = (b["dec"] - a["dec"]) * 3600
    hours = (b["t"] - a["t"]) * 24
    ang = np.degrees(np.arctan2(dra, ddec)) % 360   # 0 = north, 90 = east
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return round(float(np.hypot(dra, ddec) / hours), 1), names[int((ang + 22.5) // 45) % 8]


def month(mjd):
    return (datetime(1858, 11, 17) + timedelta(days=mjd)).strftime("%Y-%m")


def publish(name, rows, pts, cache, points_file="points.json"):
    """web/data/comets/<slug>/: up to three photos per month (its brightest good measurements) and comet.json."""
    out = ROOT / "web" / "data" / "comets" / slug(name)
    out.mkdir(parents=True, exist_ok=True)
    good = [p for p in pts if p["ok"]]
    months = {}
    for p in sorted(good, key=lambda p: p["t"]):
        months.setdefault(month(p["t"]), []).append(p)
    photos = []
    for m, sel in months.items():
        for p in sorted(sorted(sel, key=lambda q: -q["flux"])[:3], key=lambda q: q["t"]):
            file = f"{p['obs']}_{p['det']}.png"
            photo(p, out / file, cache)
            photos.append(dict(file=file, mjd=round(p["t"], 4), lam=round(p["lam"], 3), flux=round(p["flux"], 2),
                               ra=round(p["ra"], 5), dec=round(p["dec"], 5)))   # where it was cut out: the time-lapse centres there
    first = [e for e in rows if month(e["t"]) == month(rows[0]["t"])]
    speed, direction = motion(first)
    verdicts = {m: co2_verdict(sel) for m, sel in months.items()}
    comet = dict(
        id=name, name=name, kind="known", real=True, dir=slug(name),
        ra=round(first[len(first) // 2]["ra"], 3), dec=round(first[len(first) // 2]["dec"], 3),
        first_mjd=round(rows[0]["t"], 4), exposures=len(rows), measured=len(good),
        speed_arcsec_per_hour=speed, direction=direction, photos=photos,
        spectrum={m: [dict(lam=round(p["lam"], 4), flux=round(p["flux"], 3), err=round(p["err"], 3)) for p in sorted(sel, key=lambda q: q["lam"])]
                  for m, sel in months.items()},
        co2=verdicts, co2_verdict=overall(verdicts), points_file=points_file,   # the measurements behind this file
        source="SPHEREx spectral images from NASA/IPAC IRSA; positions from IRSA (3I/ATLAS) or JPL Horizons; photometry by bake/comet_spectrum.py",
    )
    if name == "3I/ATLAS":
        comet["about"] = "Interstellar comet, the third object known to come from outside the Solar System. SPHEREx observed it in August and December 2025."
    json.dump(comet, (out / "comet.json").open("w"), indent=1)
    print(f"  {name}: {len(photos)} photos, {len(good)} of {len(pts)} measurements usable, {speed} arcsec/hour {direction}, "
          f"CO2 {overall(verdicts)}: " + "; ".join(f"{m} {v['state']} ({v.get('excess', '-')} +- {v.get('sigma', '-')} mJy, "
                                                   f"{v['n_band']} band / {v['n_cont']} nearby)" for m, v in verdicts.items()), flush=True)


def run(name, publish_only=False):
    cache = cache_dir(name)
    cache.mkdir(parents=True, exist_ok=True)
    rows = exposures_3iatlas(cache) if name == "3I/ATLAS" else exposures_known(name, cache)
    print(f"{name}: {len(rows)} exposures with images", flush=True)
    points = cache / ("points-all-visits.json" if ALL_VISITS else "points.json")
    if publish_only:
        pts = json.loads(points.read_text())
    else:
        with ThreadPoolExecutor(4) as pool:
            pts = [p for p in pool.map(lambda e: measure(e, cache), rows) if p]
        json.dump(pts, points.open("w"), indent=1)
    publish(name, rows, pts, cache, points.name)


if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("--")]
    for n in names or ["3I/ATLAS"]:
        run(n, publish_only="--publish" in sys.argv)
