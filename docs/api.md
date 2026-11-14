# API

One Cloudflare Worker (`worker/src/index.js`) answers every `/api/*` request and also serves the app's files from `web/`. All routes are `GET`, return JSON, and send `Access-Control-Allow-Origin: *`. Errors are `{"error": "..."}` with a 4xx or 5xx status.

Comets and comments live in Cloudflare D1 (database `comet-hunt`, schema in `worker/migrations/`). `/api/explored` still returns made-up data from `worker/src/example-data.js` with `"example": true`.

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

## GET /api/comets/:id (D1)

One comet for its page. URL-encode the id (`/api/comets/3I%2FATLAS`). Adds `detail` (null for example comets) and `comments`, oldest first.

```json
{ "id": "3I/ATLAS", "kind": "known", "real": true, "tags": { "comet": 0, "asteroid": 0, "glitch": 0, "unsure": 0 },
  "detail": { "speed_arcsec_per_hour": 99.0, "direction": "west", "first_mjd": 60888.3334, "exposures": 259, "measured": 159,
    "photos": [ { "file": "2025W33_1B_0599_1_D5.png", "mjd": 60901.2413, "lam": 4.254, "flux": 95.58 } ],
    "spectrum": { "2025-08": [ { "lam": 4.254, "flux": 95.58, "err": 0.82 } ], "2025-12": [ { "lam": 4.277, "flux": 532.73, "err": 3.1 } ] } },
  "comments": [ { "author": "orbit_owl", "tag": "comet", "body": "The tail points away from the Sun.", "created_at": 1762998800000 } ] }
```

Refusal: `404 {"error":"no comet C-9999"}`.

## GET /api/explored (example)

Which patch-sized sky cells people have checked, for the heat map, and one cell nobody has checked.

```json
{ "example": true, "total": 3339, "checked": 508,
  "cells": [ { "ra_min": 325.5, "ra_max": 329.1, "dec_min": 31.8, "dec_max": 35.3, "checks": 20 } ],
  "suggest": { "ra": 77, "dec": 30.4 } }
```

- `cells` lists only cells with `checks > 0`. The grid is 51 bands of Dec, each split into about 3.5 degree steps of RA (the size of one SPHEREx patch).

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

- `POST /api/comments` `{ dot, text, tag? }` with a Turnstile token: tag is one of `comet`, `asteroid`, `glitch`, `unsure`.
- `GET /api/comets/:id`: one comet with its dots, photos, measurements and comment thread.
- `GET /api/known?ra=&dec=&t=`: known comets and asteroids at a spot and time, from IMCCE SkyBoT.

## Tests

`npm test` runs `worker/test_contract.sh` against `http://127.0.0.1:8787`: every route above, its refusals, the CORS header, and that the pages are served.
