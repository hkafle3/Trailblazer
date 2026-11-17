"""Measure the spectrum of the star the 3D intro follows, with the app's own web/live/spectrum.js in a browser
-> bake/cache/intro/star_spectrum.json (bake/intro_photo.py puts it into web/data/intro/photo.json).
Needs the app up (npm run dev) and the network (the image search and NASA's S3 copy of SPHEREx); about two minutes.
Run: uv run -q --with playwright python bake/intro_spectrum.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
RA, DEC = 160.48719442815, 30.72595118702   # Gaia DR3 735835070124268800, G 12.8: the STAR of bake/intro_photo.py
OUT = Path(__file__).resolve().parent / "cache/intro/star_spectrum.json"


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome")
        pg = await b.new_page()
        await pg.goto(BASE + "/tests/live.html", wait_until="domcontentloaded")
        res = await pg.evaluate("""async ([ra, dec]) => {
          const { spectrum } = await import('/live/spectrum.js'); const maps = await (await fetch('/data/wavemaps.json')).json();
          return await spectrum(ra, dec, { maps }); }""", [RA, DEC])
        await b.close()
    OUT.parent.mkdir(parents=True, exist_ok=True); OUT.write_text(json.dumps(res))
    print(f"{len(res['points'])} points, {len(res['gaps'])} gaps, from {res['covering']} exposures -> {OUT}")

asyncio.run(main())
