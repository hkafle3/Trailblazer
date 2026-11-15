"""Browser check for the Spectral dial and its active layers on the patch viewer, in headless Chrome. Needs the app up
(npm run dev) and the network (NASA's S3 copy of SPHEREx; IRSA when the image index is not bound, about 30 s a detector).
Starts live at RA 77, Dec 30.4 on D1. The dial turned into another detector rebuilds there, the Band box follows and
every frame's wavelength sits inside the channel; spinning makes one build, not one per step; a ?ch= link gives the same
wavelengths; one active layer is that channel's photo; two make a colour composite with both colours that differs from
either alone; removing a chip takes its colour away; re-centring keeps and shifts the composite; Heat and Color
Difference still change it; a fourth layer is refused; the Band box moves the dial into its detector.
Run: uv run -q --with playwright python web/tests/spectral_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, re, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
START = f"{BASE}/timelapse.html?ra=77&dec=30.4&det=D1"
BLUE, RED, MID = 8, 76, 42   # 0-based channels: 9 (D1, 0.92 µm), 77 (D5, 4.10 µm), 43 (D3, 2.01 µm)
PIXELS = "(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) | 0; return h; })()"
# bright pixels of the photo that are clearly blue (B well over R) and clearly orange or red (R well over B)
HUES = """(() => { const c = document.getElementById('patch'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, b = 0, r = 0;
  for (let i = 0; i < d.length; i += 4) { if (Math.max(d[i], d[i + 1], d[i + 2]) < 60) continue; n++; if (d[i + 2] > d[i] + 40) b++; if (d[i] > d[i + 2] + 40) r++; }
  return [n, b, r]; })()"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page()
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        ev = pg.evaluate

        async def settle(ch, layers=None, timeout=240000):   # the main build is channel ch (and, with layers, the composite has them all)
            await pg.wait_for_function(f"(() => {{ const s = __lapse.state; return s.m && s.m.channel === {ch} && !document.body.classList.contains('busy') }})()", timeout=timeout)
            if layers: await pg.wait_for_function(f"__lapse.state.comp?.main === __lapse.state.m && __lapse.state.comp.layers.length === {layers}", timeout=timeout)
            await pg.focus("#play"); await pg.keyboard.press("Home"); await pg.wait_for_timeout(150)   # the first visit, for comparable pixels

        async def dial_to(n):   # by keyboard, as a person would: Home, then a page (17 channels) at a time, then single steps
            await pg.focus("#sp-dial"); await pg.keyboard.press("Home")
            for _ in range(n // 17): await pg.keyboard.press("PageUp")
            for _ in range(n % 17): await pg.keyboard.press("ArrowRight")

        await pg.goto(START)
        await pg.wait_for_function("__lapse.state.m && __lapse.state.m.channel === null", timeout=240000)
        ch = await ev("__lapse.channels")

        # 1. the dial into D3: one rebuild there, the Band box follows, every frame inside channel 43
        before = await ev("__lapse.builds")
        await dial_to(MID); await settle(MID)
        m = await ev("(() => { const m = __lapse.state.m; return { det: m.detector, lams: m.frames.map(f => f.lam), n: m.frames.length, all: m.visits_all } })()")
        c = ch[MID]
        assert m["det"] == "D3" and await ev("document.getElementById('det').value") == "D3", f"detector {m['det']}"
        assert all(c["lo"] <= x < c["hi"] for x in m["lams"]), f"frame wavelengths {m['lams']} outside channel 43, {c['lo']:.4f} to {c['hi']:.4f} µm"
        built = await ev("__lapse.builds") - before
        assert built == 1, f"spinning the dial through {MID + 1 + 3} steps made {built} builds"
        status = await ev("document.getElementById('status').textContent")
        assert f"{m['n']} of {m['all']} visits have channel 43" in status, status
        cap = await ev("document.getElementById('vVisit').textContent")
        shown = float(re.search(r"at ([\d.]+) µm", cap)[1])
        assert c["lo"] - 5e-4 <= shown < c["hi"] + 5e-4, cap
        print(f"PASS dial: channel 43 rebuilt on D3 in one build; {m['n']} of {m['all']} visits at {', '.join(f'{x:.3f}' for x in m['lams'])} µm, inside {c['lo']:.3f} to {c['hi']:.3f}")

        nm = round(c["um"] * 1000)
        vt, vn = await ev("[document.getElementById('sp-dial').getAttribute('aria-valuetext'), document.getElementById('sp-dial').getAttribute('aria-valuenow')]")
        assert vn == "43" and vt.startswith("Channel 43 ") and f"{nm} nanometres" in vt and "D3" in vt, vt
        print(f"PASS dial aria: valuenow 43, valuetext \"{vt}\"")
        alone_mid = await ev(PIXELS)

        # 2. the link restores the same channel and wavelengths
        q = urllib.parse.parse_qs(urllib.parse.urlparse(pg.url).query)
        assert q.get("ch") == ["43"] and q.get("det") == ["D3"], pg.url
        pg2 = await ctx.new_page(); await pg2.goto(pg.url)
        await pg2.wait_for_function(f"__lapse.state.m?.channel === {MID}", timeout=240000)
        lams2 = await pg2.evaluate("__lapse.state.m.frames.map(f => f.lam)")
        assert lams2 == m["lams"], f"?ch=43 gave {lams2}, the dial gave {m['lams']}"
        assert await pg2.evaluate("__spectral.i") == MID
        await pg2.close()
        print("PASS link: ?ch=43 opens on channel 43 with the same wavelengths")

        # 3. one active layer is that channel's photo, in grey
        await dial_to(BLUE); await settle(BLUE)
        alone_blue = await ev(PIXELS)
        await pg.focus("#sp-dial"); await pg.keyboard.press("Enter"); await settle(BLUE)
        assert await ev("__lapse.state.comp") is None and await ev(PIXELS) == alone_blue, "one layer is not the channel's own photo"
        print("PASS one layer: the photo is channel 9 alone, unchanged")

        # 4. a second layer: a composite, in both colours, unlike either alone
        await dial_to(RED); await pg.keyboard.press("Enter"); await settle(BLUE, 2)
        comp = await ev(PIXELS); n, blue, red = await ev(HUES)
        assert comp not in (alone_blue, alone_mid), "the composite looks like one channel"
        assert blue > 0.005 * n and red > 0.005 * n, f"composite colours: {blue} blue and {red} red of {n} bright pixels"
        assert "layers=9,77" in pg.url, pg.url
        status = await ev("document.getElementById('status').textContent")
        print(f"PASS two layers: composite of channels 9 and 77, {blue} blue and {red} red of {n} bright pixels; status \"{status}\"")

        # 5. removing a chip takes its colour away
        await pg.click(".sp-chip[data-n='76']"); await pg.wait_for_timeout(300)
        assert await ev("__lapse.state.comp") is None and await ev(PIXELS) == alone_blue, "the photo kept channel 77 after its chip was removed"
        print("PASS chip: removing channel 77 brings back channel 9 alone")

        # 6. Heat and Color Difference still change the composite
        await pg.focus("#sp-dial"); await pg.keyboard.press("Enter"); await settle(BLUE, 2)   # the dial is still on 77
        await pg.focus("#play"); await pg.keyboard.press("End"); await pg.wait_for_timeout(150)
        last = await ev(PIXELS)
        for tid in ("ly-heat", "diff"):
            await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(150)
            on = await ev(PIXELS); await pg.click(f"label[for={tid}]"); await pg.wait_for_timeout(150)
            assert on != last and await ev(PIXELS) == last and await ev("!!__lapse.state.comp"), f"{tid} on the composite"
        print("PASS toggles: Heat and Color Difference change the composite and undo cleanly")

        # 7. re-centre: the composite moves with the photo, then rebuilds at the new centre with both layers
        await pg.focus("#play"); await pg.keyboard.press("Home"); await pg.wait_for_timeout(150)
        ra0 = await ev("__lapse.state.m.ra"); still = await ev(PIXELS)
        r = await ev("(() => { const r = document.getElementById('patch').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()")
        await pg.mouse.move(*r); await pg.mouse.down(); await pg.mouse.move(r[0] + 80, r[1] + 40, steps=8)
        moved = await ev(PIXELS)
        assert moved != still and await ev("!!__lapse.state.comp"), "the composite did not move with the photo"
        await pg.mouse.up()
        await pg.wait_for_function(f"__lapse.state.m.ra !== {ra0}", timeout=240000); await settle(BLUE, 2)
        assert await ev("__lapse.state.comp.layers.every(L => L.m.ra === __lapse.state.m.ra && L.m.dec === __lapse.state.m.dec)"), "layers from two spots"
        assert "layers=9,77" in pg.url, pg.url
        print(f"PASS re-centre: the composite moved with the drag, then both layers rebuilt at RA {await ev('__lapse.state.m.ra.toFixed(4)')}")

        # 8. three layers at most
        await dial_to(MID); await pg.keyboard.press("Enter"); await dial_to(MID + 1); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(200)
        assert await ev("__spectral.active.size") == 3 and not await ev("document.getElementById('sp-on').checked"), "a fourth layer was taken"
        assert "3 layers at most" in await ev("document.getElementById('status').textContent")
        print("PASS cap: a fourth layer is refused and the status line says so")

        # 9. the Band box moves the dial into its detector (with no layers)
        for k in list(await ev("[...__spectral.active]")): await ev(f"__spectral.toggle({k}, false)")
        await pg.select_option("#det", "D2")
        await pg.wait_for_function("__lapse.state.m.detector === 'D2' && __lapse.state.m.channel === null && !document.body.classList.contains('busy')", timeout=240000)
        i = await ev("__spectral.i")
        assert ch[i]["detector"] == "D2" and "ch=" not in pg.url, (i, pg.url)
        print(f"PASS band: D2 in the Band box turns the dial to channel {i + 1}, D2's best-covered wavelength")

        assert not errors, f"page errors: {errors}"
        await b.close()

asyncio.run(main())
