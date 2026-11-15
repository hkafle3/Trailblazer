# API

One Cloudflare Worker (`worker/src/index.js`) answers every `/api/*` request and also serves the app's files from `web/`. All routes are `GET`, return JSON, and send `Access-Control-Allow-Origin: *`. Errors are `{"error": "..."}` with a 4xx or 5xx status.

Comets and comments live in Cloudflare D1 (database `comet-hunt`, schema in `worker/migrations/`). `/api/explored` counts real checks from the `checks` table (`POST /api/checks`).

Database: `npm run dev` applies the migrations to a local copy first, so it works with no account. `npm run db:remote` applies them to the real database (needs `npx wrangler login`). A new table or column is a new numbered file in `worker/migrations/`; never edit one that has been applied.

## GET /api/comets (D1)

Markers for the Explore map: comets people found (`kind: "comet"`) and known objects (`kind: "known"`), read from the `comets` table. `example: true` marks seeded example rows; `real: true` marks real objects with real data (3I/ATLAS).

```json
{ "comets": [
  { "id": "C-0147", "kind": "comet", "ra": 328, "dec": 34, "day": 127, "tail": -150, "real": false, "example": true,
    "tags": { "comet": 12, "asteroid": 1, "glitch": 0, "unsure": 1 } },
  { "id": "3I/ATLAS", "kind": "known", "ra": 247.109, "dec": -16.84, "day": 99, "real": true, "example": false }
] }
```

- `ra`, `dec`: degrees. `day`: days since the coverage start (MJD 60789, 24 Apr 2025); the marker appears once the time slider reaches it.
- `tags`: votes, counted from the `comments` table. A tag is part of a comment, and only each person's latest tag counts.
- `co2`, `photos` (known comets): the carbon dioxide verdict of a measured comet (`detected`, `quiet` or `unclear`; `null` until its spectrum is measured) and how many SPHEREx photos it is in. The Comets page lists them.
- `track` (known comets): `[[day, ra, dec, magnitude], ...]` every 10 days from JPL Horizons. The map moves the marker along it and shows it only while magnitude is 16 or brighter. Built by `bake/known_comets.py`.

## GET /api/comets/:id (D1)

One comet for its page. URL-encode the id (`/api/comets/3I%2FATLAS`). Adds `detail` (null for example comets) and `comments`, oldest first.

```json
{ "id": "3I/ATLAS", "kind": "known", "real": true, "tags": { "comet": 0, "asteroid": 0, "glitch": 0, "unsure": 0 },
  "detail": { "speed_arcsec_per_hour": 99.0, "direction": "west", "first_mjd": 60888.3334, "exposures": 259, "measured": 159,
    "photos": [ { "file": "2025W33_1B_0599_1_D5.png", "mjd": 60901.2413, "lam": 4.254, "flux": 95.58 } ],
    "spectrum": { "2025-08": [ { "lam": 4.254, "flux": 95.58, "err": 0.82 } ], "2025-12": [ { "lam": 4.277, "flux": 532.73, "err": 3.1 } ] } },
  "comments": [ { "author": "orbit_owl", "tag": "comet", "body": "The tail points away from the Sun.", "created_at": 1762998800000 } ] }
```

A measured comet (`bake/comet_spectrum.py`; 3I/ATLAS, C/2025 R2, C/2024 T5, 210P so far) adds `photos`, `spectrum` (by month), `dir` (its folder under `web/data/comets/`), `co2` (the carbon dioxide verdict per month: `state` detected, quiet or unclear, with `excess` and `sigma` in mJy) and `co2_verdict` (one word for the page's badge: detected if any month shows it).

For a known comet from JPL's catalog, `detail` holds `spherex`: every SPHEREx D1 photo whose outline held the comet when it was taken (`[{ "day": 210.43, "obs": "2025W47_..." }]`), plus `q` (closest distance to the Sun, AU), `tp` (when, Julian date) and `mags`.

Refusals: `404 {"error":"no comet C-9999"}`, `400 {"error":"comet id is not valid"}`, `503` if the database does not answer.

## POST /api/comments (D1)

Adds a comment to a comet. A tag makes it a vote: each author's latest tag is the one that counts.

```http
POST /api/comments
Content-Type: application/json

{ "comet_id": "3I/ATLAS", "tag": "comet", "body": "The tail points away from the Sun.", "author": "orbit_owl", "turnstile": "<token from the widget>" }
```

- `comet_id`: an existing comet id, as stored (no URL encoding in the body).
- `tag`: optional, one of `comet`, `asteroid`, `glitch`, `unsure`.
- `body`: 1 to 1000 characters after trimming.
- `author`: 1 to 24 letters, digits, spaces, `_`, `.` or `-`. The page takes it from the sign-in (`window.CH_USER.name` or localStorage `ch.user`), else asks for a nickname.
- `turnstile`: the Cloudflare Turnstile token, checked with siteverify before anything touches the database.

`201` returns the stored comment and the comet's new tally:

```json
{ "comment": { "comet_id": "3I/ATLAS", "author": "orbit_owl", "tag": "comet", "body": "The tail points away from the Sun.", "created_at": 1763120000000 },
  "tags": { "comet": 1, "asteroid": 0, "glitch": 0, "unsure": 0 } }
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

## GET /api/explored (D1)

Which patch-sized sky cells people have checked, for the heat map, and one cell nobody has checked. Never cached, so a spot shows on the map as soon as someone opens it.

```json
{ "total": 3339,
  "cells": [ { "ra_min": 266.4, "ra_max": 269.9, "dec_min": 3.5, "dec_max": 7.1, "checks": 3 } ],
  "suggest": { "ra": 77, "dec": 30.4 } }
```

- `cells` lists only cells with `checks > 0`. The grid is 51 bands of Dec, each split into about 3.5 degree steps of RA (the size of one SPHEREx patch). A cell's number is its position in that grid, counting band by band from the north pole.
- `suggest` is RW Aurigae's patch while nobody has checked it, then the unchecked cell nearest to it.

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

The SPHEREx photos covering a point, from IRSA's search, cached for a day. The browser then reads the pixels straight from NASA's public S3 bucket (`web/live/fits.js`).

```json
{ "ra": 269.4463, "dec": 4.7671, "det": "D1",
  "images": [ { "t": 60914.21, "key": "dr1/level2/.../image.fits", "obs": "...", "coll": "spherex_dr1" } ],
  "collections": { "spherex_dr1": 31, "spherex_qr3": 32 } }
```

Refusals: `400 {"error":"ra must be 0 to 360"}`, `400 {"error":"dec must be -90 to 90"}`, `400 {"error":"det must be D1 to D6"}`, and `503` with `retry_after` when IRSA's search is down (an empty `images` list always means "no photos here", never "search failed").

## GET /api/gaia?ra=&dec=

Gaia DR3 stars within 0.04 degrees, with proper motions, for checking measured star motion. `503` when ESA's archive is down.

## Planned (not built)

- `GET /api/comets/:id`: one comet with its dots, photos, measurements and comment thread.
- `GET /api/known?ra=&dec=&t=`: known comets and asteroids at a spot and time, from IMCCE SkyBoT.

## Tests

`npm test` runs `worker/test_contract.sh` against `http://127.0.0.1:8787`: every route above, its refusals, the CORS header, and that the pages are served. The `POST /api/comments` checks write to the database, so they run only against a local server (127.0.0.1, localhost) and are skipped elsewhere.
