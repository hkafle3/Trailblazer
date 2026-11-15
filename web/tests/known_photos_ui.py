"""Browser check for a known comet's live photo strip and the strip player (comet.js, live/cutout.js). Needs the app up and
the network (NASA's S3 copy of SPHEREx, and the image search); takes a minute or two.
Run: uv run -q --with playwright python web/tests/known_photos_ui.py [base url]
- C/2024 J3 (ATLAS): one photo per visit, each centred on JPL's position for that visit's middle exposure (the ring in the
  middle of the box); each label agrees with its measured SNR (Seen at 5 or more, Too faint below); the summary counts them.
- A visit pill opens the time-lapse on that visit, centred on the comet, the predicted spot ringed.
- The player (C/2025 R2 (SWAN), baked photos): it cycles, pause stops it, a thumbnail click jumps to that photo, and with
  reduced motion it starts paused."""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
J3, SWAN = "C/2024 J3 (ATLAS)", "C/2025 R2 (SWAN)"
page = lambda cid: f"{BASE}/comet.html?id=" + urllib.parse.quote(cid, safe="")


def visit_picks(shots):   # live/cutout.js visitShots: photos under 5 days apart are one visit; its middle exposure
    vs = []
    for i, s in enumerate(shots):
        if i == 0 or s["day"] - shots[i - 1]["day"] >= 5: vs.append([])
        vs[-1].append(s)
    return [v[(len(v) - 1) // 2] for v in vs]


async def ctx_for(b, motion="no-preference"):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion=motion)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    return ctx


async def strip(b):
    ctx = await ctx_for(b)
    detail = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(J3, safe=""))).json())["detail"]
    picks = visit_picks(detail["spherex"])
    pg = await ctx.new_page()
    await pg.goto(page(J3))
    await pg.wait_for_selector("#c-photos-panel:not([hidden])")
    await pg.locator("#c-photos-panel").scroll_into_view_if_needed()
    await pg.wait_for_function("!/Building|Built/.test(document.querySelector('#c-photos-panel .frames-note')?.textContent ?? 'Building')", timeout=240000)
    figs = await pg.eval_on_selector_all("#c-photos figure", """fs => fs.map(f => {
      const p = f.querySelector('.pv-mini').getBoundingClientRect(), r = f.querySelector('.ring').getBoundingClientRect(), cv = f.querySelector('canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let lit = 0; for (let k = 0; k < d.length; k += 4) lit += d[k] > 40;
      return { ra: +f.dataset.ra, dec: +f.dataset.dec, verdict: f.dataset.verdict, snr: f.dataset.snr === '' ? null : +f.dataset.snr,
        vis: f.querySelector('.vis').textContent, w: cv.width, lit, off: Math.hypot(r.x + r.width / 2 - p.x - p.width / 2, r.y + r.height / 2 - p.y - p.height / 2) };
    })""")
    assert len(figs) == len(picks) == 4, f"{len(figs)} photos for {len(picks)} visits"
    for f, s in zip(figs, picks):
        assert abs(f["ra"] - s["ra"]) < 1e-6 and abs(f["dec"] - s["dec"]) < 1e-6, f"photo not centred on JPL's position: {f} vs {s}"
        assert f["w"] == 96 and f["lit"] > 200, f"photo not drawn: {f}"
        assert f["off"] < 1, f"ring {f['off']:.1f} px off the photo's centre"
        if f["snr"] is None: assert f["verdict"] in ("unmeasured", "error") and "Seen" not in f["vis"], f
        elif f["snr"] >= 5: assert f["verdict"] == "seen" and f["vis"].startswith("Seen"), f
        else: assert f["verdict"] == "faint" and f["vis"].startswith("Too faint"), f
    seen = sum(f["verdict"] == "seen" for f in figs)
    note = await pg.text_content("#c-photos-panel .frames-note")
    assert (note.startswith(f"Seen in {seen} of 4") if seen else note.startswith("Too faint")), note
    print("  SNR per visit:", [(f["snr"], f["vis"]) for f in figs], "|", note)

    # the second visit's pill: the time-lapse opens on that visit, centred on the comet's position then, centre ringed
    s = picks[1]
    pill = pg.locator(".visits a").nth(1)
    href = await pill.get_attribute("href")
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
    assert abs(float(q["ra"][0]) - s["ra"]) < 1e-4 and abs(float(q["dec"][0]) - s["dec"]) < 1e-4 and abs(float(q["t"][0]) - 60789 - s["day"]) < 1e-4, href
    await pill.click()
    await pg.wait_for_url("**/timelapse*")
    await pg.wait_for_function("/visits, built/.test(document.getElementById('status')?.textContent||'')", timeout=240000)
    await pg.wait_for_timeout(500)
    label = await pg.get_attribute("#play", "aria-valuetext")
    assert "Apr 2026" in label, f"time-lapse opened on {label}"
    ring = await pg.evaluate("""() => {   // the predicted ring: white, 15 canvas px round the centre of the view
      const c = document.getElementById('patch'), g = c.getContext('2d'), cx = c.width / 2, cy = c.height / 2;
      return [0, 1, 2, 3, 4, 5, 6, 7].map(k => { const a = k * Math.PI / 4, d = g.getImageData(Math.round(cx + 15 * Math.cos(a)), Math.round(cy + 15 * Math.sin(a)), 1, 1).data; return Math.min(d[0], d[1], d[2]); });
    }""")
    assert sum(v > 200 for v in ring) >= 6, f"no ring at the centre: {ring}"
    print(f"  pill opens the time-lapse on {label}, centre ringed")
    await ctx.close()


async def player(b):
    ctx = await ctx_for(b)
    pg = await ctx.new_page()
    await pg.goto(page(SWAN))
    await pg.wait_for_selector(".player[data-i]")
    await pg.locator(".player").scroll_into_view_if_needed()
    seen = set()
    for _ in range(12):
        seen.add(await pg.get_attribute(".player", "data-i")); await pg.wait_for_timeout(250)
    n = await pg.locator("#c-photos figure").count()
    assert len(seen) >= 3 and await pg.get_attribute(".player", "data-playing") == "1", f"player did not cycle: {seen}"
    # the big frame shows the photo of the highlighted thumbnail, the ring at its centre
    same = await pg.evaluate("() => { const i = +document.querySelector('.player').dataset.i, f = document.querySelectorAll('#c-photos figure')[i]; return f.classList.contains('on') && f.querySelector('img').src === document.querySelector('.player img').src }")
    assert same, "big frame and highlighted thumbnail differ"
    await pg.click(".player .tl-knob")   # pause
    i0 = await pg.get_attribute(".player", "data-i"); await pg.wait_for_timeout(1500)
    assert await pg.get_attribute(".player", "data-i") == i0 and not await pg.get_attribute(".player", "data-playing"), "pause did not stop it"
    k = (int(i0) + 2) % n
    await pg.locator("#c-photos figure").nth(k).click()
    assert await pg.get_attribute(".player", "data-i") == str(k) and "on" in (await pg.locator("#c-photos figure").nth(k).get_attribute("class")), "thumbnail click did not jump"
    await pg.focus(".player .tl-knob"); await pg.keyboard.press("ArrowRight")
    assert await pg.get_attribute(".player", "data-i") == str((k + 1) % n), "arrow key did not step"
    await ctx.close()
    ctx = await ctx_for(b, "reduce")
    pg = await ctx.new_page()
    await pg.goto(page(SWAN))
    await pg.wait_for_selector(".player[data-i]")
    await pg.locator(".player").scroll_into_view_if_needed()
    await pg.wait_for_timeout(1500)
    assert await pg.get_attribute(".player", "data-i") == "0" and not await pg.get_attribute(".player", "data-playing"), "reduced motion did not start paused"
    await ctx.close()
    print(f"  player: cycled {len(seen)} of {n} photos, pause holds, thumbnail click and arrow key step, reduced motion starts paused")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        await player(b)
        await strip(b)
        await b.close()
    print("PASS known comet photos: live strip centred on JPL's positions, labels match SNR, pill opens its visit, player works")

asyncio.run(main())
