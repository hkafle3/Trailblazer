"""Data check: the baked facts (detail.facts, bake/comet_facts.py) and the daily snapshot (now, worker/src/now.js) for five
comets against a fresh JPL Horizons query, within stated tolerances. Reads the running app's API; asks Horizons itself.
If JPL has published a new orbit solution since the bake, the orbit comparisons are reported as such, not as failures
(the fix is a re-bake). Exit 1 on any failure.
Run: python3 bake/check_facts.py [http://127.0.0.1:8873]"""
import json, math, re, sys, time, urllib.parse, urllib.request

API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8873"
HZ = "https://ssd.jpl.nasa.gov/api/horizons.api?"
COMETS = ["C/2026 A2 (Bok)", "235P/LINEAR", "3I/ATLAS", "C/2025 R2 (SWAN)", "240P/NEAT-B"]
MJD_JD = 2400000.5
TOL = dict(e=2e-5, q=2e-5, i=1e-3, tp=0.02, moid=2e-5, peri_jd=0.05, peri_q=2e-5, enc_jd=0.05, enc_delta=2e-5,
           now_delta=1e-6, now_r=1e-6, now_T=0.01, now_elong=0.01, now_v=1e-6, link_arcsec=2.0, photo_arcsec=20.0)
fails, notes = [], []


def get(url, tries=8):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return r.read()
        except Exception as e:
            time.sleep(3 * 2 ** k)
    raise IOError(url[:100])


def hz(des, frag, **p):
    p = {"format": "json", "COMMAND": f"'DES={des};" + ("'" if frag else " CAP; NOFRAG;'"), "MAKE_EPHEM": "YES", "CSV_FORMAT": "YES", **p}
    text = json.loads(get(HZ + urllib.parse.urlencode(p)))["result"]
    time.sleep(1)
    assert "$$SOE" in text, text[-300:]
    return text


def rows(text):
    head = text.split("$$SOE")[0].strip().splitlines()
    cols = [c.strip() for c in head[-2].split(",")]
    return [dict(zip(cols, [x.strip() for x in l.split(",")])) for l in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()]


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok: fails.append(what)


def close(name, got, want, tol, cid, soft=False):
    ok = got is not None and want is not None and abs(got - want) <= tol
    if not ok and soft: notes.append(f"{cid} {name}: baked {got}, fresh {want} (JPL's solution changed since the bake)"); print("NOTE", notes[-1]); return
    check(ok, f"{cid} {name}: baked {got}, fresh {want} (within {tol})")


def sep(a1, d1, a2, d2):
    r = math.radians
    c = math.sin(r(d1)) * math.sin(r(d2)) + math.cos(r(d1)) * math.cos(r(d2)) * math.cos(r(a1 - a2))
    return math.degrees(math.acos(max(-1, min(1, c)))) * 3600


for cid in COMETS:
    c = json.loads(get(API + "/api/comets/" + urllib.parse.quote(cid, safe="")))
    f, now = (c.get("detail") or {}).get("facts"), c.get("now")
    if not f: check(False, f"{cid}: no baked facts in its record"); continue
    o, des, frag = f["orb"], f["orb"]["des"], f["orb"]["frag"]
    el = hz(des, frag, EPHEM_TYPE="ELEMENTS", OBJ_DATA="YES", CENTER="'500@10'", TLIST=f"'{o['epoch']}'", REF_PLANE="ECLIPTIC", OUT_UNITS="AU-D", CSV_FORMAT="NO")
    soln = (re.search(r"soln ref\.=\s*(JPL#[^,\s]+)", el) or [None, None])[1]
    changed = soln != o["soln"]
    if changed: notes.append(f"{cid}: JPL's solution is now {soln}, baked {o['soln']}"); print("NOTE", notes[-1])
    body = el.split("$$SOE")[1]
    v = {k: float(x) for k, x in re.findall(r"\b(EC|QR|IN|Tp)\s*=\s*([-\d.E+]+)", body)}
    moid = float(re.search(r"MOID=\s*([-\d.E+]+)", el).group(1))
    close("eccentricity", o["e"], v["EC"], TOL["e"], cid, changed)
    close("perihelion distance (AU)", o["q"], v["QR"], TOL["q"], cid, changed)
    close("inclination (deg)", o["i"], v["IN"], TOL["i"], cid, changed)
    close("osculating perihelion time (JD)", o["tp"], v["Tp"], TOL["tp"], cid, changed)
    close("MOID (AU)", o["moid"], moid, TOL["moid"], cid, changed)
    for key in ("prev", "next"):   # each refined perihelion passage: a fresh 10-minute table around it
        p = f["peri"][key]
        if not p: continue
        t = rows(hz(des, frag, EPHEM_TYPE="OBSERVER", CENTER="'500@399'", START_TIME=f"'JD{p['jd'] - 0.5}'", STOP_TIME=f"'JD{p['jd'] + 0.5}'",
                    STEP_SIZE="'10 m'", QUANTITIES="'19'", CAL_FORMAT="JD"))
        best = min(t, key=lambda r: float(r["r"]))
        jd = float(next(v for k, v in best.items() if k.startswith("Date")))
        close(f"{key} perihelion date (JD)", p["jd"], jd, TOL["peri_jd"], cid, changed)
        close(f"{key} perihelion distance (AU)", p["q"], float(best["r"]), TOL["peri_q"], cid, changed)
    if f.get("enc"):
        e = f["enc"]
        t = rows(hz(des, frag, EPHEM_TYPE="OBSERVER", CENTER="'500@399'", START_TIME=f"'JD{e['jd'] - 0.5}'", STOP_TIME=f"'JD{e['jd'] + 0.5}'",
                    STEP_SIZE="'10 m'", QUANTITIES="'20'", CAL_FORMAT="JD"))
        best = min(t, key=lambda r: float(r["delta"]))
        close("closest to Earth this pass (JD)", e["jd"], float(next(v for k, v in best.items() if k.startswith("Date"))), TOL["enc_jd"], cid, changed)
        close("closest to Earth this pass (AU)", e["delta"], float(best["delta"]), TOL["enc_delta"], cid, changed)
    if now:
        jd = (time.mktime(time.strptime(now["as_of"], "%Y-%m-%d")) - time.timezone) / 86400 + 2440587.5
        r0 = rows(hz(des, frag, EPHEM_TYPE="OBSERVER", CENTER="'500@399'", TLIST=f"'{jd}'", TLIST_TYPE="JD", QUANTITIES="'1,9,19,20,23,29'",
                     ANG_FORMAT="DEG", EXTRA_PREC="YES"))[0]
        same = now["soln"] == soln
        close("snapshot delta (AU)", now["delta"], float(r0["delta"]), TOL["now_delta"], cid, not same)
        close("snapshot r (AU)", now["r"], float(r0["r"]), TOL["now_r"], cid, not same)
        close("snapshot elongation (deg)", now["elong"], float(r0["S-O-T"]), TOL["now_elong"], cid, not same)
        T = None if r0["T-mag"] == "n.a." else float(r0["T-mag"])
        if now["T"] is not None or T is not None: close("snapshot magnitude", now["T"], T, TOL["now_T"], cid, not same)
        vec = rows(hz(des, frag, EPHEM_TYPE="VECTORS", CENTER="'500@10'", TLIST=f"'{jd}'", TLIST_TYPE="JD", REF_PLANE="ECLIPTIC", OUT_UNITS="AU-D", VEC_TABLE="2"))[0]
        close("snapshot speed (AU/day)", math.hypot(now["vx"], now["vy"], now["vz"]), math.hypot(*(float(vec[k]) for k in ("VX", "VY", "VZ"))), TOL["now_v"], cid, not same)
    else: check(False, f"{cid}: no snapshot")
    photos = {round(p["mjd"], 4) for p in c["detail"].get("photos") or []}
    for k, vis in enumerate(f["inv"]["visits"][:3]):   # the comet's place on the first visits' linked pictures, as SPHEREx saw it
        l = vis["link"]
        t = rows(hz(des, frag, EPHEM_TYPE="OBSERVER", CENTER="'500@-163182'", TLIST=f"'{l['t'] + MJD_JD}'", TLIST_TYPE="JD", QUANTITIES="'1'", ANG_FORMAT="DEG"))[0]
        a = float(next(v for kk, v in t.items() if kk.startswith("R.A."))); d = float(next(v for kk, v in t.items() if kk.startswith("DEC")))
        tol = TOL["photo_arcsec"] if round(l["t"], 4) in photos else TOL["link_arcsec"]
        s = sep(l["ra"], l["dec"], a, d)
        check(s <= tol or changed, f"{cid} visit {k + 1} link position: {s:.2f} arcsec from Horizons (within {tol})")

print(f"\n{'FAIL' if fails else 'PASS'} facts against a fresh Horizons query: {len(COMETS)} comets, {len(fails)} failures, {len(notes)} notes")
sys.exit(1 if fails else 0)
