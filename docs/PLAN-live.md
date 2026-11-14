# Plan: live coordinates (any RA/Dec)

## Goal
A user types any RA/Dec (or opens `?ra=&dec=`). Within about 15 s the time-lapse page shows real SPHEREx
frames of that spot, one per survey visit, wavelength-matched, with measured positions, using the same
view as the five baked targets. Repeat visits to the same spot load in under 1 s.

## Design: the browser does the astronomy, a tiny Cloudflare Worker only finds images
Measured on 2026-11-14:
- IRSA's search (SIA) works but has no CORS and throws intermittent 502s. TAP was down all day.
- IRSA's cutout service costs 4 MB and 3 to 5 s per image (it always bundles a 3.9 MB PSF) and says "Server busy".
- NASA's public S3 copy (`nasa-irsa-spherex`) has CORS and HTTP range reads. Each 65 MB image keeps its
  2040x2040 float32 IMAGE uncompressed at a fixed offset, so a browser can read just the rows it needs.
- Each detector's wavelength map (WCS-WAVE, 9x9 grid) was identical across every exposure checked
  (30 to 40 files each for D1, D5, D6, version 7.0.5), so it ships once per detector.

So:
1. Worker `GET /api/images?ra=&dec=&det=D1..D6`: calls SIA for `spherex_dr1` and `spherex_qr3` with retry,
   keeps science rows on that detector, returns `[{t, key}]` (`key` = S3 key from `cloud_access`), CORS on,
   cached for a day. Worker `GET /api/gaia?ra=&dec=`: ESA Gaia TAP cone of 6", proxied and cached.
2. Browser `web/live.js`, per exposure: range-read the first 40 KB (primary + IMAGE header), parse the
   TAN-SIP WCS, find the target's full-frame pixel, look up the wavelength in the detector's map.
3. Pick the wavelength the most visits have (same rule as `bake/flipbook.py`), up to 3 exposures per visit.
4. For each pick: range-read the 49 full rows around the target (400 KB), reproject to the same 36x36,
   5"/px north-up grid with bilinear sampling, normalize by median and MAD, median per visit.
5. Centroid, motion fit, Gaia comparison: the same rules as the baker, in JS. Output is a manifest object
   with the same shape as `data/flip/*/manifest.json`, so `timelapse.html` draws it unchanged.
6. Results cached in IndexedDB by rounded RA/Dec and detector.

## API contract (examples)
| Request | Response |
|---|---|
| `/api/images?ra=269.4463&dec=4.7671&det=D1` | `200 {"images":[{"t":60914.2,"key":"dr1/level2/.../...D1....fits"}, ...], "collections":["spherex_dr1","spherex_qr3"]}` |
| `/api/images?ra=400&dec=4` | `400 {"error":"ra must be 0 to 360"}` |
| `/api/images?ra=10&dec=-95` | `400 {"error":"dec must be -90 to 90"}` |
| `/api/images?ra=10&dec=4&det=D9` | `400 {"error":"det must be D1 to D6"}` |
| SIA 502 five times in a row | `503 {"error":"IRSA search is not answering, try again or pick a baked target","retry_after":30}` |
| A spot SPHEREx has not imaged on that detector | `200 {"images":[]}`; the page says "No SPHEREx images here yet" |
| Fewer than 2 visits | the page shows the frame(s) and says a time-lapse needs 2 or more visits |
| `/api/gaia?ra=269.4463&dec=4.7671` | `200 {"pmra":-801.6,"pmdec":10362.4,"g":8.19,"sep":1.4}` or `200 {}` when no match |

## Evaluator (all scripted)
1. **Math golden test** (`tests/golden.html` vs `bake/golden.py`): for 30 real exposures across detectors,
   the JS full-frame pixel of the target matches astropy within 0.05 px and the wavelength within 0.002 um.
2. **Pipeline match**: for each baked target, the live pipeline's matched wavelength is within 0.02 um of the
   baked one and its measured motion within 15% of the baked value. Barnard's Star still passes the Gaia check.
3. **Contract test** (`tests/api.sh`): every example above returns the listed status and shape.
4. **Speed**: a spot not seen before shows its first frame in under 8 s and all frames in under 15 s on the
   M5 Pro; a cached spot in under 1 s. The smooth-check benchmark still passes while frames build.

## Risk
The main way this goes wrong: the JS world-to-pixel math (TAN plus SIP distortion) is slightly off, and every
frame is then quietly misaligned. Evaluator 1 catches that before anything else is built on it.

## Out of scope for now
Deploying the Worker publicly (needs a Cloudflare account decision), the brightness view, the 3D fly-in.

## Review outcome (Codex, one pass, 2026-11-14) and results
Adopted: S3 key from `cloud_access` JSON with an access_url fallback; dedupe by obs_id preferring DR1; a failed
search is a 503, never an empty list; SIP inverse by Newton steps on the forward A/B, seeded by AP/BP; headers read
to the END card; big-endian with BSCALE/BZERO; SIP off for the spectral WCS (this also fixed the baker, which was
up to 8 nm off); fetch bounds from the projected footprint; Gaia matched in a wide cone after propagating from
2016.0; detection check before centroiding; bounded concurrency; work off the main thread; session cache instead
of IndexedDB. Changed after testing: detection at 3 sigma with re-centring (5 sigma dropped WISE 0855 to 2 visits),
a Gaia star is accepted only if its path lies on what SPHEREx sees, and Deep Survey searches run only near the
ecliptic poles with shorter retries (IRSA 502 retries had made one search take 14 s).
Not adopted: bad-pixel bit masking (the median over exposures is enough for these frames so far).

| Check | Result |
|---|---|
| Math golden test, 36 exposures, all six detectors | worst 4e-7 px, 2e-10 um (would be off 5 px without SIP) |
| Pipeline match vs Python bake, five targets | wavelengths identical; motion within 7% |
| Contract test (worker/test_contract.sh) | all pass |
| Cold new spots | Andromeda D1 8.7 s, Crab Nebula D3 7.8 s, Pleiades 17.4 s before the retry fix |
| Smoothness while building | 0 of 1,197 frames dropped, worst 9.4 ms |
