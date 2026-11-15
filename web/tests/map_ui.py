"""Browser check that a comet sits in the same place on Explore and on its own page, in headless Chrome. Needs the app up (npm run dev).
For known comets on three timeline days: Explore's link carries the day, the comet page's mini map puts its dot where Explore
drew the comet (within 1% of the map's width and height) and shows that date, and "Find on map" lands back on Explore on
that day with the comet in the same place, named. Also: no ?day= means the timeline's default day, an example comet keeps
its fixed place, and a comet too faint to show on Explore still shows when found from its page. Then the edges: every
link follows the timeline, a click during the replay opens the day that was clicked, paths split where they cross the
map's edge, empty and one-point paths, and no page-to-page transition for people who ask for less motion.
Run: uv run -q --with playwright python web/tests/map_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, datetime, json, math, re, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DAYS, DEFAULT, TOL = [529, 300, 120], 529, 0.01
MJD0 = 60789   # day 0 of the timeline (web/data/coverage.json)

# where the centre of `dot` is inside `box`, as fractions of the box's width and height (what the user sees)
FRAC = """([box, dot]) => { const b = box.getBoundingClientRect(), d = dot.getBoundingClientRect();
  return [(d.left + d.width / 2 - b.left) / b.width, (d.top + d.height / 2 - b.top) / b.height]; }"""
# every known comet Explore is showing: [name, link, place on the map]
SHOWN = """() => { const map = document.getElementById('map').getBoundingClientRect();
  return [...document.querySelectorAll('.mk.known[href]')].filter(a => { const s = getComputedStyle(a); return s.display !== 'none' && s.visibility !== 'hidden'; })
    .map(a => { const d = a.querySelector('i').getBoundingClientRect();
      return [a.querySelector('b')?.textContent ?? '', a.getAttribute('href'), [(d.left + d.width / 2 - map.left) / map.width, (d.top + d.height / 2 - map.top) / map.height]]; }); }"""


def date_text(day):   # "Oct 5, 2026"
    d = datetime.date(1858, 11, 17) + datetime.timedelta(days=MJD0 + day)
    return f"{d:%b} {d.day}, {d.year}"


def mollweide(ra, dec):   # an independent copy of the map's projection, to check the RA/Dec text against the dot
    lon, lat = math.radians(((-ra + 180) % 360) - 180), math.radians(dec)
    t = lat
    for _ in range(50):
        if abs(dec) > 89.9: break
        t -= (2 * t + math.sin(2 * t) - math.pi * math.sin(lat)) / (2 + 2 * math.cos(2 * t))
    return [(lon * math.cos(t) / math.pi + 1) / 2, (1 - math.sin(t)) / 2]


def close(a, b, tol=TOL):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


async def explore(pg, url):
    await pg.goto(BASE + url)
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.known", state="attached")
    return int(await pg.eval_on_selector("#time", "e => e.value")), (await pg.text_content("#t-date")).strip()


async def comet_page(pg, url, name, want, day, why):
    """Open a comet's page: its dot must be at `want`; with a day, the page must show that date. Returns the dot's place."""
    await pg.goto(BASE + "/" + url); await pg.wait_for_selector("#c-mini-dot:not([hidden])", state="attached")
    assert (await pg.text_content("#c-id")) == name, f"{why}: {url} opened {await pg.text_content('#c-id')}"
    got = await pg.evaluate(FRAC, [await pg.query_selector("#c-mini"), await pg.query_selector("#c-mini-dot")])
    assert close(got, want), f"{why}: {name} is at {got} on its page, {want} on Explore"
    ra, dec = map(float, re.match(r"RA ([\d.]+)\D+Dec ([+-][\d.]+)", await pg.text_content("#c-where")).groups())
    assert close(mollweide(ra, dec), got), f"{why}: {name} says RA {ra} Dec {dec}, which is not where its dot is"
    shown = (await pg.text_content("#c-when")).strip()
    assert shown == (date_text(day) if day is not None else ""), f"{why}: {name} shows the date '{shown}', expected day {day}"
    return got


async def find_on_map(pg, name, want, day, why):
    """Press "Find on map": Explore must open on `day` with the comet at `want`, showing and named."""
    assert (await pg.text_content("#c-find")).strip() == "Find on map", f"{why}: the button says '{await pg.text_content('#c-find')}'"
    await pg.click("#c-find")
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.focus", state="attached")
    assert int(await pg.eval_on_selector("#time", "e => e.value")) == day, f"{why}: Find on map for {name} opened the wrong day"
    mk = pg.locator(".mk.focus")
    assert await mk.count() == 1 and await mk.locator("i").is_visible(), f"{why}: {name} does not show after Find on map"
    assert await mk.locator("b").is_visible() and await mk.locator("b").text_content() == name, f"{why}: {name} is not named after Find on map"
    box = await mk.locator("b").bounding_box(); vp = pg.viewport_size
    assert box["x"] >= 0 and box["x"] + box["width"] <= vp["width"], f"{why}: {name}'s name runs off the screen"
    got = await pg.evaluate(FRAC, [await pg.query_selector("#map"), await mk.locator("i").element_handle()])
    assert close(got, want), f"{why}: Find on map put {name} at {got}, expected {want}"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
        ex, pg = await ctx.new_page(), await ctx.new_page()

        for day in DAYS:
            got_day, label = await explore(ex, "/explore.html" if day == DEFAULT else f"/explore.html?day={day}")
            assert got_day == day, f"Explore opened on day {got_day}, expected {day}"
            assert date_text(day).startswith(label + ","), f"Explore's timeline says {label} on day {day}, expected {date_text(day)}"
            shown = await ex.evaluate(SHOWN)
            assert shown, f"day {day}: Explore shows no known comet"
            for name, href, at in shown:
                assert href == f"comet.html?id={urllib.parse.quote(name, safe='()')}&day={day}", f"day {day}: {name} links to {href}"
                dot = await comet_page(pg, href, name, at, day, f"day {day}")
                await find_on_map(pg, name, dot, day, f"day {day}")
            print(f"PASS day {day} ({date_text(day)}): {len(shown)} known comets sit in the same place on Explore, on their page and after Find on map")
            if day == DEFAULT:   # the same pages without ?day=
                for name, href, at in shown:
                    dot = await comet_page(pg, href.split("&day=")[0], name, at, DEFAULT, "no day")
                    await find_on_map(pg, name, dot, DEFAULT, "no day")
                print(f"PASS no day: {len(shown)} comet pages without ?day= use day {DEFAULT} ({date_text(DEFAULT)})")

        # moving the timeline changes the day the links carry
        await explore(ex, "/explore.html")
        await ex.focus("#play"); await ex.keyboard.press("PageDown"); await ex.wait_for_timeout(200)
        hrefs = await ex.eval_on_selector_all('#marks a[href^="comet.html"]', "as => as.map(a => a.getAttribute('href'))")
        assert len(hrefs) >= 78 and all(h.endswith(f"&day={DEFAULT - 30}") for h in hrefs), "links do not follow the timeline"   # 72 known, 5 example, the card
        print(f"PASS timeline: after moving back 30 days all {len(hrefs)} comet links (example comets and the card too) carry day {DEFAULT - 30}")

        # a comet too faint for Explore to show on a day still shows, dimmed, when found from its page
        await explore(ex, "/explore.html?day=120")
        hidden = await ex.eval_on_selector_all(".mk.known[hidden]", "as => as.map(a => [a.querySelector('b').textContent, a.getAttribute('href')])")
        assert hidden, "day 120: no faint comet to test with"
        name, href = hidden[0]
        await pg.goto(BASE + "/" + href); await pg.wait_for_selector("#c-mini-dot:not([hidden])", state="attached")
        dot = await pg.evaluate(FRAC, [await pg.query_selector("#c-mini"), await pg.query_selector("#c-mini-dot")])
        await find_on_map(pg, name, dot, 120, "faint")
        assert await pg.locator(".mk.focus.faint").count() == 1, f"{name} is not dimmed while too faint to see"
        print(f"PASS faint: {name}, hidden on Explore on day 120, shows dimmed and named after Find on map")

        # an example comet has no path: it stays where Explore draws it, with no date
        await explore(ex, "/explore.html")
        at = await ex.evaluate(FRAC, [await ex.query_selector("#map"), await ex.query_selector('.mk.comet[href^="comet.html?id=C-0147"] i')])
        dot = await comet_page(pg, "comet.html?id=C-0147", "C-0147", at, None, "example")
        await find_on_map(pg, "C-0147", dot, DEFAULT, "example")
        dot = await comet_page(pg, "comet.html?id=C-0147&day=120", "C-0147", at, None, "example, day 120")
        await find_on_map(pg, "C-0147", dot, 120, "example, day 120")
        await explore(ex, "/explore.html?day=300")   # its link carries the day too, so the round trip comes back to that day
        href = await ex.get_attribute('.mk.comet[href^="comet.html?id=C-0147"]', "href")
        assert href == "comet.html?id=C-0147&day=300", f"C-0147 links to {href} on day 300"
        dot = await comet_page(pg, href, "C-0147", at, None, "example, from day 300")
        await find_on_map(pg, "C-0147", dot, 300, "example, from day 300")
        print("PASS example comet C-0147 keeps its fixed place on its page and after Find on map, and its link keeps the day")

        # a click while the replay runs opens the day that was clicked, once, however many clicks follow
        await explore(ex, "/explore.html")
        await ex.click("#play"); await ex.wait_for_function("+document.getElementById('time').value > 100 && document.querySelector('.mk.known:not([hidden])')")
        clicked = await ex.evaluate("""() => { const all = [...document.querySelectorAll('.mk.known:not([hidden])')].filter(a => getComputedStyle(a).visibility !== 'hidden');
            const a = all[0], href = a.getAttribute('href'); a.click(); a.click(); (all[1] ?? a).click(); return href; }""")
        await ex.wait_for_selector("#c-mini-dot:not([hidden])", state="attached")
        want_day = int(clicked.split("&day=")[1]); landed = urllib.parse.urlparse(ex.url)
        assert urllib.parse.parse_qs(landed.query) == urllib.parse.parse_qs(clicked.split("?")[1]), f"clicked {clicked} during the replay, landed on {ex.url}"
        assert (await ex.text_content("#c-when")).strip() == date_text(want_day), "the page opened from the replay shows another date"
        await ex.wait_for_timeout(600); assert ex.url.endswith(landed.query), "a second click navigated again"
        print(f"PASS replay: a click on day {want_day} while the timeline was moving opened day {want_day}, once")

        # keyboard Enter on a comet still opens its page
        await explore(ex, "/explore.html?day=300")
        mk = ex.locator(".mk.known:not([hidden])").first; href = await mk.get_attribute("href")
        await mk.focus(); await ex.keyboard.press("Enter"); await ex.wait_for_selector("#c-mini-dot:not([hidden])", state="attached")
        assert ex.url.endswith(href.split("?")[1]), f"Enter on {href} opened {ex.url}"
        print("PASS keyboard: Enter on a comet opens its page on the timeline's day")

        # every path: no line across the map where it crosses the edge, and the comet's dot is on the line
        await pg.goto(BASE + "/comet.html?id=C-0147")
        bad, split = await pg.evaluate("""async () => { const m = await import('/skymap.js'), { comets } = await (await fetch('/api/comets')).json(), bad = [], split = [];
            for (const c of comets.filter(c => c.track?.length)) {
              const subs = m.trackPath(c.track).split('M').filter(Boolean).map(s => s.split('L').map(p => p.split(' ').map(Number)));
              if (subs.length > 1) split.push(c.id);
              for (const s of subs) for (let i = 1; i < s.length; i++) if (Math.abs(s[i][0] - s[i - 1][0]) > 100 || Math.abs(s[i][1] - s[i - 1][1]) > 100) { bad.push(c.id + ': a line jumps across the map'); break; }
              for (const day of [0, 5, 120, 300, 525, 529]) { const [ra, dec] = m.trackAt(c.track, day), [u, v] = m.fwd(ra, dec);
                if (!subs.flat().some(p => Math.hypot(p[0] - u * 2000, p[1] - v * 1000) < 1.5)) bad.push(c.id + ': the dot is off the path on day ' + day); } }
            return [bad, split]; }""")
        assert not bad, f"paths: {bad[:5]}"
        assert "C/2025 E1 (PANSTARRS)" in split, "C/2025 E1 (PANSTARRS) crosses the map's edge near the pole but its path is not split there"
        await pg.goto(BASE + "/comet.html?id=" + urllib.parse.quote("C/2025 E1 (PANSTARRS)", safe="") + "&day=525"); await pg.wait_for_selector("#c-mini-dot:not([hidden])", state="attached")
        d = await pg.get_attribute("#c-mini-path", "d")
        dot = await pg.evaluate(FRAC, [await pg.query_selector("#c-mini"), await pg.query_selector("#c-mini-dot")])
        pts = [tuple(map(float, p.split())) for sub in d.split("M") if sub for p in sub.split("L")]
        assert d.count("M") > 1 and min(math.hypot(x - dot[0] * 2000, y - dot[1] * 1000) for x, y in pts) < 3, "C/2025 E1 (PANSTARRS): the page's dot is not on its drawn path"
        print(f"PASS paths: all known comets' paths are unbroken lines with the dot on them; {len(split)} are split at the map's edge, C/2025 E1 (PANSTARRS) among them")

        # an empty path is no path (fixed place, the rest of the page still loads); a one-point path is that point
        async def with_track(route, track):
            r = await route.fetch(); c = await r.json(); c["track"] = track
            await route.fulfill(response=r, body=json.dumps(c))
        one = "**/api/comets/" + urllib.parse.quote("C/2026 P3 (SWAN)", safe="()")
        await pg.route(one, lambda route: with_track(route, []))
        await comet_page(pg, "comet.html?id=" + urllib.parse.quote("C/2026 P3 (SWAN)", safe="()") + "&day=300", "C/2026 P3 (SWAN)", mollweide(26.7423, -56.9647), None, "empty path")
        assert "photographed it" in await pg.text_content("#c-empty") and (await pg.text_content("#t-head")).strip(), "empty path: the rest of the page did not load"
        await pg.unroute(one); await pg.route(one, lambda route: with_track(route, [[40, 10, 20, 15]]))
        await comet_page(pg, "comet.html?id=" + urllib.parse.quote("C/2026 P3 (SWAN)", safe="()") + "&day=300", "C/2026 P3 (SWAN)", mollweide(10, 20), 300, "one-point path")
        await pg.unroute(one)
        async def list_tracks(route):
            r = await route.fetch(); j = await r.json(); known = [c for c in j["comets"] if c.get("track")]
            known[0]["track"] = []; known[1]["track"] = [[40, 10, 20, 15]]
            await route.fulfill(response=r, body=json.dumps(j))
        await ex.route("**/api/comets", list_tracks)
        await explore(ex, "/explore.html?day=300")
        hrefs = await ex.eval_on_selector_all('#marks a[href^="comet.html"]', "as => as.map(a => a.getAttribute('href'))")
        assert len(hrefs) >= 78 and all(h.endswith("&day=300") for h in hrefs) and len(await ex.evaluate(SHOWN)) >= 12, "Explore stopped placing comets when one path was empty"
        await ex.unroute("**/api/comets")
        print("PASS odd paths: an empty path keeps the fixed place and the page still loads, a one-point path is that point, Explore carries on")

        # the page-to-page transition: the map glides into the mini map, and not at all for people who ask for less motion
        seen = {}
        for motion in ("no-preference", "reduce"):
            c2 = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion=motion)
            await c2.add_init_script("""try { localStorage.setItem('ch.tour', '1') } catch {}
                addEventListener('pageswap', e => sessionStorage.setItem('swap', String(!!e.viewTransition)));
                addEventListener('pagereveal', e => { if (!e.viewTransition) return; window.vtGroups = [];
                  e.viewTransition.ready.then(() => { window.vtGroups = [...new Set(document.getAnimations().map(a => a.effect?.pseudoElement).filter(Boolean))]; }); });""")
            p2 = await c2.new_page(); await explore(p2, "/explore.html")
            await p2.locator(".mk.known:not([hidden]) i").first.click(); await p2.wait_for_selector("#c-mini-dot:not([hidden])", state="attached"); await p2.wait_for_timeout(300)
            seen[motion] = [await p2.evaluate("sessionStorage.getItem('swap')"), await p2.evaluate("window.vtGroups ?? null")]
            await c2.close()
        assert seen["reduce"] == ["false", None], f"less motion: a page transition still ran {seen['reduce']}"
        assert seen["no-preference"][0] == "true" and "::view-transition-group(sky)" in (seen["no-preference"][1] or []), f"the map did not glide into the mini map {seen['no-preference']}"
        print("PASS transition: the Explore map glides into the comet page's mini map; with less motion asked for, no page transition runs")
        await b.close()

try:
    asyncio.run(main())
except AssertionError as e:
    print("FAIL", e); sys.exit(1)
