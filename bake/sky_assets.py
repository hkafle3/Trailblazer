"""Assets for the UI demo, from real SPHEREx data:
  web/data/sky.jpg             the SPHEREx all-sky picture as an oval (Mollweide), RA increasing to the left
  web/data/coverage.png        where and when SPHEREx photographed: a 720x360 RA/Dec grid (0.5 degree cells);
                                 R,G = day of the first photo since the start date (16 bit), B = photos (D1, capped 255),
                                 A = 255 where covered
  web/data/coverage.json       the start date and the number of days the grid spans
  web/data/visits.png          when each cell was visited: up to 6 visit start days per cell (a visit is a burst of
                               photos; 20+ quiet days start a new one). Same grid, stacked 3 tall: block k holds visit
                               2k in R,G and 2k+1 in B,A as day+1 (16 bit), 0 = no such visit
Same projection and HEALPix math as web/timelapse.html and web/sky.js.
Run: uv run -q --with numpy --with pillow python bake/sky_assets.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"
R2 = np.sqrt(2)


def moll_inverse(W, H):   # pixel centres -> ra, dec (degrees), mask of pixels inside the oval
    px, py = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    x, y = (px / W * 2 - 1) * 2 * R2, (1 - py / H * 2) * R2
    inside = (x / (2 * R2)) ** 2 + (y / R2) ** 2 <= 1
    th = np.arcsin(np.clip(y / R2, -1, 1))
    lon = np.pi * x / (2 * R2 * np.cos(th))
    lat = np.arcsin(np.clip((2 * th + np.sin(2 * th)) / np.pi, -1, 1))
    return np.degrees(-lon) % 360, np.degrees(lat), inside


def radec2xyf(ra, dec):   # radians -> face coords, vectorised port of sky.js
    z = np.sin(dec); za = np.abs(z); tt = (ra / (np.pi / 2)) % 4
    jp, jm = 0.5 + tt - z * 0.75, 0.5 + tt + z * 0.75
    ifp, ifm = np.floor(jp), np.floor(jm)
    face_eq = np.where(ifp == ifm, (ifp % 4) + 4, np.where(ifp < ifm, ifp % 4, ifm % 4 + 8))
    x_eq, y_eq = jm - ifm, 1 - (jp - ifp)
    ntt = np.minimum(3, np.floor(tt)); tp = tt - ntt; tmp = np.sqrt(3 * (1 - za))
    jp2, jm2 = tp * tmp, (1 - tp) * tmp
    x_p = np.where(z > 0, 1 - jm2, jp2); y_p = np.where(z > 0, 1 - jp2, jm2); f_p = np.where(z > 0, ntt, ntt + 8)
    eq = za <= 2 / 3
    return np.where(eq, x_eq, x_p), np.where(eq, y_eq, y_p), np.where(eq, face_eq, f_p).astype(int)


def spread(v):
    r = np.zeros_like(v)
    for i in range(8): r |= ((v >> i) & 1) << (2 * i)
    return r


def sky(W=2000, H=1000):
    src = np.asarray(Image.open(ROOT / "web/data/allsky3.png").convert("RGB"))
    cols, n = src.shape[1] // 64, 8   # order 3: 8x8 tiles per face, 64 px each
    ra, dec, inside = moll_inverse(W, H)
    x, y, f = radec2xyf(np.radians(ra), np.radians(dec))
    ix, iy = np.minimum(n - 1, np.floor(x * n)).astype(int), np.minimum(n - 1, np.floor(y * n)).astype(int)
    k = f * n * n + spread(ix) + 2 * spread(iy)
    u, v = x * n - ix, y * n - iy
    cc, rr = v, u   # tileUV(u, v) = (v, u)
    sx = (k % cols) * 64 + np.minimum(63, np.floor(cc * 64)).astype(int)
    sy = (k // cols) * 64 + np.minimum(63, np.floor(rr * 64)).astype(int)
    out = np.zeros((H, W, 3), np.uint8)
    out[inside] = src[sy[inside], sx[inside]]
    Image.fromarray(out).save(OUT / "sky.jpg", quality=88)


def coverage(step=0.5, samples=12):
    rows = [json.loads(l) for l in (ROOT / "bake/coverage/exposures.jsonl").open()]
    rows = [r for r in rows if len(r["poly"]) >= 8]
    t = np.array([r["t"] for r in rows]); t0 = np.floor(t.min())
    c = np.radians(np.array([r["poly"][:8] for r in rows]).reshape(-1, 4, 2))   # four corners (ra, dec)
    xyz = np.stack([np.cos(c[..., 1]) * np.cos(c[..., 0]), np.cos(c[..., 1]) * np.sin(c[..., 0]), np.sin(c[..., 1])], -1)
    W, H = int(360 / step), int(180 / step)
    first = np.full(W * H, np.inf); count = np.zeros(W * H, np.int64)
    s = (np.arange(samples) + 0.5) / samples
    seen = []   # (cell, day) pairs, for the visit list
    for a in s:   # bilinear points across each patch, on the sphere, so rotation and the RA wrap come out right
        w = s[None, :, None]
        e01 = (1 - w) * xyz[:, None, 0] + w * xyz[:, None, 1]   # (N, samples, 3) along one edge
        e32 = (1 - w) * xyz[:, None, 3] + w * xyz[:, None, 2]   # and along the opposite edge
        p = (1 - a) * e01 + a * e32
        p /= np.linalg.norm(p, axis=-1, keepdims=True)
        ra = np.degrees(np.arctan2(p[..., 1], p[..., 0])) % 360; dec = np.degrees(np.arcsin(p[..., 2]))
        cell = np.minimum(H - 1, ((90 - dec) / step).astype(int)) * W + np.minimum(W - 1, (ra / step).astype(int))
        np.minimum.at(first, cell.ravel(), np.repeat(t, samples))
        seen.append(np.unique(cell.ravel().astype(np.int64) * 1024 + np.repeat(np.floor(t - t0).astype(np.int64), samples)))
        if a == s[samples // 2]:   # one row of samples per patch for the count, so a patch counts about once per cell
            np.add.at(count, np.unique(np.stack([cell, np.arange(len(t))[:, None].repeat(samples, 1)], -1).reshape(-1, 2), axis=0)[:, 0], 1)
    days = np.where(np.isfinite(first), first - t0, 0).astype(np.uint16)
    img = np.zeros((H * W, 4), np.uint8)
    img[:, 0], img[:, 1] = days >> 8, days & 255
    img[:, 2] = np.minimum(255, count); img[:, 3] = np.where(np.isfinite(first), 255, 0)
    Image.fromarray(img.reshape(H, W, 4), "RGBA").save(OUT / "coverage.png")
    visits(np.unique(np.concatenate(seen)), W, H)
    span = int(days.max()) + 1
    json.dump({"mjd0": float(t0), "days": span, "images": len(rows), "step": step, "deep_fields": deep_fields(count, W, H, step)},
              (OUT / "coverage.json").open("w"))
    print(f"{len(rows)} images, MJD {t0} + {span} days, {np.isfinite(first).mean():.1%} of cells covered")


def deep_fields(count, W, H, step):
    """SPHEREx's two deep fields sit on the ecliptic poles, where every scan circle crosses. For each: its position and
    the median photos per 0.5-degree cell within 2 degrees, against the whole sky's median (D1 photos)."""
    dec = 90 - (np.arange(H) + 0.5) * step
    ra = (np.arange(W) + 0.5) * step
    RA, DEC = np.meshgrid(np.radians(ra), np.radians(dec))
    e = np.radians(23.4393)
    beta = np.degrees(np.arcsin(np.sin(DEC) * np.cos(e) - np.cos(DEC) * np.sin(e) * np.sin(RA))).ravel()
    covered = count > 0
    sky = float(np.median(count[covered]))
    out = []
    for name, ra0, dec0, sel in (("North ecliptic pole", 270.0, 66.5607, beta > 88), ("South ecliptic pole", 90.0, -66.5607, beta < -88)):
        here = float(np.median(count[covered & sel]))
        out.append(dict(name=name, ra=ra0, dec=dec0, photos=int(here), sky=int(sky)))
    return out


def visit_starts(codes, gap=20):
    """(cell, start day) of every visit. codes = cell * 1024 + day, sorted; 20+ days apart starts a new visit."""
    cell, day = codes // 1024, codes % 1024
    start = np.ones(len(codes), bool)
    start[1:] = (cell[1:] != cell[:-1]) | (day[1:] - day[:-1] >= gap)
    return cell[start], day[start]


# check: photos on days 0, 20, 41 are three visits (each step is 20+ days); days 3 and 10 in the next cell are one
_c, _d = visit_starts(np.array([7 * 1024 + 0, 7 * 1024 + 20, 7 * 1024 + 41, 8 * 1024 + 3, 8 * 1024 + 10]))
assert list(_c) == [7, 7, 7, 8] and list(_d) == [0, 20, 41, 3], (_c, _d)


def visits(codes, W, H, gap=20, keep=6):
    """codes = cell * 1024 + day, sorted. A cell's visit starts where the cell changes or 20+ days have passed.
"""
    sc, sd = visit_starts(codes, gap)
    k = np.arange(len(sc)) - np.searchsorted(sc, sc)   # visit number within its cell: 0, 1, 2, ...
    m = k < keep
    v = np.zeros((keep, W * H), np.int64)
    v[k[m], sc[m]] = sd[m] + 1
    img = np.zeros((keep // 2, H * W, 4), np.uint8)
    for b in range(keep // 2):
        a, c = v[2 * b], v[2 * b + 1]   # day+1 fits 10 bits; alpha stays 255 (browsers alter colour where it is not)
        img[b, :, 0], img[b, :, 1], img[b, :, 2], img[b, :, 3] = a & 255, c & 255, (a >> 8) | ((c >> 8) << 4), 255
    Image.fromarray(img.reshape(keep // 2 * H, W, 4), "RGBA").save(OUT / "visits.png")
    n = (v > 0).sum(0)
    print("visits per photographed cell:", {i: round(float((n[n > 0] == i).mean()), 3) for i in range(1, keep + 1)})


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    sky(); coverage()
