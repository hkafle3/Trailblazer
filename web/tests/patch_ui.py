"""Browser check for the patch viewer's baked targets and Ming's four toggles, in headless Chrome. Needs the app up.
Each ?target= shows the band (#det) it was baked in, and each toggle (Spectral, Heat, Hide Stationary, Color Difference)
changes the picture on its own and all together, then turning it off brings the picture back. Also: the status line is
seen in sky mode, a discovery is dropped when the coordinates change, the play handle answers a plain click (screen
readers) once and ignores the click after a press or a drag, and the cards fit (no hidden scrolling in Descriptions,
nothing over the photo or the timeline) at 1440x900 and 1280x720.
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
        # Color Difference's colour key shows only while it is on
        assert await pg.is_hidden("#diffkey"), "the colour key shows with Color Difference off"
        await pg.click("label:has(#diff)"); await pg.wait_for_timeout(100)
        assert await pg.is_visible("#diffkey") and "brighter" in await pg.text_content("#diffkey"), "the colour key is missing with Color Difference on"
        await pg.click("label:has(#diff)"); await pg.wait_for_timeout(100)
        assert await pg.is_hidden("#diffkey"), "the colour key stays after Color Difference is turned off"
        print("PASS colour key: shown only while Color Difference is on")
        for tid in TOGGLES: await pg.click(f"label:has(#{tid})")
        await pg.wait_for_timeout(200)
        assert await pg.evaluate(PIXELS) != base, "all four toggles together leave the picture unchanged"

        # the play handle: a click with no pointer before it (assistive technology) toggles; a mouse press toggles once
        playing = "document.getElementById('play').classList.contains('on')"
        await pg.evaluate("document.getElementById('play').click()"); assert await pg.evaluate(playing), "a plain click does not play"
        await pg.evaluate("document.getElementById('play').click()"); assert not await pg.evaluate(playing), "a plain click does not pause"
        kb = await pg.locator("#play").bounding_box(); cx, cy = kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2
        await pg.mouse.click(cx, cy); await pg.wait_for_timeout(100); assert await pg.evaluate(playing), "a mouse click does not play (or toggled twice)"
        await pg.mouse.click(cx, cy); await pg.wait_for_timeout(100); assert not await pg.evaluate(playing), "a mouse click does not pause (or toggled twice)"
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx - 120, cy, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(100)
        assert not await pg.evaluate(playing), "a drag on the handle started playing"
        print("PASS play handle: plain clicks and mouse clicks toggle once each, a drag does not")

        # the cards fit: Descriptions shows everything without scrolling, and no card sits on the photo or the timeline
        FIT = """() => { const r = s => document.querySelector(s).getBoundingClientRect(), hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            const d = document.querySelector('.pv-desc .pv-scroll'), bad = [];
            if (d.scrollHeight > d.clientHeight + 2) bad.push('Descriptions scrolls');
            for (const c of ['.pv-options', '.pv-layers', '.pv-others', '.pv-found', '.pv-desc', '.pv-state', '.pv-mini'])
              for (const o of ['.pv-frame', '.tl-line', '.tl-date']) if (hit(r(c), r(o))) bad.push(c + ' over ' + o);
            const f = document.querySelector('.pv-found .pv-scroll');
            if (f.scrollHeight > f.clientHeight + 2 && !f.classList.contains('more')) bad.push('Findings has more below, unmarked');
            return bad; }"""
        for w, h in [(1440, 900), (1280, 720)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            bad = await pg.evaluate(FIT); assert not bad, f"{w}x{h}: {bad}"
        await pg.set_viewport_size({"width": 1440, "height": 900})
        print("PASS cards: Descriptions fits without scrolling and no card covers the photo or the timeline at 1440x900 and 1280x720")

        # sky mode (no spot yet): a bad position is said beside the search, in the live region
        await pg.goto(f"{BASE}/timelapse.html"); await pg.wait_for_function("document.body.classList.contains('sky')")
        await pg.fill("#coords", "not a place"); await pg.press("#coords", "Enter")
        st = pg.locator("#status[role=status]")
        assert await st.is_visible() and "Type RA and Dec" in await st.text_content(), "sky mode: the status line is not seen"
        assert await pg.is_hidden(".pv-found"), "an empty Findings card shows before any patch"
        print("PASS status: in sky mode a bad position is said beside the search")

        # a discovery belongs to its spot: other coordinates drop it from the label, the link and the address together
        await pg.goto(f"{BASE}/timelapse.html?ra=77.3058&dec=27.3551&det=D1&diff=1&found=C-0147")
        await pg.wait_for_function(ready, timeout=180000)
        assert (await pg.text_content("#state-label")) == "Discovered" and await pg.get_attribute("#state", "href") == "comet.html?id=C-0147" and "found=C-0147" in pg.url, "Discovered not shown"
        # a Findings list longer than its card is a named region the keyboard can reach, with a white outline
        knob = pg.locator("#play"); await knob.focus(); await knob.press("End")
        await pg.wait_for_function("(t => t && !/checking/i.test(t))(document.getElementById('vKnown')?.textContent)", timeout=180000)
        sc = await pg.evaluate("(e => [e.scrollHeight > e.clientHeight + 2, e.tabIndex, e.getAttribute('role'), e.getAttribute('aria-label')])(document.querySelector('.pv-found .pv-scroll'))")
        if sc[0]:
            assert sc[1:] == [0, "region", "Findings"], f"the scrolling Findings list is not a reachable region: {sc}"
            await pg.focus("#det"); await pg.keyboard.press("Tab")
            got = await pg.evaluate("(e => [e.matches('.pv-found .pv-scroll'), getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineColor])(document.activeElement)")
            assert got == [True, "solid", "rgb(255, 255, 255)"], f"Tab after Band does not land on Findings with a white outline: {got}"
            print("PASS findings: the long list is a Findings region, next after Band on Tab, with a white outline")
        else: print("NOTE findings: this visit's list fits, so the scroll region was not exercised")
        await pg.select_option("#det", "D2"); await pg.wait_for_timeout(300)   # another band at the same spot keeps it
        assert (await pg.text_content("#state-label")) == "Discovered", "a band change dropped the discovery"
        await pg.fill("#coords", "269.4463 4.7671"); await pg.press("#coords", "Enter"); await pg.wait_for_timeout(300)
        assert (await pg.text_content("#state-label")) == "Undiscovered" and await pg.get_attribute("#state", "href") == "forums.html", "new coordinates still say Discovered"
        assert "found=" not in pg.url and await pg.is_hidden("#vName"), f"new coordinates keep the discovery: {pg.url}"
        print("PASS discovery: kept for a band change, dropped from the label, link, Found as line and address at new coordinates")

        # phones: Tab follows the one column from top to bottom (the markup is in that order)
        await pg.set_viewport_size({"width": 390, "height": 844})
        await pg.goto(f"{BASE}/timelapse.html?target=barnard"); await pg.wait_for_function(ready)
        await pg.focus("#play"); order = ["play"]
        for _ in range(12):
            await pg.keyboard.press("Tab"); order.append(await pg.evaluate("document.activeElement.id || document.activeElement.className"))
        want = ["play", "state", "coords", "det", "fov", "ly-spec", "ly-heat", "still", "diff"]
        seen = [x for x in order if x in want]
        assert seen[:len(want)] == want, f"Tab order on a phone: {order}"
        print("PASS phone tab order: timeline, Discovered, Coordinates, Band, Zoom, then the four toggles, as they appear")

        # month names on the timeline never touch, from a narrow phone to a desktop
        TOUCH = """() => { const r = [...document.querySelectorAll('.tl-tick:not(.quiet) b')].map(b => b.getBoundingClientRect()).sort((a, b) => a.left - b.left), bad = [];
            for (let i = 1; i < r.length; i++) if (r[i].left < r[i - 1].right + 2) bad.push(Math.round(r[i - 1].right - r[i].left)); return [r.length, bad]; }"""
        for w, h in [(320, 700), (390, 844), (768, 1024), (1440, 900)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            n, bad = await pg.evaluate(TOUCH)
            assert n >= 4 and not bad, f"{w} px: {n} month names, overlaps {bad}"
        print("PASS timeline labels: month names thin out and never touch at 320, 390, 768 and 1440 px")

        # the photo's legend, Color Difference's key row included, sits wholly inside the frame
        await pg.click("label:has(#diff)")
        INSIDE = """() => { const f = document.querySelector('.pv-frame').getBoundingClientRect(), bad = [];
            for (const s of document.querySelectorAll('#legend span')) { const r = s.getBoundingClientRect();
              if (r.left < f.left || r.right > f.right || r.top < f.top || r.bottom > f.bottom) bad.push(s.textContent);
              if (s.getClientRects().length > 1 || r.height > 1.6 * parseFloat(getComputedStyle(s).fontSize)) bad.push(s.textContent + ' wraps'); }
            return [document.querySelectorAll('#legend span').length, bad]; }"""
        for w, h in [(320, 700), (390, 844), (1440, 900)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            n, bad = await pg.evaluate(INSIDE)
            assert n == 6 and not bad, f"{w} px legend: {bad}"
        await pg.click("label:has(#diff)")
        print("PASS legend: all six items, the colour key too, sit whole inside the photo frame at 320, 390 and 1440 px")

        assert not errors, f"page errors: {errors}"
        await b.close()
    print("PASS toggles: Spectral, Heat, Hide Stationary and Color Difference each change the picture, alone and together, and undo cleanly")

asyncio.run(main())
