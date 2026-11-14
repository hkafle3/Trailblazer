"""Collect where and when SPHEREx photographed the sky -> bake/coverage/exposures.jsonl (one line per image).

SPHEREx photographs one square patch (about 3.5 degrees) at a time and covers the sky in strips over about six
months. IRSA has no "every footprint" download, and on 2026-11-14 its TAP search was down while a wider SIA
circle (0.5 degree) timed out, but a point search answers in about 0.6 s. So we ask about points on a HEALPix
order-5 grid (12,288 points, about 1.8 degrees apart): every 3.5-degree square contains several, so no image is
missed. Detector D1 only (the 0.75-1.1 um band): its footprint pattern is the survey's pattern.
Coarse first (every 4th point covers the sky evenly), resumable, 4 requests at a time.
Run: uv run --with certifi python bake/coverage.py
"""
import csv, io, json, math, ssl, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import certifi

OUT = Path(__file__).resolve().parent / "coverage"
CTX = ssl.create_default_context(cafile=certifi.where())
ORDER, NSIDE = 5, 32
JRLL, JPLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7]


def center(k):   # HEALPix nested pixel centre -> (ra, dec) degrees, the same math as web/sky.js
    face, ipf = divmod(k, NSIDE * NSIDE)
    ix = sum(((ipf >> (2 * i)) & 1) << i for i in range(ORDER))
    iy = sum(((ipf >> (2 * i + 1)) & 1) << i for i in range(ORDER))
    x, y = (ix + 0.5) / NSIDE, (iy + 0.5) / NSIDE
    jr = JRLL[face] - x - y
    if jr < 1: nr, z = jr, 1 - jr * jr / 3
    elif jr > 3: nr, z = 4 - jr, (4 - jr) ** 2 / 3 - 1
    else: nr, z = 1, (2 - jr) * 2 / 3
    t = (JPLL[face] * nr + x - y) % 8
    return math.degrees(math.pi / 4 * t / nr) % 360, math.degrees(math.asin(z))


def ecliptic_lat(ra, dec):
    e, a, d = math.radians(23.4393), math.radians(ra), math.radians(dec)
    return math.degrees(math.asin(math.sin(d) * math.cos(e) - math.cos(d) * math.sin(e) * math.sin(a)))


def search(coll, ra, dec, tries=6):
    url = "https://irsa.ipac.caltech.edu/SIA?" + urllib.parse.urlencode({
        "COLLECTION": coll, "POS": f"CIRCLE {ra} {dec} 0.001", "BAND": "0.80e-6/0.85e-6",   # D1 only
        "RESPONSEFORMAT": "CSV", "MAXREC": "50000"})
    for i in range(tries):
        try:
            text = urllib.request.urlopen(url, context=CTX, timeout=60).read().decode()
            if text.startswith("s_ra"):
                return list(csv.DictReader(io.StringIO(text)))
        except Exception:
            pass
        time.sleep(0.5 * 1.6 ** i)
    return None   # gave up: the point is retried on the next run


def run():
    OUT.mkdir(exist_ok=True)
    done_f, exp_f = OUT / "done.txt", OUT / "exposures.jsonl"
    done = set(done_f.read_text().split()) if done_f.exists() else set()
    seen = {json.loads(l)["id"] for l in exp_f.open()} if exp_f.exists() else set()
    order = [k for k in range(12 * NSIDE * NSIDE) if k % 4 == 0] + [k for k in range(12 * NSIDE * NSIDE) if k % 4]
    todo = [k for k in order if str(k) not in done]
    print(f"{len(todo)} points to ask about, {len(seen)} images already known", flush=True)

    def one(k):
        ra, dec = center(k)
        colls = ["spherex_dr1", "spherex_qr3"] + (["spherex_dr1_deep", "spherex_qr3_deep"] if abs(ecliptic_lat(ra, dec)) > 75 else [])
        res = [search(c, ra, dec) for c in colls]
        return k, (None if any(r is None for r in res) else [(c, row) for c, rows in zip(colls, res) for row in rows])

    t0, n = time.time(), 0
    with ThreadPoolExecutor(4) as pool, exp_f.open("a") as ef, done_f.open("a") as df:
        for k, rows in pool.map(one, todo):
            n += 1
            if rows is None:
                continue
            for coll, r in rows:
                if r["obs_id"] in seen:
                    continue
                seen.add(r["obs_id"])
                poly = [round(float(v), 4) for v in r["s_region"].split()[2:]]
                ef.write(json.dumps({"id": r["obs_id"], "t": round(float(r["t_min"]), 4), "coll": coll, "poly": poly}) + "\n")
            df.write(f"{k}\n")
            if n % 200 == 0:
                ef.flush(); df.flush()
                rate = n / (time.time() - t0)
                print(f"{n}/{len(todo)} points, {len(seen)} images, {rate:.1f} points/s, about {(len(todo) - n) / rate / 60:.0f} min left", flush=True)
    print(f"done: {len(seen)} images", flush=True)


if __name__ == "__main__":
    run()
