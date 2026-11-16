"""Bake the data of the 3D intro "How this map was made" (web/intro.js) into web/data/intro/. Standard library only.
  tiles.bin      SPHEREx D1 photo footprints, sorted by time: every photo of the first 4 days, then every 3rd.
                 16 bytes each: float32 day (since MJD 60789), int16 x3 centre direction, int16 x3 half-edge vector
                 (centre to the middle of one side, in units of 1/16). Directions are ecliptic unit vectors.
  scene.json     trimmed copy of the 3D prototype's scene.json (JPL Horizons): inner planets' orbits, Earth every 2 days,
                 every comet's position every 2 days, and 3I/ATLAS's path and photos.
  sky.jpg        the prototype's SPHEREx all-sky picture (web/data/allsky3.png resampled to ecliptic equirectangular), copied as is.
The first photo itself (photo.jpg, photo.json) is baked by bake/intro_photo.py.
tiles.bin is rebuilt from this repo (bake/coverage/exposures.jsonl, from bake/coverage.py). scene.json and sky.jpg came from the
earlier 3D prototype, which is not in the repo: give its data folder to rebuild them, or leave it out to keep the committed ones.
Run: python3 bake/intro_assets.py [prototype data folder]
"""
import json, math, shutil, struct, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROTO = Path(sys.argv[1]) if len(sys.argv) > 1 else None
OUT = REPO / "web/data/intro"
MJD0, EPS = 60789, math.radians(23.4392911)


def ecl(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    x, y, z = math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)
    return (x, math.cos(EPS) * y + math.sin(EPS) * z, -math.sin(EPS) * y + math.cos(EPS) * z)


ex = [json.loads(l) for l in (REPO / "bake/coverage/exposures.jsonl").open()]
ex = sorted((r for r in ex if len(r["poly"]) >= 8), key=lambda r: r["t"])
early = [r for r in ex if r["t"] - MJD0 < 4.75]
keep = early + ex[len(early)::3]
q = lambda v, s: max(-32767, min(32767, round(v * s)))
buf = bytearray()
for r in keep:
    p = [ecl(r["poly"][2 * k], r["poly"][2 * k + 1]) for k in range(4)]
    c = [sum(v[j] for v in p) / 4 for j in range(3)]
    n = math.sqrt(sum(v * v for v in c)); c = [v / n for v in c]
    e = [(p[0][j] + p[1][j]) / 2 - c[j] * n for j in range(3)]          # centre -> middle of side 0-1
    buf += struct.pack("<f6h", r["t"] - MJD0, *[q(v, 32767) for v in c], *[q(v, 32767 * 16) for v in e])
(OUT / "tiles.bin").write_bytes(buf)

if PROTO:
    S = json.loads((PROTO / "scene.json").read_text())
    r3 = lambda a: [round(v, 3) for v in a]
    c3 = next(c for c in S["comets"] if c["id"] == "3I/ATLAS")
    scene = dict(mjd0=S["mjd0"], days=S["days"], step=S["step"], photos=len(ex), drawn=len(keep),
                 planets=[dict(name=p["name"], orbit=r3(p["orbit"])) for p in S["planets"] if p["name"] in ("Mercury", "Venus", "Earth", "Mars", "Jupiter")],
                 earth=[round(v, 4) for v in S["earth"]],
                 comets=[dict(id=c["id"], pos=r3(c["pos"])) for c in S["comets"] if c["shots"] and c["id"] != "3I/ATLAS"],
                 atlas=dict(id=c3["id"], pos=c3["pos"], arc=c3["arc"], shots=c3["shots"]))
    (OUT / "scene.json").write_text(json.dumps(scene, separators=(",", ":")))
    shutil.copy(PROTO / "sky.jpg", OUT / "sky.jpg")
assert len(buf) == 16 * len(keep)
d0 = struct.unpack_from("<f", buf, 0)[0]; assert 0.7 < d0 < 0.8, d0
print(f"photos {len(ex)}, drawn {len(keep)} ({len(early)} early); tiles.bin {len(buf)/1e6:.2f} MB; scene.json {(OUT/'scene.json').stat().st_size/1e6:.2f} MB")
