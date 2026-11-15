"""Browser check for the time-lapse's Spectrum card: click a star, get its spectrum. Needs the app up (npm run dev) and
the network (the image search, NASA's S3 copy of SPHEREx, Gaia); a spectrum reads about 360 headers and 102 exposures,
so this takes a few minutes.
Run: uv run -q --with playwright python web/tests/spectrum_ui.py [base url] [screenshot dir]   (default http://127.0.0.1:8787)

On timelapse.html?target=barnard at 1440 x 900 and at 390 x 844 (touch):
- Barnard's Star itself saturates SPHEREx at nearly every wavelength (its core is flagged OVERFLOW and SUR_ERROR out to
  about 2.5 pixels on all six detectors), so with the flags masked it must come out as gaps that say "saturated", never
  a zero; the one or two channels it keeps (D6, 4.98 µm on 2026-11-15) are hollow. That is the real case of "a gap is
  a gap".
- STAR, a Gaia G 13.6 star 75" from Barnard's Star in the same photo, is the clean case: at least 60 valid points (filled
  plus hollow) from 0.8 to 4.8 µm or wider, falling with wavelength past about 1.5 µm, hollow points exactly where the
  measure doubts them, the CSV one row per point, and &spec= reopening it.
- Picking does not re-centre; dragging still does. On a phone the page does not scroll and the card's taps are 44 px."""
import asyncio, os, statistics, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
STAR = (269.43868, 4.78653)   # Gaia DR3 4472836047939582592, G 13.6
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


async def result(pg, secs=300):
    await pg.wait_for_function("__spec.spec.res", timeout=secs * 1000)
    return await pg.evaluate("""() => { const r = __spec.spec.res, svg = document.getElementById('spec-chart');
      const pt = [...svg.querySelectorAll('circle.pt')];
      return { points: r.points.map(p => ({ lam: p.lam, flux: p.flux, doubt: p.doubt })), gaps: r.gaps,
        circles: pt.length, hollow: pt.filter(c => c.classList.contains('doubt') && getComputedStyle(c).fill === 'rgb(0, 0, 0)' && c.getAttribute('stroke')).length,
        filled: pt.filter(c => !c.classList.contains('doubt') && c.getAttribute('fill')).length, ticks: svg.querySelectorAll('line.gap').length,
        status: document.getElementById('spec-status').textContent, where: document.getElementById('spec-where').textContent, url: location.search }; }""")


async def pick(pg, ra, dec, touch=False):
    x, y = await pg.evaluate(f"__spec.screenOf({ra}, {dec})")
    if touch: await pg.touchscreen.tap(x, y)
    else: await pg.mouse.click(x, y)


async def lapse(pg):   # the built centre, the build count and the pan
    return await pg.evaluate("({ key: __lapse.state.m.key, ra: __lapse.state.m.ra, builds: __lapse.builds, pan: __lapse.pan })")


def clean_checks(r, label):
    pts = r["points"]
    lams = [p["lam"] for p in pts]
    check(len(pts) >= 60, f"{label}: {len(pts)} valid points ({sum(1 for p in pts if p['doubt'])} of them hollow), {len(r['gaps'])} gaps")
    check(min(lams) <= 0.8 and max(lams) >= 4.8, f"{label}: spans {min(lams):.3f} to {max(lams):.3f} µm")
    bins = [(1.4, 1.8), (2.2, 2.6), (3.0, 3.4), (3.8, 4.2), (4.5, 4.9)]
    meds = [statistics.median([p["flux"] for p in pts if a <= p["lam"] < b] or [float("nan")]) for a, b in bins]
    falling = all(meds[k + 1] < meds[k] for k in range(len(meds) - 1))
    check(falling, f"{label}: median flux falls past 1.5 µm: " + ", ".join(f"{a}-{b} µm {m:.1f} mJy" for (a, b), m in zip(bins, meds)))
    check(r["circles"] == len(pts) and r["hollow"] == sum(1 for p in pts if p["doubt"]) and r["filled"] == len(pts) - r["hollow"],
          f"{label}: {r['circles']} dots drawn, {r['hollow']} hollow (black inside, coloured ring) exactly where the measure doubts, {r['filled']} filled")
    check(r["ticks"] == len(r["gaps"]) and all(p["flux"] != 0 for p in pts), f"{label}: {r['ticks']} gap ticks for {len(r['gaps'])} gaps, no point at zero")


async def desktop(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(f"{BASE}/timelapse.html?target=barnard")
    await pg.wait_for_function("__lapse.state.m && __lapse.state.m.key === 'barnard'")
    before = await lapse(pg)
    await pg.click("#spec-mode")
    check(await pg.get_attribute("#spec-mode", "aria-pressed") == "true", "desktop: the Spectrum button turns pick mode on")
    await pick(pg, *STAR)
    await pg.wait_for_timeout(600)
    after = await lapse(pg)
    check(after == before and "target=barnard" in pg.url and "spec=" in pg.url,
          f"desktop: picking did not re-centre (centre {after['key']}, {after['builds'] - before['builds']} new builds, pan {after['pan']}); URL {pg.url.split('?')[1]}")
    r = await result(pg)
    print("  ", r["where"], "|", r["status"])
    check("Gaia DR3 4472836047939582592" in r["where"], "desktop: the Gaia star's id is shown")
    clean_checks(r, "desktop, G 13.6 star")
    async with pg.expect_download() as dl:
        await pg.click("#spec-csv")
    rows = open(await (await dl.value).path()).read().strip().split("\n")
    check(len(rows) - 1 == len(r["points"]) and rows[0].startswith("wavelength_um,"), f"desktop: CSV has {len(rows) - 1} rows for {len(r['points'])} points")
    await pg.click("#spec-log")
    logged = await pg.evaluate("document.querySelectorAll('#spec-chart circle.pt').length")
    check(logged == sum(1 for p in r["points"] if p["flux"] > 0), f"desktop: log scale draws the {logged} points above zero")
    if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "desktop-star-g13.6.png"))
    await pg.click("#spec-log")
    url = pg.url
    # a drag still re-centres while picking is on
    rc = await pg.evaluate("(() => { const r = document.getElementById('patch').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    await pg.mouse.move(*rc); await pg.mouse.down(); await pg.mouse.move(rc[0] + 120, rc[1] + 40, steps=8); await pg.mouse.up()
    await pg.wait_for_function("__lapse.state.m.key.startsWith('live')", timeout=300000)
    check("spec=" in pg.url and await pg.is_visible("#spec"), f"desktop: a drag in pick mode re-centred on {(await lapse(pg))['key']}; the card and &spec= stay")
    # &spec= reopens it
    await pg.goto(url)
    r2 = await result(pg)
    check(len(r2["points"]) >= 60 and abs(len(r2["points"]) - len(r["points"])) <= 2, f"desktop: &spec= reopened the card with {len(r2['points'])} points")
    # Barnard's Star itself: saturated everywhere, gaps that say so
    await pg.goto(f"{BASE}/timelapse.html?target=barnard")
    await pg.wait_for_function("__lapse.state.m && __lapse.state.m.key === 'barnard'")
    await pg.click("#spec-mode")
    f = await pg.evaluate("(() => { const s = __lapse.state, f = s.m.frames[s.i]; return __spec.screenOfPix(f.x, f.y); })()")
    await pg.mouse.click(*f)
    r3 = await result(pg)
    sat = sum("saturated" in g["why"] for g in r3["gaps"])
    print("  ", r3["where"], "|", r3["status"])
    check("Gaia DR3 4472832130942575872" in r3["where"], "desktop: Barnard's Star is named by its Gaia id")
    check(len(r3["points"]) <= 5 and r3["hollow"] == r3["circles"] == len(r3["points"]) and sat >= 90 and "saturates" in r3["status"] and r3["ticks"] == len(r3["gaps"]),
          f"desktop, Barnard's Star: {len(r3['points'])} points (all hollow), {len(r3['gaps'])} gaps ({sat} saturated), {r3['ticks']} gap ticks, nothing at zero")
    if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "desktop-barnard.png"))
    check(not errs, f"desktop: no page errors {errs[:3]}")
    await ctx.close()


async def phone(b):
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(f"{BASE}/timelapse.html?target=barnard")
    await pg.wait_for_function("__lapse.state.m && __lapse.state.m.key === 'barnard'")
    before = await lapse(pg)
    await pg.tap("#spec-mode")
    await pick(pg, *STAR, touch=True)
    await pg.wait_for_timeout(600)
    check(await lapse(pg) == before, "phone: a tap in pick mode did not re-centre")
    check(await pg.get_attribute(".pv-tabs [data-t=info]", "aria-pressed") == "true" and await pg.is_visible("#spec") and not await pg.is_visible(".pv-desc"),
          "phone: the card opened in the Info tab, in Descriptions' place")
    r = await result(pg)
    clean_checks(r, "phone, G 13.6 star")
    sizes = await pg.evaluate("""() => Object.fromEntries(['#spec-mode', '#spec-close', '#spec-log', '#spec-csv', '.pv-tabs [data-t=info]'].map(s => {
      const b = document.querySelector(s).getBoundingClientRect(); return [s, [Math.round(b.width), Math.round(b.height)]]; }))""")
    check(all(w >= 44 and h >= 44 for w, h in sizes.values()), f"phone: tap targets {sizes}")
    scroll = await pg.evaluate("[document.scrollingElement.scrollHeight, innerHeight, document.scrollingElement.scrollWidth, innerWidth]")
    check(scroll[0] <= scroll[1] and scroll[2] <= scroll[3], f"phone: the page does not scroll (content {scroll[0]} x {scroll[2]}, window {scroll[1]} x {scroll[3]})")
    chart = await pg.evaluate("(() => { const c = document.getElementById('spec-chart').getBoundingClientRect(), p = document.getElementById('spec').getBoundingClientRect(); return [c.top, c.bottom, p.top, p.bottom]; })()")
    check(chart[0] >= chart[2] and chart[1] <= chart[3] + 1, f"phone: the whole chart shows in the panel without scrolling it (chart {chart[0]:.0f}-{chart[1]:.0f}, panel {chart[2]:.0f}-{chart[3]:.0f})")
    if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "phone-star-g13.6.png"))
    await pg.tap("#spec-close")
    check(not await pg.is_visible("#spec") and await pg.is_visible(".pv-desc") and "spec=" not in pg.url, "phone: closing brings Descriptions back and drops &spec=")
    # Barnard's Star on the phone, for the screenshot and the saturated message
    await pg.tap("#spec-mode")
    f = await pg.evaluate("(() => { const s = __lapse.state, f = s.m.frames[s.i]; return __spec.screenOfPix(f.x, f.y); })()")
    await pg.touchscreen.tap(*f)
    r3 = await result(pg)
    check(len(r3["points"]) <= 5 and "saturates" in r3["status"], f"phone, Barnard's Star: {r3['status']}")
    if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "phone-barnard.png"))
    check(not errs, f"phone: no page errors {errs[:3]}")
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        await desktop(b)
        await phone(b)
        await b.close()
    print(f"{len(fails)} failed" if fails else "all passed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
