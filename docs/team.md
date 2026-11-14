# Working on Comet Hunt

## The pieces and where they live

| Piece | Status | Files | Next step |
|---|---|---|---|
| Explore map (home) | Works with example data | `web/index.html`, `web/explore.js`, `web/styles.css` | Polish; touch layout |
| Patch view (time-lapse) | Works with real SPHEREx data, old styling | `web/timelapse.html`, `web/live/` | Restyle to match `design/screens/patch.html`: side by side, blink, remove still stars |
| Comet page + tagged comments | Static design only | `web/comet.html` | Load a comet from `/api/comets/:id`; post comments |
| Guide + practice patch | Static design only | `web/guide.html` | Use IRSA's real 3I/ATLAS images as the practice patch |
| API | Images and Gaia real; comets and explored are example data | `worker/src/` | D1 tables for comets, dots, comments, explored; Turnstile on posts |
| Known objects | Not started | | `/api/known` from IMCCE SkyBoT |
| Dot finder | Not started | | Blink new photo pairs, save moving dots as candidates (nightly) |
| Data prep | Works | `bake/` | Rebuild the coverage map when the full coverage list lands |
| Pitch and demo | Not started | `docs/prior-art.md`, `docs/architecture.html` | Story: SPHEREx gives every find a spectrum |

The design reference for every screen is `design/screens/` (open the HTML files, or the PNGs in `design/screens/shots/`). Keep the look: glass panels, few words, icons and numbers over labels, lots of space. Colors mean one thing each: orange comets and selection, blue known objects, mint explored by people.

## How we work

- Branch off `main`, one branch per piece, small pull requests.
- Run `npm run dev` and `npm test` before opening a pull request. If you touched `web/live/` or `bake/`, also open `/tests/golden.html` and `/tests/live.html` and run `python3 bake/verify.py`.
- Keep API response shapes as written in `docs/api.md`; change the doc in the same pull request if a shape must change.
- No keys or tokens in the repo. Cloudflare secrets go in `wrangler secret`, local ones in `worker/.dev.vars` (ignored by git).
