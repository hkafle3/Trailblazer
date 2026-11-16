"""Browser check for the Comets tab (compact rows on a wide screen, photo tiles on a phone), the sky's hover names, page
titles and the comet page's width, in headless Chrome. Needs the app up (npm run dev). Expected values come from
GET /api/comets, web/data/comets/thumbs/index.json and skymap.js, never from the page.
Also, in WebKit (iPhone, 390x844): the tiles fill the first screen with real photos, and in light and dark the page is
dark behind the header and under the search box.
Run: uv run -q --with playwright python web/tests/comets_ui.py [base url]   (default http://127.0.0.1:8787)
     (WebKit once: uv run -q --with playwright python -m playwright install webkit)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DAY = 529   # Explore's default day (skymap.js LAST_DAY)
EXPECT = {"3I/ATLAS": "detected", "C/2025 R2 (SWAN)": "detected", "C/2026 A2 (Bok)": "detected",
          "C/2024 T5 (ATLAS)": "unclear", "210P/Christensen": "unclear", "P/2021 N1 (ZTF)": "unclear",
          "C/2024 G3 (ATLAS)": "unclear", "C/2023 A3 (Tsuchinshan-ATLAS)": "unclear",
          "C/2023 R1 (PANSTARRS)": "unclear", "C/2025 K1 (ATLAS)": "unclear"}   # migration 0012
GROUPS = [("c", "CO2 glow"), ("u", "No clear signal"), ("o", "Could be measured"), ("f", "Too faint")]   # the order on the page
BADGE = {"c": "CO2", "u": "no signal", "o": "not measured", "f": "too faint"}
PAGES = ["/", "/explore", "/comet", "/comet?id=3I%2FATLAS", "/forums", "/timelapse", "/guide"]
shelf = lambda c: "c" if c.get("co2") == "detected" else "u" if c.get("co2") else "f" if c.get("faint") else "o"
KS = "cuof"

# what the page shows: every group's ids in order, its count, and whether the group is shown
READ = """() => Object.fromEntries([...'cuof'].map(k => { const s = document.getElementById('s-' + k);
  return [k, { n: +s.querySelector('.n').textContent, shown: !s.hidden,
    ids: [...s.querySelectorAll('[data-id]')].map(e => e.dataset.id) }]; }))"""
# every comet element: where it is, whether it is drawn, its photo (and whether that loaded), its badge
ITEMS = """() => [...document.querySelectorAll('#c-list .it')].map(a => { const r = a.getBoundingClientRect(), i = a.querySelector('img'), p = a.querySelector('.ph').getBoundingClientRect();
  return { id: a.dataset.id, href: a.getAttribute('href'), x: r.left, top: r.top, bottom: r.bottom, w: r.width, h: r.height, visible: !!r.height,
    ph: [p.width, p.height], src: i?.getAttribute('src') ?? null, loaded: !!i && i.complete && i.naturalWidth > 0,
    badge: getComputedStyle(a.querySelector('.badge')).display !== 'none' ? a.querySelector('.badge').textContent : null }; })"""
# the group headings in page order, as drawn: name and count
HEADS = """() => [...document.querySelectorAll('#c-list .sec')].filter(h => h.getBoundingClientRect().height)
  .map(h => [h.firstChild.nextSibling.textContent.trim(), +h.querySelector('.n').textContent])"""
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

# The color behind a point: every background color in the stack under it, painted over the page itself (<html>).
# An <html> with no color of its own counts as white: iPhone Safari (iOS 27) showed white there on the Comets list,
# because it did not carry <body>'s color out to the page. Gradients and images do not count, only flat colors.
UNDER = """([x, y]) => { const rgba = e => (getComputedStyle(e).backgroundColor.match(/[\\d.]+/g) || []).map(Number),
    root = rgba(document.documentElement); let c = root.length === 3 || root[3] === 1 ? root.slice(0, 3) : [255, 255, 255];
  for (const e of document.elementsFromPoint(x, y).reverse()) { const [r, g, b, a = 1] = rgba(e);
    if (e !== document.documentElement && a > 0) c = [r * a + c[0] * (1 - a), g * a + c[1] * (1 - a), b * a + c[2] * (1 - a)]; }
  const l = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  return .2126 * l(c[0]) + .7152 * l(c[1]) + .0722 * l(c[2]); }"""
DARK_PAGES = ["/comet", "/", "/explore", "/timelapse", "/comet?id=3I%2FATLAS", "/candidate?id=none", "/forums"]


async def phone_grid(p):
    """WebKit as an iPhone at 390x844 (the direction B mockup): the comets with a photo are square tiles in two columns,
    at least 4 wholly on the first screen, every one with its photo loaded and its corner badge; the comets without a
    photo are rows after the last tile (never an empty square); Too faint is folded behind a 44 px tap target."""
    b = await p.webkit.launch()
    ctx = await b.new_context(**{**p.devices["iPhone 14"], "viewport": {"width": 390, "height": 844}})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page()
    api = (await (await ctx.request.get(BASE + "/api/comets")).json())["comets"]
    by = {c["id"]: c for c in api if c["kind"] == "known" and c["real"]}
    await pg.goto(BASE + "/comet"); await pg.wait_for_selector("#s-c .it")
    await pg.wait_for_function("[...document.querySelectorAll('#c-list .lanes img')].every(i => i.complete)", timeout=20000)
    items = [i for i in await pg.evaluate(ITEMS) if shelf(by[i["id"]]) != "f"]
    tiles = [i for i in items if i["ph"][0] > 100]
    rows = [i for i in items if i["ph"][0] <= 100]
    assert {i["id"] for i in tiles} == {i for i in by if shelf(by[i]) != "f" and by[i].get("thumb")}, "tiles are not exactly the comets with a photo"
    for t in tiles:
        assert abs(t["ph"][0] - t["ph"][1]) < 1, f"{t['id']}: photo is not square ({t['ph']})"
        assert t["loaded"], f"{t['id']}: empty or broken photo"
        assert t["badge"] == BADGE[shelf(by[t["id"]])], f"{t['id']}: badge {t['badge']!r}"
    xs = sorted({round(t["x"]) for t in tiles})
    assert len(xs) == 2, f"tiles in {len(xs)} columns"
    full = [t for t in tiles if t["top"] >= 0 and t["bottom"] <= 844]
    assert len(full) >= 4, f"only {len(full)} tiles wholly on the first screen"
    last = max(t["bottom"] for t in tiles)
    for r in rows:
        assert not r["src"] and r["h"] <= 62 and r["top"] >= last, f"{r['id']}: no photo, but not a row after the tiles"
    assert await pg.text_content("#s-all") == f"Measured and could be{len(items)}", "phone heading or its count"
    small = await pg.evaluate("""() => [...document.querySelectorAll('#c-list .f-search, #c-list .sel, #s-f summary, #c-list .lanes .it')]
      .filter(e => e.getBoundingClientRect().height < 44).map(e => e.dataset.id || e.className)""")
    assert not small, f"tap targets under 44 px: {small[:5]}"
    assert not await pg.is_visible("#s-f .rows"), "Too faint is open before it is asked"
    await pg.tap("#s-f summary")
    assert await pg.is_visible("#s-f .it >> nth=0"), "Too faint did not open"
    await ctx.close(); await b.close()
    return f"{len(tiles)} tiles ({len(full)} wholly on the first screen), {len(rows)} rows without a photo after them"


async def dark_on_iphone(p):
    """WebKit as an iPhone at 390x844, light and dark: behind the header and under the search box is dark (luminance at
    most 0.1) on the Comets list, and behind the header on every other page."""
    b = await p.webkit.launch()
    out = []
    for scheme in ["light", "dark"]:
        ctx = await b.new_context(**{**p.devices["iPhone 14"], "viewport": {"width": 390, "height": 844}}, color_scheme=scheme)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page()
        for path in DARK_PAGES:
            await pg.goto(BASE + path); await pg.wait_for_timeout(1200)
            pts = await pg.evaluate("""() => { const h = document.querySelector('.topbar').getBoundingClientRect(), s = document.querySelector('#c-list:not([hidden]) .f-search');
              const at = { header: [4, h.top + h.height / 2] }; if (s) { const r = s.getBoundingClientRect(); at.search = [4, r.bottom + 6]; } return at; }""")
            for where, xy in pts.items():
                lum = await pg.evaluate(UNDER, xy)
                out.append(f"{scheme} {path} {where} {lum:.3f}")
                assert lum <= .1, f"WebKit {scheme}: {path} is not dark behind the {where} ({lum:.3f})"
        await ctx.close()
    await b.close()
    return out


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
        pg = await ctx.new_page()
        api = (await (await ctx.request.get(BASE + "/api/comets")).json())["comets"]
        known = [c for c in api if c["kind"] == "known" and c["real"]]
        by = {c["id"]: c for c in known}
        want = {k: {c["id"] for c in known if shelf(c) == k} for k in KS}
        baked = (await (await ctx.request.get(BASE + "/data/comets/thumbs/index.json")).json())

        # every known comet in exactly one group, the right one; counts from the data
        await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-c .it")
        # the photos load after the API answers: wait until each has finished (loaded or failed), and for the fonts,
        # before reading pixels or measuring the rows
        await pg.wait_for_function("[...document.querySelectorAll('#c-list .lanes img')].every(i => i.complete)", timeout=20000)
        await pg.evaluate("document.fonts.ready.then(() => true)")
        got = await pg.evaluate(READ)
        h1 = await pg.evaluate("[...document.querySelectorAll('h1')].filter(h => !h.closest('[hidden]')).map(h => h.textContent)")
        assert h1 == ["Comets"], f"the Comets list's level-one headings are {h1}"
        ids = sum((got[k]["ids"] for k in KS), [])
        assert sorted(ids) == sorted(by), f"{len(ids)} entries for {len(by)} known comets, or a comet twice"
        for k in KS:
            assert set(got[k]["ids"]) == want[k], f"group {k}: {set(got[k]['ids']) ^ want[k]}"
            assert got[k]["n"] == len(want[k]), f"group {k} says {got[k]['n']}, data has {len(want[k])}"

        # 1440x900, as the desktop mockup: four groups in order with the data's counts, three rows to a line, CO2 glow and
        # No clear signal above the fold, Too faint folded
        heads = await pg.evaluate(HEADS)
        assert heads == [[name, len(want[k])] for k, name in GROUPS], f"group headings {heads}"
        items = {i["id"]: i for i in await pg.evaluate(ITEMS)}
        for k in "cuo":
            xs = sorted({round(items[i]["x"]) for i in got[k]["ids"]})
            assert len(xs) == min(3, len(want[k])), f"group {k}: rows in {len(xs)} columns ({xs})"
            assert all(abs(items[i]["h"] - 62) < .5 for i in got[k]["ids"]), f"group {k}: a row is not 62 px tall: {[(i, items[i]['h']) for i in got[k]['ids']]}"
        for i in want["c"] | want["u"]:
            assert 0 <= items[i]["top"] and items[i]["bottom"] <= 900, f"{i} is below the fold at 1440x900 ({items[i]['bottom']:.0f})"
        assert not await pg.is_visible("#s-f .rows"), "Too faint is open before it is asked"

        # the CO2 results match the API (and migration 0012); every photo is the right one and loaded: a measured comet's
        # brightest photo, any other comet's baked SPHEREx photo (bake/known_thumbs.py), none for a comet with neither
        assert {i: by[i]["co2"] for i in EXPECT} == EXPECT, f"API CO2 results changed: {[(i, by[i]['co2']) for i in EXPECT]}"
        assert {i: await pg.get_attribute(f'#c-list .it[data-id="{i}"]', "data-co2") for i in EXPECT} == EXPECT, "a row's CO2 result is not the API's"
        for i in want["c"] | want["u"]:
            detail = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(i, safe=""))).json())["detail"]
            top = max(ph["flux"] for ph in detail["photos"] if ph.get("flux") is not None)   # the thumbnail is its brightest photo
            assert items[i]["src"] in {f"data/comets/{detail['dir']}/{ph['file']}" for ph in detail["photos"] if ph.get("flux") == top}, f"{i} thumbnail {items[i]['src']} is not its brightest photo"
            assert items[i]["loaded"], f"{i} thumbnail did not load"
        for i in want["o"] | want["f"]:
            exp = f"data/comets/thumbs/{baked[i]['file']}" if i in baked else None
            assert items[i]["src"] == exp, f"{i}: photo {items[i]['src']}, baked {exp}"
            if exp and i in want["o"]: assert items[i]["loaded"], f"{i}: baked photo did not load"
        assert any(i in baked for i in want["o"]), "no could-be-measured comet has a baked photo"
        await pg.click("#s-f summary")
        assert await pg.is_visible(f"#s-f .it >> nth={len(want['f']) - 1}"), "Too faint did not open"
        await pg.wait_for_function("[...document.querySelectorAll('#s-f img')].every(i => i.complete)", timeout=20000)
        bad = [i["id"] for i in await pg.evaluate(ITEMS) if i["src"] and not i["loaded"]]
        assert not bad, f"photos that did not load: {bad}"

        # every row links to its comet page on the day
        hrefs = await pg.eval_on_selector_all("#c-list [data-id]", "as => as.map(a => [a.dataset.id, a.getAttribute('href')])")
        assert len(hrefs) == len(by)
        for i, h in hrefs:
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(h).query)
            assert h.startswith("comet.html?") and q == {"id": [i], "day": [str(DAY)]}, f"{i} links to {h}"

        # search and each filter change every group and its count, and the status line says how many match
        places = await pg.evaluate(PLACES, [DAY])
        assert await pg.get_attribute("#l-status", "role") == "status", "no status line for screen readers"
        async def check(what, keep):
            g = await pg.evaluate(READ)
            for k in KS:
                exp = [i for i in by if shelf(by[i]) == k and keep(i)]
                assert sorted(g[k]["ids"]) == sorted(exp) and g[k]["n"] == len(exp), f"{what}, group {k}: {g[k]['n']} shown, {len(exp)} expected"
                assert g[k]["shown"] == bool(exp), f"{what}: group {k} shown={g[k]['shown']} with {len(exp)} comets"
            n = len([i for i in by if keep(i)])   # what a screen reader hears: the persistent status line
            said = await pg.text_content("#l-status")
            assert said == (f"{n} comet{'' if n == 1 else 's'}" if n else "No comets match."), f"{what}: status says {said!r} for {n} comets"
        await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-c .it")
        await pg.fill("#l-q", "ATLAS"); await check("search ATLAS", lambda i: "atlas" in i.lower())
        assert len([i for i in by if "atlas" in i.lower()]) < len(by)
        # a search that matches a too-faint comet opens Too faint, so the match is on screen; clearing it folds it again
        hit = sorted(want["f"])[0]
        await pg.fill("#l-q", hit.lower()); await check(f"search {hit}", lambda i: hit.lower() in i.lower())
        assert await pg.is_visible(f'#s-f .it[data-id="{hit}"]'), f"search {hit}: Too faint did not open to show it"
        await pg.fill("#l-q", ""); await check("cleared", lambda i: True)
        assert not await pg.is_visible("#s-f .rows"), "Too faint stays open after the search is cleared"
        await pg.fill("#l-q", "swan"); await check("search swan", lambda i: "swan" in i.lower())
        await pg.fill("#l-q", "3i/"); await check("search 3i/", lambda i: "3i/" in i.lower())
        assert not any("3i/" in i.lower() for i in want["f"]) and not await pg.is_visible("#s-f"), "Too faint shows with no match in it"
        await pg.fill("#l-q", "")
        for region in ["north", "south", "ecliptic"]:
            await pg.select_option("#l-region", region); await check(f"region {region}", lambda i: places[i][region])
            label = await pg.evaluate("() => document.getElementById('l-region').selectedOptions[0].textContent")
            assert await pg.text_content(".sel:has(#l-region) .v") == label, f"Region box does not say {label}"
        await pg.fill("#l-q", "atlas"); await check("ecliptic + atlas", lambda i: places[i]["ecliptic"] and "atlas" in i.lower())
        await pg.fill("#l-q", "no such comet"); await check("no match", lambda i: False)
        assert await pg.is_visible("#l-none"), "no message when nothing matches"
        await pg.fill("#l-q", ""); await pg.select_option("#l-region", ""); await check("all sky", lambda i: True)

        # sort: Result and Most photos put the most photographed first in every group, Name orders it by name
        g = await pg.evaluate(READ)
        assert all([by[i]["photos"] for i in g[k]["ids"]] == sorted((by[i]["photos"] for i in g[k]["ids"]), reverse=True) for k in KS), "Result is out of order"
        await pg.select_option("#l-sort", "photos"); g = await pg.evaluate(READ)
        assert all([by[i]["photos"] for i in g[k]["ids"]] == sorted((by[i]["photos"] for i in g[k]["ids"]), reverse=True) for k in KS), "Most photos is out of order"
        await pg.select_option("#l-sort", "name"); g = await pg.evaluate(READ)
        names = await pg.evaluate("ids => ids.map(x => [...x].sort((a, b) => a.localeCompare(b)))", [g[k]["ids"] for k in KS])
        assert [g[k]["ids"] for k in KS] == names, "Name sort is out of order"
        assert await pg.text_content(".sel:has(#l-sort) .v") == "Name", "Sort box does not say Name"

        # opening a CO2 row, a could-be row and a faint comet shows that comet
        for sel in ['#s-c .it[data-id="C/2025 R2 (SWAN)"]', "#s-o .it >> nth=0", "#s-f .it >> nth=0"]:
            await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-c .it")
            if "s-f" in sel: await pg.click("#s-f summary")
            name = await pg.get_attribute(sel, "data-id")
            await pg.click(sel); await pg.wait_for_function("n => document.getElementById('c-id')?.textContent === n", arg=name)
            assert await pg.is_hidden("#c-list") and await pg.is_visible(".comet-grid"), f"{name}: comet page shows the list"
            assert f"day={DAY}" in pg.url, f"{name}: opened without the day ({pg.url})"

        # a list opened on another day links to that day, and Region filters by the places on that day
        await pg.goto(BASE + "/comet.html?day=300"); await pg.wait_for_selector("#s-o .it")
        assert all(h.endswith("&day=300") for h in await pg.eval_on_selector_all("#c-list [data-id]", "as => as.map(a => a.getAttribute('href'))")), "day 300 not carried"
        p300 = await pg.evaluate(PLACES, [300])
        assert any(p300[i]["south"] != places[i]["south"] for i in by), "day 300 and 529 put every comet in the same hemisphere"
        for region in ["north", "south", "ecliptic"]:
            await pg.select_option("#l-region", region); await check(f"day 300, region {region}", lambda i: p300[i][region])

        # a measured comet with no photo (thumb null) still gets its row, with an empty ring and no broken image; counts follow the data
        spare = sorted(want["o"])[0]
        async def stub(route):
            d = await (await route.fetch()).json()
            for c in d["comets"]:
                if c["id"] in ("3I/ATLAS", spare): c.update(co2="detected", thumb=None)
            await route.fulfill(json=d)
        await pg.route("**/api/comets", stub)
        await pg.goto(BASE + "/comet.html"); await pg.wait_for_selector("#s-c .it")
        g = await pg.evaluate(READ)
        assert g["c"]["n"] == len(want["c"]) + 1 and g["o"]["n"] == len(want["o"]) - 1, f"stubbed counts {g['c']['n']}, {g['o']['n']}"
        for i in ("3I/ATLAS", spare):
            row = pg.locator(f'#s-c .it[data-id="{i}"]')
            assert await row.is_visible() and await row.locator("img").count() == 0, f"{i}: no row, or a broken photo, without a thumb"
        await pg.unroute("**/api/comets", stub)

        # the sky: a known comet's name is hidden until the pointer is on it (or it has keyboard focus)
        await pg.goto(BASE + "/explore.html"); await pg.wait_for_selector("body[data-ready='1']")
        await pg.wait_for_function("!document.getElementById('play').classList.contains('on')", timeout=60000)   # the replay Explore opens with has ended: markers hold still
        await pg.wait_for_selector(".mk.peek:not([hidden])", state="attached")
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
        for w in [320, 390, 700, 800, 900, 1024, 1440]:
            c2 = await b.new_context(viewport={"width": w, "height": 900})
            await c2.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
            p2 = await c2.new_page()
            for path, ready in [("/comet?id=3I%2FATLAS", ".talk .composer"), ("/comet", "#s-c .it")]:
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
        grid = await phone_grid(p)
        dark = await dark_on_iphone(p)
    print(f"WebKit iPhone 390x844 grid: {grid}")
    print("WebKit iPhone 390x844, luminance behind (at most 0.1):\n  " + "\n  ".join(dark))
    print(f"PASS Comets list: {len(by)} comets ({len(want['c'])} CO2 glow, {len(want['u'])} no clear signal, {len(want['o'])} could be measured, {len(want['f'])} too faint); "
          "1440x900 three-column rows with the mockup's groups and counts; photos (measured, baked, none: no broken image); links with the day; "
          "search (opens and refolds Too faint), regions (day 529 and 300), sort, spoken counts; phone grid (WebKit); sky names on hover; "
          "UTF-8 titles; comet page and list fit 320-1440 px; dark behind header and search in WebKit, light and dark")

asyncio.run(main())
