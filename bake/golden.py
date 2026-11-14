"""Reference answers for the browser pipeline, computed with astropy -> web/tests/golden.json, web/data/wavemaps.json.

For real exposures already in bake/cache: the target's full-frame pixel (0-based x, y) from the IMAGE header
read straight from NASA's public S3 copy, and the wavelength SPHEREx saw there (astropy WCS key W on the
cutout). The browser must reproduce both (web/tests/golden.html). Also writes each detector's wavelength map
(WCS-WAVE: X, Y grid in 1-based full-frame pixels, wavelength and bandwidth in um), which the app ships once.
Run: uv run --with astropy --with certifi python bake/golden.py
"""
import glob, json, logging, os, re, ssl, urllib.request
from pathlib import Path

import certifi
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

logging.getLogger("astropy").setLevel(logging.ERROR)
ROOT = Path(__file__).resolve().parent.parent
S3 = "https://nasa-irsa-spherex.s3.amazonaws.com/"
CTX = ssl.create_default_context(cafile=certifi.where())
NAME = re.compile(r"(level2_(\d{4}W\d+_\w+?)_\d+_\d+D(\d)_spx_(l2b-v\d+-\d{4}-\d+))_(-?[\d.]+)_(-?[\d.]+)\.fits$")


def s3_header(key, hdu=1):
    """Header of HDU number `hdu`, from range reads of the S3 file (headers are 2880-byte blocks ending in END)."""
    off = 0
    for i in range(hdu + 1):
        raw = b""
        while b"END" + b" " * 77 not in [raw[j:j + 80] for j in range(0, len(raw), 80)]:
            req = urllib.request.Request(S3 + key, headers={"Range": f"bytes={off + len(raw)}-{off + len(raw) + 2879}"})
            raw += urllib.request.urlopen(req, context=CTX, timeout=60).read()
        h = fits.Header.fromstring(raw.decode("ascii"))
        size = abs(h["BITPIX"]) // 8 * int(np.prod([h[f"NAXIS{n}"] for n in range(1, h["NAXIS"] + 1)] or [0])) + h.get("PCOUNT", 0)
        if i == hdu:
            return h
        off += len(raw) + (size + 2879) // 2880 * 2880


out, maps = [], {}
for f in sorted(glob.glob(str(ROOT / "bake/cache/*.fits"))):
    m = NAME.search(os.path.basename(f))
    if not m:
        continue
    stem, week, det, ver, ra, dec = m.groups()
    ra, dec = float(ra), float(dec)
    with fits.open(f) as h:
        cx, cy = WCS(h["IMAGE"].header).world_to_pixel_values(ra, dec)
        spectral = WCS(h["IMAGE"].header, fobj=h, key="W")
        spectral.sip = None   # IRSA: SIP distortion must be off for the spectral WCS (irsa-tutorials spherex_intro)
        lam, bw = spectral.pixel_to_world_values(cx, cy)
        t = h["WCS-WAVE"].data
        if f"D{det}" not in maps:
            v = t["VALUES"][0]   # numpy shape (ny, nx, 2): the FITS -TAB array reversed; [..., 0] wavelength, [..., 1] bandwidth
            maps[f"D{det}"] = dict(x=t["X"][0].tolist(), y=t["Y"][0].tolist(), lam=v[..., 0].tolist(), bw=v[..., 1].tolist())
    per_det = sum(o["det"] == f"D{det}" for o in out)
    if per_det >= 6:   # 6 exposures per detector is enough
        continue
    key = f"dr1/level2/{week}/{ver}/{det}/{stem}.fits"
    x, y = WCS(s3_header(key)).world_to_pixel_values(ra, dec)
    out.append(dict(key=key, det=f"D{det}", ra=ra, dec=dec, x=float(x), y=float(y), lam=float(lam), bw=float(bw)))
    print(f"D{det} {stem[-40:]}: pixel {float(x):.3f}, {float(y):.3f}  lambda {float(lam):.4f} um", flush=True)

(ROOT / "web/tests/golden.json").write_text(json.dumps(out, indent=1))
(ROOT / "web/data/wavemaps.json").write_text(json.dumps(maps))
print(f"{len(out)} golden exposures, wavelength maps for {sorted(maps)}")
