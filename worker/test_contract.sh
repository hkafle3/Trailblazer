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
check "missing ra" "/api/images?dec=4" 400 'ra must be 0 to 360'
check "Gaia near Barnard's Star" "/api/gaia?ra=269.4463&dec=4.7671" 200 '"pmdec":10362'
check "comets list from D1" "/api/comets" 200 '"id":"3I/ATLAS"'
check "example comets marked" "/api/comets" 200 '"example":true'
check "tally counts each person once" "/api/comets/C-0147" 200 '"tags":{"comet":12,"asteroid":1,"glitch":0,"unsure":1}'
check "3I/ATLAS has real photos" "/api/comets/3I%2FATLAS" 200 '"photos":\[{"file"'
check "3I/ATLAS has a spectrum" "/api/comets/3I%2FATLAS" 200 '"spectrum":{"2025-08":\[{"lam"'
check "unknown comet" "/api/comets/C-9999" 404 'no comet C-9999'
# a malformed id must get our JSON error from the Worker; on the live site Cloudflare's edge refuses it first
case "$BASE" in *127.0.0.1*|*localhost*|*\[::1\]*) bad_id='"error":"comet id is not valid"' ;; *) bad_id='400 Bad Request' ;; esac
check "malformed comet id" "/api/comets/%ZZ" 400 "$bad_id"
check "explored cells" "/api/explored" 200 '"cells":'
check "explored suggests a patch" "/api/explored" 200 '"suggest":{"ra":'
check "home page served" "/" 200 'Trailblazer'
check "Explore map page served" "/explore" 200 'id="tl"'
check "Forums page served" "/forums.html" 200 'Forums'
check "explored grid" "/api/explored" 200 '"total":3339'
check "forums feed" "/api/posts" 200 '"comet_id":'
check "GET on the checks route" "/api/checks" 405 'use POST'
check "time-lapse page served" "/timelapse.html" 200 'SPHEREx'
check "Comets list page served" "/comet.html" 200 'id="c-list"'
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
    post "post on an id with a slash and spaces" "{\"comet_id\":\"C/2025 R2 (SWAN)\",\"body\":\"hi\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 201 '"comet_id":"C/2025 R2 (SWAN)"'
    post "missing body" "{\"comet_id\":\"3I/ATLAS\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    post "blank body" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"   \",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    long=$(python3 -c 'print("a" * 1001)')
    post "too-long body" "{\"comet_id\":\"3I/ATLAS\",\"body\":\"$long\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"body"'
    post "bad tag" "{\"comet_id\":\"3I/ATLAS\",\"tag\":\"star\",\"body\":\"hi\",\"author\":\"$who\",\"turnstile\":\"$(tok)\"}" 400 '"field":"tag"'
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
