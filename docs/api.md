# API

One Cloudflare Worker (`worker/src/index.js`) answers every `/api/*` request and also serves the app's files from `web/`. All routes are `GET`, return JSON, and send `Access-Control-Allow-Origin: *`. Errors are `{"error": "..."}` with a 4xx or 5xx status.

Comets and comments live in Cloudflare D1 (database `comet-hunt`, schema in `worker/migrations/`). `/api/explored` counts real checks from the `checks` table (`POST /api/checks`).

Database: `npm run dev` applies the migrations to a local copy first, so it works with no account. `npm run db:remote` applies them to the real database (needs `npx wrangler login`). A new table or column is a new numbered file in `worker/migrations/`; never edit one that has been applied.

## GET /api/comets (D1)

Markers for the Explore map: comets people found (`kind: "comet"`) and known objects (`kind: "known"`), read from the `comets` table. Every row is real (`real: true`): the seeded example comets were removed in migration 0014. A comet people found is a candidate someone reported from a time-lapse (`candidate: true`, ids `C-0175` and up).

```json
{ "comets": [
  { "id": "C-0175", "kind": "comet", "ra": 77.3, "dec": 27.4, "day": 120, "tail": -150, "real": true,
    "tags": { "comet": 3, "asteroid": 1, "glitch": 0, "unsure": 0, "star": 0 }, "candidate": true, "det": "D1", "visit": "2025-08-22", "author": "orbit_owl", "created_at": 1763200000000 },
  { "id": "3I/ATLAS", "kind": "known", "ra": 247.109, "dec": -16.84, "day": 99, "real": true, "co2": "detected", "photos": 259 }
] }
```

- `ra`, `dec`: degrees. `day`: days since the coverage start (MJD 60789, 24 Apr 2025); the marker appears once the time slider reaches it.
- `tags`: votes, counted from the `comments` table. A tag is part of a comment, and only each person's latest tag counts.
- `co2`, `photos` (known comets): the carbon dioxide verdict of a measured comet (`detected`, `quiet` or `unclear`; `null` until its spectrum is measured) and how many SPHEREx photos it is in. The Comets page lists them.
- `thumb` (measured comets): one of the photos its page shows, the one where the comet is brightest (`data/comets/<dir>/<file>`); `null` for the rest. The Comets page uses it for the measured comets' cards.
- `pictures`, `first`, `last`, `visits`, `seen`, `measured` (known comets): from the baked picture inventory (`detail.facts.inv`): how many SPHEREx pictures held it on any detector, the first and last (MJD), how many visits, in how many SPHEREx detected it and how many could be measured. `peri_prev`, `peri_next`: its perihelion passages (Julian date) around the bake day. The Comets list groups and orders by these.
- `track` (known comets): `[[day, ra, dec, magnitude], ...]` every 10 days from JPL Horizons. The map moves the marker along it and shows it only while magnitude is 16 or brighter. Built by `bake/known_comets.py`.

## GET /api/comets/:id (D1)

One comet for its page. URL-encode the id (`/api/comets/3I%2FATLAS`). Adds `detail` and `comments`, oldest first.

```json
{ "id": "3I/ATLAS", "kind": "known", "real": true, "tags": { "comet": 0, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0 },
  "detail": { "speed_arcsec_per_hour": 99.0, "direction": "west", "first_mjd": 60888.3334, "exposures": 259, "measured": 159,
    "photos": [ { "file": "2025W33_1B_0599_1_D5.png", "mjd": 60901.2413, "lam": 4.254, "flux": 95.58, "ra": 243.82269, "dec": -16.39156 } ],
    "spectrum": { "2025-08": [ { "lam": 4.254, "flux": 95.58, "err": 0.82 } ], "2025-12": [ { "lam": 4.277, "flux": 532.73, "err": 3.1 } ] } },
  "comments": [ { "author": "orbit_owl", "tag": "comet", "body": "The tail points away from the Sun.", "created_at": 1762998800000 } ] }
```

A measured comet (`bake/comet_spectrum.py`; 3I/ATLAS, C/2025 R2, C/2024 T5, 210P so far) adds `photos` (each with the comet's `ra`, `dec` when it was taken, from JPL Horizons as SPHEREx saw it; its detector ends the file name), `spectrum` (by month), `dir` (its folder under `web/data/comets/`), `co2` (the carbon dioxide verdict per month: `state` detected, quiet or unclear, with `excess` and `sigma` in mJy) and `co2_verdict` (one word for the page's badge: detected if any month shows it).

For a known comet from JPL's catalog, `detail` holds `spherex`: every SPHEREx D1 photo whose outline held the comet when it was taken (`[{ "day": 210.43, "obs": "2025W47_..." }]`), plus `q` (closest distance to the Sun, AU), `tp` (when, Julian date) and `mags`.

Every known comet's `detail.facts` (`bake/comet_facts.py`, migration 0017) holds what its page states (comet-plan/fact-table.md): `orb` (JPL's orbit at the bake day's epoch, with its solution `soln`, data arc and MOID; `des` is its Horizons designation), `peri` (the previous and next perihelion passages, refined), `enc` (its closest approach to Earth this pass, or null when not bracketed), `status` (`fragment` or `disrupted`) and `extrapolated`, `path` (heliocentric ecliptic positions for Depth, covering every picture's time plus or minus 30 days; `path.soln` is the JPL solution they come from; migration 0019), `T` (predicted magnitude every 5 days) and `inv` (every SPHEREx picture that held it over the whole survey, grouped into visits at gaps of 5 days, each visit with its verdict, best SNR, the predicted distance at its middle, `link`: the picture its time-lapse link opens, and `xyz`: the comet's exact heliocentric ecliptic position in AU at that picture's time, where Depth's playback stops).

`now` is the daily snapshot (`worker/src/now.js`, table `comet_now`, migration 0018): `{ as_of, soln, T, T30, r, rdot, delta, deldot, elong, side, cnst, ra, dec, x, y, z, vx, vy, vz }` from JPL Horizons for that UTC day, or `null`. A cron (every 10 minutes, 00:00 to 05:59 UTC) refreshes 10 comets a run; a failed fetch keeps the last good row and its date. Pages hide it when `as_of` is more than 2 days old, and combine it with `facts` only when `soln` matches.

Refusals: `404 {"error":"no comet C-9999"}`, `400 {"error":"comet id is not valid"}`, `503` if the database does not answer.

## GET /api/threads (D1)

The Forums page's threads: every comet with at least one written comment, newest activity first. Votes with no text are left out of `comments` (they are counted in `tags`).

```json
{ "threads": [ { "id": "3I/ATLAS", "kind": "known", "ra": 247.109, "dec": -16.84, "day": 99, "real": true,
    "tags": { "comet": 1, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0 }, "last": 1763200000000,
    "comments": [ { "author": "orbit_owl", "tag": "comet", "body": "The CO2 glow shows in the August photos.", "created_at": 1763200000000 } ] } ] }
```

- `last`: the newest comment's `created_at` (unix ms). `comments` are oldest first.

## POST /api/comments (D1)

Adds a comment to a comet. A tag makes it a vote: each author's latest tag is the one that counts.

```http
POST /api/comments
Content-Type: application/json

{ "comet_id": "3I/ATLAS", "tag": "comet", "body": "The tail points away from the Sun.", "author": "orbit_owl", "turnstile": "<token from the widget>" }
```

- `comet_id`: an existing comet id, as stored (no URL encoding in the body).
- `tag`: optional, one of `comet`, `asteroid`, `glitch`, `unsure`, `star` (`star`: added in migration 0015, the time-lapse's "Star" vote).
- `body`: 1 to 1000 characters after trimming, or empty when there is a tag (a vote alone).
- `author`: 1 to 24 letters, digits, spaces, `_`, `.` or `-`. The page takes it from the sign-in (`window.CH_USER.name` or localStorage `ch.user`), else asks for a nickname.
- `turnstile`: the Cloudflare Turnstile token, checked with siteverify before anything touches the database.

`201` returns the stored comment and the comet's new tally:

```json
{ "comment": { "comet_id": "3I/ATLAS", "author": "orbit_owl", "tag": "comet", "body": "The tail points away from the Sun.", "created_at": 1763120000000 },
  "tags": { "comet": 1, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0 } }
```

Refusals (JSON, CORS headers as above):

| Status | Body | When |
|---|---|---|
| 400 | `{"error":"body must be 1 to 1000 characters","field":"body"}` | bad input; `field` is `comet_id`, `tag`, `body`, `author` or `turnstile` (or `body` when it is not JSON) |
| 403 | `{"error":"human check failed, try again"}` | Turnstile refused the token |
| 403 | `{"error":"human check already used, try again"}` | the token already paid for a comment |
| 404 | `{"error":"no comet C-9999"}` | unknown comet |
| 405 | `{"error":"use POST"}` | any other method |
| 429 | `{"error":"too many comments, wait a minute","retry_after":60}` | more than 5 comments by one author in a minute |
| 503 | `{"error":"database is not answering, try again"}` | D1 error |

### Turnstile keys

- Live site: site key `0x4AAAAAAGBTgXAx-fdK_qGx` (public, in `data-sitekey` in `web/comet.html`; the widget allows `comet-hunt.comet-hunt.workers.dev` and `localhost`). The secret is a Worker secret, set with `npx wrangler secret put TURNSTILE_SECRET --config worker/wrangler.toml`. Never commit it.
- Local dev: on `localhost`, `127.0.0.1` and `[::1]` the page swaps in Cloudflare's test site key `1x00000000000000000000AA` (always passes), to match the test secret `1x0000000000000000000000000000000AA` in `worker/.dev.vars` (copy `worker/.dev.vars.example`). No account needed.
- The test widget hands out the same dummy token, `XXXX.DUMMY.TOKEN.XXXX`, every time. The Worker does not claim that token when siteverify says a test secret checked it, so you can post more than once locally. A real secret refuses the dummy token, so this changes nothing on the live site.
- To test the real widget locally, put the real secret in `worker/.dev.vars` and remove the localhost swap in `web/comet.html` for that session.

Each accepted token is stored as a SHA-256 hash (`turnstile_tokens`, migration 0007) in the same transaction as the comment, so a token pays for one comment only. The rate limit is checked inside that same insert, so posts sent at the same moment cannot get past it.

## "Discuss this": candidates (D1, migration 0013)

A visitor who finds a moving dot on a time-lapse turns it into a candidate others can see and tag. A candidate is a `comets`
row (kind `comet`, real, ids `C-0175` and up), so `GET /api/comets`, `GET /api/comets/:id`, `POST /api/comments`, the
Forums and the Explore markers all work on it. Those rows carry `candidate: true` and the fields below. One dot in one
visit is one candidate: "the same dot" means within 1 arcmin, and "the same visit" means one whose days (`visit.start` to
`visit.end`) share a day with it. Not the first day alone: the exposures in a visit depend on the channel and detector
the time-lapse was built at, so the same visit can start a day later in another channel.

### POST /api/candidates

```http
POST /api/candidates
Content-Type: application/json

{ "ra": 269.4651, "dec": 4.7473, "det": "D1", "channel": 6,
  "visit": { "start": "2026-08-23", "end": "2026-08-24", "mjd": 61275.71, "exposures": 3, "lam": 0.7654, "epochs": [61275.1, 61276.3] },
  "tag": "comet", "body": "Moves between visits.", "author": "mira_v", "turnstile": "<token from the widget>" }
```

- `ra` 0 to 360 (not 360), `dec` -90 to 90, numbers. The time-lapse sends the centre of the patch, where the click put the dot.
- `det`: `D1` to `D6`.
- `channel`: optional, the Spectral channel the time-lapse was built at, 1 to 102 as in `?ch=` (17 per detector, so it must be on `det`). Stored with `det` in `detail.candidate`; the candidate page rebuilds its frames at that channel (without one, at the detector's best-covered wavelength).
- `visit`: the frame on screen (`live/pipeline.js`): `start` and `end` as `YYYY-MM-DD`, `mjd` within SPHEREx's mission, `exposures` 1 to 1000, `lam` 0.7 to 5.1 µm, `epochs` optional (at most 100 times, each within 30 days of `mjd`). Stored whole in `detail.candidate.visit`.
- `tag`: required, one of `comet`, `asteroid`, `glitch`, `unsure`, `star` (`star`: added in migration 0015, the time-lapse's "Star" vote). It is the poster's first vote.
- `body`: optional, at most 1000 characters after trimming.
- `author`: as for comments. `turnstile`: as for comments (one token, one write).

`201`: a new candidate, the next free id. `200`: a candidate was already within 1 arcmin in the same visit, so the post
joined it (its tag and comment went into that thread). The check runs inside the insert, in one D1 transaction, so two
posts at once still make one row.

```json
{ "id": "C-0182", "created": true,
  "candidate": { "id": "C-0182", "ra": 269.4651, "dec": 4.7473, "det": "D1", "visit": "2026-08-23", "author": "mira_v", "created_at": 1763200000000 } }
{ "id": "C-0182", "merged": true, "candidate": { "id": "C-0182", "...": "the first report's fields" } }
```

Refusals:

| Status | Body | When |
|---|---|---|
| 400 | `{"error":"det must be D1 to D6","field":"det"}` | bad input; `field` is `ra`, `dec`, `det`, `channel`, `visit`, `tag`, `body`, `author` or `turnstile` (or `body` when it is not JSON) |
| 403 | `{"error":"human check failed, try again"}` | Turnstile refused the token |
| 403 | `{"error":"human check already used, try again"}` | the token already paid for a write |
| 405 | `{"error":"use POST"}` | any other method |
| 413 | `{"error":"body too large","field":"body"}` | over 8 KB |
| 429 | `{"error":"too many reports, wait a minute","retry_after":60}` | over 5 a minute from one IP (`CANDIDATES_LIMIT` in `wrangler.toml`, checked before the body is read) |
| 503 | `{"error":"database is not answering, try again"}` | D1 error |

### GET /api/candidates/near?ra=&dec=[&visit=YYYY-MM-DD]

Candidates within 1 arcmin, oldest first, with their tallies and distance (`sep`, arcsec). With `visit`, those whose
visit includes that day; without, any visit (the time-lapse asks once per spot and picks the one sharing a day with the
visit on screen). Each row has `visit` (first day), `visit_end` and `channel` (null when none was given). Never cached. `ra`/`dec` refusals as for `/api/images`;
a bad `visit` is `400 {"error":"visit must be YYYY-MM-DD"}`.

```json
{ "candidates": [ { "id": "C-0182", "ra": 269.4651, "dec": 4.7473, "det": "D1", "visit": "2026-08-23", "author": "mira_v",
  "visit_end": "2026-08-24", "channel": 6, "created_at": 1763200000000, "tags": { "comet": 1, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0 }, "sep": 0 } ] }
```

### POST /api/sightings

"It's <name>": the dot is a known object SkyBoT predicted within 1 arcmin in that visit. Stored in `sightings` and nothing
else: no candidate, no page, no marker. No Turnstile (one click, and nothing anyone else sees); the same rate limit as
candidates, counted separately.

```http
POST /api/sightings
Content-Type: application/json

{ "name": "2001 FM127", "ra": 269.4651, "dec": 4.7473, "det": "D1", "visit": { "start": "2025-08-27", "...": "as above" }, "author": "mira_v" }
```

`201` returns `{ "sighting": { "id": 3, "name": "2001 FM127", "ra": 269.4651, "dec": 4.7473, "det": "D1", "visit": "2025-08-27", "author": "mira_v", "created_at": 1763200000000 } }`.
Refusals: `400` with `field` `name` (1 to 40 letters, digits, spaces and `( ) / ' . _ + -`), `ra`, `dec`, `det`, `visit` or `author`; `405`, `413` (over 4 KB), `429` and `503` as above.

### On the other routes

- `GET /api/comets` and `/api/comets/:id`: a candidate has `candidate: true`, `det`, `visit` (first day), `author`, `created_at`; `/api/comets/:id` adds `detail.candidate` (`visit`, `det`, `channel`).
- `POST /api/comments`: a tag alone, with an empty `body`, is now accepted (the candidate page's Tags card). Without a tag the body still needs 1 to 1000 characters.
- Explore keeps a candidate's marker hollow and labelled candidate until it has at least 5 tags and 60% say comet.

## GET /api/known?ra=&dec=&t=

Known comets and asteroids in a time-lapse frame, from IMCCE SkyBoT (a public service that works out where every known small body is at a given moment). Planets are left out. Built from kzkei's version on the include-documentation-and-scope branch. A time-lapse frame is one visit, several exposures over a few days, and a known asteroid crosses the patch in hours, so the time-lapse asks at each distinct exposure time of the visit (exposures less than 1.2 hours apart count as one; baked targets have only the visit's middle). It asks three at a time, the frame on screen first, after the frames show. It draws where SkyBoT put each object at each time, joined by a dashed path, and lists them in the panel with their dates.

- `t` is the frame's time as an MJD. The cone is 0.15 degrees, which covers the widest 12 arcmin view.
- Comets are always kept (`mag` is null when SkyBoT sends none). SkyBoT itself leaves out objects whose predicted position is uncertain by more than 2 arcmin (its default), which keeps badly known objects off the picture. Asteroids are kept at V magnitude 21 or brighter, at most 8, brightest first. `omitted` counts the asteroids left out.
- Cached for a day: a past frame's answer never changes.

```
GET /api/known?ra=77.3058&dec=27.3551&t=61285.0302
200 { "ra": 77.3058, "dec": 27.3551, "t": 61285.0302,
      "comets": [ { "name": "C/2025 R2", "ra": 77.31029, "dec": 27.35555, "mag": 20.3, "err": 2.99 } ],
      "asteroids": [], "omitted": 0 }
```

Refusals:

| Request | Status | Body |
|---|---|---|
| `ra` missing or outside 0 to 360 | 400 | `{"error": "ra must be 0 to 360"}` |
| `dec` missing or outside -90 to 90 | 400 | `{"error": "dec must be -90 to 90"}` |
| `t` missing, not a number, or outside MJD 40000 to 80000 | 400 | `{"error": "t must be an MJD"}` |
| SkyBoT down | 503 | `{"error": "SkyBoT is not answering", "retry_after": 30}` |

The frame is the median of its exposures, so a fast asteroid usually leaves no dot: its path means a known object passed through during that visit, not that a dot under it is that object. The panel says "Catalog check unavailable" when every time answered 503, and counts the times that could not be checked otherwise. A rows-but-unreadable SkyBoT answer is a 503, never a cached empty result.

## GET /api/depth?ra=&dec=[&t=]

Data for the per-patch Depth view (no UI yet): every object in the time-lapse patch that has a catalog distance, in parsecs, ready for one logarithmic scale. Code: `worker/src/depth.js`. Three sources, each answered, cached and failed on its own:

| Source | Catalog | Placed when | Distance (`d_pc`, with `d_lo_pc`..`d_hi_pc`) |
|---|---|---|---|
| `sso` | IMCCE SkyBoT at `t` (MJD), geocentric | SkyBoT gives a range `dg` | `dg` in pc; no range error is published, so both ends are `null` |
| `stars` | ESA Gaia DR3 | `parallax_over_error > 5 AND ruwe < 1.4` | `1000 / (parallax + 0.017 mas)`, ends at parallax plus or minus its error |
| `galaxies` | SIMBAD (Harvard mirror), `otype = 'G..'` | `rvz_redshift >= 0.01`, quality A to D, spectroscopic or unstated | comoving distance, flat LCDM, H0 = 70, Om = 0.3; ends from the redshift error plus a 300 km/s peculiar-velocity floor (`unc_basis`) |

- Cone 0.15 degrees around `ra`, `dec` rounded to 4 decimals (the same cone as `/api/known`; it covers the 12 arcmin square). `t` is optional; without it `sso` is `skipped`.
- Nothing without a usable distance gets a number: stars that fail the cut are `unknown_count` only (their positions are in `/api/gaia`); galaxies that fail are listed in `unknown` with a `reason` (`no redshift`, `redshift not spectroscopic`, `redshift quality E`, `z below 0.01`); a SkyBoT row without a range is in `unknown` (`no distance`).
- Each object keeps the raw measurement in `raw` (parallax and error with RUWE; redshift, error, type, quality, nature; `dg` and `dh` in au). Star positions are Gaia's epoch 2016.0, with `pmra`, `pmdec`.
- Lists hold at most `limit` (1000) rows, brightest stars first; `count` is always the exact number (from a `COUNT` of the same query) and `truncated` says when the list is shorter. Rows that disagree with that count make the source `unavailable`.
- Status per source: `ok`; `skipped`; `unavailable` with `error` and `retry_after` (an outage, refusal, timeout or unreadable answer; never an older copy, and never saved to D1 like the other searches); `pending` with `retry_after: 5` when it has not answered within 4 s. A pending source keeps fetching after the answer goes out and is cached, so asking again usually gets it (SkyBoT takes 5 to 8 s on the ecliptic). If that background fetch fails, or takes more than 25 s in all, the failure is noted for 60 s (Cache API, under the same key with `failed/`): asks in that minute get `unavailable` without calling the archive, and the next success replaces the note. A note is never an answer.
- Cache API, per source, only when `ok`: stars 30 days, galaxies 7 days, sso 7 days (keyed with `t`). The response is `public, max-age=3600` when every source is `ok` or `skipped`, otherwise `no-store`.
- Local dev only (`DEPTH_FAULTS=1` in `worker/.dev.vars`): `fail=sso,stars,galaxies` forces those sources to fail at once, `outage=...` makes them fail after the deadline (the background path), `fresh=1` skips cache reads. Ignored everywhere else.

```
GET /api/depth?ra=167.1309&dec=5.1732&t=61023.3194
200 { "ra": 167.1309, "dec": 5.1732, "t": 61023.3194, "radius_deg": 0.15, "rules": "depth-v1", "sources": {
  "sso": { "status": "ok", "source": "IMCCE SkyBoT", "observer": "geocentre", "count": 15, "truncated": false, "epoch_jd": 2461023.8194,
    "placed": [ { "name": "3I", "num": null, "class": "Comet", "ra": 167.15705, "dec": 5.16429, "mag": null, "err_arcsec": 0.97,
      "raw": { "dg_au": 1.80715592229, "dh_au": 2.14669872055 }, "d_pc": 0.0000087613, "d_lo_pc": null, "d_hi_pc": null } ], "unknown": [] },
  "stars": { "status": "ok", "source": "ESA Gaia DR3", "epoch": 2016, "count": 57, "truncated": false, "limit": 1000, "unknown_count": 140, "placed": [ ... ] },
  "galaxies": { "status": "pending", "retry_after": 5 } } }
```

Refusals are those of `/api/known` (`ra`, `dec`, and `t` when given). `python3 worker/depth_eval.py` checks the live answer against the catalogs queried directly (needs `npm run dev` with `DEPTH_FAULTS=1`); `worker/depth.test.mjs` (in `npm test`) checks the rules and readers offline.

## GET /api/explored (D1)

Which patch-sized sky cells people have checked, for the heat map, and one of the least-checked cells to suggest. Never cached, so a spot shows on the map as soon as someone opens it, and each visit gets a fresh suggestion.

```json
{ "total": 3339,
  "cells": [ { "ra_min": 266.4, "ra_max": 269.9, "dec_min": 3.5, "dec_max": 7.1, "checks": 3 } ],
  "suggest": { "ra": 211.46, "dec": -3.53 } }
```

- `cells` lists only cells with `checks > 0`. The grid is 51 bands of Dec, each split into about 3.5 degree steps of RA (the size of one SPHEREx patch). A cell's number is its position in that grid, counting band by band from the north pole.
- `suggest` is the centre of a cell picked at random, on every request, from the cells with the fewest checks (unchecked ones while any are left). Only cells that make a good first look are picked: more than 10 degrees from the Milky Way plane (galactic latitude), where the crowd of stars hides moving dots, and less than 75 degrees from the ecliptic, outside the polar caps that SPHEREx's deep survey covers. That list is worked out once per Worker isolate, so a request only counts.

## POST /api/checks (D1)

Records that someone opened a spot: the time-lapse calls it each time a live time-lapse finishes building (so a reload or another detector counts again; the five baked targets do not count). Adds one to that spot's cell.

```
POST /api/checks   {"ra": 269.4463, "dec": 4.7671}
201                {"cell": 1234, "checks": 3}
```

Refusals:

| Request | Status | Body |
|---|---|---|
| body over 1024 bytes (checked while reading, whatever `Content-Length` says) | 413 | `{"error": "body too large", "field": "body"}` |
| body is not JSON | 400 | `{"error": "body must be JSON", "field": "body"}` |
| `ra` missing, not a number, or outside 0 to 360 | 400 | `{"error": "ra must be 0 to 360", "field": "ra"}` |
| `dec` missing, not a number, or outside -90 to 90 | 400 | `{"error": "dec must be -90 to 90", "field": "dec"}` |
| GET (or any method but POST) | 405 | `{"error": "use POST"}` with `Allow: POST` |
| more than 10 requests a minute from one IP (Cloudflare rate limit, `CHECKS_LIMIT` in wrangler.toml; it runs before the body is read, so every request counts, refused ones included) | 429 | `{"error": "too many checks, wait a minute"}` |
| database down | 503 | `{"error": "database is not answering, try again"}` |

No sign-in or human check: a count is low stakes. The rate limit keeps a script from spending the database's daily writes; the worst it can do then is light up cells on the map.

## GET /api/images?ra=&dec=&det=

The SPHEREx photos covering a point, cached for a day. The browser then reads the pixels straight from NASA's public S3 bucket (`web/live/fits.js`).

```json
{ "ra": 269.4463, "dec": 4.7671, "det": "D1",
  "images": [ { "t": 60914.21, "key": "dr1/level2/.../image.fits", "obs": "...", "coll": "spherex_dr1" } ],
  "collections": { "spherex_dr1": 31, "spherex_qr3": 32 }, "source": "index" }
```

`source` says who answered. `"index"` is our own index of every level-2 image (`bake/sky_index.py` builds it from the image headers on NASA's S3 bucket; one file per detector in the R2 bucket `comet-hunt-sky-index`, read by `worker/src/sky_index.js`). It gives the same answer IRSA's search gives: an image counts when the 0.001 degree circle around the point touches its footprint polygon (IRSA's `s_region`), one row per `obs`, DR1 first, the deep collections only within 15 degrees of the ecliptic poles. `"IRSA"` is IRSA's search (SIA), used only when the index cannot answer (its file is missing or R2 fails). Answers cached or saved before the index arrived have no `source`.

The index is a snapshot of the bucket as listed on 2026-11-15 (DR1, and QR3 through week 2026W40_2A). Photos from weeks published after that are missing from `"index"` answers until the index is rebuilt; a scheduled refresh is not built yet.

The Worker accepts only one version of each index file: the one whose R2 etag is pinned in `worker/wrangler.toml` (`SKY_ETAG_D1` to `SKY_ETAG_D6`; for these single-part uploads the etag is the file's MD5). A replaced, truncated or corrupted file has another etag, so it is refused and IRSA answers until the pins match again.

#### Refreshing the image index

1. List the bucket's level-2 keys again (`keys.tsv`: key, tab, size).
2. Read the headers: `uv run --with aiohttp python bake/sky_headers.py keys.tsv hdr_dN.jsonl N` for each detector. It resumes, and exits non-zero while any file failed.
3. Build: `uv run --with numpy python bake/sky_index.py hdr_dN.jsonl OUT keys.tsv`. It writes nothing unless every listed key has exactly one header and every row passes its checks (6-decimal times in time order, footprints that are the images' own quadrilaterals).
4. Verify the build: `bake/sky_index_eval.py` against IRSA answers (0 unexplained differences) and `uv run --with numpy python bake/test_sky_index.py`.
5. Pin it locally: put each file's MD5 (`md5 -q OUT/dN.bin`) in `SKY_ETAG_DN` in `worker/wrangler.toml`.
6. Run the full-file tests: `SKY_INDEX_DIR=OUT node --test worker/sky_index_full.test.mjs` (byte-identical answers, every cell, and each pin equal to its file's MD5).
7. Upload each file: `npx wrangler r2 object put comet-hunt-sky-index/dN.bin --file OUT/dN.bin --remote --config worker/wrangler.toml`, then compare the uploaded object with the file (download it again, or check that a preview version answers with `"source":"index"`, which only happens when R2's etag equals the pin).
8. Deploy. Between the upload and the deploy, that detector's searches fall back to IRSA (the old pin refuses the new file).

Refusals: `400 {"error":"ra must be 0 to 360"}`, `400 {"error":"dec must be -90 to 90"}`, `400 {"error":"det must be D1 to D6"}`, and `503` with `retry_after` when the index cannot answer and IRSA's search is down (an empty `images` list always means "no photos here", never "search failed").

## GET /api/gaia?ra=&dec=

Gaia DR3 stars within 0.04 degrees, with proper motions and Gaia G brighter than 19 (fainter stars are below what SPHEREx measures, and the cut keeps crowded fields such as Baade's Window to about 3,200 stars), for checking measured star motion. Read from IRSA's copy of Gaia DR3 (its Gator catalog service, about 1.5 s); ESA's own archive is the fallback, tried once for up to 8 s. `source` says which answered (`"IRSA"` or `"ESA"`). `503` when both are down. The time-lapse waits at most 8 s for this and otherwise shows its frames without the Gaia comparison.

### Saved answers (D1 `searches`, all three outside searches)

Every complete answer from `/api/images`, `/api/gaia` and `/api/known` is also saved in D1 under its path and the parameters it reads (`ra`, `dec`, `det`, `t`, `v`; others are ignored). When the outside service fails (a `5xx`) or `/api/images` answers only in part, the last saved answer to that exact search is sent instead: `200`, the same JSON, `Cache-Control: no-store` and an `X-Saved-At` time. A search never answered before still gets the `503`; a bad request still gets its `400`. Added after IRSA's image search answered 502 for most of 2026-11-15.

## GET /api/cat?cat=&ra=&dec= (R2 OLDSKY, then the archives)
The Colors tab's and the Brightness change card's catalogues for one spot (`worker/src/cat.js`): `cat` is `2mass`, `catwise`, `allwise`, `gaia` (Gaia DR3 with `phot_variable_flag`), all from IRSA's TAP, `simbad` (SIMBAD's TAP at CDS, else its CfA mirror) or `vsx` (VSX, `B/vsx`, from VizieR's ASU service at CDS, else CfA), in a 0.275 degree cone about the spot rounded to 0.001 degree. The answer is the archive's own text (CSV; VSX tab-separated), stored in R2 at `cat/v1/<cat>/<pos>.csv|tsv` the first time and served from there after. Before storing, the Worker checks only that the answer is a table with every column the browser needs and a complete last line; the browser parses and checks every row. Errors: `400` for an unlisted catalogue or a bad position; `429` past 12 new spots' catalogues a minute per IP (stored ones are never limited); `503` when no archive answers with a usable table (nothing is stored, so a later request asks again). Redirects are refused and only the listed hosts are asked.

### cat=neowise: NEOWISE single exposures for the Brightness change card
`GET /api/cat?cat=neowise&ra=&dec=&r=` returns NEOWISE-R single-exposure photometry (`neowiser_p1bs_psd`) within `r` arcsec (a whole number, 3 to 30, default 5) of the spot, which is rounded to 0.0001 degree (0.36 arcsec; the other catalogues' 0.001 degree is too coarse for a cone this small). IRSA's TAP is asked first; when it fails, IRSA's Gator, whose IPAC table the Worker rewrites to the same CSV columns, so R2 holds one format at `cat/v1/neowise/<ra>±<dec>_<r>.csv`. The card asks with the star's CatWISE-epoch place and a radius of 3 arcsec plus its motion over 6.5 years. Same checks, rate limit and errors as the other catalogues; a spot NEOWISE never detected is `200` with the header line only.

```
GET /api/cat?cat=neowise&ra=85.62757&dec=-8.54869&r=5      200 text/csv, X-Cat: miss (then hit)
ra,dec,mjd,w1mpro,w1sigmpro,w1snr,w2mpro,w2sigmpro,w2snr,qual_frame,qi_fact,saa_sep,moon_masked,cc_flags
85.6275860,-8.5486080,57089.39936119,10.150,0.021,52.1,9.968,0.021,51.7,10,1.0,99.878,00,0000
GET /api/cat?cat=neowise&ra=10&dec=4&r=2                   400 {"error":"r must be a whole number of arcsec, 3 to 30"}
GET /api/cat?cat=neowise&ra=400&dec=0                      400 {"error":"ra must be 0 to 360"}
TAP and Gator both failing                                 503 {"error":"catalogue unavailable","reason":"..."} (nothing stored)
```

The card (`web/timelapse.html`, built in `web/live/colorsworker.js` mode `bright`, arithmetic in `web/live/brightness.js`) groups the exposures into visits by the decade detector's frozen rule: SNR >= 5, `qual_frame` > 0, `qi_fact` > 0, `saa_sep` > 5, the band's `moon_masked` and `cc_flags` characters 0, fainter than 8.0 (W1) / 7.0 (W2), within 2.5 arcsec of the star then; 30-day gaps; at least 5 good exposures; the median, error 1.253 std / sqrt(n) with a 0.02 mag floor. Known limit: near NEOWISE's limit the SNR cut keeps the brighter exposures, so a faint star's visit medians can read bright.

## GET /api/colors?ra=&dec= (R2 OLDSKY)
A baked Colors result at this spot (`bake/colors_bake.mjs`; the showcase), or `404` and the page offers a live build. The bake's own centre must be within 2 arcsec of the spot asked for. To bake the showcase into production R2 once Ed has reported it: `node bake/colors_bake.mjs --api https://comet-hunt.comet-hunt.workers.dev --ra 84.0181 --dec -6.577 --out <dir> --put remote --bucket comet-hunt-oldsky --config worker/wrangler.toml`.

## Planned (not built)

- `GET /api/comets/:id`: one comet with its dots, photos, measurements and comment thread.

## Tests

`npm test` runs `worker/test_contract.sh` against `http://127.0.0.1:8787`: every route above, its refusals, the CORS header, and that the pages are served. The `POST /api/comments` checks write to the database, so they run only against a local server (127.0.0.1, localhost) and are skipped elsewhere.

## GET /api/posts (D1)

The Forums feed: the 200 newest comments that have text, across every comet, newest first. Never cached.

```json
{ "posts": [ { "comet_id": "3I/ATLAS", "author": "mira_v", "tag": "comet", "body": "Strong carbon dioxide peak at 4.26.",
  "created_at": 1763200000000, "kind": "known", "ra": 247.109, "dec": -16.84, "real": true } ] }
```

## GET /api/oldsky (R2 OLDSKY, then IRSA)

The older survey's picture of a spot, for "Then and now" (`worker/src/oldsky.js`, used by `web/live/blinkworker.js`). Only `survey=allwise` with `band=W1` or `W2`, and `survey=2mass` with `band=Ks`; one size, 780 arcsec (`size`, if sent, must be `780`); `ra` 0 to 360 and `dec` -90 to 90, rounded to 0.001 degree for the stored key.

```json
{ "v": 1, "survey": "allwise", "band": "W2", "size_arcsec": 780, "ra": 84.018, "dec": -6.578, "release": "AllWISE Atlas (p3am_cdd)",
  "tiles": [ { "name": "allwise_W2_int.fits", "path": "api/oldsky/v1/allwise/W2/780/84.018-6.578/allwise_W2_int.fits",
    "source": "https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/...-w2-int-3.fits?center=84.018,-6.578&size=780arcsec",
    "bytes": 1084025, "gzip": true, "etag": "...", "header": { "BAND": "2", "DATEOBS1": "2010-03-06T22:30:53.139", "DATEOBS2": "2010-09-17T04:47:46.567" } } ] }
```

- R2 first (`X-Oldsky: hit`). A miss is rate limited per IP (`OLDSKY_LIMIT`, 6 a minute; 429 past it), then IRSA is asked: the host is fixed to irsa.ipac.caltech.edu, redirects are refused, 20 s and at most 4 MB a tile (by its Content-Length), at most 8 tiles, one at a time. The Worker plan allows 10 ms of CPU, so a tile is streamed into R2 at its declared length without being copied, inflated or hashed here; the Worker reads only its first 64 KB (the header: a 2-D image of a known BITPIX, of the band asked) and, for a gzip (detected from its first bytes), its 4-byte size trailer, and checks the stored length (or the gzip's inflated size, at most 16 MB) covers NAXIS1 x NAXIS2 x |BITPIX|/8 after the header, padded to 2880. Anything wrong deletes what was stored. The manifest is stored last and carries each tile's size and R2 etag, no checksum. The browser inflates every byte and checks the whole image; a damaged stored tile makes that band "inconclusive" (there is no route to drop a stored tile: delete its manifest in R2 by hand). An IRSA failure answers `503 {"error":"older survey unavailable"}` with `Cache-Control: no-store` and stores nothing; no tile at all is `404`.
- AllWISE: the nearest Atlas tile's intensity image and coverage map. 2MASS: every Ks atlas image overlapping the 12 arcmin field (one box search).
- `GET /api/oldsky/v1/...` serves a stored tile as IRSA sent it (canonical keys only). The page checks it against `sha256`.

A new spot comes in steps, so each request stays inside the Workers plan's CPU limit (a whole 2MASS mosaic in one request measured 17.6 ms on a 10 ms plan): the first request searches IRSA, stores the plan and answers `202 {"pending": ["2mass_Ks_001126_ki1020021.fits", ...]}`; then `GET /api/oldsky/tile?survey=&band=&ra=&dec=&name=` stores one tile of that plan per request (names from the plan only; `OLDSKY_TILE_LIMIT`, 30 a minute per IP; `404` for a name not in the plan); then `GET /api/oldsky` again writes and answers the manifest once every tile has passed its checks. A tile that fails is deleted and its request answers `503`; tiles that passed are kept, and there is no manifest until all have.

## GET /api/blink?ra=&dec= (R2 OLDSKY)

A baked "Then and now" blink at this spot (`bake/blink_bake.mjs`; the showcase J053604.34-063439.0), or `404`, and the page builds it live. `result.json` holds each band's state, report and checks; `frames_path` (`GET /api/blink/v1/<pos>/frames.bin`) the calibrated frames as float32. To bake the showcase into production R2 once Ed has reported it: `node bake/blink_bake.mjs --api https://comet-hunt.comet-hunt.workers.dev --put remote --region "Orion A" --distance-ly 1250 --dust-k 680`.
