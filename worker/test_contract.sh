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
check "explored cells" "/api/explored" 200 '"checks":'
check "explored suggests a patch" "/api/explored" 200 '"suggest":{"ra":77'
check "home page served" "/" 200 'Find the dots that move'
check "time-lapse page served" "/timelapse.html" 200 'SPHEREx'
check "unknown route" "/api/nope" 404 'not found'
check "CORS header" "/api/images?ra=400&dec=4" 400 'ra must'   # header checked below
curl -s -m 30 -D - -o /dev/null "$BASE/api/images?ra=400&dec=4" | grep -qi 'access-control-allow-origin: \*' && echo "PASS CORS header present" || { echo "FAIL CORS header missing"; fails=$((fails + 1)); }
[ $fails -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
