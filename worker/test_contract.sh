#!/bin/sh
# Contract test for the Worker (examples and refusals in docs/api.md). Run with the app up:
#   npm run dev   then   npm test   (or: sh worker/test_contract.sh [base url])
BASE=${1:-http://127.0.0.1:8787}
fails=0
check() {   # name, url, expected status, expected text in the body
  out=$(curl -s -L -m 120 -w '\n%{http_code}' "$BASE$2")
  code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
  if [ "$code" = "$3" ] && printf '%s' "$body" | grep -q -- "$4"; then echo "PASS $1 ($code)"
  else echo "FAIL $1: got $code, wanted $3 with '$4': $(printf '%s' "$body" | head -c 200)"; fails=$((fails + 1)); fi
}
check "images for Barnard's Star" "/api/images?ra=269.4463&dec=4.7671&det=D1" 200 '"key":"dr1/level2/'
check "ra out of range" "/api/images?ra=400&dec=4" 400 'ra must be 0 to 360'
check "dec out of range" "/api/images?ra=10&dec=-95" 400 'dec must be -90 to 90'
check "bad detector" "/api/images?ra=10&dec=4&det=D9" 400 'det must be D1 to D6'
check "images fmt 2" "/api/images?ra=269.4463&dec=4.7671&det=D1&fmt=2" 200 '"fmt":2,"folders":'
check "images bad fmt" "/api/images?ra=10&dec=4&det=D1&fmt=3" 400 'fmt must be 1 or 2'
check "images region too wide" "/api/images?ra=10&dec=4&det=D1&r=0.5" 400 'r must be 0.001 to 0.15 degrees'
check "missing ra" "/api/images?dec=4" 400 'ra must be 0 to 360'
check "Gaia near Barnard's Star" "/api/gaia?ra=269.4463&dec=4.7671" 200 '"pmdec":10362'
check "depth for the 3I/ATLAS patch" "/api/depth?ra=167.1309&dec=5.1732&t=61023.3194" 200 '"rules":"depth-v1"'
check "depth without t skips SkyBoT" "/api/depth?ra=180&dec=0" 200 '"sso":{"status":"skipped"'
check "depth bad t" "/api/depth?ra=180&dec=0&t=abc" 400 't must be an MJD'
check "depth bad dec" "/api/depth?ra=180&dec=-95" 400 'dec must be -90 to 90'
check "comets list from D1" "/api/comets" 200 '"id":"3I/ATLAS"'
# every row is a real object with real data: the seeded example comets were removed (migration 0014)
if curl -s -m 120 "$BASE/api/comets" | python3 -c 'import json, sys; c = json.load(sys.stdin)["comets"]; sys.exit(not c or any(x["real"] is not True or "example" in x for x in c))'
then echo "PASS /api/comets has only real rows"; else echo "FAIL /api/comets has rows that are not real (or none)"; fails=$((fails + 1)); fi
# a known comet without measured photos gets its clearest SPHEREx photo, baked by bake/known_thumbs.py
check "a baked comet photo" "/api/comets" 200 '"thumb":"data/comets/thumbs/'
check "3I/ATLAS has real photos" "/api/comets/3I%2FATLAS" 200 '"photos":\[{"file"'
check "3I/ATLAS has a spectrum" "/api/comets/3I%2FATLAS" 200 '"spectrum":{"2025-08":\[{"lam"'
check "unknown comet" "/api/comets/C-9999" 404 'no comet C-9999'
# what a comet's page states: the baked facts (bake/comet_facts.py, migration 0017) and the daily snapshot (worker/src/now.js)
check "Bok has its baked facts" "/api/comets/C%2F2026%20A2%20(Bok)" 200 '"facts":{"baked":"'
check "Bok has its picture inventory" "/api/comets/C%2F2026%20A2%20(Bok)" 200 '"inv":{"n":'
check "a comet carries its daily snapshot" "/api/comets/235P%2FLINEAR" 200 '"now":{"as_of":"'
check "the list carries the visits' verdicts" "/api/comets" 200 '"seen":'
check "the planets' paths for Depth" "/data/planets.json" 200 '"jupiter":\[\['
check "forum threads" "/api/threads" 200 '"threads":\['
check "Forums search box" "/forums.html" 200 'id="q"'
# a malformed id must get our JSON error from the Worker; on the live site Cloudflare's edge refuses it first
case "$BASE" in *127.0.0.1*|*localhost*|*\[::1\]*) bad_id='"error":"comet id is not valid"' ;; *) bad_id='400 Bad Request' ;; esac
check "malformed comet id" "/api/comets/%ZZ" 400 "$bad_id"
# "Then and now": the older survey's tiles (worker/src/oldsky.js). Refusals, then a real spot: a stored tile's bytes are
# IRSA's own (sha256 of the FITS, gzip or not, against a direct download) and its checksum is the manifest's
check "oldsky unlisted survey" "/api/oldsky?survey=neowise&band=W2&ra=84&dec=-6" 400 'survey must be allwise or 2mass'
check "oldsky band not of the survey" "/api/oldsky?survey=2mass&band=W2&ra=84&dec=-6" 400 'band must be Ks'
check "oldsky non-finite ra" "/api/oldsky?survey=allwise&band=W2&ra=Infinity&dec=-6" 400 'ra must be 0 to 360'
check "oldsky dec out of range" "/api/oldsky?survey=allwise&band=W2&ra=84&dec=-91" 400 'dec must be -90 to 90'
check "oldsky another size" "/api/oldsky?survey=allwise&band=W2&ra=84&dec=-6&size=1200" 400 'size must be 780'
check "oldsky odd key refused" "/api/oldsky/v1/allwise/W2/780/84.018-6.578/..%2F..%2Fx" 404 'not found'
if python3 - "$BASE" <<'PY'
import gzip, hashlib, json, sys, time, urllib.request
base = sys.argv[1]; get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "comet-hunt-contract-test"}), timeout=180).read()
inf = lambda b: gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b
import random
spot = f"ra={random.uniform(0, 360):.3f}&dec={random.uniform(-60, 60):.3f}"   # a fresh spot: a real miss each run (and the showcase's, a hit)
for q in ("survey=allwise&band=W2", "survey=2mass&band=Ks"):
  for where in (spot, "ra=84.01808&dec=-6.5775"):
    for step in range(4):   # a new spot comes in steps: 202 with the tiles pending, each fetched, then the manifest
        m = json.loads(get(f"{base}/api/oldsky?{q}&{where}"))
        if "pending" not in m: break
        for name in m["pending"]: get(f"{base}/api/oldsky/tile?{q}&{where}&name={name}")
    assert "tiles" in m, m
    for t in m["tiles"][:2]:
        mine = get(f"{base}/{t['path']}"); time.sleep(0.5); theirs = get(t["source"])
        assert t["source"].startswith("https://irsa.ipac.caltech.edu/"), t["source"]
        assert len(mine) == t["bytes"], t["name"]   # manifest v2: size and R2 etag (the Worker hashes nothing); v1 had sha256
        assert "sha256" not in t or hashlib.sha256(mine).hexdigest() == t["sha256"], t["name"]
        assert hashlib.sha256(inf(mine)).hexdigest() == hashlib.sha256(inf(theirs)).hexdigest(), t["name"]
        assert inf(mine)[:9] == b"SIMPLE  =", t["name"]
PY
then echo "PASS oldsky tiles are IRSA's own bytes, checksums match"; else echo "FAIL oldsky tiles"; fails=$((fails + 1)); fi
check "baked showcase blink" "/api/blink?ra=84.01808&dec=-6.5775" 200 '"designation":"J053604.34-063439.0"'
check "no baked blink elsewhere" "/api/blink?ra=10&dec=10" 404 'no baked blink here'
check "explored cells" "/api/explored" 200 '"cells":'
check "explored suggests a patch" "/api/explored" 200 '"suggest":{"ra":'
check "home page served" "/" 200 'Trailblazer'
check "Explore map page served" "/explore" 200 'id="tl"'
check "Forums page served" "/forums.html" 200 'Forums'
check "explored grid" "/api/explored" 200 '"total":3339'
# the unexplored suggestion: a least-checked cell away from the Milky Way plane and the polar caps, picked at random
if python3 - "$BASE" <<'PY'
import json, math, sys, urllib.request
base = sys.argv[1]
get = lambda: json.load(urllib.request.urlopen(urllib.request.Request(base + "/api/explored", headers={"User-Agent": "comet-hunt-contract-test"}), timeout=60))
R = math.pi / 180
gal = lambda ra, dec: math.asin(math.sin(dec * R) * math.sin(27.12825 * R) + math.cos(dec * R) * math.cos(27.12825 * R) * math.cos((ra - 192.85948) * R)) / R
ecl = lambda ra, dec: math.asin(math.sin(dec * R) * math.cos(23.4393 * R) - math.cos(dec * R) * math.sin(23.4393 * R) * math.sin(ra * R)) / R
grid, k = [], 0   # the heat map's grid (worker/src/index.js): 51 bands of Dec, about 3.5 degrees of RA per cell
for i in range(51):
    n = max(1, round(360 * math.cos((90 - (i + .5) * 180 / 51) * R) / 3.5)); grid.append((k, n)); k += n
def cell(ra, dec):
    i = min(50, math.floor((90 - dec) / (180 / 51))); k, n = grid[i]
    return k + min(n - 1, math.floor(ra / 360 * n))
seen = set()
for _ in range(20):
    e = get(); s = e["suggest"]; ra, dec = s["ra"], s["dec"]
    counts = {cell((c["ra_min"] + c["ra_max"]) / 2, (c["dec_min"] + c["dec_max"]) / 2): c["checks"] for c in e["cells"]}
    least = min(counts.get(k + j, 0) for i, (k, n) in enumerate(grid) for j in range(n)
                if abs(gal(360 * (j + .5) / n, 90 - (i + .5) * 180 / 51)) > 10 and abs(ecl(360 * (j + .5) / n, 90 - (i + .5) * 180 / 51)) < 75)
    assert counts.get(cell(ra, dec), 0) == least, f"suggest {s} has {counts.get(cell(ra, dec), 0)} checks, the least is {least}"
    assert abs(gal(ra, dec)) > 10, f"suggest {s} is in the galactic plane (b = {gal(ra, dec):.1f})"
    assert abs(ecl(ra, dec)) < 75, f"suggest {s} is in a polar cap (ecliptic latitude {ecl(ra, dec):.1f})"
    seen.add(cell(ra, dec))
assert len(seen) >= 5, f"20 requests suggested only {len(seen)} cells"
print(f"suggest: 20 requests, {len(seen)} different cells, all least-checked, |b| > 10, |ecliptic lat| < 75")
PY
then echo "PASS explored suggests a least-checked cell outside the galactic plane and polar caps, varying between requests"
else echo "FAIL explored suggestion"; fails=$((fails + 1)); fi
check "forums feed" "/api/posts" 200 '"posts":\['
check "GET on the checks route" "/api/checks" 405 'use POST'
check "time-lapse page served" "/timelapse.html" 200 'SPHEREx'
check "Comets list page served" "/comet.html" 200 'id="l-all"'
check "known: t missing" "/api/known?ra=77.3&dec=27.3" 400 't must be an MJD'
check "known: t not an MJD" "/api/known?ra=77.3&dec=27.3&t=2026" 400 't must be an MJD'
check "known: ra out of range" "/api/known?ra=400&dec=27.3&t=61285" 400 'ra must be 0 to 360'
# SkyBoT at one of C/2025 R2 (SWAN)'s SPHEREx photos (2 Sep 2026): the comet is there, within 30 arcsec of where JPL put it
if python3 - "$BASE" <<'PY'
import json, math, sys, urllib.request
base = sys.argv[1]
k = json.load(urllib.request.urlopen(urllib.request.Request(base + "/api/known?ra=77.3058&dec=27.3551&t=61285.0302", headers={"User-Agent": "comet-hunt-contract-test"}), timeout=60))
swan = [c for c in k["comets"] if c["name"] == "C/2025 R2"]
assert swan, f"no C/2025 R2 in {k}"
d = math.hypot((swan[0]["ra"] - 77.3058) * math.cos(math.radians(27.3551)), swan[0]["dec"] - 27.3551) * 3600
assert d < 30, f"C/2025 R2 is {d:.0f} arcsec from its photo position"
assert all(a["mag"] <= 21 for a in k["asteroids"]) and len(k["asteroids"]) <= 8, "asteroid cut not applied"
PY
then echo "PASS known: SkyBoT puts C/2025 R2 within 30 arcsec of its SPHEREx photo"
else echo "FAIL known: SkyBoT check"; fails=$((fails + 1)); fi
check "unknown route" "/api/nope" 404 'not found'
check "CORS header" "/api/images?ra=400&dec=4" 400 'ra must'   # header checked below
curl -s -m 30 -D - -o /dev/null "$BASE/api/images?ra=400&dec=4" | grep -qi 'access-control-allow-origin: \*' && echo "PASS CORS header present" || { echo "FAIL CORS header missing"; fails=$((fails + 1)); }
# known comets, checked on the parsed JSON: every real known comet has a path through the last coverage day, and
# every SPHEREx photo of C/2025 R2 (SWAN) carries the comet's position at that moment
if python3 - "$BASE" <<'PY'
import json, sys, urllib.request, urllib.parse
base = sys.argv[1]
# Cloudflare's bot protection refuses Python's default "Python-urllib" user agent (403) on the live site
get = lambda path: json.load(urllib.request.urlopen(urllib.request.Request(base + path, headers={"User-Agent": "comet-hunt-contract-test"}), timeout=60))
known = [c for c in get("/api/comets")["comets"] if c["kind"] == "known" and c["real"]]
assert len(known) >= 30, f"only {len(known)} real known comets"
short = [c["id"] for c in known if not c.get("track") or c["track"][-1][0] < 529]
assert not short, f"paths ending before day 529: {short}"
swan = get("/api/comets/" + urllib.parse.quote("C/2025 R2 (SWAN)", safe=""))
shots = swan["detail"]["spherex"]
assert shots and all(isinstance(p.get("ra"), (int, float)) and isinstance(p.get("dec"), (int, float)) for p in shots), "photo without a position"
# measured spectra (bake/comet_spectrum.py, migration 0008): CO2 verdicts as checked by eye (T5: no points above the band, so unclear)
verdict = lambda name: get("/api/comets/" + urllib.parse.quote(name, safe=""))["detail"].get("co2_verdict")
expect = {"3I/ATLAS": "detected", "C/2025 R2 (SWAN)": "detected", "C/2024 T5 (ATLAS)": "unclear", "210P/Christensen": "unclear",
          "C/2026 A2 (Bok)": "detected", "P/2021 N1 (ZTF)": "unclear",
          "C/2024 G3 (ATLAS)": "unclear",
          "C/2023 A3 (Tsuchinshan-ATLAS)": "unclear",
          "C/2023 R1 (PANSTARRS)": "unclear",
          "C/2025 K1 (ATLAS)": "unclear"}   # migration 0012: measured 2026-11-15 (Bok: CO2 line resolved in 2026-09 and 2026-10)
got = {n: verdict(n) for n in expect}
assert got == expect, f"CO2 verdicts {got}, expected {expect}"
assert len(swan["detail"]["photos"]) > 0 and swan["detail"]["dir"] == "c-2025-r2-swan", "R2 photos missing"
# the Comets list (comet.html with no id): all 72 known comets (migration 0010), each with its CO2 result and photo count, and each row's page opens
assert len(known) == 72, f"{len(known)} known comets listed, expected 72"
assert sum(c.get("faint") is True for c in known) == 50, "faint flags: expected 50 predicted too faint in their photos"
listed = {c["id"]: c.get("co2", "missing") for c in known}
assert {n: listed.get(n) for n in expect} == expect, f"list CO2 {[(n, listed.get(n)) for n in expect]}"
assert all(v is None for n, v in listed.items() if n not in expect), "an unmeasured comet has a CO2 result"
assert all(isinstance(c.get("photos"), int) and c["photos"] > 0 for c in known), "a known comet without a photo count"
bad = [c["id"] for c in known if get("/api/comets/" + urllib.parse.quote(c["id"], safe=""))["id"] != c["id"]]
assert not bad, f"pages that do not open: {bad}"
PY
then echo "PASS known comets: paths reach the last day, every photo has a position, CO2 verdicts as measured, all 72 listed (50 faint) and open"
else echo "FAIL known comets"; fails=$((fails + 1)); fi
# POST /api/comments writes to D1, so it runs against the local dev server only (Cloudflare's test secret accepts its dummy token
# XXXX.DUMMY.TOKEN.XXXX and, measured 2026-11-14, any string; each post gets a unique one because a token is single use)
tok() { echo "XXXX.DUMMY.TOKEN.XXXX.$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"; }
post() {   # name, json body, expected status, expected text in the body [, route [, extra header]]
  out=$(curl -s -m 30 -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' ${6:+-H} ${6:+"$6"} --data "$2" "$BASE${5:-/api/comments}")
  code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
  if [ "$code" = "$3" ] && printf '%s' "$body" | grep -q -- "$4"; then echo "PASS $1 ($code)"
  else echo "FAIL $1: got $code, wanted $3 with '$4': $(printf '%s' "$body" | head -c 200)"; fails=$((fails + 1)); fi
}
case "$BASE" in
  *127.0.0.1*|*localhost*|*\[::1\]*)
    who="tester $$"; note="contract test $$ $(date +%s)"
    post "post a tagged comment" "{\"comet_id\":\"3I/ATLAS\",\"tag\":\"comet\",\"body\":\"$note\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 201 '"tags":{"comet":'
    check "posted comment is in the thread" "/api/comets/3I%2FATLAS" 200 "\"body\":\"$note\""
    check "posted comment is in the Forums threads" "/api/threads" 200 "\"body\":\"$note\""
    check "posted comment is in the Forums feed" "/api/posts" 200 "\"body\":\"$note\""
    # the tally counts each person once, by their latest tag: two new people tag 3I/ATLAS, A says comet then asteroid, B says comet
    if python3 - "$BASE" <<'PY'
import json, os, random, sys, urllib.request
base, pid = sys.argv[1], os.getpid()
def call(path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
    return json.load(urllib.request.urlopen(req, timeout=30))
tags = lambda: call("/api/comets/3I%2FATLAS")["tags"]
before = tags()
for who, tag in [("tally a %d" % pid, "comet"), ("tally a %d" % pid, "asteroid"), ("tally b %d" % pid, "comet")]:
    call("/api/comments", {"comet_id": "3I/ATLAS", "tag": tag, "body": "", "author": who, "turnstile": "XXXX.DUMMY.TOKEN.XXXX.%x" % random.getrandbits(48)})
after = tags()
assert {k: after[k] - before[k] for k in after} == {"comet": 1, "asteroid": 1, "glitch": 0, "unsure": 0, "star": 0}, (before, after)
PY
    then echo "PASS tally counts each person once (their latest tag)"; else echo "FAIL tally counts each person once"; fails=$((fails + 1)); fi
    post "post on an id with a slash and spaces" "{\"comet_id\":\"C/2025 R2 (SWAN)\",\"body\":\"hi\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 201 '"comet_id":"C/2025 R2 (SWAN)"'
    post "missing body" "{\"comet_id\":\"3I/ATLAS\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    post "blank body" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"   \",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    long=$(python3 -c 'print("a" * 1001)')
    post "too-long body" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"$long\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    post "a tag alone is a vote" "{\"comet_id\":\"3I/ATLAS\",\"tag\":\"unsure\",\"body\":\"\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 201 '"tag":"unsure","body":""'
    post "star is a tag" "{\"comet_id\":\"3I/ATLAS\",\"tag\":\"star\",\"body\":\"\",\"author\":\"star $$\",\"turnstile\":\"$(tok)\"}" 201 '"tag":"star","body":""'
    post "bad tag" "{\"comet_id\":\"3I/ATLAS\",\"tag\":\"planet\",\"body\":\"hi\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"tag"'
    post "bad author name" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"hi\",\"author\":\"<b>x</b>\",\"turnstile\":\"$(tok)\"}" 400 '"field":"author"'
    post "missing turnstile token" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"hi\",\"author\":\"$who\"}" 400 '"field":"turnstile"'
    post "not JSON" "nope" 400 'body must be JSON'
    post "unknown comet" "{\"comet_id\":\"C-9999\",\"body\":\"hi\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 404 'no comet C-9999'
    check "GET on the post route" "/api/comments" 405 'use POST'
    burst="burst $$"
    for i in 1 2 3 4 5; do curl -s -o /dev/null -X POST -H 'Content-Type: application/json' --data "{\"comet_id\":\"3I/ATLAS\",\"body\":\"burst $i\",\"author\":\"$burst\",\"turnstile\":\"$(tok)\"}" "$BASE/api/comments"; done
    post "rate limit: 6th in a minute" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"burst 6\",\"author\":\"$burst\",\"turnstile\":\"$(tok)\"}" 429 'wait a minute'
    # a token pays for one comment: the same token again is refused and adds nothing
    t=$(tok)
    post "fresh token accepted" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"replay 1\",\"author\":\"replay $$\",\"turnstile\":\"$t\"}" 201 '"body":"replay 1"'
    post "reused token refused" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"replay 2\",\"author\":\"replay $$\",\"turnstile\":\"$t\"}" 403 'already used'
    if curl -s -m 30 "$BASE/api/comets/3I%2FATLAS" | grep -q '"body":"replay 2"'; then echo "FAIL reused token left no comment"; fails=$((fails + 1)); else echo "PASS reused token left no comment"; fi
    # the test widget's dummy token repeats on every load, so local dev does not claim it (a real secret refuses it)
    for i in 1 2; do post "dummy token works twice locally ($i)" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"dummy $i\",\"author\":\"dummy $$\",\"turnstile\":\"XXXX.DUMMY.TOKEN.XXXX\"}" 201 "\"body\":\"dummy $i\""; done
    # the rate limit holds when posts arrive at once: 10 in parallel, at most 5 get in
    race="race $$"; dir=$(mktemp -d)
    for i in 1 2 3 4 5 6 7 8 9 10; do
      curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data "{\"comet_id\":\"3I/ATLAS\",\"body\":\"race $i\",\"author\":\"$race\",\"turnstile\":\"$(tok)\"}" "$BASE/api/comments" > "$dir/$i" &
    done; wait
    ok=$(cat "$dir"/* | grep -o 201 | wc -l | tr -d ' '); limited=$(cat "$dir"/* | grep -o 429 | wc -l | tr -d ' '); rm -r "$dir"
    if [ "$ok" = 5 ] && [ "$limited" = 5 ]; then echo "PASS 10 parallel posts: 5 accepted, 5 limited"; else echo "FAIL 10 parallel posts: $ok accepted, $limited limited"; fails=$((fails + 1)); fi
    # the heat map: opening a spot adds one check to its cell, and the map shows that cell with the new count
    if python3 - "$BASE" <<'PY'
import json, sys, urllib.request
base = sys.argv[1]
def call(path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
    return json.load(urllib.request.urlopen(req, timeout=30))
ra, dec = 269.4463, 4.7671
inside = lambda c: c["ra_min"] <= ra < c["ra_max"] and c["dec_min"] <= dec < c["dec_max"]
before = sum(c["checks"] for c in call("/api/explored")["cells"] if inside(c))
got = call("/api/checks", {"ra": ra, "dec": dec})
after = [c for c in call("/api/explored")["cells"] if inside(c)]
assert len(after) == 1 and after[0]["checks"] == before + 1 == got["checks"], f"before {before}, after {after}, post {got}"
for r, d in [(0, 90), (360, -90), (359.999, 0), (0, -90)]:   # grid edges land in a real cell
    c = call("/api/checks", {"ra": r, "dec": d})["cell"]
    assert 0 <= c < 3339, f"({r}, {d}) -> cell {c}"
# the rate limit: 10 checks a minute per visitor, then 429 and nothing written (locally the visitor is the
# CF-Connecting-IP header, so each run is a fresh visitor; on Cloudflare the edge sets that header itself)
import os, urllib.error
who = {"Content-Type": "application/json", "CF-Connecting-IP": f"contract-{os.getpid()}"}
send = lambda: urllib.request.urlopen(urllib.request.Request(base + "/api/checks", data=b'{"ra": 200.5, "dec": -60.5}', headers=who, method="POST"), timeout=30)
counts = [json.load(send())["checks"] for _ in range(10)]
try: send(); raise AssertionError("11th check in a minute was accepted")
except urllib.error.HTTPError as e: assert e.code == 429, f"11th check got {e.code}"
cell = [c for c in call("/api/explored")["cells"] if c["ra_min"] <= 200.5 < c["ra_max"] and c["dec_min"] <= -60.5 < c["dec_max"]]
assert cell[0]["checks"] == counts[-1], f"a refused check was written: {cell[0]['checks']} vs {counts[-1]}"
PY
    then echo "PASS opening a spot adds one check to its cell, shown on the map; grid edges land in real cells; 11th check a minute refused"
    else echo "FAIL heat map checks"; fails=$((fails + 1)); fi
    # "Discuss this" (docs/api.md): candidates, the near check and sightings. Each run uses its own spot and visitor IPs.
    if python3 - "$BASE" <<'PY'
import json, os, random, re, sys, threading, urllib.error, urllib.request
base, pid = sys.argv[1], os.getpid()
def call(path, body=None, ip="cand-%d" % pid, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json", "CF-Connecting-IP": ip}, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
tok = lambda: "XXXX.DUMMY.TOKEN.XXXX.%x" % random.getrandbits(48)
ra, dec = round(random.uniform(10, 350), 4), round(random.uniform(-60, 60), 4)   # a fresh spot each run
visit = {"start": "2025-08-28", "end": "2025-08-30", "mjd": 60917.1087, "exposures": 3, "lam": 0.8426, "epochs": [60917.0, 60918.2]}
post = lambda ip, **kw: call("/api/candidates", {"ra": ra, "dec": dec, "det": "D3", "visit": visit, "tag": "comet", "body": "moves", "author": "tester", "turnstile": tok(), **kw}, ip)
count = lambda: len(call("/api/comets")[1]["comets"])
before = count()
# create: C-\d{4}, with what was sent stored
code, c = post("cand-a-%d" % pid)
assert code == 201 and c.get("created") and re.fullmatch(r"C-\d{4}", c["id"]), (code, c)
cid = c["id"]
_, g = call("/api/comets/" + cid)
assert g["candidate"] and g["kind"] == "comet" and abs(g["ra"] - ra) < 1e-4 and abs(g["dec"] - dec) < 1e-4 and g["det"] == "D3" and g["visit"] == "2025-08-28", g
assert g["detail"]["candidate"]["visit"]["exposures"] == 3 and g["detail"]["candidate"]["visit"]["epochs"] == [60917.0, 60918.2], g["detail"]
assert g["tags"] == {"comet": 1, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0} and g["author"] == "tester", g
# a second post 30 arcsec away in the same visit joins it: the same id, no new row, its tag added
code, m = post("cand-b-%d" % pid, dec=round(dec + 30 / 3600, 6), tag="asteroid", author="second")
assert code == 200 and m.get("merged") and m["id"] == cid, (code, m)
assert count() == before + 1, "a merged post made a row"
assert call("/api/comets/" + cid)[1]["tags"]["asteroid"] == 1
# a "Star" vote from the time-lapse is its own tag
code, m = post("cand-star-%d" % pid, tag="star", author="stargazer")
assert code == 200 and m["id"] == cid and call("/api/comets/" + cid)[1]["tags"]["star"] == 1, (code, m)
# the same visit seen at another channel and detector starts a day later: it shares a day, so it joins too
code, m2 = post("cand-b2-%d" % pid, det="D1", channel=5, visit={**visit, "start": "2025-08-29", "epochs": [60917.0]})
assert code == 200 and m2.get("merged") and m2["id"] == cid, (code, m2)
assert count() == before + 1, "a channel's report of the same visit made a row"
assert [x["id"] for x in call("/api/candidates/near?ra=%s&dec=%s&visit=2025-08-30" % (ra, dec))[1]["candidates"]] == [cid], "last day of the visit"
# the near check finds it in that visit, and not in another
_, n = call("/api/candidates/near?ra=%s&dec=%s&visit=2025-08-28" % (ra, dec + 20 / 3600))
assert [x["id"] for x in n["candidates"]] == [cid] and n["candidates"][0]["tags"]["comet"] == 1, n
assert call("/api/candidates/near?ra=%s&dec=%s&visit=2026-03-11" % (ra, dec))[1]["candidates"] == []
assert call("/api/candidates/near?ra=%s&dec=%s&visit=nope" % (ra, dec))[0] == 400
# 1.5 arcmin away, or the same spot in another visit, is a new candidate
code, far = post("cand-c-%d" % pid, dec=round(dec + 90 / 3600, 6))
assert code == 201 and far["id"] != cid, (code, far)
code, other = post("cand-c-%d" % pid, visit={**visit, "start": "2026-03-11", "end": "2026-03-11", "mjd": 61110.436, "epochs": [61110.4]})
assert code == 201 and other["id"] not in (cid, far["id"]), (code, other)
# a report at a channel stores the channel and its detector for the candidate page's frames
code, chd = post("cand-ch-%d" % pid, dec=round(dec - 90 / 3600, 6), det="D2", channel=20)
assert code == 201 and call("/api/comets/" + chd["id"])[1]["detail"]["candidate"] | {"visit": None} == {"visit": None, "det": "D2", "channel": 20}, chd
assert call("/api/comets/" + cid)[1]["detail"]["candidate"]["channel"] is None
# two posts at once at a fresh spot: one row, both get its id
ra2, out = round((ra + 7) % 360, 4), []
ts = [threading.Thread(target=lambda i=i: out.append(call("/api/candidates", {"ra": ra2, "dec": dec, "det": "D1", "visit": visit, "tag": "comet", "author": "racer%d" % i, "turnstile": tok()}, "cand-race%d-%d" % (i, pid)))) for i in range(2)]
[t.start() for t in ts]; [t.join() for t in ts]
assert sorted(c for c, _ in out) == [200, 201] and out[0][1]["id"] == out[1][1]["id"], out
assert len(call("/api/candidates/near?ra=%s&dec=%s" % (ra2, dec))[1]["candidates"]) == 1
# refusals: 400 with the field named, nothing written
rows = count()
for k, (field, change) in enumerate([("ra", {"ra": 400}), ("ra", {"ra": "12"}), ("dec", {"dec": -95}), ("det", {"det": "D9"}), ("tag", {"tag": "planet"}), ("tag", {"tag": None}),
                      ("visit", {"visit": {"start": "2025-8-28"}}), ("visit", {"visit": {**visit, "exposures": 0}}), ("visit", {"visit": {**visit, "mjd": 1}}),
                      ("visit", {"visit": {**visit, "start": "1900-01-01"}}), ("visit", {"visit": {**visit, "end": "9999-12-31"}}), ("visit", {"visit": {**visit, "mjd": 61110.4}}),
                      ("channel", {"channel": 200}), ("channel", {"channel": 5}), ("channel", {"channel": "5"}),
                      ("author", {"author": "<b>x</b>"}), ("body", {"body": "a" * 1001}), ("body", {"body": 5}), ("turnstile", {"turnstile": ""})]):
    code, e = post("cand-bad-%d-%d" % (k, pid), **change)   # its own IP each, under the 5 a minute limit
    assert code == 400 and e.get("field") == field, (field, change, code, e)
assert call("/api/candidates", raw=b"nope", ip="cand-raw-%d" % pid)[0] == 400
assert count() == rows, "a refused post was stored"
assert call("/api/candidates")[0] == 405
# one human check pays for one report: the same token again is refused, at a fresh spot, and writes nothing
t, rows, ra3 = tok(), count(), round((ra + 14) % 360, 4)
assert call("/api/candidates", {"ra": ra3, "dec": dec, "det": "D1", "visit": visit, "tag": "comet", "author": "replayer", "turnstile": t}, "cand-replay1-%d" % pid)[0] == 201
code, e = call("/api/candidates", {"ra": round((ra3 + 3) % 360, 4), "dec": dec, "det": "D1", "visit": visit, "tag": "comet", "author": "replayer", "turnstile": t}, "cand-replay2-%d" % pid)
assert code == 403 and "already used" in e["error"], (code, e)
assert count() == rows + 1 and call("/api/candidates/near?ra=%s&dec=%s" % (round((ra3 + 3) % 360, 4), dec))[1]["candidates"] == [], "a reused token wrote a candidate"
# the rate limit: 5 a minute per IP, then 429 before anything is read
codes = [call("/api/candidates", {"tag": "nope"}, "cand-limit-%d" % pid)[0] for _ in range(6)]
assert codes == [400] * 5 + [429], codes
# a sighting is stored without a candidate
rows = count()
code, s = call("/api/sightings", {"name": "2001 FM127", "ra": ra, "dec": dec, "det": "D1", "visit": visit, "author": "tester"}, "seen-%d" % pid)
assert code == 201 and s["sighting"]["name"] == "2001 FM127" and s["sighting"]["visit"] == "2025-08-28" and s["sighting"]["id"] > 0, (code, s)
assert count() == rows, "a sighting made a candidate"
assert call("/api/sightings", {"name": "<script>", "ra": ra, "dec": dec, "det": "D1", "visit": visit, "author": "tester"}, "seen-%d" % pid)[1].get("field") == "name"
PY
    then echo "PASS candidates: create C-NNNN with its fields (channel and detector kept), same-visit 1-arcmin repost joins it (also from another channel starting a day later), other visit or 1.5' away is new, two at once make one, refusals 400, 6th a minute 429, sighting stored alone"
    else echo "FAIL candidates"; fails=$((fails + 1)); fi
    # the checks refusals use their own visitor IP per run (the rate limit counts every request, refused ones too)
    post "check: not JSON" "nope" 400 'body must be JSON' /api/checks "CF-Connecting-IP: contract-sh-$$"
    post "check: ra out of range" '{"ra":400,"dec":4}' 400 '"field":"ra"' /api/checks "CF-Connecting-IP: contract-sh-$$"
    post "check: ra not a number" '{"ra":"12","dec":4}' 400 '"field":"ra"' /api/checks "CF-Connecting-IP: contract-sh-$$"
    post "check: dec missing" '{"ra":12}' 400 '"field":"dec"' /api/checks "CF-Connecting-IP: contract-sh-$$"
    post "check: dec out of range" '{"ra":12,"dec":-95}' 400 '"field":"dec"' /api/checks "CF-Connecting-IP: contract-sh-$$"
    big=$(python3 -c 'print("{\"ra\":12,\"dec\":4,\"pad\":\"" + "a" * 1970 + "\"}")')
    post "check: 2000-byte body" "$big" 413 '"error":"body too large"' /api/checks "CF-Connecting-IP: contract-sh-$$"
    post "check: valid check still accepted" '{"ra":12,"dec":4}' 201 '"checks":' /api/checks "CF-Connecting-IP: contract-sh-$$" ;;
  *) echo "SKIP POST /api/comments and /api/checks (not a local server)" ;;
esac
[ $fails -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
