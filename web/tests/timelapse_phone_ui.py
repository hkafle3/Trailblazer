"""Browser check for the time-lapse on a phone (the redesign's phone mockups 1a, 1c and 2, 2026-11-16; before it, the T1
"tool tabs" of 2026-11-15), in system Chrome at 390x844 with touch, as a phone. Needs the app up (npm run dev) and the
network (NASA's S3 copy of SPHEREx, for the live spot and the Spectral rebuild). On Barnard's Star (baked) and on a live
spot (RA 77, Dec 30.4, D1):
1. one column in the mockup's order (Back with the name, the verdict, the photo with its tabs, the timeline, Advanced,
   Report a new find), nothing sideways, also on a short screen (390x664); the page scrolls down to the end;
2. the header is solid and ends where the content starts;
3. Advanced opens and shuts, and shows the dial, the filters, Zoom with the whole region, and the position;
4. Heat, Hide Stationary and Color Difference change the photo from Advanced and undo cleanly;
5. Spectral: a touch drag turns the dial without scrolling the page, and the dial taken into D3 (channel 43, as
   spectral_ui.py) rebuilds once, the Band box follows and every frame sits inside the channel;
6. Report a new find opens the Discuss sheet over the bottom of the page, on screen, usable (a tag and a nickname
   enable Post), and it closes;
7. every tap target on screen, scrolled top to bottom (and the sheet), is at least 44 px both ways;
8. no console errors or page errors.
Run: uv run -q --with playwright python web/tests/timelapse_phone_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
MID = 42   # 0-based channel 43 (D3, 2.01 µm), as spectral_ui.py
READY = "window.__lapse?.state.m && !document.body.classList.contains('busy')"
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"
# what is wrong with the layout right now: page scroll, sideways overflow, a part off screen, the header over the content
LAYOUT = """() => { const bad = [], W = innerWidth, d = document.documentElement;
  if (d.scrollWidth > W + 1 || document.body.scrollWidth > W + 1) bad.push(`sideways: ${Math.max(d.scrollWidth, document.body.scrollWidth)} > ${W}`);
  const order = ['.pv-who', '.pv-frame', '.tl', '.pv-adv', '.pv-report'].map(s => [s, document.querySelector(s).getBoundingClientRect()]);
  for (const [s, r] of order) if (!r.height || r.left < -1 || r.right > W + 1) bad.push(`${s} not within the screen's width: ${[r.left, r.right].map(Math.round)}`);
  for (let i = 1; i < order.length; i++) if (order[i][1].top < order[i - 1][1].bottom - 1) bad.push(`${order[i][0]} above the end of ${order[i - 1][0]}`);
  const tl = document.querySelector('.tl-date').getBoundingClientRect(), f = document.querySelector('.pv-frame').getBoundingClientRect();
  if (tl.top < f.bottom - 1) bad.push('the timeline date sits on the photo');
  const hd = document.querySelector('.topbar'), hr = hd.getBoundingClientRect(), top = document.querySelector('.pv-who').getBoundingClientRect().top + document.body.scrollTop;
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


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        errors = []

        async def page(url):
            pg = await ctx.new_page()
            # Cloudflare Turnstile's own frame (the Discuss sheet's check, live only) logs its probes: not this page's
            pg.on("console", lambda m: m.type == "error" and "challenges.cloudflare.com" not in (m.location or {}).get("url", "") and errors.append(f"{url}: console {m.text} at {(m.location or {}).get('url')}"))
            pg.on("pageerror", lambda e: errors.append(f"{url}: {e}"))
            await pg.goto(f"{BASE}/{url}"); await pg.wait_for_function(READY, timeout=240000); await pg.wait_for_timeout(400)
            return pg

        async def scroll_small(pg):   # tap targets under 44 px anywhere on the page, scrolled top to bottom
            out = set(); H = await pg.evaluate("document.body.scrollHeight")
            for y in range(0, H, 600):
                await pg.evaluate(f"document.body.scrollTo(0, {y})"); await pg.wait_for_timeout(60)
                out |= set(await pg.evaluate(SMALL))
            await pg.evaluate("document.body.scrollTo(0, 0)")
            return sorted(out)

        async def check_layout(pg, where):
            for size in ({"width": 390, "height": 844}, {"width": 390, "height": 664}):
                await pg.set_viewport_size(size); await pg.wait_for_timeout(250)
                bad = await pg.evaluate(LAYOUT); assert not bad, f"{where} {size}: {bad}"
            await pg.set_viewport_size({"width": 390, "height": 844}); await pg.wait_for_timeout(250)
            await pg.evaluate("document.body.scrollTo(0, 1e6)"); await pg.wait_for_timeout(100)
            r = await pg.evaluate("document.querySelector('.pv-share').getBoundingClientRect().bottom")
            assert r <= 844 + 0.5, f"{where}: the page does not scroll to its end ({r})"
            await pg.evaluate("document.body.scrollTo(0, 0)")
            for on in (True, False):
                if (await pg.get_attribute("#adv-btn", "aria-expanded") == "true") != on: await pg.tap("#adv-btn"); await pg.wait_for_timeout(150)
                shown = [s for s in ("#sp-dial", "#still", "#fov", ".pv-mini", "#coords") if await pg.locator(s).is_visible()]
                assert shown == (["#sp-dial", "#still", "#fov", ".pv-mini", "#coords"] if on else []), f"{where}: Advanced {'open' if on else 'shut'} shows {shown}"
                bad = await pg.evaluate(LAYOUT); assert not bad, f"{where}, Advanced {'open' if on else 'shut'}: {bad}"
                small = await scroll_small(pg); assert not small, f"{where}, Advanced {'open' if on else 'shut'}: tap targets under 44 px: {small}"
            print(f"PASS {where}: one column in order (name and verdict, photo, timeline, Advanced, Report) at 390x844 and 390x664, nothing sideways, "
                  "solid header above the content, the page scrolls to its end; Advanced opens and shuts; every tap target 44 px or more")

        # ---------- Barnard's Star: layout, Advanced, toggles, Discuss ----------
        pg = await page("timelapse.html?target=barnard")
        assert await pg.text_content("#pv-name") == "Barnard's Star" and (await pg.text_content("#pv-say")).startswith("Moved 10 arcseconds a year.")
        await check_layout(pg, "Barnard's Star")
        await pg.tap("#adv-btn"); await pg.wait_for_timeout(150)

        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(150)
        base = await pg.evaluate(PIXELS)
        for tid, key in (("ly-heat", "heat"), ("still", "still"), ("diff", "diff")):
            await pg.locator(f"label[for={tid}]").scroll_into_view_if_needed()
            await pg.tap(f"label[for={tid}]"); await pg.wait_for_timeout(200)
            on = await pg.evaluate(PIXELS)
            assert await pg.evaluate(f"__lapse.state.{key}") and on != base, f"{tid} from Advanced did not change the photo"
            await pg.tap(f"#{tid}"); await pg.wait_for_timeout(200)
            assert not await pg.evaluate(f"__lapse.state.{key}") and await pg.evaluate(PIXELS) == base, f"{tid} did not undo"
        print("PASS toggles: Heat, Hide Stationary and Color Difference (in Advanced) change the photo and undo, by label and by box")

        await pg.locator("#state").scroll_into_view_if_needed()
        await pg.tap("#state"); await pg.wait_for_selector("#talk", state="visible"); await pg.wait_for_timeout(300)
        sheet = await pg.evaluate("(() => { const r = document.getElementById('talk').getBoundingClientRect(), f = document.querySelector('.pv-frame').getBoundingClientRect(); return [r.top, r.bottom, r.left, r.right, f.top, innerHeight] })()")
        top, bottom, left, right, ftop, H = sheet
        assert left >= 0 and right <= 390 and bottom <= H + 0.5 and top >= 104 - 0.5, f"the sheet is not on screen: {sheet}"
        assert await pg.locator("#talk .close").is_visible() and await pg.locator("#talk .pv-post").is_disabled()
        await pg.tap("#talk label.pv-row:has([value=comet])"); await pg.fill("#talk .nick", "phonetester")
        assert await pg.locator("#talk .pv-post").is_enabled(), "Post stays off with a tag and a nickname"
        await pg.locator("#talk .pv-post").scroll_into_view_if_needed()
        assert await pg.locator("#talk .pv-post").is_visible()
        bad = await pg.evaluate(LAYOUT); assert not bad, f"with the sheet open: {bad}"
        small = await pg.evaluate(SMALL)
        assert not small, f"Discuss sheet: tap targets under 44 px: {small}"
        await pg.tap("#talk .close"); await pg.wait_for_selector("#talk", state="hidden")
        assert await pg.locator("#state").is_visible()
        print(f"PASS discuss: Report a new find opens the sheet over the bottom of the page (top at {round(top)} px), a tag and a nickname enable Post, every tap 44 px or more, it closes")

        # ---------- a live spot: the same layout, and the Spectral dial rebuilding with the photo in view ----------
        pg = await page("timelapse.html?ra=77&dec=30.4&det=D1")
        assert await pg.text_content("#pv-name") == "Sky spot"
        await check_layout(pg, "live spot")
        await pg.tap("#adv-btn"); await pg.wait_for_timeout(150)
        await pg.locator("#sp-dial").scroll_into_view_if_needed(); await pg.wait_for_timeout(150)
        y0 = await pg.evaluate("document.body.scrollTop")
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
        assert i1 != i0 and await pg.evaluate("document.body.scrollTop") == y0, f"a touch drag did not turn the dial ({i0} -> {i1}) or scrolled the page"
        await pg.wait_for_function(READY + " && __lapse.state.m.channel === __spectral.i", timeout=240000)
        before = await pg.evaluate("__lapse.builds")
        await pg.focus("#sp-dial"); await pg.keyboard.press("Home")
        for _ in range(MID // 17): await pg.keyboard.press("PageUp")
        for _ in range(MID % 17): await pg.keyboard.press("ArrowRight")
        for _ in range(2400):
            if await pg.evaluate(READY + f" && __lapse.state.m.channel === {MID}"): break
            await pg.wait_for_timeout(100)
        m = await pg.evaluate("(() => { const m = __lapse.state.m; return { det: m.detector, lams: m.frames.map(f => f.lam), n: m.frames.length, all: m.visits_all, ch: m.channel } })()")
        c = (await pg.evaluate("__lapse.channels"))[MID]
        assert m["ch"] == MID and m["det"] == "D3" and await pg.evaluate("document.getElementById('det').value") == "D3", m
        assert all(c["lo"] <= x < c["hi"] for x in m["lams"]), f"frames at {m['lams']} outside channel 43"
        assert await pg.evaluate("__lapse.builds") - before == 1, "the dial made more than one build"
        assert f"{m['n']} of {m['all']} visits have channel 43" in await pg.text_content("#status")
        assert await pg.locator(".pv-spectral").is_visible() and await pg.get_attribute("#adv-btn", "aria-expanded") == "true", "the rebuild shut Advanced or hid the dial"
        print(f"PASS spectral: a touch drag turned the dial ({i0 + 1} -> {i1 + 1}) without scrolling the page; channel 43 rebuilt once on D3 ({m['n']} of {m['all']} visits, "
              f"{', '.join(f'{x:.3f}' for x in m['lams'])} µm)")
        await pg.focus("#sp-dial"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(200)
        small = await scroll_small(pg); assert not small, f"Spectral with a layer on: tap targets under 44 px: {small}"
        bad = await pg.evaluate(LAYOUT); assert not bad, f"Spectral with a layer on: {bad}"
        print("PASS spectral layer: with a layer chip showing, the layout holds and the chip is a 44 px tap")

        assert not errors, f"console or page errors: {errors}"
        print("PASS console: no errors or page errors")
        await b.close()

asyncio.run(main())
