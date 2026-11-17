"""Browser check of the home page's headline and its link (web/index.html, home variant A "Quiet"), at 1440 x 900,
1280 x 800, 390 x 844 and 320 x 640. Needs the app up (npm run dev).
At each size: the headline and "Start with a real example" are shown in Sansation, inside the window with no scrolling,
clear of the header (logo, nav, account circle) and of the SPHEREx telescope; the art behind each (read with the text
hidden) is dark enough that white text on its brightest 5% has a contrast of at least 4.5. The link opens Barnard's
Star's time-lapse (its manifest loads), and a click on the art still lifts off to Explore.
Run: uv run -q --with playwright python web/tests/home_ui.py [base url] [screenshot dir]   (default http://127.0.0.1:8787)"""
import asyncio, base64, pathlib, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
HEADLINE = "Find objects that move in space, in photos from NASA's SPHEREx telescope."
LINK = "Start with a real example"
SIZES = [("desktop-1440x900", dict(viewport={"width": 1440, "height": 900}, device_scale_factor=2)),
         ("desktop-1280x800", dict(viewport={"width": 1280, "height": 800}, device_scale_factor=2)),
         ("phone-390x844", dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)),
         ("phone-320x640", dict(viewport={"width": 320, "height": 640}, device_scale_factor=2, is_mobile=True, has_touch=True))]
BOX = "sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }"
# brightest 5% of the pixels in a PNG, as relative luminance (WCAG)
LUMA = """async src => { const im = new Image(); im.src = src; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, lin = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4, L = [];
  for (let i = 0; i < d.length; i += 4) L.push(.2126 * lin(d[i]) + .7152 * lin(d[i + 1]) + .0722 * lin(d[i + 2]));
  L.sort((a, b) => a - b); return L[Math.floor(L.length * .95)]; }"""

fails = []
def check(what, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + what + (f"  ({detail})" if detail else ""))
    if not ok: fails.append(what)

def apart(a, b): return a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1]


async def size(b, name, opts):
    ctx = await b.new_context(**opts); pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    await pg.goto(BASE + "/"); await pg.wait_for_selector(".topbar .authbox .av")
    await pg.evaluate("document.fonts.ready"); await pg.wait_for_timeout(500)
    w, h = opts["viewport"]["width"], opts["viewport"]["height"]
    check(f"{name}: the headline reads as written", (await pg.inner_text(".qa h1")).strip() == HEADLINE)
    check(f"{name}: the link reads as written", (await pg.inner_text(".qa .cta")).strip() == LINK)
    fonts = await pg.evaluate("[...document.querySelectorAll('.qa h1, .qa .cta')].map(e => getComputedStyle(e).fontFamily)")
    check(f"{name}: one typeface, the header's Sansation, loaded", all(f.strip('"').startswith('Sansation') for f in fonts)
          and await pg.evaluate("document.fonts.check('300 24px Sansation') && document.fonts.check('400 17px Sansation')"), str(fonts))
    check(f"{name}: the page does not scroll", await pg.evaluate("document.scrollingElement.scrollHeight <= innerHeight"))
    h1, cta = await pg.evaluate(BOX, ".qa h1"), await pg.evaluate(BOX, ".qa .cta")
    head = await pg.evaluate("parseFloat(getComputedStyle(document.querySelector('.topbar')).height)")
    for what, r in [("headline", h1), ("link", cta)]:
        check(f"{name}: the {what} is inside the window, under the header", r[0] >= 0 and r[2] <= w and r[1] >= head and r[3] <= h, f"{[round(v) for v in r]}, header {head:.0f}")
    others = {sel: await pg.evaluate(BOX, sel) for sel in [".topbar .brand-mark", ".topbar nav", ".topbar .authbox", ".craft img"]}
    for sel, r in others.items():
        check(f"{name}: headline and link clear of {sel}", apart(h1, r) and apart(cta, r), f"{[round(v) for v in r]}")
    lines = await pg.evaluate("(() => { const h = document.querySelector('.qa h1'); return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)); })()")
    print(f"     {name}: headline on {lines} lines, link at {[round(v) for v in cta]}")
    if SHOTS: SHOTS.mkdir(parents=True, exist_ok=True); await pg.screenshot(path=str(SHOTS / f"{name}.png"))
    # contrast: the art under each, with the text hidden
    await pg.add_style_tag(content=".qa { visibility: hidden }"); await pg.wait_for_timeout(100)
    for what, r in [("headline", h1), ("link", cta)]:
        png = await pg.screenshot(clip=dict(x=r[0], y=r[1], width=r[2] - r[0], height=r[3] - r[1]))
        L = await pg.evaluate(LUMA, "data:image/png;base64," + base64.b64encode(png).decode())
        ratio = 1.05 / (L + .05)
        check(f"{name}: white {what} on the art behind it has contrast >= 4.5", ratio >= 4.5, f"{ratio:.1f}:1 on its brightest 5%")
    await pg.close()
    # the link opens Barnard's Star's time-lapse
    pg = await ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    await pg.goto(BASE + "/"); await pg.wait_for_selector(".qa .cta")
    async with pg.expect_response(lambda r: "data/flip/barnard/manifest.json" in r.url, timeout=20000) as man:
        await pg.click(".qa .cta")
    check(f"{name}: the link opens Barnard's Star's time-lapse", re.search(r"/timelapse(\.html)?\?target=barnard$", pg.url) and (await man.value).ok, pg.url)
    # the art still lifts off to Explore (a spot on Earth, low in the middle)
    await pg.goto(BASE + "/"); await pg.wait_for_selector(".scene")
    await pg.mouse.click(w * .5, h - 20)
    await pg.wait_for_url(re.compile(r"/explore(\.html)?$"), timeout=5000)   # the Worker serves explore.html as /explore
    check(f"{name}: a click on the art still goes to Explore", True)
    check(f"{name}: no page errors", not errs, "; ".join(errs))
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        for name, opts in SIZES: await size(b, name, opts)
        await b.close()
    print(f"\n{len(fails)} failed" if fails else "\nall passed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
