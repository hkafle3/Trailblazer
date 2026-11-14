"""Bake nearby stars (Gaia DR3, within 25 pc) -> web/data/stars.json.

Positions in parsecs (x toward RA 0, z toward the north celestial pole) and
velocities in parsecs per 1,000 years from proper motion (no radial velocity).
Run: python3 bake/stars.py
"""
import csv, io, json, math, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "stars.json"
Q = ("SELECT ra, dec, parallax, pmra, pmdec, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source "
     "WHERE parallax > 40 AND parallax_over_error > 10")
URL = "https://gea.esac.esa.int/tap-server/tap/sync?" + urllib.parse.urlencode(
    dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=Q))
MAS = math.pi / 180 / 3.6e6  # radians per milliarcsecond


def unit(ra, dec):
    return [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)]


rows = list(csv.DictReader(io.StringIO(urllib.request.urlopen(URL, timeout=120).read().decode())))
pos, vel, mag, col = [], [], [], []
for r in rows:
    ra, dec = math.radians(float(r["ra"])), math.radians(float(r["dec"]))
    d = 1000 / float(r["parallax"])
    east = [-math.sin(ra), math.cos(ra), 0]
    north = [-math.sin(dec) * math.cos(ra), -math.sin(dec) * math.sin(ra), math.cos(dec)]
    u = unit(ra, dec)
    pmra, pmdec = float(r["pmra"] or 0) * MAS, float(r["pmdec"] or 0) * MAS
    pos += [round(d * c, 4) for c in u]
    vel += [round(d * 1000 * (pmra * e + pmdec * n), 5) for e, n in zip(east, north)]  # pc per 1,000 yr
    g = float(r["phot_g_mean_mag"] or 15)
    mag.append(round(g - 5 * math.log10(d / 10), 2))  # absolute G
    col.append(round(float(r["bp_rp"] or 1.5), 2))

assert len(mag) > 4000, len(mag)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(dict(source="Gaia DR3, parallax > 40 mas", n=len(mag), pos=pos, vel=vel, absmag=mag, bp_rp=col),
                          separators=(",", ":")))
print(len(mag), "stars", f"{OUT.stat().st_size / 1024:.0f} KB")
