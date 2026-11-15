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
check "explored cells" "/api/explored" 200 '"checks":'
check "explored suggests a patch" "/api/explored" 200 '"suggest":{"ra":77'
check "home page served" "/" 200 'Find the dots that move'
check "time-lapse page served" "/timelapse.html" 200 'SPHEREx'
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
PY
then echo "PASS known comets: paths reach the last day, every photo has a position"
else echo "FAIL known comets"; fails=$((fails + 1)); fi
# POST /api/comments writes to D1, so it runs against the local dev server only (Cloudflare's test secret accepts its dummy token
# XXXX.DUMMY.TOKEN.XXXX and, measured 2026-11-14, any string; each post gets a unique one because a token is single use)
tok() { echo "XXXX.DUMMY.TOKEN.XXXX.$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"; }
post() {   # name, json body, expected status, expected text in the body
  out=$(curl -s -m 30 -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' --data "$2" "$BASE/api/comments")
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
    if [ "$ok" = 5 ] && [ "$limited" = 5 ]; then echo "PASS 10 parallel posts: 5 accepted, 5 limited"; else echo "FAIL 10 parallel posts: $ok accepted, $limited limited"; fails=$((fails + 1)); fi ;;
  *) echo "SKIP POST /api/comments checks (not a local server)" ;;
esac
[ $fails -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
