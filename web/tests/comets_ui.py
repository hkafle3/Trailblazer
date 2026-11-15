"""Browser check for the Comets tab (shelves), the sky's hover names, page titles and the comet page's width, in headless
Chrome. Needs the app up (npm run dev). Expected values come from GET /api/comets and skymap.js, never from the page.
Run: uv run -q --with playwright python web/tests/comets_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DAY = 529   # Explore's default day (skymap.js LAST_DAY)
EXPECT = {"3I/ATLAS": "detected", "C/2025 R2 (SWAN)": "detected", "C/2026 A2 (Bok)": "detected",
          "C/2024 T5 (ATLAS)": "unclear", "210P/Christensen": "unclear", "P/2021 N1 (ZTF)": "unclear",
          "C/2024 G3 (ATLAS)": "unclear", "C/2023 A3 (Tsuchinshan-ATLAS)": "unclear",
          "C/2023 R1 (PANSTARRS)": "unclear", "C/2025 K1 (ATLAS)": "unclear"}   # migration 0012
LABEL = {"detected": "CO2 glow", "unclear": "No clear signal", "quiet": "No gas glow"}
PAGES = ["/", "/explore", "/comet", "/comet?id=3I%2FATLAS", "/forums", "/timelapse", "/guide"]
shelf = lambda c: "m" if c.get("co2") else "f" if c.get("faint") else "o"

# what the page shows: every shelf's ids in order, its count, and whether the shelf is shown
READ = """() => Object.fromEntries(['m', 'o', 'f'].map(k => { const s = document.getElementById('s-' + k);
  return [k, { n: +s.querySelector('.n').textContent, shown: !s.hidden,
    ids: [...s.querySelectorAll('[data-id]')].map(e => e.dataset.id) }]; }))"""
# where skymap.js puts each comet on a day, and which region filters keep it (computed here, not read from the page)
PLACES = """async ([day]) => { const m = await import('/skymap.js'), { comets } = await (await fetch('/api/comets')).json(), R = Math.PI / 180;
  return Object.fromEntries(comets.filter(c => c.kind === 'known' && c.real).map(c => {
    const [ra, dec] = m.trackAt(c.track, day) ?? [c.ra, c.dec], beta = Math.asin(Math.sin(dec * R) * Math.cos(23.44 * R) - Math.cos(dec * R) * Math.sin(23.44 * R) * Math.sin(ra * R)) / R;
    return [c.id, { uv: m.fwd(ra, dec), north: dec >= 0, south: dec < 0, ecliptic: Math.abs(beta) < 15 }]; })); }"""
# visible elements of <main> that stick out of the window, and horizontal page overflow
CLIPPED = """() => { const W = innerWidth, out = [];
  for (const e of document.querySelectorAll('main *')) { const r = e.getBoundingClientRect();
    if (r.width && r.height && getComputedStyle(e).visibility !== 'hidden' && (r.right > W + 1 || r.left < -1)) out.push(e.id || e.className || e.tagName); }
  return { overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - W, out: out.slice(0, 5) }; }"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
        pg = await ctx.new_page()
        api = (await (await ctx.request.get(BASE + "/api/comets")).json())["comets"]
        known = [c for c in api if c["kind"] == "known" and c["real"]]
        by = {c["id"]: c for c in known}
        want = {k: {c["id"] for c in known if shelf(c) == k} for k in "mof"}

        # every known comet on exactly one shelf, the right one; counts from the data
        await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-m .card")
        got = await pg.evaluate(READ)
        ids = got["m"]["ids"] + got["o"]["ids"] + got["f"]["ids"]
        assert sorted(ids) == sorted(by), f"{len(ids)} entries for {len(by)} known comets, or a comet twice"
        for k in "mof":
            assert set(got[k]["ids"]) == want[k], f"shelf {k}: {set(got[k]['ids']) ^ want[k]}"
            assert got[k]["n"] == len(want[k]), f"shelf {k} says {got[k]['n']}, data has {len(want[k])}"

        # the measured comets' CO2 results match the API (and migration 0012), each with its own photo, all above the fold
        cards = await pg.eval_on_selector_all("#s-m .card", """cs => cs.map(c => { const r = c.getBoundingClientRect(), i = c.querySelector('img');
          return { id: c.dataset.id, co2: c.dataset.co2, label: c.querySelector('.v').textContent, src: i.getAttribute('src'),
            loaded: i.complete && i.naturalWidth > 0, top: r.top, bottom: r.bottom, g: c.querySelector('.v .g').className }; })""")
        assert {c["id"]: c["co2"] for c in cards} == {i: by[i]["co2"] for i in want["m"]}, "a card's CO2 result is not the API's"
        assert {i: by[i]["co2"] for i in EXPECT} == EXPECT, f"API CO2 results changed: {[(i, by[i]['co2']) for i in EXPECT]}"
        for c in cards:
            assert c["label"] == LABEL[c["co2"]], f"{c['id']} says {c['label']!r}"
            assert ("g-co2" in c["g"]) == (c["co2"] == "detected"), f"{c['id']} has the wrong dot"
            detail = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(c["id"], safe=""))).json())["detail"]
            assert c["src"] in {f"data/comets/{detail['dir']}/{ph['file']}" for ph in detail["photos"]}, f"{c['id']} thumbnail {c['src']} is not one of its photos"
            assert c["loaded"], f"{c['id']} thumbnail did not load"
            assert 0 <= c["top"] and c["bottom"] <= 900, f"{c['id']} is below the fold at 1440x900 ({c['bottom']:.0f})"

        # every card and tile links to its comet page on the day; Too faint is folded until asked
        hrefs = await pg.eval_on_selector_all("#c-list [data-id]", "as => as.map(a => [a.dataset.id, a.getAttribute('href')])")
        for i, h in hrefs:
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(h).query)
            assert h.startswith("comet.html?") and q == {"id": [i], "day": [str(DAY)]}, f"{i} links to {h}"
        assert not await pg.is_visible("#s-f .faintlist"), "Too faint is open before it is asked"
        await pg.click("#s-f summary")
        assert await pg.is_visible(f"#s-f .faintlist a >> nth={len(want['f']) - 1}"), "Too faint did not open"

        # each sky tile's dot sits where skymap.js puts that comet on the day, within 1% of the tile's map
        places = await pg.evaluate(PLACES, [DAY])
        tiles = await pg.eval_on_selector_all("#s-o .tile", """ts => ts.map(t => { const m = t.querySelector('.skymini').getBoundingClientRect(), d = t.querySelector('.skymini i').getBoundingClientRect();
          return [t.dataset.id, (d.left + d.width / 2 - m.left) / m.width, (d.top + d.height / 2 - m.top) / m.height]; })""")
        for i, u, v in tiles:
            eu, ev = places[i]["uv"]
            assert abs(u - eu) < .01 and abs(v - ev) < .01, f"{i}: dot at {u:.3f},{v:.3f}, skymap.js puts it at {eu:.3f},{ev:.3f}"

        # search and each filter change every shelf and its count
        async def check(what, keep):
            g = await pg.evaluate(READ)
            for k in "mof":
                exp = [i for i in by if shelf(by[i]) == k and keep(i)]
                assert sorted(g[k]["ids"]) == sorted(exp) and g[k]["n"] == len(exp), f"{what}, shelf {k}: {g[k]['n']} shown, {len(exp)} expected"
                assert g[k]["shown"] == bool(exp), f"{what}: shelf {k} shown={g[k]['shown']} with {len(exp)} comets"
        await pg.fill("#l-q", "ATLAS"); await check("search ATLAS", lambda i: "atlas" in i.lower())
        assert len([i for i in by if "atlas" in i.lower()]) < len(by)
        await pg.fill("#l-q", "swan"); await check("search swan", lambda i: "swan" in i.lower())
        await pg.fill("#l-q", "")
        for region in ["north", "south", "ecliptic"]:
            await pg.select_option("#l-region", region); await check(f"region {region}", lambda i: places[i][region])
        await pg.fill("#l-q", "atlas"); await check("ecliptic + atlas", lambda i: places[i]["ecliptic"] and "atlas" in i.lower())
        await pg.fill("#l-q", "no such comet"); await check("no match", lambda i: False)
        assert await pg.is_visible("#l-none"), "no message when nothing matches"
        await pg.fill("#l-q", ""); await pg.select_option("#l-region", ""); await check("all sky", lambda i: True)

        # sort: Result puts a CO2 glow first, Most photos and Name order every shelf
        g = await pg.evaluate(READ)
        flags = [by[i]["co2"] == "detected" for i in g["m"]["ids"]]
        assert flags == sorted(flags, reverse=True), "Result sort: a CO2 glow is not first"
        await pg.select_option("#l-sort", "photos"); g = await pg.evaluate(READ)
        assert all([by[i]["photos"] for i in g[k]["ids"]] == sorted((by[i]["photos"] for i in g[k]["ids"]), reverse=True) for k in "mof"), "Most photos is out of order"
        await pg.select_option("#l-sort", "name"); g = await pg.evaluate(READ)
        names = await pg.evaluate("ids => ids.map(x => [...x].sort((a, b) => a.localeCompare(b)))", [g[k]["ids"] for k in "mof"])
        assert [g[k]["ids"] for k in "mof"] == names, "Name sort is out of order"

        # opening a card, a tile and a faint comet shows that comet
        for sel in ['#s-m .card[data-id="C/2025 R2 (SWAN)"]', "#s-o .tile >> nth=0", "#s-f .faintlist a >> nth=0"]:
            await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-m .card")
            if "faint" in sel: await pg.click("#s-f summary")
            name = await pg.get_attribute(sel, "data-id")
            await pg.click(sel); await pg.wait_for_function("n => document.getElementById('c-id').textContent === n", arg=name)
            assert await pg.is_hidden("#c-list") and await pg.is_visible(".comet-grid"), f"{name}: comet page shows the list"
            assert f"day={DAY}" in pg.url, f"{name}: opened without the day ({pg.url})"

        # a list opened on another day links to that day and places the tiles on it
        await pg.goto(BASE + "/comet.html?day=300"); await pg.wait_for_selector("#s-o .tile")
        assert all(h.endswith("&day=300") for h in await pg.eval_on_selector_all("#c-list [data-id]", "as => as.map(a => a.getAttribute('href'))")), "day 300 not carried"
        p300 = await pg.evaluate(PLACES, [300])
        i, u, v = (await pg.eval_on_selector_all("#s-o .tile", """ts => ts.map(t => { const m = t.querySelector('.skymini').getBoundingClientRect(), d = t.querySelector('.skymini i').getBoundingClientRect();
          return [t.dataset.id, (d.left + d.width / 2 - m.left) / m.width, (d.top + d.height / 2 - m.top) / m.height]; })"""))[0]
        assert abs(u - p300[i]["uv"][0]) < .01 and abs(v - p300[i]["uv"][1]) < .01, f"day 300: {i} is not at its place"

        # the sky: a known comet's name is hidden until the pointer is on it (or it has keyboard focus)
        await pg.goto(BASE + "/explore.html"); await pg.wait_for_selector(".mk.peek:not([hidden])", state="attached")
        mk = pg.locator(".mk.peek:not([hidden])").first
        assert not await mk.locator("b").is_visible(), "name shows before hover"
        await mk.locator("i").hover(); await pg.wait_for_timeout(300)
        assert await mk.locator("b").is_visible(), "name hidden on hover"
        await pg.mouse.move(5, 450); await pg.wait_for_timeout(300)
        assert not await mk.locator("b").is_visible(), "name stays after the pointer leaves"
        await pg.keyboard.press("Shift"); await mk.focus(); await pg.wait_for_timeout(200)   # focus after a key press counts as keyboard focus
        assert await mk.locator("b").is_visible(), "name hidden on keyboard focus"

        # every page decodes as UTF-8: no "Â" in its title, and the server says so
        for path in PAGES:
            await pg.goto(BASE + path); await pg.wait_for_timeout(600)
            t = await pg.title()
            assert "Â" not in t and "Trailblazer" in t, f"{path} title {t!r}"
            ct = (await ctx.request.get(BASE + path)).headers.get("content-type", "")
            assert "charset=utf-8" in ct.lower(), f"{path} Content-Type {ct!r}"
        await ctx.close()

        # the comet page and the Comets list fit the window from 700 to 1024 px (and a phone): nothing clipped
        for w in [390, 700, 800, 900, 1024]:
            c2 = await b.new_context(viewport={"width": w, "height": 900})
            await c2.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
            p2 = await c2.new_page()
            for path, ready in [("/comet?id=3I%2FATLAS", ".talk .composer"), ("/comet", "#s-m .card")]:
                await p2.goto(BASE + path); await p2.wait_for_selector(ready); await p2.wait_for_timeout(500)
                r = await p2.evaluate(CLIPPED)
                assert r["overflow"] <= 0 and not r["out"], f"{path} at {w}px: overflow {r['overflow']}, clipped {r['out']}"
                if "id=" in path:   # the comments panel sits beside or under the photos, never on top of them
                    hit = await p2.evaluate("""() => { const t = document.querySelector('.talk').getBoundingClientRect();
                      return [...document.querySelectorAll('.col > :not([hidden])')].some(e => { const r = e.getBoundingClientRect();
                        return r.left < t.right && t.left < r.right && r.top < t.bottom && t.top < r.bottom; }); }""")
                    assert not hit, f"{path} at {w}px: the comments panel covers the comet's panels"
            await c2.close()
        await b.close()
    print(f"PASS Comets shelves: {len(by)} comets ({len(want['m'])} measured, {len(want['o'])} could be, {len(want['f'])} too faint), "
          "CO2 results and photos, links, sky tiles on skymap.js places, search, regions, sort; sky names on hover; "
          "UTF-8 titles; comet page and list fit 390-1024 px")

asyncio.run(main())
