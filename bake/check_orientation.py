"""Which HiPS tile orientation is right? Neighboring tiles must agree along shared edges.
Fetches a 4x4 block of sharp order-5 SPHEREx tiles in the Milky Way (HEALPix face 5) and scores
each of the 8 orientations in index.html's tileUV by how well the touching edge rows correlate.
Run: uv run --with pillow --with numpy --with certifi python bake/check_orientation.py
"""
import io, os, ssl, urllib.request
import certifi, numpy as np
from PIL import Image

HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
ORDER, T, FACE, R = 5, 512, 5, range(14, 18)
nside = 1 << ORDER
ctx = ssl.create_default_context(cafile=certifi.where())

def spread(v): return sum(((v >> i) & 1) << (2 * i) for i in range(ORDER))
def ipix(ix, iy): return FACE * nside * nside + spread(ix) + (spread(iy) << 1)

tiles = {}
for ix in R:
    for iy in R:
        k = ipix(ix, iy)
        data = urllib.request.urlopen(f"{HIPS}/Norder{ORDER}/Dir{k // 10000 * 10000}/Npix{k}.png", context=ctx, timeout=60).read()
        tiles[ix, iy] = np.asarray(Image.open(io.BytesIO(data)).convert("L"), float)

def tile_uv(u, v, o):
    c, r = 1 - v, 1 - u
    if o & 1: c, r = r, c
    if o & 2: c = 1 - c
    if o & 4: r = 1 - r
    return c, r

t = (np.arange(T) + 0.5) / T
def edge(img, u, v, o):
    c, r = tile_uv(u, v, o)
    return img[np.clip((r * T).astype(int), 0, T - 1), np.clip((c * T).astype(int), 0, T - 1)]

lo, hi = np.full(T, 0.5 / T), np.full(T, 1 - 0.5 / T)
scores = {}
for o in range(8):
    cs = []
    for (ix, iy), a in tiles.items():
        if (ix + 1, iy) in tiles: cs.append(np.corrcoef(edge(a, hi, t, o), edge(tiles[ix + 1, iy], lo, t, o))[0, 1])
        if (ix, iy + 1) in tiles: cs.append(np.corrcoef(edge(a, t, hi, o), edge(tiles[ix, iy + 1], t, lo, o))[0, 1])
    scores[o] = float(np.nanmedian(cs))
for o, s in sorted(scores.items(), key=lambda x: -x[1]): print(f"orientation {o}: median edge correlation {s:.3f}")
best = max(scores, key=scores.get)
second = sorted(scores.values())[-2]
a = tiles[15, 15]
ceiling = float(np.median([np.corrcoef(a[i], a[i + 1])[0, 1] for i in range(0, T - 1, 16)]))  # two adjacent rows inside one tile
print(f"ceiling (adjacent rows inside a tile): {ceiling:.3f}")
assert scores[best] > 0.8 * ceiling and second < 0.6 * scores[best], "no clear winner"
assert best == 6, f"index.html assumes orientation 6, data says {best}"
print("PASS: orientation", best)
