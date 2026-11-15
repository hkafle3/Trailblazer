"""Daily geocentric positions for survey-era comets, for the patch reticles.

Reads the Minor Planet Center comet-elements snapshot and propagates each comet
with Skyfield. Keeps comets whose perihelion falls in 2024–2028. Positions are
geocentric apparent RA/Dec, once a day, from 2025-01-01 through 2027-07-01.

Writes web/data/comet_eph.json (names) and web/data/comet_eph.bin (float32 RA, Dec
per day, in comet order). The map's example markers are left alone.

Run: /tmp/comet-eph-venv/bin/python bake/comet_ephemeris.py
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from skyfield.api import load
from skyfield.constants import GM_SUN_Pitjeva_2005_km3_s2
from skyfield.data.spice import inertial_frames
from skyfield.keplerlib import _KeplerOrbit

ROOT = Path(__file__).resolve().parent.parent
SRC = Path("/Users/kei/Downloads/allcometels.json")
OUT_JSON = ROOT / "web/data/comet_eph.json"
OUT_BIN = ROOT / "web/data/comet_eph.bin"
MJD0, DAYS = 60676, 912
CHECK_MJD = 60897.0   # 2025-08-10, when SPHEREx saw 3I/ATLAS


def comet_orbit(e, q, inc, node, peri, year, month, day, ts, name):
    """Same perihelion elements as skyfield.data.mpc.comet_orbit, without pandas."""
    p = q * 2.0 if e == 1.0 else q * (1.0 + e)
    comet = _KeplerOrbit._from_periapsis(
        p, e, inc, node, peri, ts.tt(year, month, day), GM_SUN_Pitjeva_2005_km3_s2, 10, name)
    comet._rotation = inertial_frames["ECLIPJ2000"].T
    return comet


def keep(row):
    try:
        year = int(row["Year_of_perihelion"])
        q, e, inc = float(row["Perihelion_dist"]), float(row["e"]), float(row["i"])
        node, peri = float(row["Node"]), float(row["Peri"])
        month, day = int(row["Month_of_perihelion"]), float(row["Day_of_perihelion"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (2024 <= year <= 2028 and q > 0 and e >= 0 and 0 <= inc <= 180 and 1 <= month <= 12 and 0 < day < 32):
        return None
    name = " ".join(str(row.get("Designation_and_name") or "").split())
    return dict(name=name, year=year, month=month, day=day, q=q, e=e, i=inc, node=node, peri=peri) if name else None


def horizons(pdes, mjd):
    jd = mjd + 2400000.5
    params = {"format": "json", "COMMAND": f"'DES={pdes};CAP;NOFRAG'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
              "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@399'", "START_TIME": f"'JD{jd}'", "STOP_TIME": f"'JD{jd + 1}'",
              "STEP_SIZE": "'1 d'", "QUANTITIES": "'1'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'"}
    url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            text = json.loads(r.read().decode()).get("result", "")
    except Exception as exc:
        print(f"Horizons check skipped: {exc}", flush=True)
        return None
    if "$$SOE" not in text:
        print(f"Horizons check skipped: {text[:200]}", flush=True)
        return None
    parts = [x.strip() for x in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()[0].split(",")]
    return float(parts[3]), float(parts[4])


def main():
    rows = [k for k in (keep(r) for r in json.loads(SRC.read_text())) if k]
    rows.sort(key=lambda r: r["name"])
    print(f"{len(rows)} comets with perihelion 2024–2028", flush=True)
    ts = load.timescale()
    eph = load("de421.bsp")
    earth, sun = eph["earth"], eph["sun"]
    times = ts.tt_jd(MJD0 + 2400000.5 + np.arange(DAYS))
    ra = np.empty((len(rows), DAYS), np.float32)
    dec = np.empty((len(rows), DAYS), np.float32)
    failed = []
    for n, c in enumerate(rows):
        try:
            body = sun + comet_orbit(c["e"], c["q"], c["i"], c["node"], c["peri"], c["year"], c["month"], c["day"], ts, c["name"])
            r, d, _ = earth.at(times).observe(body).apparent().radec()
            ra[n], dec[n] = r.hours * 15, d.degrees
        except Exception as exc:
            failed.append((c["name"], str(exc)[:80]))
            ra[n] = dec[n] = np.nan
        if n % 40 == 0:
            print(f"  {n + 1}/{len(rows)}", flush=True)
    ok = np.isfinite(ra).all(1) & np.isfinite(dec).all(1)
    print(f"{int(ok.sum())} propagated, {len(failed)} failed", flush=True)
    for name, err in failed[:8]:
        print(f"  skip {name}: {err}", flush=True)
    hit = next((i for i, c in enumerate(rows) if c["name"] == "3I/ATLAS" and ok[i]), None)
    if hit is None:
        sys.exit("no usable orbit for 3I/ATLAS")
    k = int(round(CHECK_MJD - MJD0))
    # The MPC record is an osculating orbit at its own epoch. Two-body propagation matches
    # Horizons there, and drifts by arcminutes across the months perturbations accumulate.
    epoch = ts.tt(2026, 6, 9).tt
    ek = int(np.clip(round(epoch - 2400000.5 - MJD0), 0, DAYS - 1))
    def sky_at(index):
        return float(ra[hit, index]), float(dec[hit, index])
    def report(label, index, mjd):
        got = sky_at(index)
        ref = horizons("2025 N1", mjd)
        if not ref:
            print(f"{label}: RA {got[0]:.3f} Dec {got[1]:.3f}", flush=True)
            return None
        dra = ((got[0] - ref[0] + 540) % 360 - 180) * np.cos(np.radians(ref[1])) * 3600
        sep = float(np.hypot(dra, (got[1] - ref[1]) * 3600))
        print(f"{label}: Skyfield RA {got[0]:.3f} Dec {got[1]:.3f}, Horizons RA {ref[0]:.3f} Dec {ref[1]:.3f}, {sep:.0f} arcsec", flush=True)
        return sep
    at_epoch = report("3I/ATLAS at its element epoch", ek, epoch - 2400000.5)
    report("3I/ATLAS on 2025-08-10", k, CHECK_MJD)
    if at_epoch is not None and at_epoch > 60:
        sys.exit("Skyfield and Horizons disagree by more than 1 arcmin at the element epoch; not writing")
    kept = [c for c, good in zip(rows, ok) if good]
    packed = np.empty((len(kept), DAYS, 2), np.float32)
    packed[:, :, 0], packed[:, :, 1] = ra[ok], dec[ok]
    OUT_BIN.write_bytes(packed.tobytes())
    OUT_JSON.write_text(json.dumps({
        "source": "Minor Planet Center AllCometEls, Skyfield geocentric apparent positions",
        "mjd0": MJD0, "step": 1, "days": DAYS,
        "comets": [{"name": c["name"], "q": round(c["q"], 4), "e": round(c["e"], 4), "i": round(c["i"], 2)} for c in kept],
    }, separators=(",", ":")))
    print(f"wrote {len(kept)} comets, {OUT_BIN.stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
