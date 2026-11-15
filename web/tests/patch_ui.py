"""Browser check for the patch viewer's baked targets and Ming's four toggles, in headless Chrome. Needs the app up.
Each ?target= shows the band (#det) it was baked in, and each toggle (Spectral, Heat, Hide Stationary, Color Difference)
changes the picture on its own and all together, then turning it off brings the picture back.
Run: uv run -q --with playwright python web/tests/patch_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, pathlib, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DATA = pathlib.Path(__file__).resolve().parent.parent / "data" / "flip"
TARGETS = ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]
TOGGLES = {"ly-spec": "Spectral", "ly-heat": "Heat", "still": "Hide Stationary", "diff": "Color Difference"}
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page()
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        ready = "+document.getElementById('play')?.getAttribute('aria-valuemax') > 0"

        for key in TARGETS:
            want = json.loads((DATA / key / "manifest.json").read_text())["detector"]
            await pg.goto(f"{BASE}/timelapse.html?target={key}"); await pg.wait_for_function(ready)
            got = await pg.eval_on_selector("#det", "e => e.value")
            assert got == want, f"{key}: the Band box says {got}, the target is {want}"
        print(f"PASS bands: each of the {len(TARGETS)} targets shows the band it was baked in")

        await pg.goto(f"{BASE}/timelapse.html?target=barnard"); await pg.wait_for_function(ready)
        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(200)   # the last visit: Color Difference needs one after the first
        base = await pg.evaluate(PIXELS)
        for tid, name in TOGGLES.items():
            await pg.click(f"label:has(#{tid})"); await pg.wait_for_timeout(150)
            on = await pg.evaluate(PIXELS)
            await pg.click(f"label:has(#{tid})"); await pg.wait_for_timeout(150)
            off = await pg.evaluate(PIXELS)
            assert on != base, f"{name} does not change the picture"
            assert off == base, f"turning {name} off does not bring the picture back"
        for tid in TOGGLES: await pg.click(f"label:has(#{tid})")
        await pg.wait_for_timeout(200)
        assert await pg.evaluate(PIXELS) != base, "all four toggles together leave the picture unchanged"
        assert not errors, f"page errors: {errors}"
        await b.close()
    print("PASS toggles: Spectral, Heat, Hide Stationary and Color Difference each change the picture, alone and together, and undo cleanly")

asyncio.run(main())
