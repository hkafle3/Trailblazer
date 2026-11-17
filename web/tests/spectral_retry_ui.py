"""Browser check: a Spectral layer whose build failed (the image search answered 503) is tried again when the layers
change. Needs the app up (npm run dev) and the network, like spectral_ui.py.
Run: uv run -q --with playwright python web/tests/spectral_retry_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
BLUE, RED = 8, 76   # 0-based channels 9 (D1) and 77 (D5), as in spectral_ui.py


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
        fail = {"left": 1, "seen": 0}   # the first D5 image search fails, as IRSA does on a bad day

        async def images(route):
            if "det=D5" in route.request.url and fail["left"]:
                fail["left"] -= 1; fail["seen"] += 1
                return await route.fulfill(status=503, content_type="application/json", body='{"error":"IRSA is not answering"}')
            await route.continue_()
        await ctx.route("**/api/images?*", images)   # the layer's build runs in a worker; its requests come through here too
        pg = await ctx.new_page()
        await pg.goto(f"{BASE}/timelapse.html?ra=77&dec=30.4&det=D1&ch={BLUE + 1}&layers={BLUE + 1},{RED + 1}")
        await pg.wait_for_function("__lapse.state.m?.channel === %d && !document.body.classList.contains('busy')" % BLUE, timeout=240000)
        await pg.wait_for_function("/No data here for channel %d/.test(document.getElementById('status').textContent)" % (RED + 1), timeout=240000)
        assert fail["seen"] == 1 and await pg.evaluate("__lapse.state.comp") is None, "the failed layer was not the one refused"

        # turning the failed layer off and on again builds it this time
        await pg.evaluate("__spectral.toggle(%d, false); __spectral.toggle(%d, true)" % (RED, RED))
        await pg.wait_for_function("__lapse.state.comp?.layers.length === 2", timeout=240000)
        print("PASS spectral retry: a layer whose image search failed is built when the layers change")
        await b.close()

asyncio.run(main())
