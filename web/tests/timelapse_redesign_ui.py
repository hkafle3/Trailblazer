"""Browser check for the time-lapse redesign, phase 1 (UX mockups 1a, 1c and 2, 2026-11-16), in system Chrome. Needs the
app up (npm run dev, with DEPTH_FAULTS=1 in worker/.dev.vars for the "unavailable" check) and the network (Gaia and
SIMBAD through /api/depth).
1. default: the name and a one-line verdict beside the photo, built from what the page measured; honest when nothing is
   known (the verdict for made-up patches with no motion, one visit, or no Gaia star);
2. one merged "already known" mark and its legend; Advanced's "Split already known" draws them apart again;
3. Depth: the tab shows the beam, and its Distances list matches GET /api/depth for the same patch and visit date,
   object for object, nearest first; dragging turns the beam;
4. unknown and unavailable: rows with no distance say why, a pending source is asked again after retry_after, an
   unavailable one (the server's own fault switch) is said plainly;
5. Advanced holds every control the page had, each still works, and it stays open next time;
6. Report a new find: the button's words and the line under it (nothing to report on a known star);
7. the view rides in the address: a shared link reopens Depth, Photo drops it, Copy link copies it;
8. phone (390x844): one column in the mockup's order, nothing sideways, the tabs and Advanced are 44 px taps, Depth
   shows Distances under the timeline.
Run: uv run -q --with playwright python web/tests/timelapse_redesign_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
READY = "+document.getElementById('play')?.getAttribute('aria-valuemax') > 0 && !!window.__lapse?.state.m"
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"
BEAM = "(() => { const c = document.querySelector('#depth3d canvas'), t = document.createElement('canvas'); t.width = 200; t.height = 120; const g = t.getContext('2d'); g.drawImage(c, 0, 0, 200, 120); const d = g.getImageData(0, 0, 200, 120).data; let h = 0, lit = 0; for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i + 1]) | 0; if (d[i] > 60) lit++; } return [h, lit]; })()"
SHOWN = "s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).visibility !== 'hidden' && r.width > 0 && r.height > 0; }"
OLD = ["sp-dial", "sp-on", "sp-active", "still", "diff", "ly-heat", "fov", "mini", "coords", "det", "status", "vVisit", "vMotion", "vKnown"]
fails = []
def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok: fails.append(what)


async def page(b, phone=False, adv=None):
    kw = dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True) if phone else dict(viewport={"width": 1440, "height": 900})
    ctx = await b.new_context(**kw)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}" + (f"; try {{ localStorage.setItem('ch.adv', '{adv}') }} catch {{}}" if adv else ""))
    await ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    pg = await ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and "depth" not in m.text and pg.errors.append(m.text))
    return ctx, pg


async def keys_settled(pg):   # the page's Distances list once no source is pending (or after 60 s)
    for _ in range(120):
        st = await pg.evaluate("document.getElementById('dist-list').dataset.state || ''")
        if st and "pending" not in st: break
        await pg.wait_for_timeout(500)
    return await pg.evaluate("[...document.querySelectorAll('#dist-list li[data-key]')].map(l => l.dataset.key).filter(k => !k.includes('?:'))")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)

        # ---------- 1, 2, 6: the default state on Barnard's Star ----------
        ctx, pg = await page(b)
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&day=9999"); await pg.wait_for_function(READY)
        name, say, label, note = await pg.evaluate("['pv-name', 'pv-say', 'state-label', 'state-note'].map(i => document.getElementById(i).textContent)")
        check(name == "Barnard's Star" and await pg.evaluate(SHOWN, "#pv-name"), f"default: the name beside the photo ({name})")
        check(say.startswith("Moved 10 arcseconds a year.") and "Matches Gaia's Barnard's Star, already known." in say and await pg.evaluate(SHOWN, "#pv-say"), f"default: the verdict in one plain sentence: {say}")
        r = await pg.evaluate("['.pv-who', '.pv-frame'].map(s => document.querySelector(s).getBoundingClientRect().left)")
        check(r[0] > r[1], "default: the name and verdict sit beside the photo (right column)")
        check(label == "Report a new find" and note == "Barnard's Star is already known, so there is nothing to report here.", f"report: '{label}' / '{note}'")
        # honest when nothing is known: made-up patches through the page's own verdict
        V = """(([motion, gaia, ref, n, seen]) => { const f = { known: null, x: null }; const m = { key: 'live-x', name: 'x', ra: 10, dec: 5, motion, gaia, ref,
              frames: Array.from({ length: n }, (_, i) => ({ ...f, x: i < seen ? 1 : null })) }; const v = window.__lapse.verdict(m, m.frames[0]);
              return [v.parts.map(p => typeof p === 'string' ? p : p.ok).join(''), v.known]; })"""
        one = await pg.evaluate(V + "([null, null, null, 1, 1])")
        none = await pg.evaluate(V + "([null, null, null, 4, 2])")
        mover = await pg.evaluate(V + "([{ total: 29, err: 8.3, years: 1 }, null, null, 4, 4])")
        check(one == ["Only one visit here so far, so nothing can be seen moving yet.", False], f"verdict, one visit: {one}")
        check(none[0].startswith("No motion measured: the middle shows a source in 2 of 4 visits") and not none[1], f"verdict, nothing measured: {none}")
        check(mover == ["Seems to move 29 arcseconds a year, give or take 8.3. No Gaia star is here to match it.", False], f"verdict, a mover with no Gaia star: {mover}")
        # the merged mark: one "already known" key; Split draws the predicted ring and known passing apart again
        legend = lambda: pg.evaluate("[...document.querySelectorAll('#legend .lg-row')].filter(r => getComputedStyle(r).display !== 'none').map(r => r.textContent)")
        merged = await legend()
        await pg.evaluate("document.getElementById('adv-btn').click()")
        base = await pg.evaluate(PIXELS)
        await pg.click("label[for=split]"); await pg.wait_for_timeout(150)
        split, split_px = await legend(), await pg.evaluate(PIXELS)
        await pg.click("label[for=split]"); await pg.wait_for_timeout(150)
        check(merged == ["this visitearlier visitsalready known"] and split == ["this visitearlier visitspredictedknown passing"] and split_px != base and await pg.evaluate(PIXELS) == base,
              f"already known: one merged mark ({merged}); Split draws them apart ({split}) and back")

        # ---------- 5: Advanced holds every control, each still works, and stays open ----------
        await pg.reload(); await pg.wait_for_function(READY)
        check(await pg.get_attribute("#adv-btn", "aria-expanded") == "true", "Advanced: stays open next time (after a reload)")
        inside = await pg.evaluate(f"{json.dumps(OLD)}.filter(i => !document.getElementById(i)?.closest('#adv-body'))")
        check(not inside, f"Advanced: every old control is inside the drawer (missing: {inside})")
        vis = [i for i in OLD if not await pg.evaluate(SHOWN, f"#{i}")]
        check(not vis or vis == ["status"], f"Advanced open: every control on screen (not shown: {vis})")
        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(150)
        base = await pg.evaluate(PIXELS); bad = []
        for tid in ("still", "diff", "ly-heat"):
            await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(120); on = await pg.evaluate(PIXELS)
            await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(120); off = await pg.evaluate(PIXELS)
            if on == base or off != base: bad.append(tid)
        fov0 = await pg.evaluate("__lapse.state.fov"); await pg.fill("#fov", "9"); await pg.dispatch_event("#fov", "input")
        fov1 = await pg.evaluate("__lapse.state.fov")
        await pg.focus("#sp-dial"); n0 = await pg.get_attribute("#sp-dial", "aria-valuenow"); await pg.keyboard.press("ArrowRight")
        n1 = await pg.get_attribute("#sp-dial", "aria-valuenow"); um = await pg.text_content("#sp-um")
        check(not bad and fov1 != fov0 and n1 == str(int(n0) + 1) and um.strip(), f"Advanced: Hide Stationary, Color Difference and Heat change the photo and undo ({bad or 'all'}); Zoom {fov0} -> {fov1}; the dial steps {n0} -> {n1} ({um} microns)")
        await pg.click("#adv-btn"); await pg.wait_for_timeout(100)
        hidden = [i for i in OLD if await pg.evaluate(SHOWN, f"#{i}")]
        check(not hidden and await pg.get_attribute("#adv-btn", "aria-expanded") == "false", f"Advanced shut: its controls are hidden ({hidden})")
        check(not pg.errors, f"default and Advanced: no page errors {pg.errors}")
        await ctx.close()

        # ---------- 3, 7: Depth matches /api/depth; the view rides in the address ----------
        ctx, pg = await page(b)
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&day=9999"); await pg.wait_for_function(READY)
        await pg.click("#tab-depth")
        check("view=depth" in pg.url and await pg.get_attribute("#tab-depth", "aria-selected") == "true" and await pg.evaluate(SHOWN, "#depth3d") and await pg.evaluate(SHOWN, "#dist"),
              f"Depth: the tab shows the beam and Distances, and the address says view=depth ({pg.url})")
        got = await keys_settled(pg)
        url = await pg.evaluate("__depth.url")
        visit = await pg.evaluate("__lapse.state.m.frames[__lapse.state.i].mjd.toFixed(4)")
        api = await (await pg.request.get(url if url.startswith('http') else BASE + url)).json()
        want = sorted(((o["d_pc"], f"{src}:{o.get('id') or o.get('name')}") for src in ("sso", "stars", "galaxies") for o in api["sources"][src].get("placed") or []))
        check(f"t={visit}" in url and "ra=269.4463" in url, f"Depth: asks /api/depth for this patch and the visit on screen ({url})")
        check(got == [k for _, k in want] and len(got) > 10, f"Depth: the list matches /api/depth object for object, nearest first ({len(got)} on the page, {len(want)} in the API)")
        check(await pg.evaluate("+document.getElementById('depth3d').dataset.objects") == len(want), "Depth: the beam places the same number of objects")
        # the beam: the target and the lettered objects as named rings, every other placed object as a faint dot
        shown = await pg.evaluate("__depth.shown")
        ring_rows = await pg.evaluate("[...document.querySelectorAll('#dist-list li[data-key]')].filter(l => /^(Barnard's Star|Star [A-D]|Galaxy [A-D]|The star in the middle)/.test(l.querySelector('.nm').textContent) || l.querySelector('.dmk.a')).map(l => l.dataset.key)")
        check(1 <= len(shown["rings"]) <= 5 and want[0][1] in shown["rings"] and sorted(shown["rings"]) == sorted(ring_rows),
              f"Depth: the target and the lettered objects are the beam's rings ({len(shown['rings'])}), the same ones the list names")
        check(sorted(shown["rings"] + shown["dots"]) == sorted(k for _, k in want) and not set(shown["rings"]) & set(shown["dots"])
              and await pg.evaluate("+document.getElementById('depth3d').dataset.dots") == len(want) - len(shown["rings"]),
              f"Depth: every other placed object is a dot ({len(shown['dots'])}), so rings and dots together are /api/depth's list")
        first = await pg.evaluate("(l => [l.querySelector('.nm').textContent, l.querySelector('small').textContent, l.querySelector('.dd').textContent])(document.querySelector('#dist-list li'))")
        check(first[0] == "Barnard's Star" and first[1].startswith("Gaia parallax, ±") and first[2] == "6", f"Depth: the nearest is the target, with its source and error: {first}")
        await pg.wait_for_timeout(2200)   # the swing out from the telescope ends
        b0 = await pg.evaluate(BEAM)
        box = await pg.locator("#depth3d canvas").bounding_box(); cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 160, cy + 30, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(200)
        b1 = await pg.evaluate(BEAM)
        check(b0[1] > 200 and b1[0] != b0[0], f"Depth: the beam is drawn ({b0[1]} lit samples) and a drag turns it")
        # hovering a dot names it
        cv = await pg.locator("#depth3d canvas").bounding_box(); spot = None
        for k in shown["dots"][::7]:
            xy = await pg.evaluate("k => __depth.screenOf(k)", k)
            if xy and cv["x"] + 20 < xy[0] < cv["x"] + cv["width"] - 20 and cv["y"] + 60 < xy[1] < cv["y"] + cv["height"] - 40: spot = xy; break
        await pg.mouse.move(*spot); await pg.wait_for_timeout(200)
        peek = await pg.evaluate("[document.getElementById('depth3d').dataset.peek, document.querySelector('#depth3d .lbl.tip').textContent, getComputedStyle(document.querySelector('#depth3d .lbl.tip')).opacity]")
        check(peek[0] in shown["dots"] and " ly" in peek[1] and peek[2] == "1", f"Depth: hovering a dot shows its name and distance: {peek[1]}")
        await pg.mouse.move(cv["x"] + 5, cv["y"] + 5)
        # a shared link reopens Depth; Copy link copies the view; Photo drops it
        await pg.click("#share-depth"); await pg.wait_for_timeout(200)
        clip = await pg.evaluate("navigator.clipboard.readText()")
        check("view=depth" in clip and "target=barnard" in clip, f"Copy link copies this view: {clip}")
        p2 = await ctx.new_page(); p2.errors = []; p2.on('pageerror', lambda e: p2.errors.append(str(e))); await p2.goto(clip); await p2.wait_for_function(READY)
        check(await p2.get_attribute("#tab-depth", "aria-selected") == "true" and await p2.evaluate(SHOWN, "#depth3d") and await p2.evaluate(SHOWN, "#dist"), "a shared link reopens Depth")
        await p2.click("#tab-photo"); await p2.wait_for_timeout(100)
        check("view=" not in p2.url and await p2.evaluate(SHOWN, "#patch") and not await p2.evaluate(SHOWN, "#depth3d"), f"Photo drops view= from the address ({p2.url})")
        # the next visit asks again for that date
        await pg.focus("#play"); await pg.keyboard.press("Home"); await pg.wait_for_timeout(300)
        check(f"t={await pg.evaluate('__lapse.state.m.frames[0].mjd.toFixed(4)')}" in await pg.evaluate("__depth.url"), "Depth: another visit asks for its own date")
        check(not pg.errors and not p2.errors, f"Depth: no page errors {pg.errors + p2.errors}")
        await ctx.close()

        # ---------- 4: unknown, pending and unavailable ----------
        ctx, pg = await page(b)
        asked = []
        async def made_up(route):
            asked.append(route.request.url)
            await route.fulfill(json={"ra": 269.4463, "dec": 4.7671, "rules": "depth-v1", "sources": {
                "sso": {"status": "pending", "retry_after": 2},
                "stars": {"status": "ok", "source": "ESA Gaia DR3", "count": 2, "truncated": False, "limit": 1000, "unknown_count": 7, "placed": [
                    {"id": "1", "ra": 269.45, "dec": 4.77, "g": 12.1, "pmra": 0, "pmdec": 0, "raw": {}, "d_pc": 100, "d_lo_pc": 95, "d_hi_pc": 105},
                    {"id": "2", "ra": 269.44, "dec": 4.76, "g": 14.0, "pmra": 0, "pmdec": 0, "raw": {}, "d_pc": 1000, "d_lo_pc": 900, "d_hi_pc": 1100}]},
                "galaxies": {"status": "ok", "source": "SIMBAD", "count": 0, "truncated": False, "placed": [], "unknown_count": 1, "unknown": [
                    {"id": "LEDA 1", "otype": "G", "ra": 269.43, "dec": 4.78, "raw": {}, "reason": "no redshift"}]}}})
        await pg.route("**/api/depth**", made_up)
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&view=depth"); await pg.wait_for_function(READY)
        await pg.wait_for_function("document.querySelectorAll('#dist-list li').length >= 4")
        rows = await pg.evaluate("[...document.querySelectorAll('#dist-list li')].map(l => [l.querySelector('.nm').textContent, l.querySelector('small').textContent, l.querySelector('.dd').textContent])")
        status = await pg.text_content("#dist-status")
        check(["LEDA 1", "SIMBAD redshift: no redshift", "unknown"] in rows and any(r[0] == "7 more stars" and r[2] == "unknown" for r in rows), f"unknown: named rows with their reason, and the stars without a usable parallax counted: {rows[-2:]}")
        check("still answering, asking again in 2 s" in status, f"pending: said plainly: {status}")
        await pg.wait_for_timeout(4500)
        check(len(asked) >= 2, f"pending: asked again after retry_after ({len(asked)} requests)")
        await pg.unroute("**/api/depth**", made_up)
        # the server's own fault switch (DEPTH_FAULTS=1 in local dev): galaxies fail at once
        await pg.route("**/api/depth**", lambda route: route.continue_(url=route.request.url + "&fail=galaxies"))
        await pg.focus("#play"); await pg.keyboard.press("End")
        await pg.wait_for_function("/Galaxies \\(SIMBAD\\): not answering right now/.test(document.getElementById('dist-status').textContent)", timeout=60000)
        check(True, f"unavailable: said plainly: {await pg.text_content('#dist-status')}")
        await ctx.close()

        # ---------- 9: honest states (Codex review, 2026-11-17) ----------
        ctx, pg = await page(b)
        # a detector candidate is not the patch's middle: no motion or catalog match is claimed for it
        await pg.route("**/data/candidates.json", lambda r: r.fulfill(status=404, body="not found"))
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&cand=K-0001&sample=1"); await pg.wait_for_function(READY + " && !!window.__cand?.ring")
        say, note = await pg.evaluate("['pv-say', 'state-note'].map(i => document.getElementById(i).textContent)")
        check("detector candidate" in say and "known" not in say.replace("not called known", "") and "already known" not in note and "Gaia's" not in say,
              f"candidate: the verdict claims no motion or match for it: {say} / {note}")
        # its Advanced (opened for its votes) shuts when asked
        await pg.click("#adv-btn"); await pg.wait_for_timeout(150)
        check(await pg.get_attribute("#adv-btn", "aria-expanded") == "false" and not await pg.locator("#adv-body").is_visible(), "candidate: Advanced shuts when its button is pressed")
        # the right column flows: a long name and verdict push Report (and Distances) down instead of running under them
        LONG = """() => { document.getElementById('pv-name').textContent = 'Sample candidate K-0001 with a much longer name than usual';
            document.getElementById('pv-say').textContent = 'A long verdict. '.repeat(14); }"""
        FLOW = """() => { const r = s => document.querySelector(s).getBoundingClientRect(), w = r('.pv-who'), nxt = r(document.body.classList.contains('depth') ? '#dist' : '.pv-report');
            return [Math.round(w.bottom), Math.round(nxt.top), Math.round(nxt.bottom), Math.round(r('.tl-date').top)]; }"""
        flows = []
        for vw, vh in ((1440, 900), (1280, 720)):
            await pg.set_viewport_size({"width": vw, "height": vh}); await pg.evaluate(LONG); await pg.wait_for_timeout(150)
            flows.append(await pg.evaluate(FLOW))
        await pg.set_viewport_size({"width": 1440, "height": 900})
        check(all(w <= n + 1 for w, n, _, _ in flows), f"long name and verdict: the cards below start after them at 1440 and 1280 wide {flows}")
        await pg.unroute("**/data/candidates.json")
        # the arrows a tab or the 3D view use do not step the visit
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&day=9999"); await pg.wait_for_function(READY)
        i0 = await pg.evaluate("__lapse.state.i")
        await pg.focus("#tab-photo"); await pg.keyboard.press("ArrowRight"); await pg.wait_for_timeout(200)
        i1, v1 = await pg.evaluate("[__lapse.state.i, document.getElementById('tab-depth').getAttribute('aria-selected')]")
        await pg.wait_for_function("+document.getElementById('depth3d').dataset.objects > 0", timeout=60000)
        await pg.focus("#depth3d canvas"); await pg.keyboard.press("ArrowLeft"); await pg.keyboard.press("ArrowRight"); await pg.wait_for_timeout(200)
        check(i1 == i0 and v1 == "true" and await pg.evaluate("__lapse.state.i") == i0, f"arrows: the tabs and the 3D view keep the visit ({i0} -> {i1}, Depth {v1})")
        # an open Spectrum card gives way to Distances when Depth is chosen
        await pg.click("#tab-photo"); await pg.evaluate("__spec.open(269.4463, 4.7671, 2026)"); await pg.wait_for_timeout(300)
        was = await pg.evaluate("document.body.classList.contains('speccing')")
        await pg.click("#tab-depth"); await pg.wait_for_timeout(300)
        sp = await pg.evaluate("[document.body.classList.contains('speccing'), (r => r.width > 0 && r.height > 0)(document.getElementById('dist').getBoundingClientRect()), (r => r.width > 0)(document.getElementById('spec').getBoundingClientRect()), location.search]")
        check(was and not sp[0] and sp[1] and not sp[2] and "spec=" not in sp[3], f"Spectrum then Depth: the card closes and Distances shows ({sp})")
        # another visit whose distances cannot be had: the old beam goes at once and the failure is said over it
        mjd = await pg.evaluate("__lapse.state.m.frames.map(f => f.mjd.toFixed(4))")
        photo_before = await pg.evaluate("document.getElementById('depth3d').dataset.photo")
        await pg.route("**/api/depth**", lambda r: r.fulfill(status=503, json={"error": "archive down"}))
        await pg.focus("#play"); await pg.keyboard.press("Home")
        await pg.wait_for_function("document.getElementById('depth3d').dataset.state === 'error'", timeout=20000)
        photo_after = await pg.evaluate("document.getElementById('depth3d').dataset.photo")
        check(photo_before == mjd[-1] and photo_after == mjd[0], f"Depth failure: the far end shows the new visit's photo anyway ({photo_before} -> {photo_after})")
        st = await pg.evaluate("(b => [b.dataset.objects, b.dataset.rings, b.dataset.dots, b.querySelectorAll('.lbl:not(.tip):not(.mark)').length, document.getElementById('depth-msg').textContent, document.querySelectorAll('#dist-list li').length])(document.getElementById('depth3d'))")
        check(st[:3] == ["0", "0", "0"] and "Could not ask the catalogs" in st[4] and st[5] == 0, f"Depth failure: the old beam and list are gone, the failure is said ({st})")
        await pg.unroute("**/api/depth**")
        # the server's own fault switch (DEPTH_FAULTS=1): every catalog fails for another visit; the photo still follows it
        await pg.route("**/api/depth**", lambda route: route.continue_(url=route.request.url + "&fail=sso,stars,galaxies"))
        await pg.keyboard.press("ArrowRight")
        await pg.wait_for_function("/No catalog is answering/.test(document.getElementById('depth-msg').textContent)", timeout=30000)
        fs = await pg.evaluate("[document.getElementById('depth3d').dataset.photo, document.getElementById('depth3d').dataset.state, document.getElementById('depth3d').dataset.objects]")
        check(fs == [mjd[1], "error", "0"], f"Depth with every catalog failing (fault switch): the photo is visit 2's, the failure is said, no objects ({fs})")
        await pg.unroute("**/api/depth**")
        # Copy link keeps the visit on screen: the link reopens that visit, and Depth asks for its date
        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(300)
        last = await pg.evaluate("[__lapse.state.i, __lapse.state.m.frames[__lapse.state.i].mjd.toFixed(4)]")
        await pg.click("#share-depth"); await pg.wait_for_timeout(200)
        clip = await pg.evaluate("navigator.clipboard.readText()")
        p2 = await ctx.new_page(); await p2.goto(clip); await p2.wait_for_function(READY)
        await p2.wait_for_function("!!window.__depth?.url", timeout=20000)
        got = await p2.evaluate("[__lapse.state.i, __depth.url]")
        check("day=" in clip and got[0] == last[0] and f"t={last[1]}" in got[1], f"Copy link: the link reopens visit {last[0]} and Depth asks for its date ({clip} -> visit {got[0]}, {got[1]})")
        await p2.close()
        # a live spot whose images cannot be found: the failure shows beside the photo with Advanced shut
        await pg.route("**/api/images**", lambda r: r.fulfill(status=502, json={"error": "IRSA is not answering"}))
        await pg.goto(f"{BASE}/timelapse.html?ra=10.1234&dec=-20.5678&det=D1")
        await pg.wait_for_function("document.getElementById('status').className === 'err'", timeout=60000)
        err = await pg.evaluate("[document.getElementById('adv-btn').getAttribute('aria-expanded'), document.getElementById('pv-err').textContent, (r => r.width > 0 && r.height > 0)(document.getElementById('pv-err').getBoundingClientRect())]")
        check(err[0] == "false" and err[1] and err[2], f"image failure: said beside the photo with Advanced shut ({err[1]})")
        await ctx.close()

        # ---------- 10: the dot in the middle, the facts, and one card at a time (Codex review, third pass) ----------
        ctx, pg = await page(b)
        await pg.goto(f"{BASE}/timelapse.html?target=rdra"); await pg.wait_for_function(READY)
        # a known asteroid is the dot only when SkyBoT puts it on the dot; 30 arcsec away it is "nearby", not a match
        K = """((east, east2) => { const ra = e => 10 + e / 3600 / Math.cos(5 * Math.PI / 180);
              const pts = east2 == null ? [[61000, ra(east), 5]] : [[60999.5, ra(east), 5], [61000.5, ra(east2), 5]];   // two exposure times either side of the visit's middle
              const f = { x: 50, y: 50, mjd: 61000, known: { left: 0, failed: 0, bodies: new Map([['2001 AB', { kind: 'asteroid', mag: 18, pts }]]) } };
              const m = { key: 'live-x', name: 'x', ra: 10, dec: 5, grid: 101, arcsec_per_pixel: 6.15, motion: null, gaia: null, ref: null, frames: [f, { ...f, known: null }] };
              const v = __lapse.verdict(m, f); return [v.parts.map(p => typeof p === 'string' ? p : p.ok).join(''), v.known]; })"""
        on, off, passing = await pg.evaluate(K + "(4)"), await pg.evaluate(K + "(30)"), await pg.evaluate(K + "(-25, 55)")
        check("matches the known asteroid 2001 AB" in on[0] and on[1] and "Nearby: the known asteroid 2001 AB passed 30 arcseconds" in off[0] and not off[1] and "matches" not in off[0],
              f"known at the middle: 4 arcsec is the dot ({on[1]}), 30 arcsec is only nearby ({off})")
        # an asteroid crossing the patch, 25 arcsec from the dot at one exposure and 15 at the visit's middle: nearby, never the
        # target (its own motion does not widen the match); Barnard's Star still matches Gaia (checked in 1)
        check("Nearby: the known asteroid 2001 AB passed 15 arcseconds" in passing[0] and not passing[1] and "matches" not in passing[0], f"a passing asteroid a little off the middle is nearby, not the target: {passing}")
        # the facts follow the patch: a different wavelength shows, though the verdict's words are the same
        await pg.evaluate("__lapse.state.m.lam0 = 1.234; document.getElementById('split').click(); document.getElementById('split').click()")
        check("1.23 µm" in await pg.text_content("#pv-facts"), f"facts: a new wavelength shows ({await pg.text_content('#pv-facts')})")
        # one card at a time: Discuss closes the Spectrum card; Depth closes Discuss; Play goes back to Photo
        # (on a wide screen the Spectrum card covers Report; a narrow one shows both, so the sheet can open over the card)
        await pg.set_viewport_size({"width": 390, "height": 844}); await pg.wait_for_timeout(200)
        await pg.evaluate("__spec.open(271.9, 66.7, 2026)"); await pg.wait_for_timeout(200)
        await pg.click("#state"); await pg.wait_for_selector("#talk", state="visible")
        a = await pg.evaluate("[document.body.classList.contains('speccing'), document.body.classList.contains('talking'), location.search.includes('spec=')]")
        await pg.set_viewport_size({"width": 1440, "height": 900}); await pg.wait_for_timeout(200)
        await pg.click("#tab-depth"); await pg.wait_for_timeout(300)
        bcls = await pg.evaluate("[document.body.classList.contains('talking'), (r => r.width > 0 && r.height > 0)(document.getElementById('dist').getBoundingClientRect()), (r => r.width > 0)(document.getElementById('talk').getBoundingClientRect())]")
        await pg.evaluate("document.getElementById('play').click()"); await pg.wait_for_timeout(300)
        c = await pg.evaluate("[document.getElementById('tab-photo').getAttribute('aria-selected'), document.getElementById('play').classList.contains('on')]")
        await pg.evaluate("document.getElementById('play').click()")
        check(a == [False, True, False] and bcls == [False, True, False] and c == ["true", True],
              f"one card at a time: Discuss closed Spectrum {a}; Depth closed Discuss and shows Distances {bcls}; Play went back to Photo {c}")
        check(not pg.errors, f"cards: no page errors {pg.errors}")
        await ctx.close()

        # ---------- 8: phone ----------
        ctx, pg = await page(b, phone=True)
        await pg.goto(f"{BASE}/timelapse.html?target=barnard&day=9999"); await pg.wait_for_function(READY); await pg.wait_for_timeout(300)
        order = await pg.evaluate("['.pv-who', '.pv-frame', '.tl', '.pv-adv', '.pv-report'].map(s => document.querySelector(s).getBoundingClientRect()).map(r => [Math.round(r.top), Math.round(r.bottom)])")
        check(all(order[i][1] <= order[i + 1][0] + 1 for i in range(len(order) - 1)), f"phone: name and verdict, photo, timeline, Advanced, Report in one column: {order}")
        check(not await pg.evaluate("document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth"), "phone: nothing sideways")
        taps = await pg.evaluate("['#tab-photo', '#tab-depth', '#adv-btn', '#state', '#spec-mode', '#play', '.pv-back'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => w < 44 || h < 44)")
        check(not taps, f"phone: the tabs, Advanced, Report, Spectrum, the timeline and Back are 44 px taps ({taps})")
        await pg.tap("#adv-btn"); await pg.wait_for_timeout(200)
        small = await pg.evaluate("[...document.querySelectorAll('#adv-body input, #adv-body select, #adv-body button, #adv-body [role=slider]')].map(e => { const r = e.getBoundingClientRect(); return [e.id || e.className, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => w && (w < 44 || h < 44))")
        check(not small, f"phone: every control in Advanced is a 44 px tap ({small})")
        await pg.tap("#tab-depth"); await pg.wait_for_function("document.getElementById('dist-list').children.length > 0", timeout=60000)
        d = await pg.evaluate("['.tl', '#dist'].map(s => document.querySelector(s).getBoundingClientRect().top)")
        check(d[1] > d[0] and await pg.evaluate(SHOWN, "#dist"), "phone: Depth shows Distances under the timeline")
        check(not pg.errors, f"phone: no page errors {pg.errors}")
        await ctx.close()
        await b.close()
    print(f"{'FAIL' if fails else 'PASS'} timelapse redesign: {len(fails)} failed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
