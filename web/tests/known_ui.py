"""Browser check for known comets and asteroids on the time-lapse (GET /api/known, SkyBoT). Needs the app up and the
network (IRSA and SkyBoT); takes a minute or two. Run: uv run -q --with playwright python web/tests/known_ui.py [base url]
C/2025 R2 (SWAN) is in SPHEREx photos of RA 77.3058 Dec 27.3551 on 2 Sep 2026: the Sep 2026 visit must list it and
circle it near the centre."""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page()
        await pg.goto(f"{BASE}/timelapse.html?ra=77.3058&dec=27.3551&det=D1")
        await pg.wait_for_function("/visits, built/.test(document.getElementById('status')?.textContent||'')", timeout=180000)
        n = await pg.evaluate("[...document.querySelectorAll('.tick')].findIndex(t => /Sep 2026/.test(t.getAttribute('aria-label') || ''))")
        assert n >= 0, "no Sep 2026 visit"
        await pg.locator(".tick").nth(n).click()
        await pg.wait_for_function("(t => t && !/Checking/.test(t))(document.getElementById('vKnown').textContent)", timeout=180000)
        text = await pg.evaluate("document.getElementById('vKnown').textContent")
        assert "C/2025 R2 · comet · 2 Sep" in text, f"panel says: {text}"
        await b.close()
    print("PASS known objects: the Sep 2026 visit lists C/2025 R2 on 2 Sep")

asyncio.run(main())
