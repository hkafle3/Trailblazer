"""Bake the first photo's patch of sky as SPHEREx really saw it in each of its six bands of infrared, for the colors
beat of the 3D intro (web/intro.js) -> web/data/intro/bands.jpg, and "bands" in web/data/intro/photo.json.
  bands.jpg   five pictures in a grid of three by two (the last place is empty): bands 2 to 6 (1.1 to 5.0 microns), left to
              right, top row first, each the square of tile 0 exactly as photo.jpg is (pixel (i, j) is direction
              c + u e + v f). Band 1 is the first photo itself (photo.jpg). Every other band is a mosaic of real level 2
              exposures from that band's detector that cover the square, zodiacal light model subtracted, each exposure
              levelled to its own sky and its flagged pixels (cosmic rays, dead and hot pixels) filled from around them. All are stretched to band 1's own white point, so a thing that is fainter in a
              band is drawn fainter; each band's black point is its own sky plus FLOOR times its own noise (the long
              bands are noisier, and at band 1's black point their noise would read as stars). Where no exposure covers
              the square a band is black, and "cover" says how much is covered.
SPHEREx's filters change wavelength across each detector, so within one band's picture the wavelength still varies from
place to place inside that band's range: these are six real ranges of color, not 102 single colors.
The exposures are found with the app's own image search (needs the app up: npm run dev), their headers are read from
NASA's S3 copy, and the ones chosen (the fewest that cover the square, nearest in time to the first photo first) are
downloaded whole, 65 MB each, into bake/cache/intro/bands/.
Run: uv run -q --with astropy --with numpy --with pillow --with certifi python bake/intro_bands.py [base url]"""
import json, math, ssl, struct, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import certifi
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
REPO = Path(__file__).resolve().parent.parent
OUT, CACHE = REPO / "web/data/intro", REPO / "bake/cache/intro"
S3 = "https://nasa-irsa-spherex.s3.amazonaws.com/"
RANGES = [[.75, 1.11], [1.10, 1.65], [1.64, 2.44], [2.40, 3.84], [3.81, 4.43], [4.41, 5.01]]   # microns, detectors 1 to 6 (web/live/spectral.js)
N, G, FLOOR, EPS = 1024, 96, 2.0, math.radians(23.4392911)   # N: each band's picture; G: the grid coverage is counted on
CTX = ssl.create_default_context(cafile=certifi.where())
BAD = 1 << 0 | 1 << 1 | 1 << 2 | 1 << 6 | 1 << 19   # the archive's own flags for a pixel that is not sky: transient (a cosmic ray), overflow, a failed fit, not working, outlier.
# Two in three of the bright specks in bands 4 to 6 were such pixels: they did not repeat in any other band. They take the mean of the sky around them.


def get(url, headers=None, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "intro-bake/1", **(headers or {})}), timeout=600, context=CTX) as r: return r.read()
        except Exception:
            if k == tries - 1: raise


def eq(v):
    x, y, z = v[..., 0], v[..., 1], v[..., 2]; ye, ze = math.cos(EPS) * y - math.sin(EPS) * z, math.sin(EPS) * y + math.cos(EPS) * z
    return np.degrees(np.arctan2(ye, x)) % 360, np.degrees(np.arcsin(ze / np.sqrt(x * x + ye * ye + ze * ze)))


t0, *q = struct.unpack_from("<f6h", (OUT / "tiles.bin").read_bytes(), 0)
c, e = np.array(q[:3]) / 32767, np.array(q[3:]) / 32767 / 16; f = np.cross(c, e)
def sky(n):   # RA, Dec of an n by n grid over the tile's square
    g = (np.arange(n) + .5) / n * 2 - 1; U, V = np.meshgrid(g, g); return eq(c + U[..., None] * e + V[..., None] * f)

doc = json.loads((OUT / "photo.json").read_text())
ra_g, dec_g = sky(G)
hdr_f = CACHE / "bands/headers.json"; hdr_f.parent.mkdir(parents=True, exist_ok=True)
headers = json.loads(hdr_f.read_text()) if hdr_f.exists() else {}

def header(key):   # the IMAGE header of an exposure: the first 35 KB of the file
    if key not in headers: headers[key] = get(S3 + key, {"Range": "bytes=2880-37439"}).decode("ascii", "replace")
    return fits.Header.fromstring(headers[key])

def covers(key):   # which places of the grid are on this exposure's detector, away from its edge
    px, py = WCS(header(key)).all_world2pix(ra_g, dec_g, 0, quiet=True)
    return (px > 4) & (px < 2035) & (py > 4) & (py < 2035)

def load(key, n=2 * N):   # the exposure on the square: sky brightness in MJy/sr with its own sky level taken off, NaN where it has nothing
    p = CACHE / "bands" / key.split("/")[-1]
    if not p.exists(): print("fetching", p.name, flush=True); p.write_bytes(get(S3 + key))
    with fits.open(p) as h:
        w = WCS(h["IMAGE"].header); img = h["IMAGE"].data.astype(np.float32) - h["ZODI"].data.astype(np.float32)
        if "D1_" not in p.name: img[(h["FLAGS"].data & BAD) != 0] = np.nan   # band 1 is left as bake/intro_photo.py makes photo.jpg
    px, py = w.all_world2pix(*sky(n), 0, quiet=True); ok = (px > 1) & (px < 2038) & (py > 1) & (py < 2038)
    ix, iy = np.clip(np.floor(px).astype(int), 0, 2038), np.clip(np.floor(py).astype(int), 0, 2038); fx, fy = np.clip(px - ix, 0, 1), np.clip(py - iy, 0, 1)
    with np.errstate(invalid="ignore"): pic = (img[iy, ix] * (1 - fx) + img[iy, ix + 1] * fx) * (1 - fy) + (img[iy + 1, ix] * (1 - fx) + img[iy + 1, ix + 1] * fx) * fy
    pic[~ok] = np.nan; pic -= np.nanpercentile(pic, 45)
    with np.errstate(all="ignore"): return np.nanmean(pic.reshape(N, 2, N, 2), (1, 3))   # sampled at about the detector's own pixels, then two by two averaged: no moire

bands, pics = [], []
for d in range(1, 7):
    if d == 1: keys = {doc["photo"]["obs"]: (doc["photo"]["mjd"], f"dr1/level2/2025W17_4B/l2b-v27-2026-196/1/level2_{doc['photo']['obs']}D1_spx_l2b-v27-2026-196.fits")}
    else:
        keys = {}
        for u in (-.7, 0, .7):
            for v in (-.7, 0, .7):
                ra, dec = eq(c + u * e + v * f)
                for im in json.loads(get(f"{BASE}/api/images?ra={float(ra):.4f}&dec={float(dec):.4f}&det=D{d}&v=2"))["images"]: keys[im["obs"]] = (im["t"], im["key"])
    with ThreadPoolExecutor(12) as ex: list(ex.map(header, [k for _, k in keys.values()]))
    hdr_f.write_text(json.dumps(headers))
    cov = {o: covers(k) for o, (_, k) in keys.items()}
    got, chosen = np.zeros((G, G), bool), []
    while got.mean() < .995:   # the exposure that adds the most; among near equals, the one nearest in time to the first photo
        gain = {o: (m & ~got).mean() for o, m in cov.items() if o not in chosen}; top = max(gain.values(), default=0)
        if top < .004: break
        o = min((o for o, g in gain.items() if g > top - .02), key=lambda o: abs(keys[o][0] - doc["photo"]["mjd"])); chosen.append(o); got |= cov[o]
    pic = np.full((N, N), np.nan, np.float32)
    for o in chosen:
        one = load(keys[o][1]); pic = np.where(np.isnan(pic), one, pic)
    for _ in range(4):   # holes (saturated star cores, bad pixels) take the mean of what is around them
        bad = ~np.isfinite(pic); p = np.pad(pic, 1, constant_values=np.nan)
        with np.errstate(all="ignore"): m = np.nanmean(np.stack([p[1 + a:p.shape[0] - 1 + a, 1 + b:p.shape[1] - 1 + b] for a in (-1, 0, 1) for b in (-1, 0, 1)]), 0)
        pic[bad] = m[bad]
    pics.append(pic)
    bands.append(dict(det=d, um=RANGES[d - 1], cover=round(float(np.isfinite(pic).mean()), 3), obs=chosen, days=sorted({round(keys[o][0] - 60789, 1) for o in chosen})))
    print(f"band {d}: {len(keys)} exposures touch the square, {len(chosen)} chosen, cover {bands[-1]['cover']}, days {bands[-1]['days']}", flush=True)

hi = np.nanpercentile(pics[0], 99.93)   # band 1's own white point, as bake/intro_photo.py stretches photo.jpg
sheet = np.zeros((2 * N, 3 * N), np.uint8)
for k, (p, b) in enumerate(zip(pics[1:], bands[1:])):
    med = np.nanmedian(p); b["noise"] = round(float(1.4826 * np.nanmedian(np.abs(p - med)) / hi), 5); lo = FLOOR * b["noise"] * hi
    sheet[(k // 3) * N:(k // 3 + 1) * N, (k % 3) * N:(k % 3 + 1) * N] = np.clip(np.arcsinh(np.clip((np.nan_to_num(p, nan=0.0) - lo) / (hi - lo), 0, None) * 10) / np.arcsinh(10), 0, 1) * 255
Image.fromarray(sheet).save(OUT / "bands.jpg", quality=84, optimize=True)
doc["bands"] = bands
(OUT / "photo.json").write_text(json.dumps(doc, separators=(",", ":")))
print(f"bands.jpg {(OUT / 'bands.jpg').stat().st_size / 1e6:.2f} MB")
