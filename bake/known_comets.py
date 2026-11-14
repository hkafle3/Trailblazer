"""Real known comets for the map: where each one was during the SPHEREx survey, and which SPHEREx photos caught it.

1. JPL's Small-Body Database: comets that pass within 5 AU of the Sun between mid-2024 and mid-2027.
2. JPL Horizons: each comet's sky position and predicted total magnitude every 2 days, Apr 2025 to Oct 2026.
   Keep the ones brighter than MAG_LIMIT at some point (bright enough for SPHEREx to plausibly see).
3. SPHEREx: every photo in bake/coverage/exposures.jsonl (detector D1) whose outline held the comet at the
   moment it was taken.
Writes bake/cache/known_comets.json (full detail) for bake/seed_d1.py.
Check: 3I/ATLAS's matches must be the D1 photos IRSA itself lists for it (bake/cache/3iatlas/obscore_3I_Atlas.vot).
Run: uv run -q --with numpy --with astropy --with certifi sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python -u bake/known_comets.py'
"""
import json, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "bake" / "cache" / "known"
OUT = ROOT / "bake" / "cache" / "known_comets.json"
MJD0, DAYS = 60789, 529               # coverage start (2025-04-24) and length, from web/data/coverage.json
STEP = 2                              # days between ephemeris points
MAG_LIMIT = 16.0


def fetch(url, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode()
        except Exception as e:
            print(f"  retry {i + 1}: {str(e)[:70]}", flush=True)
            time.sleep(2 * 2 ** i)
    raise IOError(url[:100])


def candidates():
    """Comets with perihelion between 2024-06 and 2027-06 inside 5 AU, from JPL's Small-Body Database."""
    q = urllib.parse.urlencode({"fields": "full_name,pdes,q,tp,M1,K1", "sb-kind": "c",
                                "sb-cdata": json.dumps({"AND": ["q|LT|5", "tp|GT|2460462.5", "tp|LT|2461557.5"]})})
    d = json.loads(fetch("https://ssd-api.jpl.nasa.gov/sbdb_query.api?" + q))
    return [dict(zip(d["fields"], r)) for r in d["data"]]


def ephemeris(c):
    """Sky position (RA, Dec degrees) and total magnitude from Earth every STEP days, via JPL Horizons."""
    # the window and step are in the name: a cache built for a different timeline is never reused
    f = CACHE / (c["pdes"].replace("/", "_").replace(" ", "_") + f"_{MJD0}_{DAYS}_{STEP}.json")
    if f.exists():
        cached = json.loads(f.read_text())
        if len(cached["rows"]) == len(range(0, DAYS + STEP + 1, STEP)) or cached["note"]:
            return cached
    start = f"JD{MJD0 + 2400000.5}"
    stop = f"JD{MJD0 + DAYS + STEP + 2400000.5}"   # one step past the end, so the last coverage day is bracketed
    params = {"format": "json", "COMMAND": f"'DES={c['pdes']};CAP;NOFRAG'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
              "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@399'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
              "STEP_SIZE": f"'{STEP} d'", "QUANTITIES": "'1,9'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'"}
    res = json.loads(fetch("https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)))
    text = res.get("result", "")
    rows = []
    if "$$SOE" in text:
        for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            try:
                ra, dec = float(p[3]), float(p[4])
            except (ValueError, IndexError):
                continue
            mag = float(p[5]) if len(p) > 5 and p[5] not in ("", "n.a.") else None
            rows.append([round(ra, 5), round(dec, 5), mag])
    out = dict(rows=rows, note=None if rows else text[:300])
    f.write_text(json.dumps(out))
    return out


def inside(px, py, poly):
    """Is each point inside its photo's outline? Corners go through a gnomonic projection centred on the point,
    where great circles (the outline's edges) are straight lines, so the test holds near the poles and the RA seam.
    Only outlines within ~5 degrees count: the projection does not reach the far side of the sky."""
    a0, d0 = np.radians(px)[:, None], np.radians(py)[:, None]
    a, d = np.radians(poly[:, 0::2]), np.radians(poly[:, 1::2])
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    near = (cosc > np.cos(np.radians(5))).all(1)
    cosc = np.where(cosc > 0, cosc, 1)
    X = np.cos(d) * np.sin(a - a0) / cosc
    Y = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
    hit = np.zeros(len(px), bool)
    for i in range(4):   # ray from the point (the origin) along +X: count edge crossings
        x1, y1, x2, y2 = X[:, i], Y[:, i], X[:, (i + 1) % 4], Y[:, (i + 1) % 4]
        hit ^= ((y1 > 0) != (y2 > 0)) & (x1 + (x2 - x1) * (0 - y1) / np.where(y2 == y1, 1e-12, y2 - y1) > 0)
    return hit & near


def _check_inside():
    sq = lambda ra, dec, h: [ra - h, dec - h, ra + h, dec - h, ra + h, dec + h, ra - h, dec + h]
    polys = np.array([sq(10, 0, 1), sq(0, 0, 1), sq(0.0, 0, 1), sq(180, 0, 1), sq(359.5, 30, 1)], float)
    polys[2] = [359, -1, 1, -1, 1, 1, 359, 1]                      # straddles RA 0/360
    pole = np.array([[0, 88.5, 90, 88.5, 180, 88.5, 270, 88.5]], float)   # a square around the north pole
    got = inside(np.array([10.5, 30, 0.5, 0, 359.9]), np.array([0.2, 0, 0.2, 0, 30.5]), polys)
    assert list(got) == [True, False, True, False, True], got      # far-side square must not match the point at RA 0
    assert inside(np.array([123.0]), np.array([89.9]), pole)[0] and not inside(np.array([123.0]), np.array([85.0]), pole)[0]


_check_inside()


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    cands = candidates()
    if not any("2025 N1" in c["full_name"] for c in cands):
        cands.append(dict(full_name="C/2025 N1 (ATLAS)", pdes="2025 N1"))   # 3I/ATLAS: interstellar, needed for the check
    print(f"{len(cands)} candidate comets from JPL's database", flush=True)
    with ThreadPoolExecutor(3) as pool:
        ephs = list(pool.map(ephemeris, cands))
    days = np.arange(0, DAYS + STEP + 1, STEP)
    keep = []
    for c, e in zip(cands, ephs):
        rows = e["rows"]
        if len(rows) != len(days):
            continue
        mags = [r[2] for r in rows if r[2] is not None]
        if not mags or min(mags) > MAG_LIMIT:
            if "2025 N1" not in c["pdes"]:
                continue
        keep.append((c, np.array([[r[0], r[1]] for r in rows]), [r[2] for r in rows]))
    print(f"{len(keep)} comets brighter than magnitude {MAG_LIMIT} at some point", flush=True)

    rows = [json.loads(l) for l in (ROOT / "bake/coverage/exposures.jsonl").open()]
    rows = [r for r in rows if len(r["poly"]) >= 8]
    t = np.array([r["t"] for r in rows]) - MJD0
    polys = np.array([r["poly"][:8] for r in rows], float)
    ids = np.array([r["id"] for r in rows])
    out = []
    for c, track, mags in keep:
        unwrapped = np.degrees(np.unwrap(np.radians(track[:, 0])))
        ok = (t >= 0) & (t <= DAYS)
        px = np.interp(t[ok], days, unwrapped) % 360
        py = np.interp(t[ok], days, track[:, 1])
        hit = inside(px, py, polys[ok])
        shots = sorted(zip(t[ok][hit].round(4).tolist(), ids[ok][hit].tolist(), px[hit].round(4).tolist(), py[hit].round(4).tolist()))
        name = c["full_name"].strip()
        out.append(dict(name=name, pdes=c["pdes"], q=c.get("q"), tp=c.get("tp"),
                        track=[[int(d), round(float(r), 4), round(float(dc), 4), m] for d, (r, dc), m in zip(days, track, mags)],
                        spherex=[dict(day=d, obs=o, ra=r, dec=dc) for d, o, r, dc in shots]))   # exact position at each photo
        print(f"  {name}: brightest {min(m for m in mags if m is not None) if any(m is not None for m in mags) else 'n/a'}, SPHEREx D1 photos {len(shots)}", flush=True)
    # check before publishing: every SPHEREx D1 photo IRSA lists for 3I/ATLAS must be among ours. Ours may hold more:
    # IRSA's list covers Aug and Dec 2025, and SPHEREx photographed the comet again in Mar-Apr 2026.
    from astropy.table import Table
    irsa = Table.read(ROOT / "bake/cache/3iatlas/obscore_3I_Atlas.vot")
    want = {str(r["obs_id"]) for r in irsa if str(r["spherex_detector"]).strip() in ("D1", "1")}
    atlas = next((o for o in out if "2025 N1" in o["pdes"]), None)
    assert atlas, "3I/ATLAS has no usable ephemeris, so the check cannot run"
    got = {s["obs"] for s in atlas["spherex"]}
    in_window = {s["obs"] for s in atlas["spherex"] if s["day"] < 240}   # through Dec 2025, IRSA's span
    print(f"3I/ATLAS check: IRSA lists {len(want)} D1 photos; we found {len(got)} ({len(in_window)} through Dec 2025); "
          f"in both {len(want & got)}; ours only through Dec 2025: {sorted(in_window - want)}", flush=True)
    assert want <= got, f"missed IRSA photos: {sorted(want - got)}"
    OUT.write_text(json.dumps(out))
    print(f"wrote {OUT.name}: {len(out)} comets", flush=True)


if __name__ == "__main__":
    main()
