"""Browser check: when a known comet's live photos cannot be fetched (NASA's S3 copy of SPHEREx refuses every request),
the photo strip says they could not be measured, never that the comet was too faint. Needs the app up (npm run dev).
Run: uv run -q --with playwright python web/tests/known_photos_fail_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
J3 = "C/2024 J3 (ATLAS)"   # as in known_photos_ui.py: live photos, four visits


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        await ctx.route("https://nasa-irsa-spherex.s3.amazonaws.com/**", lambda r: r.abort())
        pg = await ctx.new_page()
        await pg.goto(f"{BASE}/comet.html?id=" + urllib.parse.quote(J3, safe=""))
        await pg.wait_for_selector("#c-photos-panel:not([hidden])")
        await pg.locator("#c-photos-panel").scroll_into_view_if_needed()
        note = "document.querySelector('#c-photos-panel .frames-note')?.textContent ?? 'Building'"
        await pg.wait_for_function(f"!/Building|Built/.test({note})", timeout=240000)
        text = await pg.evaluate(note)
        verdicts = await pg.eval_on_selector_all("#c-photos figure", "fs => fs.map(f => f.dataset.verdict)")
        assert verdicts and "faint" not in verdicts and "seen" not in verdicts, f"photos were measured with S3 refused: {verdicts}"
        assert text == "These photos could not be measured.", f"summary with no photo measured: {text!r}"
        print(f"PASS known photos offline: {len(verdicts)} photos unavailable, and the summary says they could not be measured")
        await b.close()

asyncio.run(main())
