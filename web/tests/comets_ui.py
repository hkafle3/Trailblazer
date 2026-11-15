"""Browser check for the Comets list and the sky's hover names, in headless Chrome. Needs the app up (npm run dev).
Run: uv run -q --with playwright python web/tests/comets_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
EXPECT = {"3I/ATLAS": "CO2 glow detected", "C/2025 R2 (SWAN)": "CO2 glow detected",
          "C/2024 T5 (ATLAS)": "Not enough signal", "210P/Christensen": "Not enough signal",
          "C/2026 A2 (Bok)": "CO2 glow detected", "P/2021 N1 (ZTF)": "Not enough signal",
          "C/2024 G3 (ATLAS)": "Not enough signal",
          "C/2023 A3 (Tsuchinshan-ATLAS)": "Not enough signal",
          "C/2023 R1 (PANSTARRS)": "Not enough signal"}   # migration 0012


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
        pg = await ctx.new_page()

        # the list: 72 rows, the measured CO2 results, every other comet unmeasured, links to each comet's own page
        await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector(".crow")
        rows = await pg.eval_on_selector_all(".crow", "rs => rs.map(r => [r.querySelector('b').textContent, r.querySelector('.co2').textContent, r.getAttribute('href')])")
        assert len(rows) == 72, f"{len(rows)} rows, expected 72"
        got = {n: c for n, c, _ in rows}
        assert {n: got.get(n) for n in EXPECT} == EXPECT, f"CO2 results {[(n, got.get(n)) for n in EXPECT]}"
        assert all(c == "Not measured yet" for n, c in got.items() if n not in EXPECT), "an unmeasured comet shows a result"
        assert all(h.startswith("comet.html?id=") and urllib.parse.unquote(h[14:]) == n for n, _, h in rows), "a row links to the wrong page"

        # a row opens that comet's page, which still shows one comet
        await pg.click('.crow:has-text("C/2025 R2 (SWAN)")'); await pg.wait_for_function("document.getElementById('c-id').textContent === 'C/2025 R2 (SWAN)'")
        assert await pg.is_hidden("#c-list") and await pg.is_visible(".comet-grid"), "comet page shows the list"

        # the sky: a known comet's name is hidden until the pointer is on it (or it has keyboard focus)
        await pg.goto(BASE + "/explore.html"); await pg.wait_for_selector(".mk.peek:not([hidden])", state="attached")
        mk = pg.locator(".mk.peek:not([hidden])").first
        assert not await mk.locator("b").is_visible(), "name shows before hover"
        await mk.locator("i").hover(); await pg.wait_for_timeout(300)
        assert await mk.locator("b").is_visible(), "name hidden on hover"
        await pg.mouse.move(5, 450); await pg.wait_for_timeout(300)
        assert not await mk.locator("b").is_visible(), "name stays after the pointer leaves"
        await pg.keyboard.press("Shift"); await mk.focus(); await pg.wait_for_timeout(200)   # focus after a key press counts as keyboard focus
        assert await mk.locator("b").is_visible(), "name hidden on keyboard focus"
        await b.close()
    print("PASS Comets list: 72 rows, CO2 results, links open each comet; sky names show on hover")

asyncio.run(main())
