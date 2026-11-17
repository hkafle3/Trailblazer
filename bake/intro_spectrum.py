"""Measure, with the app's own code in a browser, the light of two things in the 3D intro's photo in SPHEREx's colors:
the star the film follows (web/live/spectrum.js, 102 colors) -> bake/cache/intro/star_spectrum.json, and the galaxy
(the same, -> galaxy_spectrum.json; and every exposure of detector 4 that saw it between 2.9 and 3.84 microns, measured
with web/live/cutout.js starLight -> galaxy_fine.json). bake/intro_photo.py puts them into web/data/intro/photo.json.
Needs the app up (npm run dev) and the network (the image search and NASA's S3 copy of SPHEREx); about five minutes.
Run: uv run -q --with playwright python bake/intro_spectrum.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
STAR = 160.48719442815, 30.72595118702   # Gaia DR3 735835070124268800, G 12.8: the STAR of bake/intro_photo.py
GALAXY = 160.54585, 30.7986              # 2MASX J10421099+3047551, as the 2MASS Redshift Survey places it
OUT = Path(__file__).resolve().parent / "cache/intro"
SPECTRUM = """async ([ra, dec]) => { const { spectrum } = await import('/live/spectrum.js'); const maps = await (await fetch('/data/wavemaps.json')).json(); return await spectrum(ra, dec, { maps }); }"""
FINE = """async ([ra, dec]) => {
  const { imageHeader, worldToPix, wavelengthAt } = await import('/live/fits.js'); const { pool, starLight } = await import('/live/cutout.js'); const { MJY } = await import('/live/spectrum.js');
  const maps = await (await fetch('/data/wavemaps.json')).json(), list = (await (await fetch(`/api/images?ra=${ra}&dec=${dec}&det=D4&v=2`)).json()).images, points = [];
  await pool(list, 8, async e => { const h = await imageHeader(e.key), p = worldToPix(h, ra, dec); if (!(p[0] >= 16 && p[1] >= 16 && p[0] <= 2023 && p[1] <= 2023)) return;
    const [lam, bw] = wavelengthAt(maps.D4, p[0], p[1]); if (lam < 2.9 || lam > 3.84) return; const m = await starLight({ ...e, h, det: 'D4' }, ra, dec);
    points.push({ lam, bw, obs: e.obs, t: e.t, gap: m.gap || null, flux: m.gap ? null : m.flux * MJY, err: m.gap ? null : m.noise * MJY, doubt: m.doubt || null }); });
  return { covering: list.length, points: points.sort((a, b) => a.lam - b.lam) }; }"""


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome")
        pg = await b.new_page()
        await pg.goto(BASE + "/tests/live.html", wait_until="domcontentloaded")
        for name, code, at in (("star_spectrum", SPECTRUM, STAR), ("galaxy_spectrum", SPECTRUM, GALAXY), ("galaxy_fine", FINE, GALAXY)):
            res = await pg.evaluate(code, list(at)); (OUT / f"{name}.json").write_text(json.dumps(res))
            print(f"{name}: {len(res['points'])} points from {res['covering']} exposures")
        await b.close()

asyncio.run(main())
