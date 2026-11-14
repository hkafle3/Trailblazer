# Comet Hunt

A public web tool for NASA Space Apps 2026 ("Planet X and SPHEREx"). People explore the sky in real SPHEREx infrared images, spot dots that move between photos, tag them as comets, asteroids or glitches, and discuss each one. Working name.

## What is in here

| Folder | What it holds |
|---|---|
| `web/` | The app. Plain HTML and JavaScript, no build step. `timelapse.html` is the sky map and time-lapse; `sky.js` is the shared 3D sky; `live/` reads SPHEREx photos in the browser; `tests/` checks the math. |
| `worker/` | The Cloudflare Worker API: finds which SPHEREx photos cover a spot (`/api/images`) and looks up Gaia star motions (`/api/gaia`). |
| `bake/` | Python scripts that prepare data: pre-built time-lapses for five test targets, the coverage map, the all-sky picture, and the science checks. |
| `design/` | Mockups and the briefs that produced them. |
| `docs/` | The architecture page and the live-search plan. |

How the pieces connect, and what is still to build on Cloudflare (D1, R2, Turnstile, a nightly dot finder): open `docs/architecture.html`.

## Run it locally

```bash
python3 -m http.server 8780 --directory web
```

```bash
cd worker && npx wrangler@4.162.0 dev --port 8787
```

Then open http://localhost:8780/timelapse.html. The page calls the API at http://127.0.0.1:8787 by default; pass `?api=<url>` to use another.

## Checks

- `python3 bake/verify.py`: measured star motions against Gaia and published values.
- `web/tests/golden.html`: browser astronomy math against astropy.
- `web/tests/live.html`: live search against the pre-built targets.
- `worker/test_contract.sh`: the API's requests and refusals.

## Rebuilding data

Downloaded photo cutouts (`bake/cache/`) and the raw coverage list (`bake/coverage/`) are not in git. `bake/coverage.py` rebuilds the coverage list in about 90 minutes; `bake/sky_assets.py` turns it into `web/data/coverage.png`.

Data: SPHEREx from NASA/IPAC IRSA. Star motions from ESA Gaia.
