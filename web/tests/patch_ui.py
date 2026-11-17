"""Browser check for the patch viewer's baked targets and Ming's three picture toggles and the Spectral dial, in headless Chrome. Needs the app up.
Each ?target= shows the band (#det) it was baked in, and each toggle (Heat, Hide Stationary, Color Difference)
changes the picture on its own and all together, then turning it off brings the picture back. Also: the status line is
seen in sky mode, a discovery is dropped when the coordinates change, the play handle answers a plain click (screen
readers) once and ignores the click after a press or a drag, and the cards fit (no hidden scrolling in Descriptions,
nothing over the photo or the timeline) at 1440x900 and 1280x720.
Run: uv run -q --with playwright python web/tests/patch_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, pathlib, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DATA = pathlib.Path(__file__).resolve().parent.parent / "data" / "flip"
TARGETS = ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]
TOGGLES = {"ly-heat": "Heat", "still": "Hide Stationary", "diff": "Color Difference"}
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
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
            await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(150)
            on = await pg.evaluate(PIXELS)
            await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(150)
            off = await pg.evaluate(PIXELS)
            assert on != base, f"{name} does not change the picture"
            assert off == base, f"turning {name} off does not bring the picture back"
        # Color Difference's colour key shows only while it is on
        assert await pg.is_hidden("#diffkey"), "the colour key shows with Color Difference off"
        await pg.click("label[for=diff]"); await pg.wait_for_timeout(100)
        assert await pg.is_visible("#diffkey") and "brighter" in await pg.text_content("#diffkey"), "the colour key is missing with Color Difference on"
        await pg.click("label[for=diff]"); await pg.wait_for_timeout(100)
        assert await pg.is_hidden("#diffkey"), "the colour key stays after Color Difference is turned off"
        print("PASS colour key: shown only while Color Difference is on")
        for tid in TOGGLES: await pg.click(f"label[for={tid}]")
        await pg.wait_for_timeout(200)
        assert await pg.evaluate(PIXELS) != base, "all the toggles together leave the picture unchanged"

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

        # the cards fit (the redesign's columns): nothing in Advanced, the name and verdict or Report sits on the photo or the
        # timeline; Advanced ends on screen, and when its controls run past its foot it is marked as having more below
        FIT = """() => { const r = s => document.querySelector(s).getBoundingClientRect(), hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            const d = document.getElementById('adv-body'), bad = [];
            for (const c of ['.pv-adv', '.pv-who', '.pv-report', '#adv-body', '.pv-mini'])
              for (const o of ['.pv-frame', '.tl-line', '.tl-date']) if (hit(r(c), r(o))) bad.push(c + ' over ' + o);
            if (r('.pv-adv').bottom > innerHeight + 1) bad.push('Advanced runs off the screen');
            if (r('.pv-who').bottom > r('.pv-report').top + 1) bad.push('the verdict runs into Report');
            if (d.scrollHeight > d.clientHeight + 2 && d.scrollTop + d.clientHeight < d.scrollHeight - 2 && !d.classList.contains('more')) bad.push('Advanced has more below, unmarked');
            return bad; }"""
        for w, h in [(1440, 900), (1280, 720)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            bad = await pg.evaluate(FIT); assert not bad, f"{w}x{h}: {bad}"
        await pg.set_viewport_size({"width": 1440, "height": 900})
        print("PASS cards: Advanced, the name and verdict and Report stay off the photo and the timeline, Advanced ends on screen and marks more below, at 1440x900 and 1280x720")

        # sky mode (no spot yet): a bad position is said beside the search, in the live region
        await pg.goto(f"{BASE}/timelapse.html"); await pg.wait_for_function("document.body.classList.contains('sky')")
        await pg.fill("#coords", "not a place"); await pg.press("#coords", "Enter")
        st = pg.locator("#status[role=status]")
        assert await st.is_visible() and "Type RA and Dec" in await st.text_content(), "sky mode: the status line is not seen"
        print("PASS status: in sky mode a bad position is said beside the search")

        # a discovery belongs to its spot: other coordinates drop it from the label, the link and the address together.
        # found=TEST-1 is a made-up id, as in recenter_ui.py: a real candidate's Discovered state follows its own visit
        # (discuss.js, checked by discuss_ui.py), while this checks the address-level label alone
        await pg.goto(f"{BASE}/timelapse.html?ra=77.3058&dec=27.3551&det=D1&diff=1&found=TEST-1")
        await pg.wait_for_function(ready, timeout=180000)
        assert (await pg.text_content("#state-label")) == "Discovered" and await pg.get_attribute("#state", "href") == "comet.html?id=TEST-1" and "found=TEST-1" in pg.url, "Discovered not shown"
        await pg.select_option("#det", "D2"); await pg.wait_for_timeout(300)   # another band at the same spot keeps it
        assert (await pg.text_content("#state-label")) == "Discovered", "a band change dropped the discovery"
        await pg.fill("#coords", "269.4463 4.7671"); await pg.press("#coords", "Enter"); await pg.wait_for_timeout(300)
        assert (await pg.text_content("#state-label")) == "Report a new find" and await pg.get_attribute("#state", "href") == "forums.html", "new coordinates still say Discovered"
        assert "found=" not in pg.url and await pg.is_hidden("#vName"), f"new coordinates keep the discovery: {pg.url}"
        print("PASS discovery: kept for a band change, dropped from the label, link, Found as line and address at new coordinates")

        # what the patch shows (in Descriptions), made to overflow: /api/known answers with a dozen asteroids at the patch centre for every time asked
        async def many(route):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query); ra, dec = float(q["ra"][0]), float(q["dec"][0])
            await route.fulfill(json={"comets": [], "asteroids": [{"name": f"2026 TEST{n}", "ra": ra + n * 1e-4, "dec": dec, "mag": 19.5} for n in range(12)]})
        FOUND = "(e => [e.scrollHeight > e.clientHeight + 2, e.getAttribute('tabindex'), e.getAttribute('role'), e.getAttribute('aria-label')])(document.querySelector('.pv-desc .pv-scroll'))"
        listed = "document.querySelectorAll('#vKnown .known-row:not(.faint)').length >= 12"
        await pg.route("**/api/known**", many)
        await pg.goto(f"{BASE}/timelapse.html?target=barnard"); await pg.wait_for_function(ready); await pg.wait_for_function(listed)
        await pg.wait_for_timeout(200)
        sc = await pg.evaluate(FOUND)
        assert sc == [True, "0", "region", "Descriptions"], f"the overflowing Findings list is not a reachable region: {sc}"
        assert await pg.evaluate("getComputedStyle(document.querySelector('.pv-desc .pv-scroll')).maskImage") != "none", "no fade shows there is more below"
        await pg.focus("#coords"); await pg.keyboard.press("Shift+Tab")
        got = await pg.evaluate("(e => [e.matches('.pv-desc .pv-scroll'), getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineColor, getComputedStyle(e).maskImage])(document.activeElement)")
        assert got == [True, "solid", "rgb(255, 255, 255)", "none"], f"Shift+Tab from Coordinates does not land on Descriptions with a white outline and no fade: {got}"
        await pg.set_viewport_size({"width": 390, "height": 844}); await pg.wait_for_timeout(300)   # phones: the card grows, nothing scrolls
        sc = await pg.evaluate(FOUND)
        assert sc[0] is False and sc[1] is None, f"on a phone the Findings list is still a Tab stop: {sc}"
        await pg.set_viewport_size({"width": 1440, "height": 900})
        await pg.unroute("**/api/known**", many)
        print("PASS findings: an overflowing Descriptions card is a region reached by Tab (just before Coordinates), white outline, no fade while focused; no Tab stop on a phone")

        # Color Difference explains its colours to screen readers (the legend's key is decorative)
        d = await pg.evaluate("""(() => { const c = document.getElementById('diff'), t = document.getElementById(c.getAttribute('aria-describedby'));
            return t && !t.closest('[aria-hidden=true]') ? t.textContent : null; })()""")
        assert d and "Orange: brighter" in d and "Blue: dimmer" in d, f"Color Difference has no accessible description: {d}"
        await pg.click("label[for=diff]"); await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(200)
        assert "orange brighter, blue dimmer" in await pg.get_attribute("#patch", "aria-label"), "the photo's description does not explain the colours"
        await pg.click("label[for=diff]")
        print("PASS colour key, spoken: Color Difference is described as orange brighter, blue dimmer, and so is the photo while it is on")

        # phones (the redesign's one column): Tab goes the timeline, Advanced and its controls (open), then Report and Copy link;
        # shut, Advanced's controls are skipped
        await pg.set_viewport_size({"width": 390, "height": 844})
        await pg.goto(f"{BASE}/timelapse.html?target=barnard"); await pg.wait_for_function(ready)
        async def tab_order(n=14):
            await pg.focus("#play"); order = ["play"]
            for _ in range(n):
                await pg.keyboard.press("Tab"); order.append(await pg.evaluate("document.activeElement.id || document.activeElement.className"))
            return order
        # a region that scrolls is itself a Tab stop by design (timelapse.html moreBelow); whether it scrolls depends on the
        # spot's data, so that stop is not part of the order checked here
        order = [x for x in await tab_order() if "pv-scroll" not in x]
        want = ["play", "adv-btn", "sp-dial", "sp-on", "still", "diff", "ly-heat", "split", "fov", "coords", "det", "state", "share"]
        assert order[:len(want)] == want, f"Tab order on a phone, Advanced open: {order}"
        await pg.click("#adv-btn")
        order = [x for x in await tab_order(4) if "pv-scroll" not in x]
        assert order[:4] == ["play", "adv-btn", "state", "share"], f"Tab order on a phone, Advanced shut: {order}"
        await pg.click("#adv-btn")
        print("PASS phone tab order: timeline, Advanced and its controls (the dial and its box; the filters; Zoom; Coordinates and Band), Report, Copy link; shut, the controls are skipped")

        # the left cards shrink with the screen: every control inside them stays on screen, down to 320 px
        for w in (320, 390):
            await pg.set_viewport_size({"width": w, "height": 844}); await pg.wait_for_timeout(300)
            out = await pg.evaluate("[...document.querySelectorAll('#adv-body input, #adv-body select, #adv-body label, #adv-body svg, #adv-body canvas')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.left < 0 || r.right > innerWidth); }).map(e => e.id || e.textContent)")
            assert not out, f"{w} px: off screen {out}"
        # removing a Spectral layer keeps keyboard focus: on the next chip, then the box when none are left
        await pg.set_viewport_size({"width": 1440, "height": 900}); await pg.wait_for_timeout(200)
        await pg.evaluate("window.__spectral.toggle(10, true); window.__spectral.toggle(20, true)")
        await pg.focus(".sp-chip[data-n='10']"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(100)
        assert await pg.evaluate("document.activeElement.dataset.n") == "20", "focus lost after removing a chip"
        await pg.keyboard.press("Enter"); await pg.wait_for_timeout(100)
        assert await pg.evaluate("document.activeElement.id") == "sp-on", "focus lost after removing the last chip"
        print("PASS spectral chips: removing one keeps focus on the next chip, then the box")
        print("PASS phone cards: every control in Advanced stays on screen at 320 and 390 px")
        # Forums (same shared stylesheet): no sideways scroll at tablet and phone widths (styles.css asks 1100 px of body)
        for w in (390, 700, 768, 900, 1024):
            await pg.set_viewport_size({"width": w, "height": 844}); await pg.goto(f"{BASE}/forums.html"); await pg.wait_for_timeout(500)
            assert not await pg.evaluate("document.documentElement.scrollWidth > innerWidth"), f"Forums scrolls sideways at {w} px"
        print("PASS forums width: no sideways scroll at 390, 700, 768, 900 and 1024 px")
        await pg.goto(f"{BASE}/timelapse.html?target=barnard"); await pg.wait_for_function(ready)


        # month names on the timeline never touch, from a narrow phone to a desktop
        TOUCH = """() => { const r = [...document.querySelectorAll('.tl-tick:not(.quiet) b')].map(b => b.getBoundingClientRect()).sort((a, b) => a.left - b.left), bad = [];
            for (let i = 1; i < r.length; i++) if (r[i].left < r[i - 1].right + 2) bad.push(Math.round(r[i - 1].right - r[i].left)); return [r.length, bad]; }"""
        for w, h in [(320, 700), (390, 844), (768, 1024), (1440, 900)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            n, bad = await pg.evaluate(TOUCH)
            assert n >= 4 and not bad, f"{w} px: {n} month names, overlaps {bad}"
        print("PASS timeline labels: month names thin out and never touch at 320, 390, 768 and 1440 px")

        # the photo's legend, Color Difference's key row included, sits wholly inside the frame
        await pg.click("label[for=diff]")
        INSIDE = """() => { const f = document.querySelector('.pv-frame').getBoundingClientRect(), bad = [], shown = [...document.querySelectorAll('#legend span')].filter(s => s.getClientRects().length);
            for (const s of shown) { const r = s.getBoundingClientRect();
              if (r.left < f.left || r.right > f.right || r.top < f.top || r.bottom > f.bottom) bad.push(s.textContent);
              if (s.getClientRects().length > 1 || r.height > 1.6 * parseFloat(getComputedStyle(s).fontSize)) bad.push(s.textContent + ' wraps'); }
            return [shown.length, bad]; }"""
        for w, h in [(320, 700), (390, 844), (1440, 900)]:
            await pg.set_viewport_size({"width": w, "height": h}); await pg.wait_for_timeout(300)
            n, bad = await pg.evaluate(INSIDE)
            assert n == 5 and not bad, f"{w} px legend: {n} items, {bad}"
        await pg.click("label[for=diff]")
        print("PASS legend: all five items (this visit, earlier visits, already known, and the colour key) sit whole inside the photo frame at 320, 390 and 1440 px")

        # while a live time-lapse builds, the frame says what is happening, shows each frame as it is made while nothing
        # else is on screen, and clears when the build lands; a re-centre out of the listed images shows it over the
        # moved photo, and it clears when that search fails (the search is slowed, then refused)
        SHOWN = "(() => { const s = getComputedStyle(document.getElementById('loading')); return s.visibility === 'visible' && +s.opacity > .9 ? document.getElementById('ld-text').textContent : ''; })()"
        LIT = "(() => { if (__lapse.state.m) return -1; const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 40) n++; return n; })()"
        BUILT = "/visits, built/.test(document.getElementById('status').textContent)"
        lp = await ctx.new_page(); lp.on("pageerror", lambda e: errors.append(str(e)))
        await lp.set_viewport_size({"width": 1440, "height": 900})
        await lp.goto(f"{BASE}/timelapse.html?ra=269.4463&dec=4.7922&det=D1")
        seen, lit = [], 0
        for _ in range(2400):   # 4 minutes at most: IRSA's search is slow on some days
            t = await lp.evaluate(SHOWN)
            if t and (not seen or seen[-1] != t): seen.append(t)
            if t.startswith("Building frame") or t == "Measuring the motion": lit = max(lit, await lp.evaluate(LIT))
            if await lp.evaluate(BUILT): break
            await lp.wait_for_timeout(100)
        await lp.wait_for_timeout(700)
        assert any(t.startswith("Building frame") for t in seen) and lit > 0 and await lp.evaluate(SHOWN) == "", f"first build: the frame said {seen}, lit pixels before the photo {lit}, after: '{await lp.evaluate(SHOWN)}'"
        async def refuse(route):
            await asyncio.sleep(2.5)
            try: await route.fulfill(status=502, content_type="application/json", body='{"error":"IRSA is not answering"}')
            except Exception: pass
        await lp.route("**/api/images**", refuse)
        await lp.evaluate("__lapse.recenter([-4 * 3600 / 5, 0])")
        await lp.wait_for_function(SHOWN, timeout=10000); during = await lp.evaluate(SHOWN)
        await lp.wait_for_function("document.getElementById('status').className === 'err'", timeout=30000); await lp.wait_for_timeout(700)
        after = await lp.evaluate(SHOWN)
        assert during == "Finding SPHEREx images" and after == "" and "Back at the last spot" in await lp.text_content("#status"), f"re-centre: during '{during}', after '{after}'"
        await lp.emulate_media(reduced_motion="reduce")
        assert await lp.evaluate("getComputedStyle(document.getElementById('loading')).transitionDuration") == "0s", "the loading state still fades with less motion asked for"
        await lp.close()
        print(f"PASS loading: the frame says {' -> '.join(seen)}, shows frames as they are built, clears when the build lands; a failed re-centre shows it, then clears; no fade with less motion")

        assert not errors, f"page errors: {errors}"
        await b.close()
    print("PASS toggles: Heat, Hide Stationary and Color Difference each change the picture, alone and together, and undo cleanly")

asyncio.run(main())
