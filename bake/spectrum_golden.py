"""The time-lapse's star spectrum (web/live/cutout.js starMeasure), computed directly with astropy on one SPHEREx file,
for web/tests/spectrum_check.mjs --live to compare with. Writes web/tests/spectrum_golden.json.

Run: uv run -q --with astropy --with certifi sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python bake/spectrum_golden.py'
The same rules as starMeasure, written plainly: circle of 3 pixels, sky ring 9 to 14, the comet page's BAD flag bits
masked, flagged circle pixels counted as the circle's average, noise from VARIANCE plus the sky level's error."""
import json, urllib.request
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent
KEY = "dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits"
STARS = [("Gaia DR3 4472836047939582592, G 13.6", 269.43868, 4.78653), ("Gaia DR3 star, G 11.9", 269.44387, 4.79629)]
R_AP, R_IN, R_OUT = 3, 9, 14
BAD = sum(1 << b for b in (0, 1, 2, 6, 9, 10, 11, 15, 17))

path = ROOT / "bake/cache" / Path(KEY).name
if not path.exists():
    path.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve("https://nasa-irsa-spherex.s3.amazonaws.com/" + KEY, path)
out = {"key": KEY, "stars": []}
with fits.open(path) as h:
    img = h["IMAGE"].data.astype(float)
    var = h["VARIANCE"].data.astype(float)
    usable = np.isfinite(img) & ((h["FLAGS"].data.astype(np.int64) & BAD) == 0)
    w = WCS(h["IMAGE"].header)
    for name, ra, dec in STARS:
        x, y = (float(v) for v in w.world_to_pixel_values(ra, dec))
        yy, xx = np.indices(img.shape)
        r = np.hypot(xx - x, yy - y)
        circle = r <= R_AP
        ap, ring = circle & usable, (r >= R_IN) & (r <= R_OUT) & usable
        sky = np.median(img[ring])
        sky_err = 1.2533 * np.std(img[ring]) / np.sqrt(ring.sum())
        fill = circle.sum() / ap.sum()
        flux = (img[ap] - sky).sum() * fill
        noise = np.sqrt(var[ap].sum() * fill ** 2 + (circle.sum() * sky_err) ** 2)
        out["stars"].append({"name": name, "ra": ra, "dec": dec, "x": x, "y": y, "flux": flux, "noise": noise, "sky": float(sky),
                             "circle": int(circle.sum()), "usable": int(ap.sum())})
        print(f"{name}: x {x:.3f} y {y:.3f}  flux {flux:.3f}  noise {noise:.4f}  (image units, MJy/sr summed)  {ap.sum()}/{circle.sum()} usable")
(ROOT / "web/tests/spectrum_golden.json").write_text(json.dumps(out, indent=1) + "\n")
