"""Browser check of Explore's Faint comets layer, in headless Chrome. Needs the app up (npm run dev).
Off (the default): the known comets shown are exactly the ones bright enough on the day (magnitude 16 or brighter) plus
3I/ATLAS. On: all 72 known comets have a marker on the default day, on day 120 and after the timeline moves, the faint
ones dimmer and smaller, each where skymap.js puts it (within 1%), named on hover and keyboard focus, linking to its
page with &day=. The choice is kept across reloads (localStorage), and the bright comets are the same either way.
Run: uv run -q --with playwright python web/tests/explore_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DEFAULT, TOL = 529, 0.01

# every known comet marker on screen: name, link, speck or not, dot opacity and width, place on the map
SHOWN = """() => { const map = document.getElementById('map').getBoundingClientRect();
  return [...document.querySelectorAll('.mk.known[href]')].filter(a => { const s = getComputedStyle(a); return s.display !== 'none' && s.visibility !== 'hidden'; })
    .map(a => { const i = a.querySelector('i'), d = i.getBoundingClientRect();
      return { name: a.querySelector('b')?.textContent ?? '', href: a.getAttribute('href'), speck: a.classList.contains('speck'),
               op: +getComputedStyle(i).opacity, w: d.width, at: [(d.left + d.width / 2 - map.left) / map.width, (d.top + d.height / 2 - map.top) / map.height] }; }); }"""
# what skymap.js says for every known comet on a day: name -> [u, v, magnitude]
EXPECT = """async day => { const m = await import('/skymap.js'), { comets } = await (await fetch('/api/comets')).json();
  return Object.fromEntries(comets.filter(c => c.kind === 'known').map(c => { const [ra, dec, mag] = m.trackAt(c.track, day); return [c.id, [...m.fwd(ra, dec), mag]]; })); }"""


async def explore(pg, url):
    await pg.goto(BASE + url)
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.known", state="attached")
    await pg.evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))")   # the map scales in


async def check_day(pg, day, why):
    """Faint comets on: every known comet has a marker at skymap.js's place, the faint ones as specks. Returns the markers."""
    shown, want = await pg.evaluate(SHOWN), await pg.evaluate(EXPECT, day)
    names = {s["name"] for s in shown}
    assert len(want) == 72 and names == set(want), f"{why}: {len(names)} of {len(want)} known comets have a marker, missing {set(want) - names}"
    for s in shown:
        u, v, mag = want[s["name"]]
        assert abs(s["at"][0] - u) <= TOL and abs(s["at"][1] - v) <= TOL, f"{why}: {s['name']} is at {s['at']}, skymap.js puts it at {[u, v]}"
        assert s["href"] == f"comet.html?id={urllib.parse.quote(s['name'], safe='()')}&day={day}", f"{why}: {s['name']} links to {s['href']}"
        faint = mag is None or mag > 16
        assert s["speck"] == (faint and s["name"] != "3I/ATLAS"), f"{why}: {s['name']} (magnitude {mag}) speck={s['speck']}"
    bright, specks = [s for s in shown if not s["speck"] and s["name"] != "3I/ATLAS"], [s for s in shown if s["speck"]]
    assert specks, f"{why}: no faint comet to test with"
    if bright:
        assert max(s["op"] for s in specks) < min(s["op"] for s in bright) and max(s["w"] for s in specks) < min(s["w"] for s in bright), \
            f"{why}: specks are not dimmer and smaller than the visible dots"
    return shown, specks


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
        pg = await ctx.new_page()

        # off by default: exactly the comets bright enough on the day, plus 3I/ATLAS (always findable, dimmed)
        for day in [DEFAULT, 120]:
            await explore(pg, "/explore.html" if day == DEFAULT else f"/explore.html?day={day}")
            assert not await pg.is_checked("#ly-faint"), "Faint comets is on by default"
            shown, want = await pg.evaluate(SHOWN), await pg.evaluate(EXPECT, day)
            bright = {n for n, (u, v, m) in want.items() if m is not None and m <= 16} | {"3I/ATLAS"}
            assert {s["name"] for s in shown} == bright and not any(s["speck"] for s in shown), f"day {day}: off shows {sorted(s['name'] for s in shown)}, expected {sorted(bright)}"
            print(f"PASS off, day {day}: the {len(shown)} known comets shown are the ones bright enough (and 3I/ATLAS), no specks")
            off = {s["name"]: s for s in shown}
            await pg.click("#layers > summary"); await pg.click("label:has(#ly-faint)"); await pg.keyboard.press("Escape")
            shown, specks = await check_day(pg, day, f"on, day {day}")
            for s in shown:   # the comets visible anyway are unchanged
                if s["name"] in off: assert s == off[s["name"]], f"day {day}: {s['name']} changed with the layer on: {off[s['name']]} -> {s}"
            print(f"PASS on, day {day}: all {len(shown)} known comets have a marker where skymap.js puts them, {len(specks)} faint ones dimmer and smaller; the bright ones unchanged")
            await pg.click("#layers > summary"); await pg.click("label:has(#ly-faint)"); await pg.keyboard.press("Escape")
            assert {s["name"] for s in await pg.evaluate(SHOWN)} == bright, f"day {day}: switching off does not hide the specks"

        # kept across reloads, the way it was left; and it follows the timeline
        await pg.click("#layers > summary"); await pg.click("label:has(#ly-faint)"); await pg.keyboard.press("Escape")
        await explore(pg, "/explore.html")
        assert await pg.is_checked("#ly-faint"), "Faint comets on is not kept after a reload"
        await pg.focus("#play"); await pg.keyboard.press("PageDown"); await pg.keyboard.press("PageDown"); await pg.wait_for_timeout(200)
        day = int(await pg.eval_on_selector("#time", "e => e.value")); assert day == DEFAULT - 60
        _, specks = await check_day(pg, day, f"after moving the timeline to day {day}")
        print(f"PASS kept: on after a reload; after moving the timeline to day {day} every marker follows skymap.js")

        # a speck is named on keyboard focus and on hover, and opens its comet page on the day
        await explore(pg, "/explore.html?day=120")
        mk = pg.locator(".mk.known.speck:not([hidden])").first
        name, href = await mk.locator("b").text_content(), await mk.get_attribute("href")
        assert not await mk.locator("b").is_visible(), f"{name}'s name shows before hover"
        await pg.focus("#play"); await pg.keyboard.press("Shift+Tab"); await mk.focus()
        assert await mk.locator("b").is_visible(), f"{name}'s name does not show on keyboard focus"
        await pg.mouse.move(0, 0); await mk.evaluate("e => e.blur()"); await mk.locator("i").hover()
        assert await mk.locator("b").is_visible(), f"{name}'s name does not show on hover"
        await mk.locator("i").click()
        await pg.wait_for_url(lambda u: "/comet" in u and u.endswith(href.split("?")[1])); await pg.wait_for_selector("#c-id")
        assert (await pg.text_content("#c-id")) == name and href.endswith("&day=120"), f"{name}'s speck opened {pg.url}"
        print(f"PASS speck: {name} named on focus and hover, opens {href}")

        await explore(pg, "/explore.html")
        await pg.click("#layers > summary"); await pg.click("label:has(#ly-faint)"); await pg.keyboard.press("Escape")
        await explore(pg, "/explore.html")
        assert not await pg.is_checked("#ly-faint"), "Faint comets off is not kept after a reload"
        print("PASS kept: off after a reload")
        await b.close()
    print("ALL PASS")

asyncio.run(main())
