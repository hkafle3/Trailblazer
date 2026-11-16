"""Apply test.md's selection rule: SBDB classes + Gaia DR3 availability + MOST exposures -> selection.json.

Uses predictions only (MOST's V magnitudes), never photometry.
Run: uv run -q --with astropy --with pillow --with reproject python bake/asteroid_spectra/choose.py OUTDIR
"""
import csv, io, json, math, sys, urllib.parse
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from flipbook import get  # retries IRSA's intermittent errors

OUT = Path(sys.argv[1])
CACHE = OUT / "cache"
CACHE.mkdir(parents=True, exist_ok=True)
SIGMA1 = 0.018   # mJy, forecast single-exposure noise
BUS = {"S": {"S", "Sa", "Sk", "Sl", "Sq", "Sr"}, "C": {"C", "Cb", "Cg", "Ch", "Cgh"}, "V": {"V"}, "X": {"X", "Xc", "Xe"}}
THOLEN = {"S": {"S"}, "C": {"C"}, "V": {"V"}, "X": {"X", "E", "M", "P"}}
ORBITS = {"MBA", "IMB", "OMB", "HIL", "TJN"}


def complex_of(cls, table):
    return next((k for k, v in table.items() if cls in v), None)


def pool():
    f = CACHE / "sbdb_typed.json"
    if not f.exists():
        q = urllib.parse.urlencode({"fields": "spkid,pdes,name,H,G,spec_B,spec_T,class,diameter,rot_per,a", "sb-kind": "a",
                                    "sb-ns": "n", "sb-cdata": json.dumps({"OR": ["spec_B|DF", "spec_T|DF"]})})
        f.write_bytes(get("https://ssd-api.jpl.nasa.gov/sbdb_query.api?" + q))
    d = json.loads(f.read_text())
    out = []
    for r in (dict(zip(d["fields"], row)) for row in d["data"]):
        b, t = (r["spec_B"] or "").strip(), (r["spec_T"] or "").strip()
        if any(c in b + t for c in ":("):
            continue
        cb, ct = complex_of(b, BUS) if b else None, complex_of(t, THOLEN) if t else None
        cx = cb if b else ct
        if not cx or (b and t and cb != ct):
            continue
        out.append(dict(num=int(r["pdes"]), name=r["name"], H=float(r["H"]) if r["H"] else None, G=r["G"], cls=b or t,
                        src="Bus (SMASSII)" if b else "Tholen", tholen=t or None, cx=cx, orbit=r["class"], a=float(r["a"])))
    return sorted(out, key=lambda c: c["num"])


def gaia_numbers(nums):
    f = CACHE / "gaia_sso_numbers.json"
    have = set(json.loads(f.read_text())) if f.exists() else None
    if have is None:
        have = set()
        for i in range(0, len(nums), 400):
            q = ("SELECT DISTINCT number_mp FROM gaiadr3.sso_reflectance_spectrum WHERE number_mp IN ("
                 + ",".join(map(str, nums[i:i + 400])) + ")")
            body = get("https://gea.esac.esa.int/tap-server/tap/sync?" + urllib.parse.urlencode(
                {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q})).decode()
            have |= {int(r["number_mp"]) for r in csv.DictReader(io.StringIO(body))}
        f.write_text(json.dumps(sorted(have)))
    return have


def most(num):
    """MOST rows (DR1 and QR3 only) for asteroid `num`, cached."""
    f = CACHE / f"most_{num}.tbl"
    if not f.exists():
        f.write_bytes(get("https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?" + urllib.parse.urlencode(
            {"catalog": "spherex", "input_type": "naifid_input", "obj_naifid": 20000000 + num,
             "obs_begin": "2025-05-01", "obs_end": "2026-11-16", "output_mode": "Brief"})))
    lines = f.read_text().splitlines()
    head = next((l for l in lines if l.startswith("|")), None)
    if head is None:
        return []
    bars = [i for i, ch in enumerate(head) if ch == "|"]
    cols = [head[i + 1:j].strip() for i, j in zip(bars, bars[1:])]
    rows = []
    for l in lines:
        if l.startswith(("\\", "|")) or not l.strip():
            continue
        r = {k: l[i:j + 1].strip() for k, i, j in zip(cols, bars, bars[1:])}
        if "/dr1/" in r["uri"] or "/qr3/" in r["uri"]:
            rows.append(r)
    return rows


def predict(rows):
    v = np.array([float(r["vmag"]) for r in rows if r["productid"] in ("D1", "D2", "D3")])
    if not len(v):
        return 0.0, 0.0
    flux = 3631e3 * 10 ** (-0.4 * (v - 0.3))   # mJy
    return float(np.median(flux / SIGMA1)), float(np.median(flux))


def rough_snr(c):
    """Only to skip hopeless MOST queries: asteroid at r = a seen at 90 degrees elongation."""
    if c["H"] is None or c["a"] <= 1.05:
        return None
    r, d = c["a"], math.sqrt(c["a"] ** 2 - 1)
    al = math.asin(1 / r)
    t = math.tan(al / 2)
    phi = 0.85 * math.exp(-3.33 * t ** 0.63) + 0.15 * math.exp(-1.87 * t ** 1.22)
    v = c["H"] + 5 * math.log10(r * d) - 2.5 * math.log10(phi)
    return 3631e3 * 10 ** (-0.4 * (v - 0.3)) / SIGMA1


SLOTS = [  # name, complexes, snr lo, snr hi, flux lo, flux hi, gaia ('req', 'pref', None), min images, MCA ok, Bus class
    ("T0", "S", 100, 1e9, 2, 20, "req", 150, False, "S"),
    ("S1", "S", 100, 1e9, 0, 20, "req", 100, False, None),
    ("S2", "S", 10, 100, 0, 1e9, "req", 100, False, None),
    ("S3", "S", 3, 10, 0, 1e9, "pref", 100, False, None),
    ("C1", "C", 100, 1e9, 0, 20, "req", 100, False, None),
    ("C2", "C", 10, 100, 0, 1e9, "req", 100, False, None),
    ("C3", "C", 3, 10, 0, 1e9, "pref", 100, False, None),
    ("V1", "V", 10, 1e9, 0, 1e9, "pref", 100, False, None),
    ("X1", "X", 10, 1e9, 0, 1e9, "pref", 100, False, None),
    ("F1", "SCVX", 1, 3, 0, 1e9, None, 100, True, None),
    ("F2", "SCVX", 1, 3, 0, 1e9, None, 100, True, None),
]


def main():
    cands = pool()
    gaia = gaia_numbers([c["num"] for c in cands])
    print(f"pool {len(cands)} typed asteroids, {sum(c['num'] in gaia for c in cands)} with Gaia DR3 spectra", flush=True)
    taken, picks = set(), []
    for name, cxs, lo, hi, flo, fhi, g, nmin, mca, bus in SLOTS:
        ok = [c for c in cands if c["cx"] in cxs and c["num"] not in taken and (c["orbit"] in ORBITS or (mca and c["orbit"] == "MCA"))
              and (bus is None or (c["src"].startswith("Bus") and c["cls"] == bus)) and (g != "req" or c["num"] in gaia)]
        if g == "pref":
            ok = sorted(ok, key=lambda c: (c["num"] not in gaia, c["num"]))
        pick = None
        for c in ok:
            rs = rough_snr(c)
            if rs is not None and not (lo / 10 <= rs <= hi * 10):
                continue
            rows = most(c["num"])
            snr, flux = predict(rows)
            if len(rows) >= nmin and lo <= snr < hi and flo <= flux <= fhi:
                pick = dict(c, slot=name, n_img=len(rows), pred_snr=round(snr, 2), pred_flux_mJy=round(flux, 4), gaia=c["num"] in gaia)
                break
        print(name, pick, flush=True)
        if pick:
            taken.add(pick["num"])
            picks.append(pick)
    (OUT / "selection.json").write_text(json.dumps(picks, indent=1))


if __name__ == "__main__":
    main()
