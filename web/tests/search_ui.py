"""Explore's search box (web/search.js), at 1440 x 900 with a mouse and at 390 x 844 with touch.
Desktop: / and Cmd+K focus the box, arrows move through the suggestions, Enter picks, Escape closes; "269.45 4.69" drops
the pin within 0.1 degrees and puts it in the address (?q=); "08h55m10.8s -07d14m42s" reads as RA 133.795 Dec -7.245;
"271 95" says Dec 95 is off the sky; "barnard" suggests Barnard's Star; "3I/ATLAS" opens its card where its JPL path
(trackAt) has it on the timeline's day; Sesame resolves "Vega" (live, or mocked with --mock-sesame); "planet nine" shows the
no-match message; ?q= opens on the result; the panel and the pin card have straight top rules; targets are 44 px or more.
Phone: the search button opens the box at the top, a result closes the list and opens the sheet or the pin, clear brings
the button back; the four buttons fit in one row at 360 px.
Run: uv run -q --with playwright python web/tests/search_ui.py [base url] [--mock-sesame]   (default http://127.0.0.1:8787)"""
import asyncio, sys
from playwright.async_api import async_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = args[0] if args else "http://127.0.0.1:8787"
MOCK = "--mock-sesame" in sys.argv
# the pin's sky position, from its place on the map (skymap.js inv)
PIN = """async () => { const p = document.getElementById('pin'); if (p.hidden) return null;
  const { inv } = await import('/skymap.js'); const [ra, dec] = inv(parseFloat(p.style.left) / 100, parseFloat(p.style.top) / 100);
  return { ra, dec, name: p.querySelector('.eyebrow').textContent, where: p.querySelector('[data-f=where]').textContent }; }"""
# the featured card's place, against where trackAt has its comet on the timeline's day
CARD = """async () => { const c = document.getElementById('card-comet'), id = c.querySelector('[data-f=id]').textContent;
  const { fwd, trackAt } = await import('/skymap.js'), m = [...document.querySelectorAll('#marks .mk')].find(k => k.comet?.id === id);
  const day = +document.getElementById('time').value, [ra, dec] = trackAt(m.comet.track, day), [u, v] = fwd(ra, dec);
  return { id, hidden: c.hidden || getComputedStyle(c).display === 'none', du: parseFloat(c.style.left) / 100 - u, dv: parseFloat(c.style.top) / 100 - v, day }; }"""
ROWS = "() => [...document.querySelectorAll('#xs-list [data-i]')].map(r => r.textContent.trim())"
BOX = "sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && [r.left, r.top, r.width, r.height]; }"
RULE = """sel => { const s = getComputedStyle(document.querySelector(sel));
  return [s.borderTopWidth, s.borderTopColor, s.borderTopLeftRadius, s.borderTopRightRadius]; }"""


def angle_ok(got, ra, dec, tol):
    return got and abs((got["ra"] - ra + 180) % 360 - 180) <= tol and abs(got["dec"] - dec) <= tol


async def straight(pg, sel):
    w, color, tl, tr = await pg.evaluate(RULE, sel)
    assert w == "2px" and color == "rgb(255, 255, 255)" and tl == "0px" and tr == "0px", f"{sel}: top rule {w} {color}, corners {tl} {tr}"


async def tall(pg, sel, min_px=44):
    for i, b in enumerate(await pg.evaluate(f"() => [...document.querySelectorAll({sel!r})].filter(e => e.offsetParent).map(e => {{ const r = e.getBoundingClientRect(); return [r.width, r.height]; }})")):
        assert b[0] >= min_px - .5 and b[1] >= min_px - .5, f"{sel} #{i} is {b[0]:.0f} x {b[1]:.0f} px"


async def load(pg, path="/explore"):
    await pg.goto(BASE + path)
    await pg.wait_for_function("document.body.dataset.ready === '1' && document.querySelectorAll('#marks .mk.known').length > 10")


async def search(pg, text):
    await pg.fill("#xs-q", text)
    await pg.wait_for_timeout(50)


async def mock(ctx):
    async def answer(route):
        name = route.request.url.split("?", 1)[1]
        body = "%J 279.23473479 +38.78368896 = 18:36:56.33 +38:47:01.2\n" if name.lower() == "vega" else "#! *** Nothing found *** \n"
        await asyncio.sleep(0.4)
        await route.fulfill(status=200, body=body, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "text/plain"})
    await ctx.route("https://cds.unistra.fr/**", answer)


async def desktop(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("localStorage.setItem('ch.tour','1')")
    if MOCK: await mock(ctx)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await load(pg)

    # ---- keys: / focuses, arrows move, Enter picks, Escape closes ----
    await pg.keyboard.press("/")
    assert await pg.evaluate("document.activeElement.id") == "xs-q", "/ did not focus the box"
    assert (await pg.evaluate(ROWS))[0].startswith("Barnard's Star"), "the empty box lists the targets"
    await pg.keyboard.type("269.45 4.69")
    rows = await pg.evaluate(ROWS)
    assert rows[0] == "RA 269.45° Dec +4.69°" and any(r.startswith("Barnard's Star") and "at this spot" in r for r in rows), rows
    assert await pg.get_attribute("#xs-q", "aria-activedescendant") == "xs-o0"
    await pg.keyboard.press("ArrowDown")
    assert await pg.get_attribute("#xs-q", "aria-activedescendant") == "xs-o1", "ArrowDown did not move"
    await pg.keyboard.press("ArrowUp")
    assert await pg.get_attribute("#xs-q", "aria-activedescendant") == "xs-o0", "ArrowUp did not move back"
    await pg.keyboard.press("Enter")
    await pg.wait_for_timeout(800)
    got = await pg.evaluate(PIN)
    assert angle_ok(got, 269.45, 4.69, 0.1), f"pin at {got}"
    assert await pg.is_hidden("#xs-panel"), "the list stayed open after Enter"
    assert "q=269.45+4.69" in pg.url, pg.url
    x, y, w, h = await pg.evaluate(BOX, ".pin-ring")
    assert abs(x + w / 2 - 720) < 60 and 150 < y < 750, f"the map did not fly to the pin: ring at {x:.0f}, {y:.0f}"
    zoom = await pg.evaluate("document.querySelector('.map-wrap').getBoundingClientRect().width")
    print(f"PASS keys + coordinates: / focuses, arrows move, Enter drops the pin at RA {got['ra']:.3f} Dec {got['dec']:.3f}, map flown there ({zoom:.0f} px wide), ?q= in the address")
    await pg.keyboard.press("Meta+k")
    assert await pg.evaluate("document.activeElement.id") == "xs-q" and await pg.is_visible("#xs-panel"), "Cmd+K did not open the box"
    await pg.keyboard.press("Escape")
    assert await pg.is_hidden("#xs-panel") and await pg.is_visible("#pin .pincard"), "Escape should close the list and keep the pin"
    print("PASS Cmd+K focuses, Escape closes the list and keeps the pin")

    # ---- sexagesimal, out of range, a half-typed RA ----
    await pg.click("#xs-q"); await search(pg, "08h55m10.8s -07d14m42s")
    assert (await pg.evaluate(ROWS))[0] == "RA 133.80° Dec -7.25°", await pg.evaluate(ROWS)
    await pg.keyboard.press("Enter"); await pg.wait_for_timeout(100)
    got = await pg.evaluate(PIN)
    assert angle_ok(got, 133.795, -7.245, 0.005), f"pin at {got}"
    print(f"PASS sexagesimal: 08h55m10.8s -07d14m42s reads as RA {got['ra']:.3f} Dec {got['dec']:.3f}")
    await pg.click("#xs-q"); await search(pg, "271 95")
    msg = await pg.text_content("#xs-msg")
    assert msg.startswith("Dec 95 is off the sky.") and "-90 to +90" in msg and not await pg.evaluate(ROWS), msg
    await search(pg, "08h55m10.8s")
    assert "That reads as RA 133.80°. Add the Dec." in await pg.text_content("#xs-msg")
    print("PASS out of range: 271 95 says Dec 95 is off the sky; one value asks for the Dec")

    # ---- names: a target, a comet ----
    await search(pg, "barnard")
    rows = await pg.evaluate(ROWS)
    assert rows[0] == "Barnard's Star", rows
    assert await pg.text_content("#xs-o0 b") == "Barnard", "the matched part is not bold"
    await search(pg, "eps Ind B")
    assert (await pg.evaluate(ROWS))[0].startswith("Epsilon Indi B"), await pg.evaluate(ROWS)
    print("PASS names: barnard suggests Barnard's Star, eps Ind B finds Epsilon Indi B")
    await search(pg, "3I/ATLAS"); await pg.keyboard.press("Enter")
    await pg.wait_for_timeout(800)
    card = await pg.evaluate(CARD)
    assert card["id"] == "3I/ATLAS" and not card["hidden"] and abs(card["du"]) < 1e-4 and abs(card["dv"]) < 1e-4, card
    x, y, w, h = await pg.evaluate(BOX, "#marks .mk.sel i")
    assert 300 < x < 1140 and 150 < y < 750, f"the map did not fly to 3I/ATLAS: dot at {x:.0f}, {y:.0f}"
    print(f"PASS comet: 3I/ATLAS opens its card at its trackAt place on day {card['day']}, and the map flies there")
    # another comet takes the card
    await pg.click("#xs-q"); await search(pg, "Tsuchinshan"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(700)
    card = await pg.evaluate(CARD)
    assert card["id"] == "C/2023 A3 (Tsuchinshan-ATLAS)" and abs(card["du"]) < 1e-4, card
    print("PASS comet: C/2023 A3 (Tsuchinshan-ATLAS) takes over the card")

    # ---- Sesame, then no match ----
    await pg.click("#xs-q"); await search(pg, "Vega")
    rows = await pg.evaluate(ROWS)
    assert rows[0].startswith('Look up "Vega"'), rows
    await pg.keyboard.press("Enter")
    await pg.wait_for_function("document.getElementById('xs-msg').textContent.includes('Looking') || !document.getElementById('pin').hidden && document.querySelector('#pin .eyebrow').textContent === 'Vega'", timeout=3000)
    await pg.wait_for_function("!document.getElementById('pin').hidden && document.querySelector('#pin .eyebrow').textContent === 'Vega'", timeout=8000)
    got = await pg.evaluate(PIN)
    assert angle_ok(got, 279.2347, 38.7837, 0.1), got
    print(f"PASS Sesame ({'mocked' if MOCK else 'live'}): Vega resolves to RA {got['ra']:.3f} Dec {got['dec']:.3f} and drops a pin named Vega")
    await pg.click("#xs-q"); await search(pg, "planet nine"); await pg.keyboard.press("Enter")
    await pg.wait_for_function("document.getElementById('xs-msg').textContent.startsWith('Nothing called \"planet nine\".')", timeout=9000)
    print("PASS no match: planet nine says Nothing called \"planet nine\" after the catalog lookup")

    # ---- look: straight top rules, 44 px ----
    await pg.click("#xs-q"); await search(pg, "atlas")
    await straight(pg, ".xs-panel"); await straight(pg, "#pin .pincard")
    await tall(pg, "#xs-list [data-i]"); await tall(pg, "#xs-clear")
    assert (await pg.evaluate(BOX, "#xsearch"))[3] == 44
    lx = (await pg.evaluate(BOX, "#xsearch"))[0]
    assert lx == (await pg.evaluate(BOX, "#layers > summary"))[0], "the box is not on the Layers column"
    print("PASS look: panel and pin card have straight white top rules; the box is 44 px on the Layers column; rows and clear 44 px")
    await pg.keyboard.press("Escape")

    # ---- ?q= ----
    for q, check in [("269.45+4.69", lambda p, c: angle_ok(p, 269.45, 4.69, 0.1)),
                     ("Barnard's+Star", lambda p, c: p and p["name"] == "Barnard's Star" and angle_ok(p, 269.4463, 4.7671, 0.01)),
                     ("08h55m10.8s+-07d14m42s", lambda p, c: angle_ok(p, 133.795, -7.245, 0.005)),
                     ("3I/ATLAS", lambda p, c: c["id"] == "3I/ATLAS" and abs(c["du"]) < 1e-4)]:
        await load(pg, "/explore?q=" + q)
        await pg.wait_for_timeout(900)
        p, c = await pg.evaluate(PIN), await pg.evaluate(CARD)
        assert check(p, c), f"?q={q}: pin {p}, card {c}"
        assert await pg.input_value("#xs-q") == q.replace("+", " "), "the box does not show the search"
        assert not await pg.evaluate("document.getElementById('play').classList.contains('on')"), f"?q={q}: the replay started over the result"
    print("PASS ?q=: coordinates, a target, sexagesimal and a comet open on their result, with no replay")
    assert not errors, errors
    await ctx.close()


async def phone(b):
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await load(pg)
    assert await pg.is_hidden("#xsearch"), "the box shows before the button is tapped"
    await tall(pg, "#xs-open")
    await pg.tap("#xs-open")
    assert await pg.evaluate("document.body.classList.contains('xs-typing') && document.activeElement.id === 'xs-q'"), "the button did not open the box"
    x, y, w, h = await pg.evaluate(BOX, "#xsearch")
    assert y < 130 and w > 350 and h == 44, f"the box is not full width at the top: {x, y, w, h}"
    await tall(pg, "#xs-back"); await straight(pg, ".xs-panel")
    await search(pg, "atlas")
    rows = await pg.evaluate(ROWS)
    assert rows[0] == "3I/ATLASCO2 glow", rows
    await tall(pg, "#xs-list [data-i]"); await tall(pg, "#xs-clear")
    await pg.tap("#xs-o0"); await pg.wait_for_timeout(600)
    assert await pg.is_visible("#csheet") and await pg.text_content("#csheet [data-f=name]") == "3I/ATLAS", "3I/ATLAS did not open its sheet"
    assert await pg.evaluate("!document.body.classList.contains('xs-typing')") and await pg.is_hidden("#xs-panel"), "the result left the list open"
    assert await pg.is_visible("#xsearch") and await pg.input_value("#xs-q") == "3I/ATLAS", "the box should keep what was found at the top"
    print("PASS phone: the button opens the box at the top; 3I/ATLAS closes the list and opens its sheet; box, back, clear, rows 44 px or more")
    await pg.tap("#xs-clear"); await pg.wait_for_timeout(100)
    assert await pg.is_hidden("#xsearch"), "clear did not bring back the plain map"
    await pg.tap("#csheet .sheet-x"); await pg.wait_for_timeout(300)
    assert await pg.is_visible("#xs-open"), "the search button did not come back"
    await pg.tap("#xs-open"); await search(pg, "269.45 4.69"); await pg.tap("#xs-o0"); await pg.wait_for_timeout(800)
    got = await pg.evaluate(PIN)
    assert angle_ok(got, 269.45, 4.69, 0.1), got
    x, y, w, h = await pg.evaluate(BOX, "#pin .pincard")
    assert x >= 0 and x + w <= 390 and y > 60 and y + h < 844 - 96, f"the pin card is off screen: {x, y, w, h}"
    await tall(pg, "#pin .pincard .x"); await tall(pg, "#pin .pincard .btn")
    await straight(pg, "#pin .pincard")
    print(f"PASS phone: coordinates drop the pin at RA {got['ra']:.3f} Dec {got['dec']:.3f} with its card on screen")
    await pg.tap("#xs-q"); await pg.tap("#xs-back")
    assert await pg.is_hidden("#xsearch") and await pg.is_visible("#xs-open"), "back did not return to the map"
    assert not errors, errors
    await ctx.close()

    for width in (360, 390):   # the four buttons in one row
        ctx = await b.new_context(viewport={"width": width, "height": 740}, has_touch=True, is_mobile=True)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page(); await load(pg)
        boxes = [await pg.evaluate(BOX, s) for s in ("#examples > summary", "#layers > summary", "#xs-open", "#whole")]
        assert all(bx[0] >= 0 and bx[0] + bx[2] <= width for bx in boxes), f"{width} px: a button leaves the screen {boxes}"
        assert all(boxes[i][0] + boxes[i][2] <= boxes[i + 1][0] for i in range(3)), f"{width} px: buttons overlap {boxes}"
        assert max(bx[1] + bx[3] for bx in boxes) - min(bx[1] + bx[3] for bx in boxes) < 1, f"{width} px: not one row {boxes}"
        await ctx.close()
    print("PASS phone: Examples, Layers, search and whole sky fit in one row at 360 and 390 px")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        await desktop(b)
        await phone(b)
        await b.close()

asyncio.run(main())
