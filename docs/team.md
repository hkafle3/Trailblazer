# Working on Comet Catcher

## The pieces and where they live

| Piece | Status | Files | Next step |
|---|---|---|---|
| Explore map (home) | Works with example data | `web/index.html`, `web/explore.js`, `web/styles.css` | Polish; touch layout |
| Patch view (time-lapse) | Works with real SPHEREx data, old styling | `web/timelapse.html`, `web/live/` | Restyle to match `design/screens/patch.html`: side by side, blink, remove still stars |
| Comet page + tagged comments | Loads from D1. 3I/ATLAS has real SPHEREx photos, motion and spectrum (`bake/comet_3iatlas.py`) | `web/comet.html`, `web/comet.js` | `POST /api/comments` with a Turnstile token, then live tally (Durable Object) |
| Guide + practice patch | Static design only | `web/guide.html` | Use IRSA's real 3I/ATLAS images as the practice patch |
| API + database | Images, Gaia, comets and comments real (D1: `worker/migrations/`); explored is example data | `worker/src/`, `worker/migrations/` | Explored counter in D1: +1 per patch opened or tagged, `/api/explored` reads it (same shape) |
| Known objects | Not started | | `/api/known` from IMCCE SkyBoT |
| Dot finder | Not started | | Blink photo pairs taken hours apart, save moving dots as candidates. Runs in Python or the browser: a free Worker gets only 10 ms of compute per request |
| Data prep | Works; coverage map built from all 272,962 SPHEREx photos | `bake/` | Per-cell visit dates so the map can show SPHEREx's moving sweep after the first full pass |
| Pitch and demo | Not started | `docs/prior-art.md`, `docs/architecture.html` | Story: SPHEREx gives every find a spectrum |

The design reference for every screen is `design/screens/` (open the HTML files, or the PNGs in `design/screens/shots/`). Keep the look: glass panels, few words, icons and numbers over labels, lots of space. Colors mean one thing each: orange comets and selection, blue known objects, mint explored by people.

## How we work

- Branch off `main`, one branch per piece, small pull requests.
- Run `npm run dev` and `npm test` before opening a pull request. If you touched `web/live/` or `bake/`, also open `/tests/golden.html` and `/tests/live.html` and run `python3 bake/verify.py`.
- Keep API response shapes as written in `docs/api.md`; change the doc in the same pull request if a shape must change.
- No keys or tokens in the repo. Cloudflare secrets go in `wrangler secret`, local ones in `worker/.dev.vars` (ignored by git).
