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
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
        pg = await ctx.new_page()
        await pg.goto(f"{BASE}/timelapse.html?ra=77.3058&dec=27.3551&det=D1")
        await pg.wait_for_function("/visits, built/.test(document.getElementById('status')?.textContent||'')", timeout=180000)
        # the timeline is one slider (Ming's design): step through the visits with the keyboard until Sep 2026 is on screen
        await pg.wait_for_function("+document.getElementById('play').getAttribute('aria-valuemax') > 0")   # the timeline is built
        knob = pg.locator("#play"); await knob.focus(); await knob.press("Home")
        n = int(await knob.get_attribute("aria-valuemax"))
        for _ in range(n + 1):
            if "Sep 2026" in (await knob.get_attribute("aria-valuetext") or ""): break
            await knob.press("ArrowRight")
        assert "Sep 2026" in (await knob.get_attribute("aria-valuetext") or ""), "no Sep 2026 visit"
        await pg.wait_for_function("(t => /C\\/2025 R2/.test(t) || (t && !/checking/i.test(t)))(document.getElementById('vKnown').textContent)", timeout=180000)   # the comet, or every time answered
        rows = await pg.eval_on_selector_all("#vKnown .known-row:not(.faint)", "rs => rs.map(r => [r.querySelector('.nm').textContent, r.querySelector('.dt').textContent])")
        assert ["C/2025 R2", "comet · 2 Sep"] in rows, f"panel lists: {rows}"
        # each row reads cleanly: the name on one line, the details on the next, nothing wrapped mid-phrase
        lines = await pg.eval_on_selector_all("#vKnown .known-row:not(.faint) :is(.nm, .dt)", "es => es.map(e => e.getClientRects().length === 1 && e.offsetHeight < 2 * parseFloat(getComputedStyle(e).lineHeight))")
        assert all(lines), "a known-list row wraps"
        # names on the photo never cover the target's rings or each other
        lab = await pg.evaluate("window.__labels")
        over = lambda a, b: a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]
        assert lab and lab["names"], "no names drawn on the photo"
        assert not any(over(n, r) for n in lab["names"] for r in lab["rings"]), f"a name covers a ring: {lab}"
        assert not any(over(a, b) for i, a in enumerate(lab["names"]) for b in lab["names"][i + 1:]), f"two names overlap: {lab}"
        await b.close()
    print("PASS known objects: the Sep 2026 visit lists C/2025 R2 on 2 Sep, rows on two clean lines, names clear of the rings and each other")

asyncio.run(main())
