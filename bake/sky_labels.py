"""Bake the Explore map's sky labels -> web/data/labels.json, and the constellation test fixture
-> web/tests/fixtures/constellations50.json.

Inputs, all cached in bake/labels_raw/ so this runs offline (sources and licences: README, "Data credits"):
  VI49-bound_18.dat     constellation borders, VizieR VI/49 (Davenhall & Leggett 1989), the IAU borders in B1875
  VI42-roman87.dat      the constellation lookup table, VizieR VI/42 (Roman 1987), the copy astropy ships
  constellations.json   name label points and ranks, d3-celestial (BSD 3-Clause, Olaf Frohn; d3-celestial-LICENSE)
  simbad.json           object positions from SIMBAD (CDS), fetched by identifier when missing (needs the network once)
  IAU-CSN.txt           the IAU WGSN star names with V magnitude and J2000 position (E. Mamajek's IAU-CSN list)
Output, labels.json:
  borders         [[ra, dec, ra, dec, ...], ...] J2000 degrees to 0.01. Each edge of VI/49 is a line of constant RA or
                  Dec in B1875, so it is split into 0.5 degree steps there and then precessed. Shared edges are kept once.
  constellations  [{name, id, rank, ra, dec}] d3-celestial's label points (89: Serpens has two parts)
  objects         [{name, kind, ra, dec, min, max}] giants, clouds and famous objects, then [{name, kind: 'star', ra, dec, mag}]
The page shows each name between `min` and `max` px per degree (web/sky-labels.js); stars all from 60, brightest first.
The fixture: 50 positions with astropy's get_constellation answer (12 named objects, the 2 candidates, both poles, 6
points 1.2 to 3 arcmin from a border, 28 seeded random points; any whose answer changes within 1 arcmin is redrawn),
plus C-0176's place line by the page's rule, worked out here apart from web/sky-place.js.
Run: uv run -q --with astropy --with numpy python bake/sky_labels.py
"""
import gzip, json, math, re, sys, urllib.parse, urllib.request
from pathlib import Path
import numpy as np
from astropy.coordinates import SkyCoord, FK4NoETerms, FK5, get_constellation
import astropy.units as u

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "bake" / "labels_raw"
OUT = ROOT / "web" / "data" / "labels.json"
FIXTURE = ROOT / "web" / "tests" / "fixtures" / "constellations50.json"
BUDGET = 64 * 1024   # labels.json gzipped

# (label, SIMBAD id, kind, min px/deg, max px/deg or None): the approved mockup's list
OBJECTS = [
    ("Large Magellanic Cloud", "LMC", "giant", 0, 60),
    ("Small Magellanic Cloud", "SMC", "giant", 0, 60),
    ("Andromeda Galaxy", "M31", "giant", 0, None),
    ("Orion Nebula", "M42", "object", 28, None),
    ("Pleiades", "M45", "object", 18, None),
    ("Horsehead Nebula", "Barnard 33", "object", 40, None),
    ("Orion A", "NAME Ori A", "cloud", 28, None),
    ("Orion B", "NAME Ori B", "cloud", 28, None),
    ("Perseus cloud", "NAME Perseus Cloud", "cloud", 18, None),
    ("Taurus cloud", "NAME Taurus Complex", "cloud", 18, None),
    ("Ophiuchus cloud", "NAME Ophiuchus Molecular Cloud", "cloud", 18, None),
    ("Serpens cloud", "NAME Serpens Main Cloud", "cloud", 28, None),
]
CANDIDATES = {"C-0175": (76.9563, 30.4013), "C-0176": (84.0181, -6.577)}   # the two on the live site, 2026-11-18


def simbad(ident, cache):
    if ident in cache: return cache[ident]
    q = urllib.parse.urlencode({"Ident": ident, "output.format": "ASCII"})
    txt = urllib.request.urlopen("https://simbad.harvard.edu/simbad/sim-id?" + q, timeout=30).read().decode()
    m = re.search(r"Coordinates\(ICRS,ep=J2000,eq=2000\): (\d+) (\d+) ([\d.]+)\s+([+-])(\d+) (\d+) ([\d.]+)", txt)
    if not m: raise SystemExit(f"SIMBAD: no coordinates for {ident}")
    h, mi, s, sg, d, dm, ds = m.groups()
    obj = re.search(r"^Object (.+?)  ---  (\S+)", txt, re.M)
    cache[ident] = {"ra": (int(h) + int(mi) / 60 + float(s) / 3600) * 15, "dec": (1 if sg == "+" else -1) * (int(d) + int(dm) / 60 + float(ds) / 3600),
                    "simbad_main_id": obj.group(1).strip(), "simbad_type": obj.group(2)}
    return cache[ident]


def wgsn():
    """IAU-CSN.txt: the name (with diacritics) in its fixed column; the numbers are read back from the date, since some
    columns are right-aligned. Names with a V magnitude only."""
    out = []
    for l in (RAW / "IAU-CSN.txt").read_text(encoding="utf-8").splitlines():
        if not l.strip() or l[0] in "#$": continue
        t = l[36:].split()
        i = next(k for k, x in enumerate(t) if re.fullmatch(r"\d{4}-\d\d-\d\d", x))
        mag, band, ra, dec = t[i - 6], t[i - 5], t[i - 2], t[i - 1]
        if band != "V" or mag == "_": continue
        out.append({"name": l[18:36].strip(), "kind": "star", "ra": round(float(ra), 3), "dec": round(float(dec), 3), "mag": float(mag)})
    assert len(out) > 400 and len({s["name"] for s in out}) == len(out), len(out)
    return sorted(out, key=lambda s: s["mag"])


def borders():
    polys = {}
    for line in open(RAW / "VI49-bound_18.dat"):
        polys.setdefault(line[19:23].strip(), []).append((float(line[0:8]) * 15, float(line[9:18])))
    seen, segs = set(), []
    for pts in polys.values():
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            key = tuple(sorted([(round(a[0], 3), round(a[1], 3)), (round(b[0], 3), round(b[1], 3))]))
            if key in seen or a == b or abs(a[1]) == 90 == abs(b[1]): continue
            seen.add(key)
            dra = b[0] - a[0]
            if abs(dra) != 360: dra = (dra + 180) % 360 - 180   # a 0h to 24h edge is a full circle round a pole
            n = max(1, math.ceil(max(abs(dra) * math.cos(math.radians(max(abs(a[1]), abs(b[1])) if abs(a[1]) < 89 else 0)), abs(b[1] - a[1])) / 0.5))
            segs.append([((a[0] + dra * k / n) % 360, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)])
    flat = np.array([p for s in segs for p in s])
    c = SkyCoord(flat[:, 0] * u.deg, flat[:, 1] * u.deg, frame=FK4NoETerms(equinox="B1875", obstime="B1875")).transform_to(FK5(equinox="J2000"))
    ra, dec = c.ra.deg, c.dec.deg
    out, k = [], 0
    for s in segs:
        piece = []
        for j in range(len(s)): piece += [round(float(ra[k + j]), 2), round(float(dec[k + j]), 2)]
        out.append(piece); k += len(s)
    return out


def sep(a, b):
    r = math.radians
    c = math.sin(r(a[1])) * math.sin(r(b[1])) + math.cos(r(a[1])) * math.cos(r(b[1])) * math.cos(r(a[0] - b[0]))
    return math.degrees(math.acos(max(-1, min(1, c))))


def place_line(ra, dec, objects, cname):
    """The page's rule (web/sky-place.js placeLine), written again: a famous object or giant within 5 degrees, else the
    nearest named star within 10, else no 'from' part."""
    d = lambda o: sep((ra, dec), (o["ra"], o["dec"]))
    famous = [o for o in objects if o["kind"] in ("object", "giant")]
    near = min(famous, key=d)
    if d(near) > 5:
        near = min((o for o in objects if o["kind"] == "star"), key=d)
        if d(near) > 10: return f"In {cname}"
    return f"In {cname}, {d(near):.1f}° from {'' if near['kind'] == 'star' else 'the '}{near['name']}"


def astropy_con(ra, dec):
    return str(get_constellation(SkyCoord(ra * u.deg, dec * u.deg, frame="icrs"), short_name=True))


def stable(ra, dec, r=1 / 60):
    """astropy's answer is the same at 8 points on a circle of radius r degrees round the point"""
    want = astropy_con(ra, dec)
    for k in range(8):
        a = k * math.pi / 4
        d2 = max(-90, min(90, dec + r * math.sin(a)))
        r2 = (ra + r * math.cos(a) / max(1e-6, math.cos(math.radians(dec)))) % 360
        if astropy_con(r2, d2) != want: return False
    return True


def fixture(objects, border_pieces, names):
    rng = np.random.default_rng(1987)
    pts = [{"what": o["name"], "ra": o["ra"], "dec": o["dec"]} for o in objects if o["kind"] != "star"]
    pts += [{"what": k, "ra": ra, "dec": dec} for k, (ra, dec) in CANDIDATES.items()]
    pts += [{"what": "north pole", "ra": 0.0, "dec": 90.0}, {"what": "south pole", "ra": 0.0, "dec": -90.0}]
    near = 0
    while near < 6:   # beside a border: the middle of a random border step, moved 1.2 to 3 arcmin across it
        p = border_pieces[rng.integers(len(border_pieces))]
        j = rng.integers(len(p) // 2 - 1)
        (r1, d1), (r2, d2) = p[2 * j:2 * j + 2], p[2 * j + 2:2 * j + 4]
        if abs(d1) > 80: continue
        cosd = math.cos(math.radians((d1 + d2) / 2)); dx, dy = ((r2 - r1 + 180) % 360 - 180) * cosd, d2 - d1; L = math.hypot(dx, dy)
        if not L: continue
        off = rng.uniform(1.2, 3) / 60 * rng.choice([-1, 1])
        ra, dec = ((r1 + r2) / 2 + (-dy / L) * off / cosd) % 360, (d1 + d2) / 2 + (dx / L) * off
        if not stable(ra, dec): continue
        pts.append({"what": f"{off * 60:+.1f} arcmin off a border", "ra": round(ra, 5), "dec": round(dec, 5)}); near += 1
    while len(pts) < 50:   # random over the sphere
        ra, dec = float(rng.uniform(0, 360)), math.degrees(math.asin(rng.uniform(-1, 1)))
        if not stable(ra, dec): continue
        pts.append({"what": "random", "ra": round(ra, 5), "dec": round(dec, 5)})
    for p in pts:
        p["con"] = astropy_con(p["ra"], p["dec"])
        assert p["what"] in ("north pole", "south pole") or stable(p["ra"], p["dec"]), p
    c = CANDIDATES["C-0176"]
    return {"note": "astropy get_constellation (Roman 1987) on 50 fixed positions; written by bake/sky_labels.py",
            "points": pts, "c0176": {"ra": c[0], "dec": c[1], "line": place_line(*c, objects, names[astropy_con(*c)])}}


def main():
    cache_path = RAW / "simbad.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    objects = []
    for label, ident, kind, zmin, zmax in OBJECTS:
        s = simbad(ident, cache)
        objects.append({"name": label, "kind": kind, "ra": round(s["ra"], 4), "dec": round(s["dec"], 4), "min": zmin, "max": zmax})
    cache_path.write_text(json.dumps(cache, indent=1))
    stars = wgsn()
    cons = [{"name": f["properties"]["name"], "id": f["id"], "rank": int(f["properties"]["rank"]), "ra": round(f["geometry"]["coordinates"][0] % 360, 3), "dec": f["geometry"]["coordinates"][1]}
            for f in json.loads((RAW / "constellations.json").read_text())["features"]]
    bpieces = borders()
    out = {"borders": bpieces, "constellations": cons, "objects": objects + stars}
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    size = len(gzip.compress(text.encode(), 9))
    print(f"{len(bpieces)} border pieces, {sum(len(b) for b in bpieces) // 2} points; {len(cons)} constellation names; {len(objects)} objects; {len(stars)} stars")
    print(f"labels.json {len(text.encode()) / 1024:.1f} KB, {size / 1024:.1f} KB gzipped (budget {BUDGET / 1024:.0f} KB)")
    if size > BUDGET: sys.exit(f"FAIL: labels.json is {size} bytes gzipped, over the {BUDGET} byte budget")
    OUT.write_text(text, encoding="utf-8")

    # the page's lookup table must be VI/42 as shipped (web/sky-place.js holds it inline)
    rows = [l.split() for l in (RAW / "VI42-roman87.dat").read_text().splitlines() if l.strip() and not l.startswith("#")]
    js = (ROOT / "web" / "sky-place.js").read_text()
    table = re.search(r"const ROMAN = '([^']*)'", js).group(1).split(";")
    want = [f"{float(a):g},{float(b):g},{float(c):g},{n}" for a, b, c, n in rows]
    assert table == want, "web/sky-place.js ROMAN differs from bake/labels_raw/VI42-roman87.dat"
    names = {l[:3]: l[4:].strip() for l in (RAW / "constellation_names.dat").read_text(encoding="utf-8").splitlines() if l and not l.startswith("#")}
    names.update(Cha="Chamaeleon", Oph="Ophiuchus", PsA="Piscis Austrinus")   # misspelt in astropy's copy
    js_names = dict(x.split(" ", 1) for x in re.search(r"const NAMES = '([^']*)'", js).group(1).split(";"))
    assert js_names == names, "web/sky-place.js NAMES differs from the IAU names"
    if not FIXTURE.exists() or "--fixture" in sys.argv:   # drawn once; --fixture draws it again
        FIXTURE.write_text(json.dumps(fixture(objects + stars, bpieces, names), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print("wrote", FIXTURE.relative_to(ROOT))
    print("C-0176:", place_line(*CANDIDATES["C-0176"], objects + stars, names[astropy_con(*CANDIDATES["C-0176"])]))


main()
