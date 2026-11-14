# SPHEREx time-lapse and smooth-check

Two pages share one 3D sky (`web/sky.js`):

- **`timelapse.html`**: the product direction. Pick a challenge target and watch real SPHEREx images of it
  change over time, with a ghost trail of measured positions, Gaia's predicted position, a difference view,
  a field-of-view slider, and a "What changed" panel. Arrow keys step through visits.
- **`index.html`**: the smooth-check benchmark described below.
- **Sky map** (`timelapse.html` with no options): the whole SPHEREx sky as an oval map plus a 3D view. Click the
  map to fly there, scroll to zoom, then click any spot: it opens that spot's time-lapse on the latest visit with
  the difference view on. Clicks near one of the five targets snap to it. Very bright stars that saturate the
  detector get no motion number, because their position is only good to a few pixels.
- **Live coordinates**: type any RA/Dec (degrees or 17h57m47s +04d46m02s) and a detector. The browser reads
  only the needed pixels from NASA's public S3 copy and builds the time-lapse itself (`web/live/`); a tiny
  Cloudflare Worker (`worker/`) only finds which images exist. Design and checks: `PLAN-live.md`.

## Run everything locally

```bash
python3 -m http.server 8772 --directory web
```

```bash
cd worker && npx wrangler@4.162.0 dev --port 8787
```

Then open http://localhost:8772/timelapse.html. Tests: `web/tests/golden.html` (browser math vs astropy),
`web/tests/live.html` (live pipeline vs baked frames), `sh worker/test_contract.sh`, `python3 bake/verify.py`.

## Science check (`python3 bake/verify.py`)

Motion measured from our own SPHEREx frames, against the reference (2026-11-14):

| Target | Measured | Reference | Speed | Direction |
|---|---|---|---|---|
| Barnard's Star | 10.13"/yr | Gaia DR3 10.39"/yr | 97% | 2 degrees off |
| Epsilon Indi B | 4.66"/yr | Gaia DR3 4.68"/yr | 100% | 3 degrees off |
| WISE 0855 | 6.95"/yr | Luhman & Esplin 2016, 8.14"/yr | 85% | 0 degrees off |

RW Aurigae and R Draconis barely move (Gaia: 0.02 to 0.03"/yr), so they are not checked for motion.
Each frame combines up to 3 exposures taken at the same wavelength (matched within one filter width),
because SPHEREx sees a different wavelength in every exposure and brightness changes with wavelength.

Things to know about the data:
- The challenge's WISE 0855 coordinates are from its discovery; it has moved about 2 arcmin west since,
  so the baker uses its 2026 position.
- Barnard's Star and R Draconis saturate the detector; their cores are drawn white and positions come from
  the saturated blob's centre.
- IRSA's TAP search was down all day on 2026-11-14; the baker uses SIA instead.

## Smooth-check (`index.html`)

A proof page for our Space Apps team: can a 3D SPHEREx web app stay smooth?
It streams the real SPHEREx all-sky map as tiles (like Google Maps), draws
5,323 real Gaia stars within 25 parsecs in 3D, and plays a flipbook of real
SPHEREx images of one target over time.

## Run it

```bash
python3 -m http.server 8772 --directory web
```

Open http://localhost:8772 and click **Run 10-second benchmark**. Keep the
tab visible while it runs (hidden tabs are throttled). Click **Copy results**
and paste the JSON into the team chat.

Options in the URL:
- `?bench=1` runs the benchmark automatically.
- `?stress=200000` adds 200,000 extra stars to show headroom.
- `?look=80.9,-69.8,40` points the camera at RA, Dec with a field of view in
  degrees (that one is the Large Magellanic Cloud).
- `?local=1` loads the whole-sky image from `web/data` instead of IRSA.

## What passes

| Check | Goal |
|---|---|
| Dropped frames (longer than 1.5 screen refreshes) | 1% or fewer |
| Longest freeze | 50 ms or less (3 refreshes at 60 Hz) |
| Our JavaScript work per frame | under 8 ms average |
| Draw calls | under 150 |
| Flipbook first frame after picking a target | under 1,000 ms |

These rules work at any refresh rate. Safari caps pages at 60 Hz, so raw
frame time there is never below 16.7 ms even when nothing is wrong; an
earlier version of this page wrongly failed Safari for that.

## Results so far (2026-11-14, Apple M5 Pro, 1440x900 at 2x, 120 Hz)

| Run | Avg | p99 | Worst | Frames over 33 ms | Draw calls |
|---|---|---|---|---|---|
| Normal (5,323 stars, 48 sharp tiles streamed) | 8.33 ms | 10.3 ms | 10.4 ms | 0 | 86 |
| Stress (205,323 stars) | 8.33 ms | 10.3 ms | 10.4 ms | 0 | 98 |

8.33 ms is one refresh at 120 Hz, so the page keeps up with the display.
Across 8 full-size runs after the fix, one run had a single 140 ms frame
that did not come back in 3 instrumented reruns (cause unknown). The results
JSON now lists the 3 slowest frames and what was happening in each, so a
teammate's run shows the cause if it happens again.
Before decoding tiles off the main thread, one frame took 58 to 67 ms when 48
tiles arrived at once; tiles now decode in the background and at most 2 are
added per frame.

## Data

- Sky: SPHEREx DR1 all-sky HiPS cube from IRSA, 512 px PNG tiles, open to
  browsers (CORS). Tile orientation is checked by `bake/check_orientation.py`.
- Stars: `bake/stars.py` queries ESA Gaia DR3 (parallax above 40 mas).
- Flipbook: `bake/flipbook.py` finds SPHEREx images of each target through
  IRSA's TAP service, cuts them out, reprojects them north-up, and averages
  each survey visit into one frame. IRSA's image cutouts are not open to
  browsers, and IRSA's database was down for long stretches during the
  hackathon, so frames are baked ahead of time.

```bash
uv run --with astropy --with reproject --with pillow --with certifi \
  sh -c 'SSL_CERT_FILE=$(python -m certifi) python bake/flipbook.py barnard rdra wise0855'
```
