"""Browser check for the time-lapse on a phone (T1, "tool tabs": Ed's approved design, 2026-11-15), in system Chrome at
390x844 with touch, as a phone. Needs the app up (npm run dev) and the network (NASA's S3 copy of SPHEREx, for the live
spot and the Spectral rebuild). On Barnard's Star (baked) and on a live spot (RA 77, Dec 30.4, D1):
1. the page never scrolls, either way; the photo, the timeline, the tab strip and Undiscovered are all on screen at once,
   also on a short screen (390x664, about what iPhone Safari leaves with its bars);
2. the header is solid and ends where the content starts;
3. each tab shows its own card (Options with the whole-region map) and hides the others;
4. Layers and Others: Heat, Hide Stationary and Color Difference change the photo from their tabs and undo cleanly;
5. Spectral: a touch drag turns the dial, and the dial taken into D3 (channel 43, as spectral_ui.py) rebuilds once, the
   Band box follows and every frame sits inside the channel, with the photo wholly on screen the whole time;
6. Undiscovered opens the Discuss sheet over the panel, on screen, usable (a tag and a nickname enable Post), and it closes;
7. every tap target on screen (each tab, and the sheet) is at least 44 px both ways;
8. no console errors or page errors.
Run: uv run -q --with playwright python web/tests/timelapse_phone_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
TABS = {"options": ".pv-options", "spectral": ".pv-spectral", "layers": ".pv-layers", "others": ".pv-others", "info": ".pv-desc"}
MID = 42   # 0-based channel 43 (D3, 2.01 µm), as spectral_ui.py
READY = "window.__lapse?.state.m && !document.body.classList.contains('busy')"
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"
# what is wrong with the layout right now: page scroll, sideways overflow, a part off screen, the header over the content
LAYOUT = """() => { const bad = [], W = innerWidth, H = innerHeight, d = document.documentElement;
  if (d.scrollHeight > H + 1 || document.body.scrollHeight > H + 1) bad.push(`page scrolls: ${d.scrollHeight} > ${H}`);
  if (d.scrollWidth > W + 1) bad.push(`sideways: ${d.scrollWidth} > ${W}`);
  scrollTo(0, 400); if (scrollY) bad.push(`scrollY ${scrollY} after scrollTo`); scrollTo(0, 0);
  for (const s of ['.pv-title', '.pv-frame', '.tl', '.pv-tabs', '#state']) { const r = document.querySelector(s).getBoundingClientRect();
    if (!r.height || r.top < 0 || r.left < -1 || r.bottom > H + 0.5 || r.right > W + 1) bad.push(`${s} not wholly on screen: ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`); }
  const tl = document.querySelector('.tl-date').getBoundingClientRect(), f = document.querySelector('.pv-frame').getBoundingClientRect();
  if (tl.top < f.bottom - 1) bad.push('the timeline date sits on the photo');
  const hd = document.querySelector('.topbar'), hr = hd.getBoundingClientRect(), top = document.querySelector('.pv-title').getBoundingClientRect().top;
  if (hr.bottom > top + 0.5) bad.push(`header bottom ${hr.bottom} over the content at ${top}`);
  if (getComputedStyle(hd).backgroundColor !== 'rgb(0, 0, 0)') bad.push(`header see-through: ${getComputedStyle(hd).backgroundColor}`);
  return bad; }"""
SHOWN = """sel => { const e = document.querySelector(sel), r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.height > 40 && r.top >= 0 && r.bottom <= innerHeight + 0.5; }"""
# every visible thing a finger can press: links, buttons, fields, labels of fields, sliders, scroll regions
SMALL = """() => { const out = [];
  for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, label[for], [role=slider], [tabindex]:not([tabindex="-1"])')) {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    if (r.width * r.height < 4 || s.visibility !== 'visible' || s.pointerEvents === 'none' || r.bottom <= 0 || r.top >= innerHeight) continue;
    if (e.closest('[hidden], .sr-only')) continue;
    if (r.width < 43.5 || r.height < 43.5) out.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].join('.')} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out; }"""
PHOTO_IN = "(() => { const r = document.querySelector('.pv-frame').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 120; })()"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        errors = []

        async def page(url):
            pg = await ctx.new_page()
            pg.on("console", lambda m: m.type == "error" and errors.append(f"{url}: console {m.text}"))
            pg.on("pageerror", lambda e: errors.append(f"{url}: {e}"))
            await pg.goto(f"{BASE}/{url}"); await pg.wait_for_function(READY, timeout=240000); await pg.wait_for_timeout(400)
            return pg

        async def check_tabs(pg, where):
            for size in ({"width": 390, "height": 844}, {"width": 390, "height": 664}):
                await pg.set_viewport_size(size); await pg.wait_for_timeout(250)
                bad = await pg.evaluate(LAYOUT); assert not bad, f"{where} {size}: {bad}"
            await pg.set_viewport_size({"width": 390, "height": 844}); await pg.wait_for_timeout(250)
            for t, sel in TABS.items():
                await pg.tap(f".pv-tabs [data-t={t}]"); await pg.wait_for_timeout(150)
                assert await pg.get_attribute(f".pv-tabs [data-t={t}]", "aria-pressed") == "true"
                assert await pg.evaluate(SHOWN, sel), f"{where}: the {t} tab does not show {sel} on screen"
                others = [s for s in TABS.values() if s != sel and await pg.locator(f".pstage > {s}").is_visible()]
                assert not others, f"{where}: the {t} tab also shows {others}"
                mini = await pg.locator(".pstage > .pv-mini").is_visible()
                assert mini == (t == "options"), f"{where}: the whole-region map is {'shown' if mini else 'hidden'} on {t}"
                bad = await pg.evaluate(LAYOUT); assert not bad, f"{where}, {t} tab: {bad}"
                small = await pg.evaluate(SMALL); assert not small, f"{where}, {t} tab: tap targets under 44 px: {small}"
            print(f"PASS {where}: no page scroll at 390x844 and 390x664, photo + timeline + tabs + state box on screen together, solid header above the content; "
                  "each tab shows only its card; every tap target 44 px or more")

        # ---------- Barnard's Star: layout, tabs, toggles, Discuss ----------
        pg = await page("timelapse.html?target=barnard")
        assert await pg.text_content("#pv-name") == "Barnard's Star" and (await pg.text_content("#pv-radec")).startswith("RA 269.45 Dec +4.77")
        await check_tabs(pg, "Barnard's Star")

        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(150)
        base = await pg.evaluate(PIXELS)
        for tab, tid, key in (("layers", "ly-heat", "heat"), ("others", "still", "still"), ("others", "diff", "diff")):
            await pg.tap(f".pv-tabs [data-t={tab}]"); await pg.wait_for_timeout(100)
            await pg.tap(f"label[for={tid}]"); await pg.wait_for_timeout(200)
            on = await pg.evaluate(PIXELS)
            assert await pg.evaluate(f"__lapse.state.{key}") and on != base, f"{tid} from the {tab} tab did not change the photo"
            await pg.tap(f"#{tid}"); await pg.wait_for_timeout(200)
            assert not await pg.evaluate(f"__lapse.state.{key}") and await pg.evaluate(PIXELS) == base, f"{tid} did not undo"
        print("PASS toggles: Heat (Layers tab), Hide Stationary and Color Difference (Others tab) change the photo and undo, by label and by box")

        await pg.tap(".pv-tabs [data-t=options]")
        await pg.tap("#state"); await pg.wait_for_selector("#talk", state="visible"); await pg.wait_for_timeout(300)
        sheet = await pg.evaluate("(() => { const r = document.getElementById('talk').getBoundingClientRect(), f = document.querySelector('.pv-frame').getBoundingClientRect(); return [r.top, r.bottom, r.left, r.right, f.top, innerHeight] })()")
        top, bottom, left, right, ftop, H = sheet
        assert left >= 0 and right <= 390 and bottom <= H + 0.5 and top > ftop, f"the sheet is not on screen under the photo's top: {sheet}"
        assert await pg.locator("#talk .close").is_visible() and await pg.locator("#talk .pv-post").is_disabled()
        await pg.tap("#talk label.pv-row:has([value=comet])"); await pg.fill("#talk .nick", "phonetester")
        assert await pg.locator("#talk .pv-post").is_enabled(), "Post stays off with a tag and a nickname"
        await pg.locator("#talk .pv-post").scroll_into_view_if_needed()
        assert await pg.locator("#talk .pv-post").is_visible()
        bad = [x for x in await pg.evaluate(LAYOUT) if "#state" not in x]   # the state box gives way to Post while the sheet is open
        assert not bad, f"with the sheet open: {bad}"
        small = await pg.evaluate(SMALL); assert not small, f"Discuss sheet: tap targets under 44 px: {small}"
        await pg.tap("#talk .close"); await pg.wait_for_selector("#talk", state="hidden")
        assert await pg.locator("#state").is_visible()
        print(f"PASS discuss: Undiscovered opens the sheet over the panel (top at {round(top)} px, the photo above it), a tag and a nickname enable Post, every tap 44 px or more, it closes")

        # ---------- a live spot: the same layout, and the Spectral dial rebuilding with the photo in view ----------
        pg = await page("timelapse.html?ra=77&dec=30.4&det=D1")
        assert await pg.text_content("#pv-name") == "Sky spot"
        await check_tabs(pg, "live spot")
        await pg.tap(".pv-tabs [data-t=spectral]")
        r = await pg.evaluate("(() => { const r = document.getElementById('sp-dial').getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })()")
        i0 = await pg.evaluate("__spectral.i")
        cx, cy = r[0] + r[2] / 2, r[1] + r[3] * 147 / 190   # the needle's pivot
        cdp = await ctx.new_cdp_session(pg)   # a one-finger drag round the dial, as touch events
        pts = [(cx - 70, cy - 10), (cx - 40, cy - 60), (cx, cy - 75), (cx + 40, cy - 60)]
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pts[0][0], "y": pts[0][1]}]})
        for x, y in pts[1:]: await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        await pg.wait_for_timeout(200)
        i1 = await pg.evaluate("__spectral.i")
        assert i1 != i0 and await pg.evaluate("scrollY") == 0, f"a touch drag did not turn the dial ({i0} -> {i1}) or scrolled the page"
        await pg.wait_for_function(READY + " && __lapse.state.m.channel === __spectral.i", timeout=240000)
        before = await pg.evaluate("__lapse.builds")
        await pg.focus("#sp-dial"); await pg.keyboard.press("Home")
        for _ in range(MID // 17): await pg.keyboard.press("PageUp")
        for _ in range(MID % 17): await pg.keyboard.press("ArrowRight")
        assert await pg.evaluate(PHOTO_IN), "the photo left the screen while the dial turned"
        seen_out = False
        for _ in range(2400):
            if not await pg.evaluate(PHOTO_IN): seen_out = True
            if await pg.evaluate(READY + f" && __lapse.state.m.channel === {MID}"): break
            await pg.wait_for_timeout(100)
        m = await pg.evaluate("(() => { const m = __lapse.state.m; return { det: m.detector, lams: m.frames.map(f => f.lam), n: m.frames.length, all: m.visits_all, ch: m.channel } })()")
        c = (await pg.evaluate("__lapse.channels"))[MID]
        assert m["ch"] == MID and m["det"] == "D3" and await pg.evaluate("document.getElementById('det').value") == "D3", m
        assert all(c["lo"] <= x < c["hi"] for x in m["lams"]), f"frames at {m['lams']} outside channel 43"
        assert await pg.evaluate("__lapse.builds") - before == 1, "the dial made more than one build"
        assert not seen_out and await pg.evaluate(PHOTO_IN), "the photo went off screen during the rebuild"
        assert f"{m['n']} of {m['all']} visits have channel 43" in await pg.text_content("#status")
        assert await pg.evaluate(SHOWN, ".pv-spectral"), "the Spectral card left the screen"
        print(f"PASS spectral: a touch drag turned the dial ({i0 + 1} -> {i1 + 1}); channel 43 rebuilt once on D3 ({m['n']} of {m['all']} visits, "
              f"{', '.join(f'{x:.3f}' for x in m['lams'])} µm) with the photo wholly on screen throughout")
        await pg.focus("#sp-dial"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(200)
        small = await pg.evaluate(SMALL); assert not small, f"Spectral with a layer on: tap targets under 44 px: {small}"
        bad = await pg.evaluate(LAYOUT); assert not bad, f"Spectral with a layer on: {bad}"
        print("PASS spectral layer: with a layer chip showing, the layout holds and the chip is a 44 px tap")

        assert not errors, f"console or page errors: {errors}"
        print("PASS console: no errors or page errors")
        await b.close()

asyncio.run(main())
