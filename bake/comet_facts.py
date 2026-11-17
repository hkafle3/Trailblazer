"""The facts a comet's page states (comet-plan/fact-table.md, build item 1), for every known comet, into
worker/migrations/<name>.sql as detail.facts, plus web/data/planets.json (the planets' paths for Depth) and one picture
per SPHEREx visit under web/data/comets/visits/.

For each comet, from JPL (ORB: fixed until JPL's solution changes; the daily "right now" values are the Worker's cron):
- orbit elements at the bake day's epoch, with JPL's solution id and date, the solution's own element epoch, its data
  arc (first and last observation), MOID and the bake time (Horizons ELEMENTS + its OBJ_DATA header);
- a daily ephemeris from before the first picture (or the last perihelion) to the bake day + 2 years: the perihelion
  passages and the closest approach to Earth this pass, each a minimum of r or delta bracketed in the daily table and
  refined in an hourly one; a minimum at either end of a search is no minimum (None). A periodic comet whose next
  perihelion falls past the 2 years gets a longer integrated search for it;
- heliocentric positions for Depth (a full orbit for periodic comets under 30 years, otherwise the first picture to a
  year past perihelion or the bake day);
From SPHEREx (SX):
- every picture whose outline held the comet, over the whole survey and on any of the six detectors: IRSA's
  moving-object search (MOST, by JPL's SPK-ID, so a fragment is searched as itself), each kept only when the comet's
  position as SPHEREx saw it (Horizons, hourly, interpolated to the exposure) is inside the picture's outline;
- visits: pictures grouped at gaps of 5 days or more;
- per-picture verdicts on up to 5 pictures a visit (bake/visit_verdicts.mjs, which runs web/live/cutout.js knownPhoto,
  the page's own measurement): seen (SNR 5 or more), faint, unmeasured; each visit's clearest picture is its time-lapse
  link and, for comets without a baked photo there, its picture;
CUR: status for comets that broke up (DISRUPTED, reviewed by a person) and fragments (from the designation).

Nothing is written to any database: the migration is applied with npm run db:local (or db:remote at deploy).
Run (with the app up on 8873, which answers /api/images for the measuring step):
  uv run -q --with numpy --with certifi sh -c 'SSL_CERT_FILE=$(python -m certifi) exec python -u bake/comet_facts.py 0017_comet_facts [--api http://127.0.0.1:8873] [--today 2026-11-17] [ids...]'
Raw replies are cached in bake/cache/facts/ (delete a comet's folder to fetch it again).
"""
import json, math, re, subprocess, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import urllib.request

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from known_comets import inside             # gnomonic point-in-outline (checked on import)
from seed_d1 import q

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "bake" / "cache" / "facts"
HZ = "https://ssd.jpl.nasa.gov/api/horizons.api?"
JD_UNIX, MJD_JD = 2440587.5, 2400000.5
GAP = 5            # days between pictures that start a new visit
MEASURE = 5        # pictures measured per visit at most (a visit is seen when any of them is)
SPHEREX = "500@-163182"
HZ_LOCK = __import__("threading").Lock()   # Horizons' observer code for the spacecraft
# CUR: comets reported to have broken up. A person reviews this list; the page then gates its brightness forecast (R2).
DISRUPTED = {
    "C/2024 G3 (ATLAS)": "broke up after it passed the Sun in January 2025",
    "C/2025 F2 (SWAN)": "broke up in spring 2025",
    "C/2025 K1 (ATLAS)": "broke into pieces in late 2025; JPL tracks them as C/2025 K1-B, -C and -D",
}

args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and sys.argv[i - 1] not in ("--api", "--today")]
opt = lambda k, d: next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == k), d)
OUT_NAME, ONLY = args[0], set(args[1:])
API = opt("--api", "http://127.0.0.1:8873")
TODAY = datetime.strptime(opt("--today", datetime.now(timezone.utc).strftime("%Y-%m-%d")), "%Y-%m-%d").replace(tzinfo=timezone.utc)
JD_TODAY = TODAY.timestamp() / 86400 + JD_UNIX


def get(url, tries=12):
    """GET with retries (IRSA and JPL both have bad minutes; bake/flipbook.py get without its image libraries)."""
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            if data[:30].startswith(b"Server busy") or b"Proxy Error" in data[:400]: raise IOError(data[:60])
            return data
        except Exception as e:
            wait = min(120, 3 * 2 ** i)
            print(f"  retry {i + 1}/{tries} in {wait}s: {str(e)[:80]} {url[:90]}", flush=True)
            time.sleep(wait)
    raise IOError(f"gave up: {url[:120]}")


def jd_date(jd): return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(days=jd - JD_UNIX))
def iso(jd): return jd_date(jd).strftime("%Y-%m-%d")
def hz_time(jd): return "JD" + f"{jd:.5f}"
def slug(cid): return re.sub(r"[^a-z0-9]+", "-", cid.lower()).strip("-")


# ---------- designations ----------
def designation(cid):
    """(Horizons DES, is a fragment). 3I/ATLAS is C/2025 N1; 240P/NEAT-B is 240P-B; C/2025 K1-B (ATLAS) is 2025 K1-B."""
    if cid == "3I/ATLAS": return "2025 N1", False
    m = re.match(r"^(\d+P)/.+?(-[A-Z])?$", cid)
    if m: return m.group(1) + (m.group(2) or ""), bool(m.group(2))
    m = re.match(r"^[CP]/(\d{4} [A-Z]{1,2}\d*)(-[A-Z])?", cid)
    return m.group(1) + (m.group(2) or ""), bool(m.group(2))


def _check_designation():
    assert designation("3I/ATLAS") == ("2025 N1", False)
    assert designation("240P/NEAT-B") == ("240P-B", True) and designation("240P/NEAT") == ("240P", False)
    assert designation("C/2025 K1-B (ATLAS)") == ("2025 K1-B", True) and designation("C/2026 AZ17 (Bok)") == ("2026 AZ17", False)
    assert designation("P/2018 VN2 (Leonard)") == ("2018 VN2", False) and designation("302P/Lemmon-PANSTARRS") == ("302P", False)


_check_designation()


# ---------- JPL Horizons ----------
def horizons(cid, kind, params, name):
    """One Horizons reply (text), cached per comet; the target it answered for must be this comet (a fragment as itself)."""
    f = CACHE / slug(cid) / f"{name}.txt"
    if f.exists(): return f.read_text()
    des, frag = designation(cid)
    p = {"format": "json", "COMMAND": f"'DES={des};" + ("'" if frag else " CAP; NOFRAG;'"), "MAKE_EPHEM": "YES",
         "EPHEM_TYPE": kind, "CSV_FORMAT": "YES", **params}
    p.setdefault("OBJ_DATA", "NO")
    with HZ_LOCK:   # Horizons answers 503 to parallel requests from one client
        text = json.loads(get(HZ + urllib.parse.urlencode(p)).decode()).get("result", "")
    assert "$$SOE" in text, f"{cid} {name}: Horizons answered without a table: {text[-400:]}"
    target = re.search(r"Target body name: (.+?)\s+\{", text).group(1)
    assert des in target and (frag or f"{des}-" not in target), f"{cid}: Horizons answered for {target}"
    f.parent.mkdir(parents=True, exist_ok=True); f.write_text(text)
    time.sleep(0.3)
    return text


def table(text):
    """The CSV rows between $$SOE and $$EOE as dicts keyed by the header's column names."""
    head = text.split("$$SOE")[0].strip().splitlines()
    cols = [c.strip() for c in head[-2].split(",")]
    rows = []
    for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        rows.append(dict(zip(cols, [x.strip() for x in line.split(",")])))
    return rows


def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None


def solution(text):
    """JPL's solution: its reference (JPL#34), date, data arc and the header's MOID, M1, k1."""
    ref = re.search(r"soln ref\.=\s*(JPL#[^,\s]+)", text) or re.search(r"\{source: (JPL#[^}\s]+)\}", text)
    arc = re.search(r"data arc:\s*(\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d)", text)
    g = lambda k: (re.search(r"\b" + k + r"=\s*([-\d.E+]+)", text) or [None, None])[1]
    return dict(ref=ref.group(1) if ref else None, date=(re.search(r"Soln\.date:\s*(\S+)", text) or [None, None])[1],
                first_obs=arc.group(1) if arc else None, last_obs=arc.group(2) if arc else None,
                epoch=num(g("EPOCH")), moid=num(g("MOID")), m1=num(g("M1")), k1=num(g("k1")))


def elements(cid):
    text = horizons(cid, "ELEMENTS", {"OBJ_DATA": "YES", "CENTER": "'500@10'", "TLIST": f"'{JD_TODAY:.1f}'", "REF_PLANE": "ECLIPTIC",
                                      "OUT_UNITS": "AU-D", "CSV_FORMAT": "NO"}, f"elements-{iso(JD_TODAY)}")
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    v = {k: num(x) for k, x in re.findall(r"\b(EC|QR|IN|OM|W|Tp|N|MA|TA|A|AD|PR)\s*=\s*([-\d.E+]+)", body)}
    e, a = v["EC"], v.get("A")
    per = v["PR"] / 365.25 if e < 1 and v.get("PR") and v["PR"] < 1e9 else None   # PR is days; open orbits have none
    return text, dict(e=e, q=v["QR"], i=v["IN"], node=v["OM"], peri=v["W"], tp=v["Tp"], a=a if e < 1 else None, per=per,
                      epoch=JD_TODAY)


OBS_Q = "'1,9,19,20,23,29'"


def ephemeris(cid, start, stop, step, name, center="'500@399'", q=OBS_Q):
    text = horizons(cid, "OBSERVER", {"CENTER": center, "START_TIME": f"'{hz_time(start)}'", "STOP_TIME": f"'{hz_time(stop)}'",
                                      "STEP_SIZE": f"'{step}'", "QUANTITIES": q, "ANG_FORMAT": "DEG", "EXTRA_PREC": "YES",
                                      "CAL_FORMAT": "JD"}, name)
    out = []
    for r in table(text):
        at = lambda pre: next((v for k, v in r.items() if k.startswith(pre)), None)
        out.append(dict(jd=num(at("Date")), ra=num(at("R.A.")), dec=num(at("DEC")), T=num(r.get("T-mag")),
                        r=num(r.get("r")), rdot=num(r.get("rdot")), delta=num(r.get("delta")), deldot=num(r.get("deldot")),
                        elong=num(r.get("S-O-T")), side=r.get("/r"), cnst=r.get("Cnst")))
    return out


def refine(cid, rows, key, k, name):
    """The minimum of rows[k][key], bracketed (an interior daily minimum), refined in an hourly table around it."""
    if k <= 0 or k >= len(rows) - 1: return None
    fine = ephemeris(cid, rows[k - 1]["jd"], rows[k + 1]["jd"], "1 h", name)
    j = min(range(len(fine)), key=lambda i: fine[i][key])
    if j == 0 or j == len(fine) - 1: return None
    return dict(jd=round(fine[j]["jd"], 3), value=fine[j][key])


def minima(rows, key):
    """Indices of interior local minima of rows[*][key] (daily table)."""
    v = [r[key] for r in rows]
    return [i for i in range(1, len(v) - 1) if v[i] is not None and v[i - 1] is not None and v[i + 1] is not None and v[i] <= v[i - 1] and v[i] < v[i + 1]]


def vectors(cid, start, stop, step, name, command=None):
    p = {"CENTER": "'500@10'", "START_TIME": f"'{hz_time(start)}'", "STOP_TIME": f"'{hz_time(stop)}'", "STEP_SIZE": f"'{step}'",
         "REF_PLANE": "ECLIPTIC", "OUT_UNITS": "AU-D", "VEC_TABLE": "2"}
    if command:   # a planet
        f = CACHE / "planets" / f"{name}.txt"
        if not f.exists():
            p.update({"format": "json", "COMMAND": f"'{command}'", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "VECTORS", "CSV_FORMAT": "YES", "OBJ_DATA": "NO"})
            text = json.loads(get(HZ + urllib.parse.urlencode(p)).decode())["result"]
            assert "$$SOE" in text, text[-300:]
            f.parent.mkdir(parents=True, exist_ok=True); f.write_text(text)
        text = f.read_text()
    else:
        text = horizons(cid, "VECTORS", p, name)
    return [[round(num(r["JDTDB"]), 2)] + [round(num(r[c]), 4) for c in ("X", "Y", "Z")] for r in table(text)]


# ---------- SPHEREx: every picture whose outline held the comet ----------
def spkid(cid):
    des = "3I" if cid == "3I/ATLAS" else designation(cid)[0]
    f = CACHE / slug(cid) / "sbdb.json"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(get("https://ssd-api.jpl.nasa.gov/sbdb.api?" + urllib.parse.urlencode({"des": des})))
    return json.loads(f.read_text())["object"]


def most(cid):
    """IRSA MOST over the whole survey, by SPK-ID: [{obs, det, t (mid-exposure MJD), poly[8], uri}] (DR1 wins a duplicate)."""
    f = CACHE / slug(cid) / "most.txt"
    o = spkid(cid)
    if not f.exists():
        url = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?" + urllib.parse.urlencode(
            {"catalog": "spherex", "input_type": "naifid_input", "obj_naifid": o["spkid"], "obs_begin": "2025-04-01",
             "obs_end": iso(JD_TODAY), "output_mode": "Brief"})
        for k in range(5):   # MOST sometimes answers with nothing at all: ask again, and never keep such an answer
            text = get(url).decode()
            if any(l.startswith("|") for l in text.splitlines()): break
            print(f"  MOST gave {cid} no table, again in 30 s", flush=True); time.sleep(30)
        f.write_text(text)
    lines = f.read_text().splitlines()
    head = next((l for l in lines if l.startswith("|")), None)
    assert head, f"{cid}: MOST answered without a table: {lines[:5]}"
    named = next(l for l in lines if l.startswith("\\object_name"))
    des = designation(cid)[0] if cid != "3I/ATLAS" else "2025 N1"
    assert des in named and ("-" in des or f"{des}-" not in named), f"{cid}: MOST searched {named}"
    bars = [i for i, ch in enumerate(head) if ch == "|"]
    cols = [head[i + 1:j].strip() for i, j in zip(bars, bars[1:])]
    out = {}
    for l in lines:
        if l.startswith(("\\", "|")) or not l.strip(): continue
        r = {k: l[i:j + 1].strip() for k, i, j in zip(cols, bars, bars[1:])}
        key = (r["observationid"], r["productid"])
        pic = dict(obs=r["observationid"], det=r["productid"], t=(float(r["mjd_start"]) + float(r["mjd_end"])) / 2,
                   poly=[float(r[f"{x}{n}"]) for n in range(1, 5) for x in ("ra", "dec")], dr1="/dr1/" in r["uri"])
        if key not in out or pic["dr1"] and not out[key]["dr1"]: out[key] = pic
    return sorted(out.values(), key=lambda p: (p["t"], p["det"]))


def held(cid, pics):
    """The pictures whose outline holds the comet as SPHEREx saw it (Horizons from the spacecraft, hourly, interpolated)."""
    if not pics: return []
    t0, t1 = min(p["t"] for p in pics) - 0.1, max(p["t"] for p in pics) + 0.1
    rows = ephemeris(cid, t0 + MJD_JD, t1 + MJD_JD, "1 h", "spherex-hourly", center=f"'{SPHEREX}'", q="'1'")
    jd = np.array([r["jd"] for r in rows]) - MJD_JD
    ra = np.degrees(np.unwrap(np.radians([r["ra"] for r in rows]))); dec = np.array([r["dec"] for r in rows])
    t = np.array([p["t"] for p in pics])
    pra, pdec = np.interp(t, jd, ra) % 360, np.interp(t, jd, dec)
    hit = inside(pra, pdec, np.array([p["poly"] for p in pics]))
    return [dict(obs=p["obs"], det=p["det"], t=round(p["t"], 5), ra=round(float(a), 5), dec=round(float(d), 5))
            for p, a, d, h in zip(pics, pra, pdec, hit) if h]


def at_times(cid, ts):
    """{t: (ra, dec)}: the comet as SPHEREx saw it at each MJD (Horizons, 40 times a request)."""
    out = {}
    for i in range(0, len(ts), 40):
        batch = ts[i:i + 40]
        tl = " ".join(f"{t + MJD_JD:.6f}" for t in batch)
        rows = table(horizons(cid, "OBSERVER", {"CENTER": f"'{SPHEREX}'", "TLIST": f"'{tl}'", "TLIST_TYPE": "JD", "QUANTITIES": "'1'",
                                                "ANG_FORMAT": "DEG", "EXTRA_PREC": "YES"}, f"exact-{i // 40}-{batch[0]:.4f}-{len(batch)}"))
        assert len(rows) == len(batch), f"{cid}: Horizons gave {len(rows)} of {len(batch)} positions"
        for t, r in zip(batch, rows):
            out[t] = (round(num(next(v for k, v in r.items() if k.startswith("R.A."))), 5), round(num(next(v for k, v in r.items() if k.startswith("DEC"))), 5))
    return out


def visits_of(pics):
    vs = []
    for i, p in enumerate(pics):
        if i == 0 or p["t"] - pics[i - 1]["t"] >= GAP: vs.append([])
        vs[-1].append(p)
    return vs


def to_measure(v):
    """Up to MEASURE pictures of a visit, the middle one first, spread through the visit."""
    n = len(v)
    idx = [(n - 1) // 2] + [round(k * (n - 1) / (MEASURE - 1)) for k in range(MEASURE)] if n > 1 else [0]
    out = []
    for i in idx:
        if v[i] not in out: out.append(v[i])
    return out[:MEASURE]


# ---------- the comet's facts ----------
def facts(cid, rec):
    d = rec["detail"] or {}
    el_text, el = elements(cid)
    sol = solution(el_text)
    des, frag = designation(cid)
    pics = held(cid, most(cid))
    first = min([p["t"] for p in pics] + [p["mjd"] for p in d.get("photos") or []] or [JD_TODAY - MJD_JD]) + MJD_JD
    # the daily ephemeris: from before the first picture or the last perihelion, to two years ahead
    start = math.floor(min(first, el["tp"] if el["tp"] < JD_TODAY else first) - 60) + 0.5
    stop = math.floor(JD_TODAY + 731) + 0.5
    eph = ephemeris(cid, start, stop, "1 d", f"daily-{iso(start)}-{iso(stop)}")
    passages = [refine(cid, eph, "r", k, f"peri-{k}") for k in minima(eph, "r")]
    passages = [dict(jd=p["jd"], q=p["value"]) for p in passages if p]
    nxt = next((p for p in passages if p["jd"] > JD_TODAY), None)
    prev = next((p for p in reversed(passages) if p["jd"] <= JD_TODAY), None)
    covered = eph[-1]["jd"]
    if el["per"] and el["per"] < 200 and not nxt:   # a periodic comet's next return lies past the two years: search for it
        span = (prev["jd"] if prev else el["tp"]) + el["per"] * 365.25 * 1.15 + 60
        step = "10 d" if el["per"] < 40 else "30 d"
        long = ephemeris(cid, stop, span, step, f"return-{iso(stop)}-{iso(span)}", q="'19'")
        ks = minima(long, "r")
        if ks:
            fine = ephemeris(cid, long[ks[0] - 1]["jd"], long[ks[0] + 1]["jd"], "1 h", "return-fine-1h", q="'19'")
            j = min(range(len(fine)), key=lambda i: fine[i]["r"])
            if 0 < j < len(fine) - 1: nxt = dict(jd=round(fine[j]["jd"], 2), q=fine[j]["r"])
        covered = long[-1]["jd"]
    # closest to Earth this pass: the global minimum of delta within a year of the perihelion passage nearest today
    near = min([p for p in (prev, nxt) if p], key=lambda p: abs(p["jd"] - JD_TODAY), default=None)
    enc = None
    if near:
        win = [i for i, r in enumerate(eph) if abs(r["jd"] - near["jd"]) <= 365]
        if win:
            k = min(win, key=lambda i: eph[i]["delta"])
            if win[0] < k < win[-1]:
                m = refine(cid, eph, "delta", k, f"enc-{k}")
                if m: enc = dict(jd=m["jd"], delta=m["value"])
    # Depth: heliocentric positions
    if el["per"] and el["per"] < 30:
        p0 = (prev or near or {"jd": el["tp"]})["jd"]
        d0, d1 = p0, p0 + el["per"] * 365.25
    else:
        d0 = first - 30
        d1 = max(JD_TODAY, (nxt or prev or {"jd": JD_TODAY})["jd"]) + 365
        if cid == "3I/ATLAS": d1 = max(d1, JD_TODAY + 45)
    step = max(1, math.ceil((d1 - d0) / 320))
    path = vectors(cid, d0, d1, f"{step} d", f"path-{iso(d0)}-{iso(d1)}-{step}")
    # the measured pictures (each visit's link is one of them) get the comet's exact place at their own moment: SPHEREx
    # circles Earth every 95 minutes, which moves a near comet by arcseconds between the hourly rows
    exact = at_times(cid, sorted({p["t"] for v in visits_of(pics) for p in to_measure(v)}))
    pics = [dict(p, ra=exact[p["t"]][0], dec=exact[p["t"]][1]) if p["t"] in exact else p for p in pics]
    # visits and their pictures
    vs = []
    for v in visits_of(pics):
        mid = (v[0]["t"] + v[-1]["t"]) / 2 + MJD_JD
        r = min(eph, key=lambda e: abs(e["jd"] - mid))
        vs.append(dict(start=round(v[0]["t"], 4), end=round(v[-1]["t"], 4), n=len(v), dets=sorted({p["det"] for p in v}),
                       delta=round(r["delta"], 4) if abs(r["jd"] - mid) <= 1 else None, measure=to_measure(v), pics=v))
    status = "fragment" if frag else ("disrupted" if cid in DISRUPTED else None)
    extrap = bool(prev and sol["last_obs"] and jd_of(sol["last_obs"]) < prev["jd"] <= JD_TODAY)
    return dict(
        baked=TODAY.strftime("%Y-%m-%d"),
        orb=dict(des=des, frag=frag, soln=sol["ref"], soln_date=sol["date"], soln_epoch=sol["epoch"], first_obs=sol["first_obs"], last_obs=sol["last_obs"],
                 moid=sol["moid"], m1=sol["m1"], k1=sol["k1"], **{k: round(v, 8) if isinstance(v, float) else v for k, v in el.items()}),
        peri=dict(prev=prev, next=nxt, covered=round(covered, 1)), enc=enc,
        status=status, status_note=DISRUPTED.get(cid), extrapolated=extrap,
        eph=dict(start=eph[0]["jd"], T=[[round(e["jd"], 1), e["T"]] for e in eph[::5] if e["T"] is not None]),
        path=dict(rows=path, step=step), visits=vs)


def parent_sep(cid, link):
    """Arcsec between a fragment's position on its link picture and its parent's position then (Horizons, from SPHEREx)."""
    parent = re.sub(r"-[B-Z]", "", cid)
    jd = link["t"] + MJD_JD
    rows = ephemeris(parent, jd, jd + 1 / 24, "1 h", f"frag-{slug(cid)}-{link['t']:.4f}", center=f"'{SPHEREX}'", q="'1'")
    a, d = rows[0]["ra"], rows[0]["dec"]
    c = math.sin(math.radians(d)) * math.sin(math.radians(link["dec"])) + math.cos(math.radians(d)) * math.cos(math.radians(link["dec"])) * math.cos(math.radians(a - link["ra"]))
    return round(math.degrees(math.acos(min(1, c))) * 3600, 1)


def jd_of(s): return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() / 86400 + JD_UNIX


def planets():
    """One lap of Mars and Jupiter and Earth through 2025-2029, heliocentric ecliptic AU, for Depth (web/data/planets.json)."""
    out = {}
    for name, cmd, d0, d1, step in (("earth", "399", jd_of("2025-01-01"), jd_of("2029-01-01"), "2 d"),
                                     ("mars", "499", jd_of("2026-01-01"), jd_of("2026-01-01") + 687, "4 d"),
                                     ("jupiter", "599", jd_of("2026-01-01"), jd_of("2026-01-01") + 4333, "20 d")):
        out[name] = vectors(None, d0, d1, step, f"{name}-{step.replace(' ', '')}", command=cmd)
    (ROOT / "web/data/planets.json").write_text(json.dumps(out, separators=(",", ":")))


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    listing = json.loads(get(API + "/api/comets").decode())["comets"]
    ids = [c["id"] for c in listing if c["kind"] == "known" and (not ONLY or c["id"] in ONLY)]
    recs = {cid: json.loads(get(API + "/api/comets/" + urllib.parse.quote(cid, safe="")).decode()) for cid in ids}
    planets()
    with ThreadPoolExecutor(3) as pool:
        done = dict(zip(ids, pool.map(lambda cid: facts(cid, recs[cid]), ids)))
    # measuring: the page's own measurement (web/live/cutout.js knownPhoto) through node, cached per picture
    jobs = [dict(cid=cid, visit=k, obs=p["obs"], det=p["det"], t=p["t"], ra=p["ra"], dec=p["dec"],
                 png=f"web/data/comets/visits/{slug(cid)}/{p['obs']}_{p['det']}.png")
            for cid, f in done.items() for k, v in enumerate(f["visits"]) for p in v["measure"]]
    jf = CACHE / "measure-jobs.json"; jf.write_text(json.dumps(jobs))
    if "--no-measure" not in sys.argv:
        subprocess.run(["node", str(ROOT / "bake/visit_verdicts.mjs"), str(jf), API, str(CACHE / "measure-results.json")], check=True)
    rf = CACHE / "measure-results.json"
    res = {(r["obs"], r["det"]): r for r in (json.loads(rf.read_text()) if rf.exists() else [])}
    sql = [f"-- Generated by bake/comet_facts.py on {TODAY:%Y-%m-%d}: what each known comet's page states (comet-plan/fact-table.md)"]
    for cid, f in done.items():
        d = recs[cid]["detail"] or {}
        photos = sorted(d.get("photos") or [], key=lambda p: p["mjd"])
        n_pics = sum(v["n"] for v in f["visits"])
        out_vs = []
        for v in f["visits"]:
            got = [dict(res[(p["obs"], p["det"])], **p) for p in v["measure"] if (p["obs"], p["det"]) in res]
            seen = [g for g in got if g["verdict"] == "seen"]
            valid = [g for g in got if g["verdict"] in ("seen", "faint")]
            verdict = "seen" if seen else "faint" if valid else "unmeasured"
            best = max(seen, key=lambda g: g["snr"]) if seen else (got[0] if got else v["measure"][0])
            mine = [p for p in photos if v["start"] - 0.01 <= p["mjd"] <= v["end"] + 0.01]   # baked photos in this visit
            if mine:   # a measured comet's clearest photo of the visit is its picture and its link
                ph = max(mine, key=lambda p: p["flux"])
                link = dict(t=ph["mjd"], ra=ph["ra"], dec=ph["dec"], det=ph["file"].rsplit("_", 1)[1][:2])
                img = f"data/comets/{d['dir']}/{ph['file']}"
            else:
                link = dict(t=best["t"], ra=best["ra"], dec=best["dec"], det=best["det"])
                img = best.get("png", "").replace("web/", "", 1) if best.get("png_ok") else None
            near = None
            if seen and designation(cid)[1]:   # a fragment: is its light within the 25 arcsec circle of its parent's position?
                near = parent_sep(cid, link)
            out_vs.append(dict(start=v["start"], end=v["end"], n=v["n"], dets=v["dets"], delta=v["delta"], verdict=verdict,
                               lam=best.get("lam") if not mine else ph["lam"], near_parent=near if near is not None and near <= 25 else None,
                               snr=round(max(g["snr"] for g in seen), 1) if seen else None, measured=len(valid), tried=len(got),
                               why=next((g["why"] for g in got if g.get("why")), None), link=link, img=img))
        # magnitude at the link's exposure: interpolated in the daily table (B1)
        Tj, Tv = [r[0] for r in f["eph"]["T"]], [r[1] for r in f["eph"]["T"]]
        for v in out_vs:
            x = v["link"]["t"] + MJD_JD
            v["T"] = round(float(np.interp(x, Tj, Tv)), 1) if Tj and Tj[0] <= x <= Tj[-1] else None
        inv = dict(n=n_pics, first=f["visits"][0]["start"] if f["visits"] else None, last=f["visits"][-1]["end"] if f["visits"] else None,
                   visits=out_vs)
        body = {k: v for k, v in f.items() if k not in ("visits", "eph")}
        body["inv"] = inv
        body["T"] = f["eph"]["T"]   # predicted magnitude every 5 days (Depth's brightness, the visit's magnitude)
        js = json.dumps(body, separators=(",", ":"))
        sql.append(f"UPDATE comets SET detail = json_set(detail, '$.facts', json({q(js)})) WHERE id = {q(cid)};")
        print(f"{cid}: {n_pics} pictures, {len(out_vs)} visits ({', '.join(v['verdict'] for v in out_vs)}), "
              f"peri prev {iso(f['peri']['prev']['jd']) if f['peri']['prev'] else '-'} next {iso(f['peri']['next']['jd']) if f['peri']['next'] else '-'}, "
              f"enc {iso(f['enc']['jd']) + ' ' + str(round(f['enc']['delta'], 3)) if f['enc'] else '-'}, soln {f['orb']['soln']}", flush=True)
    (ROOT / f"worker/migrations/{OUT_NAME}.sql").write_text("\n".join(sql) + "\n")
    used = set(re.findall(r'"img":"(data/comets/visits/[^"]+)"', "\n".join(sql)))   # keep only the pictures a page shows
    for png in (ROOT / "web/data/comets/visits").glob("*/*.png"):
        if str(png.relative_to(ROOT / "web")) not in used: png.unlink()
    print(f"wrote worker/migrations/{OUT_NAME}.sql ({len(done)} comets)")


if __name__ == "__main__":
    main()
