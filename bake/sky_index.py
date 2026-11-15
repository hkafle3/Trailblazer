"""Build the sky index /api/images reads instead of IRSA's SIA search: which SPHEREx level-2 images cover a point.

Input: header rows from bake/sky_headers.py (one per image file). Output: one binary file per detector, rows bucketed by
sky cell, read by worker/src/sky_index.js. Each image is its footprint polygon, the four corners of the outer pixel
edges (pixel 0.5 and 2040.5) joined by great circles. That is IRSA's own s_region, and SIA's point search matches it
(see the evaluator, bake/sky_index_eval.py). A point counts when it lies within SIA's 0.001 degree circle of the polygon.

  uv run --with numpy python bake/sky_index.py HEADERS.jsonl OUT_DIR

File layout (little endian), version 1:
  "SKYI" u32 version, u32 detector, u32 cells, u32 rows, u32 folder_bytes
  u32 first_row[cells + 1]            rows of cell c are first_row[c] .. first_row[c + 1] - 1
  folder table: folder_bytes of UTF-8, folders joined by "\n" (release/level2/period/version, e.g. dr1/level2/2025W17_4B/l2b-v27-2026-196)
  padding to a multiple of 8, then rows of ROW bytes each:
    f64 t (MJD-BEG), f32 x 12 (unit normals of the four edges, inside is n . p >= 0), u16 folder, u16 seq, u8 sub, u8 coll, u16 0
The image's obs_id is <period>_<seq:04>_<sub>, its key <folder>/<det>/level2_<obs_id>D<det>_spx_<version>.fits.
"""
import json, math, re, struct, sys
from pathlib import Path

import numpy as np

COLLS = ["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]
ROW = 64
PAD = 0.02   # degrees added around each footprint when choosing its cells: covers the 0.001 search circle and float error
LO, HI = 0.5, 2040.5   # outer pixel edges in FITS pixel coordinates (NAXIS 2040)
KEY_RE = re.compile(r"^((dr1|qr3)/level2/(\d{4}W\d\d_\d[A-Z])/([^/]+))/([1-6])/level2_\3_(\d{4})_(\d)D\5_spx_\4\.fits$")

# Sky cells: 51 bands of Dec from the north pole, each cut into about 3.5 degree steps of RA (one SPHEREx patch).
# The same grid as the heat map in worker/src/index.js; worker/src/sky_index.js has the JavaScript twin.
BANDS = 51
DEC_STEP = 180 / BANDS
GRID = []
_k = 0
for _i in range(BANDS):
    _n = max(1, round(360 * math.cos(math.radians(90 - (_i + .5) * DEC_STEP)) / 3.5))
    GRID.append((_k, _n)); _k += _n
CELLS = _k


def cell_at(ra, dec):
    i = min(BANDS - 1, int((90 - dec) // DEC_STEP)); k, n = GRID[i]
    return k + min(n - 1, int(ra / 360 * n))


def collection(key, flags):
    return COLLS[(key.startswith("qr3/")) + 2 * flags.startswith("deep_")]


def unit(ra, dec):
    a, d = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)], -1)


def pix2sky(H, x, y):
    """Vectorised sky_headers.pix2sky: H is a dict of arrays (one entry per image), x and y broadcast against them."""
    u, v = x - H["CRPIX1"], y - H["CRPIX2"]
    f = sum(H[f"A_{p}_{q}"] * u ** p * v ** q for p in range(4) for q in range(4 - p))
    g = sum(H[f"B_{p}_{q}"] * u ** p * v ** q for p in range(4) for q in range(4 - p))
    u, v = u + f, v + g
    xi = np.radians(H["PC1_1"] * u + H["PC1_2"] * v)
    eta = np.radians(H["PC2_1"] * u + H["PC2_2"] * v)
    a0, d0 = np.radians(H["CRVAL1"]), np.radians(H["CRVAL2"])
    den = np.cos(d0) - eta * np.sin(d0)
    return np.degrees(a0 + np.arctan2(xi, den)) % 360, np.degrees(np.arctan2(np.sin(d0) + eta * np.cos(d0), np.hypot(xi, den)))


def load(path):
    """Headers -> (meta list, H dict of arrays). Every image must be survey science with a TAN-SIP order 3 WCS."""
    meta, cols = [], {}
    for line in open(path):
        r = json.loads(line); h = r["h"]
        assert h["CTYPE1"] == "RA---TAN-SIP" and h["A_ORDER"] == 3 and h["B_ORDER"] == 3 and h["LONPOLE"] == 180, r["key"]
        assert h["CDELT1"] == 1 and h["CDELT2"] == 1 and h["NAXIS1"] == 2040 and h["NAXIS2"] == 2040, r["key"]
        m = KEY_RE.match(r["key"]); assert m and m.group(5) == str(h["DETECTOR"]), r["key"]
        assert h["OBSID"] == f"{m.group(3)}_{m.group(6)}_{m.group(7)}", r["key"]
        meta.append({"key": r["key"], "obs": h["OBSID"], "t": h["MJD-BEG"], "det": h["DETECTOR"], "folder": m.group(1),
                     "seq": int(m.group(6)), "sub": int(m.group(7)), "coll": collection(r["key"], h["SPS_FLAGS"])})
        for k in ["CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "PC1_1", "PC1_2", "PC2_1", "PC2_2"] + \
                 [f"{c}_{p}_{q}" for c in "AB" for p in range(4) for q in range(4 - p)]:
            cols.setdefault(k, []).append(h.get(k, 0.0))
    return meta, {k: np.array(v)[:, None] for k, v in cols.items()}


def corners(H):
    """(N, 4, 3) unit vectors of the pixel-edge corners, in s_region order: (lo,lo) (hi,lo) (hi,hi) (lo,hi)."""
    xs, ys = np.array([LO, HI, HI, LO]), np.array([LO, LO, HI, HI])
    return unit(*pix2sky(H, xs, ys))


def normals(C):
    """(N, 4, 3) unit normals of the polygon edges, oriented so the polygon's centre is on the positive side."""
    n = np.cross(C, np.roll(C, -1, axis=1))
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    centre = C.sum(1, keepdims=True)
    return n * np.sign((n * centre).sum(-1, keepdims=True))


def inside(N, p, r_deg=0.001):
    """Boolean per image: point p (unit vector) within r_deg of the polygon (each edge's half-space, widened by r)."""
    return ((N @ p) >= -math.sin(math.radians(r_deg))).all(-1)


def cells_of(H, C, N):
    """For each image, the cells its footprint (padded by PAD) can touch: a padded Dec/RA box around its edges."""
    t = np.linspace(0, 1, 33)
    # points along the four polygon edges (great circles) and along the true pixel edges (SIP): both lie in the box
    E = [C[:, i, None, :] * (1 - t)[:, None] + C[:, (i + 1) % 4, None, :] * t[:, None] for i in range(4)]
    E = np.concatenate(E, 1); E /= np.linalg.norm(E, axis=-1, keepdims=True)
    ra, dec = np.degrees(np.arctan2(E[..., 1], E[..., 0])) % 360, np.degrees(np.arcsin(E[..., 2]))
    edge = np.concatenate([np.full(33, LO), np.linspace(LO, HI, 33), np.full(33, HI), np.linspace(LO, HI, 33)])
    other = np.concatenate([np.linspace(LO, HI, 33), np.full(33, HI), np.linspace(LO, HI, 33), np.full(33, LO)])
    r2, d2 = pix2sky(H, edge, other)
    ra, dec = np.concatenate([ra, r2], 1), np.concatenate([dec, d2], 1)
    ref = ra[:, :1]
    dra = (ra - ref + 180) % 360 - 180
    dmin, dmax = dec.min(1) - PAD, dec.max(1) + PAD
    north = inside(N, np.array([0, 0, 1.0]), PAD); south = inside(N, np.array([0, 0, -1.0]), PAD)
    dmax[north] = 90; dmin[south] = -90
    out = []
    for i in range(len(C)):
        cosd = max(math.cos(math.radians(max(abs(dmin[i]), abs(dmax[i])))), 1e-9)
        full = north[i] or south[i] or dmax[i] >= 89.9 or dmin[i] <= -89.9
        lo_ra, hi_ra = ref[i, 0] + dra[i].min() - PAD / cosd, ref[i, 0] + dra[i].max() + PAD / cosd
        full = full or hi_ra - lo_ra >= 180
        s = set()
        for b in range(max(0, int((90 - min(90, dmax[i])) // DEC_STEP)), min(BANDS - 1, int((90 - max(-90, dmin[i])) // DEC_STEP)) + 1):
            k, n = GRID[b]
            if full or n == 1:
                s.update(range(k, k + n)); continue
            j0, j1 = math.floor(lo_ra / 360 * n), math.floor(hi_ra / 360 * n)
            s.update(k + j % n for j in range(j0, min(j1, j0 + n - 1) + 1))
        out.append(s)
    return out


def build(meta, H, out_dir):
    C = corners(H); N = normals(C)
    cells = cells_of(H, C, N)
    det = meta[0]["det"]
    folders = sorted({m["folder"] for m in meta}); fidx = {f: i for i, f in enumerate(folders)}
    by_cell = [[] for _ in range(CELLS)]
    for i, s in enumerate(cells):
        for c in s:
            by_cell[c].append(i)
    order = [i for c in range(CELLS) for i in sorted(by_cell[c], key=lambda i: meta[i]["t"])]
    first = np.cumsum([0] + [len(b) for b in by_cell]).astype("<u4")
    ftab = "\n".join(folders).encode()
    head = struct.pack("<4s5I", b"SKYI", 1, det, CELLS, len(order), len(ftab)) + first.tobytes() + ftab
    head += b"\0" * (-len(head) % 8)
    rows = np.zeros(len(order), dtype=[("t", "<f8"), ("n", "<f4", 12), ("folder", "<u2"), ("seq", "<u2"), ("sub", "u1"), ("coll", "u1"), ("pad", "<u2")])
    assert rows.dtype.itemsize == ROW
    idx = np.array(order)
    rows["t"] = [meta[i]["t"] for i in order]
    rows["n"] = N[idx].reshape(len(order), 12)
    rows["folder"] = [fidx[meta[i]["folder"]] for i in order]
    rows["seq"] = [meta[i]["seq"] for i in order]
    rows["sub"] = [meta[i]["sub"] for i in order]
    rows["coll"] = [COLLS.index(meta[i]["coll"]) for i in order]
    out = Path(out_dir) / f"d{det}.bin"
    out.write_bytes(head + rows.tobytes())
    sizes = np.diff(first)
    return {"file": str(out), "bytes": out.stat().st_size, "images": len(meta), "rows": len(order), "header_bytes": len(head),
            "rows_per_cell_max": int(sizes.max()), "max_cell": int(sizes.argmax()), "cells_per_image": len(order) / len(meta)}


if __name__ == "__main__":
    meta, H = load(sys.argv[1])
    for d in sorted({m["det"] for m in meta}):   # one detector at a time keeps memory to one detector's rows
        sel = [i for i, m in enumerate(meta) if m["det"] == d]
        print(json.dumps(build([meta[i] for i in sel], {k: v[sel] for k, v in H.items()}, sys.argv[2])), flush=True)
