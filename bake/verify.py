"""Science check for the baked time-lapse frames: does what we show match reality?

For every target: frames decode, enough visits match in wavelength. For targets Gaia measured with real
motion (over 1 arcsec/yr): the motion we measure from SPHEREx agrees with Gaia DR3 within 20% in speed and
20 degrees in direction; a target too faint for Gaia is checked against its published motion, more loosely. Run: python3 bake/verify.py   (exit code 1 on any failure)
"""
import base64, json, math, sys
from pathlib import Path

FLIP = Path(__file__).resolve().parent.parent / "web" / "data" / "flip"
fails = 0


def check(ok, msg):
    global fails
    fails += not ok
    print(("PASS " if ok else "FAIL ") + msg)


for d in sorted(p for p in FLIP.iterdir() if (p / "manifest.json").exists()):
    m = json.loads((d / "manifest.json").read_text())
    fr, n = m["frames"], m["grid"] ** 2
    print(f"\n{m['name']} ({m['detector']}, {len(fr)} visits, matched wavelength {m['lam0']} um +/- {m['lam_tol']})")
    check(len(fr) >= 3, f"at least 3 visits ({len(fr)})")
    check(all(len(base64.b64decode(f["data"])) == 4 * n for f in fr), "every frame has its pixel data")
    matched = sum(f["matched"] for f in fr)
    check(matched >= len(fr) - 1, f"wavelength matched in {matched} of {len(fr)} visits")
    mo, g, r = m.get("motion"), m.get("gaia"), m.get("ref")
    if mo:
        print(f"     measured motion {mo['total']} arcsec/yr (east {mo['east']}, north {mo['north']}) over {mo['years']} yr")
    # Gaia: 20% / 20 degrees. A published motion is used only for targets too faint for Gaia, which SPHEREx
    # barely detects, so it gets 35% / 30 degrees.
    want = (g, "Gaia", 0.2, 20) if g and g["total"] > 1 else (r, r["source"], 0.35, 30) if r else None
    if want and mo:
        p, label, tol, tol_deg = want
        ge, gn = p["pmra"] / 1000, p["pmdec"] / 1000
        speed = mo["total"] / p["total"]
        ang = math.degrees(abs(math.atan2(mo["east"] * gn - mo["north"] * ge, mo["east"] * ge + mo["north"] * gn)))
        check(1 - tol <= speed <= 1 + tol, f"speed {mo['total']} vs {label} {p['total']} arcsec/yr ({speed:.0%})")
        check(ang <= tol_deg, f"direction within {ang:.0f} degrees of {label}")
    elif g:
        print(f"     Gaia motion {g['total']} arcsec/yr: too small to see in about a year of 5 arcsec pixels, not checked")
    else:
        print("     no reference motion to check against")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
