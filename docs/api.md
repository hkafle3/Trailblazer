# API

One Cloudflare Worker (`worker/src/index.js`) answers every `/api/*` request and also serves the app's files from `web/`. All routes are `GET`, return JSON, and send `Access-Control-Allow-Origin: *`. Errors are `{"error": "..."}` with a 4xx or 5xx status.

Routes marked **example** return made-up data from `worker/src/example-data.js` with `"example": true`. Replacing them with D1 queries is the next backend task; keep the response shapes and the page keeps working.

## GET /api/comets (example)

Markers for the Explore map: comets people found (`kind: "comet"`) and known objects (`kind: "known"`).

```json
{ "example": true, "comets": [
  { "id": "C-0147", "kind": "comet", "ra": 328, "dec": 34, "day": 127, "tail": -150,
    "tags": { "comet": 12, "asteroid": 1, "glitch": 0, "unsure": 1 } },
  { "id": "3I/ATLAS", "kind": "known", "ra": 246.71, "dec": -16.79, "day": 108, "real": true }
] }
```

- `ra`, `dec`: degrees. `day`: days since the coverage start (MJD 60789, 24 Apr 2025); the marker appears once the time slider reaches it.
- `tags`: how many people tagged this comet's dots each way. A tag is part of a comment; it counts as that person's vote.
- `tail`: the angle the marker's tail points, in degrees (cosmetic).

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

## GET /api/known?ra=&dec=&t=

Asteroids and comets inside a 0.15° cone at one time, from IMCCE SkyBoT (planets excluded). `t` is an MJD. Asteroids of V magnitude 21 or brighter are kept, at most 8, brightest first. Comets are all kept; `mag` is null when SkyBoT sends none. Cached for a day. `503` when SkyBoT is down, and the patch then falls back to the baked Minor Planet Center orbits in `web/data/comet_eph.json`. `400` when `t` is missing or not an MJD. Which catalog is used for what, and when the patch draws a circle, is in [catalogs.md](catalogs.md).

```json
{ "ra": 246.71, "dec": -16.79, "t": 60897.0,
  "comets": [ { "name": "3I", "ra": 246.72, "dec": -16.79, "mag": null, "err": 0.97 } ],
  "asteroids": [ { "name": "Saville", "ra": 247.12, "dec": -16.81, "mag": 17.4, "err": 0.02 } ],
  "omitted": 0 }
```

## Planned (not built)

- `POST /api/comments` `{ dot, text, tag? }` with a Turnstile token: tag is one of `comet`, `asteroid`, `glitch`, `unsure`.
- `GET /api/comets/:id`: one comet with its dots, photos, measurements and comment thread.

## Tests

`npm test` runs `worker/test_contract.sh` against `http://127.0.0.1:8787`: every route above, its refusals, the CORS header, and that the pages are served.
