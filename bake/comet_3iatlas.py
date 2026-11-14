"""Real SPHEREx data for interstellar comet 3I/ATLAS -> web/data/comets/3i-atlas/ (photos + comet.json).

IRSA lists every SPHEREx exposure that contains the comet, with its predicted position in each
(https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/): 259 exposures, August and December 2025.
For each one we cut out a patch centred on the comet, measure its brightness in a circle minus the sky around
it, and read the wavelength SPHEREx saw at that spot. Each exposure is a different wavelength, so the
measurements together are the comet's spectrum. IRSA warns the comet is faint at many wavelengths and
spread out (not a point), so the circle is wide and every point carries its noise.

Run: uv run -q --with astropy --with pillow --with certifi --with reproject sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python -u bake/comet_3iatlas.py'
"""
import json, re, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from flipbook import get   # retries IRSA's intermittent errors

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "bake" / "cache" / "3iatlas"
OUT = ROOT / "web" / "data" / "comets" / "3i-atlas"
DOCS = "https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/"
SIZE = 600                       # cutout width, arcsec
R_AP, R_IN, R_OUT = 4, 9, 14     # aperture and sky annulus radii, pixels (SPHEREx pixels are 6.15 arcsec)
SR_PER_PIX = (6.15 / 206265) ** 2
# FLAGS bits that mean "this pixel's value is not trustworthy" (bit numbers from the FLAGS header, MP_*):
# transient, overflow, processing error, non-functional, missing data, hot, cold, nonlinear, persistence.
# OUTLIER (19) and SOURCE (21) are left alone: a moving comet's own coma trips both.
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17))


def exposures():
    """One row per exposure: id, detector, time, comet position, image URL (from IRSA's download script)."""
    for name in ("obscore_3I_Atlas.vot", "3IATLASImages-curl.sh"):
        if not (CACHE / name).exists():
            (CACHE / name).write_bytes(get(DOCS + name))
    urls = re.findall(r"download_file '([^']+\.fits)'", (CACHE / "3IATLASImages-curl.sh").read_text())
    by_file = {u.rsplit("/", 1)[-1]: u for u in urls}
    t = Table.read(CACHE / "obscore_3I_Atlas.vot")
    rows = []
    for r in t:
        det = str(r["spherex_detector"]).strip()
        det = det if det.startswith("D") else f"D{det}"
        key = f"level2_{r['obs_id']}{det}_"
        url = next((u for f, u in by_file.items() if f.startswith(key)), None)
        if url:
            rows.append(dict(obs=str(r["obs_id"]), det=det, t=float(r["t_min"]),
                             ra=float(r["comet_ra"]), dec=float(r["comet_dec"]), url=url))
    return sorted(rows, key=lambda e: e["t"])


def cutout(e):
    f = CACHE / f"{e['obs']}_{e['det']}_{SIZE}.fits"
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


def measure(e):
    """Brightness (mJy) of the comet in a circle, minus the median sky in a ring, plus wavelength (um)."""
    with fits.open(cutout(e)) as h:
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
    # (25-99%), and a saturated or bad pixel shows up as a huge error. Checked by hand on the August D5 points.
    ok = noise < 5 and not (flux > 3 * noise and peak_frac > 0.2)
    return dict(e, lam=float(lam), bw=float(bw), flux=float(flux), err=float(noise), x=float(x), y=float(y),
                peak_frac=peak_frac, ok=bool(ok))


def co2_excess(points):
    """Mean brightness at the CO2 band (4.20-4.32 um) over the mean of nearby continuum (3.9-4.15, 4.4-4.7 um)."""
    band = [p["flux"] for p in points if 4.20 <= p["lam"] <= 4.32]
    cont = [p["flux"] for p in points if 3.9 <= p["lam"] <= 4.15 or 4.4 <= p["lam"] <= 4.7]
    if len(band) < 2 or len(cont) < 3:
        return None
    return float(np.median(band)), float(np.median(cont)), len(band), len(cont)


def photo(p, name, grid=96, pix=6.15):
    """A north-up PNG centred on the comet: the comet stays in the middle while the stars slide past."""
    from reproject import reproject_interp
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [p["ra"], p["dec"]]
    w.wcs.crpix = [(grid + 1) / 2, (grid + 1) / 2]
    w.wcs.cdelt = [-pix / 3600, pix / 3600]
    with fits.open(cutout(p)) as h:
        a, _ = reproject_interp((h["IMAGE"].data, WCS(h["IMAGE"].header)), w, shape_out=(grid, grid))
    v = a[np.isfinite(a)]
    c = grid // 2   # scale to the comet's own centre, not the brightest star, so a faint coma still shows
    lo, hi = np.percentile(v, 20), np.nanmax(a[c - 2:c + 3, c - 2:c + 3])
    g = np.arcsinh(np.clip((np.nan_to_num(a, nan=lo) - lo) / (hi - lo), 0, None) * 8) / np.arcsinh(8)
    Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8)[::-1]).save(OUT / name)   # FITS rows run bottom-up


def motion(rows):
    """Speed (arcsec/hour) and compass direction across the sky, from IRSA's predicted positions."""
    a, b = rows[0], rows[-1]
    dra = (b["ra"] - a["ra"]) * np.cos(np.radians((a["dec"] + b["dec"]) / 2)) * 3600
    ddec = (b["dec"] - a["dec"]) * 3600
    hours = (b["t"] - a["t"]) * 24
    ang = np.degrees(np.arctan2(dra, ddec)) % 360   # 0 = north, 90 = east
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return round(float(np.hypot(dra, ddec) / hours), 1), names[int((ang + 22.5) // 45) % 8]


def publish(rows, pts):
    """web/data/comets/3i-atlas/: six photos (the three brightest good measurements per month) and comet.json."""
    OUT.mkdir(parents=True, exist_ok=True)
    good = [p for p in pts if p["ok"]]
    months = {"2025-08": [p for p in good if p["t"] < 61000], "2025-12": [p for p in good if p["t"] > 61000]}
    photos = []
    for m, sel in months.items():
        for p in sorted(sorted(sel, key=lambda q: -q["flux"])[:3], key=lambda q: q["t"]):
            name = f"{p['obs']}_{p['det']}.png"
            photo(p, name)
            photos.append(dict(file=name, mjd=round(p["t"], 4), lam=round(p["lam"], 3), flux=round(p["flux"], 2)))
    aug = [e for e in rows if e["t"] < 61000]
    speed, direction = motion(aug)
    comet = dict(
        id="3I/ATLAS", name="3I/ATLAS", kind="known", real=True,
        about="Interstellar comet, the third object known to come from outside the Solar System. SPHEREx observed it in August and December 2025.",
        ra=round(aug[len(aug) // 2]["ra"], 3), dec=round(aug[len(aug) // 2]["dec"], 3),
        first_mjd=round(rows[0]["t"], 4), exposures=len(rows), measured=len(good),
        speed_arcsec_per_hour=speed, direction=direction,
        photos=photos,
        spectrum={m: [dict(lam=round(p["lam"], 4), flux=round(p["flux"], 3), err=round(p["err"], 3)) for p in sorted(sel, key=lambda q: q["lam"])]
                  for m, sel in months.items()},
        co2={m: co2_excess(sel) for m, sel in months.items()},
        source="SPHEREx QR2 spectral images listed by IRSA (irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/); photometry by bake/comet_3iatlas.py",
    )
    json.dump(comet, (OUT / "comet.json").open("w"), indent=1)
    print(f"wrote {len(photos)} photos and comet.json: {speed} arcsec/hour {direction}", flush=True)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    rows = exposures()
    print(f"{len(rows)} exposures with images", flush=True)
    if "--publish" in sys.argv:   # redo photos and comet.json from the saved measurements
        publish(rows, json.load((CACHE / "points.json").open()))
        sys.exit()
    if "--test" in sys.argv:   # signal test: August, detectors D5 (3.8-4.4 um, holds CO2 at 4.26) and D6
        rows = [e for e in rows if e["t"] < 61000 and e["det"] in ("D5", "D6")]
        print(f"signal test on {len(rows)} August D5/D6 exposures", flush=True)
    with ThreadPoolExecutor(4) as pool:
        pts = [p for p in pool.map(measure, rows) if p]
    good = [p for p in pts if p["ok"]]
    print(f"{len(good)} of {len(pts)} measurements pass the star and bad-pixel check", flush=True)
    for name, sel in (("August", [p for p in good if p["t"] < 61000]), ("December", [p for p in good if p["t"] > 61000])):
        x = co2_excess(sel)
        print(name, len(sel), "points;", "CO2 band median %.2f mJy vs continuum %.2f mJy (%d vs %d points)" % x if x else "not enough points near 4.26 um")
    json.dump(pts, (CACHE / ("points-test.json" if "--test" in sys.argv else "points.json")).open("w"), indent=1)
    if "--test" not in sys.argv:
        publish(rows, pts)
