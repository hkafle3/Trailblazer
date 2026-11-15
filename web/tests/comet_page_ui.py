"""Browser check for one comet's page (comet.html?id=) in Ming's style, in headless Chrome. Needs the app up (npm run dev).
For a measured comet (3I/ATLAS, C/2025 R2 (SWAN)), a known unmeasured one (240P/NEAT) and a missing id:
the page shows its parts, no element carries the older rounded-glass classes, and nothing runs past the window at 390,
800 and 1440 px. Expected values come from GET /api/comets/:id, never from the page.
Run: uv run -q --with playwright python web/tests/comet_page_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
IDS = ["3I/ATLAS", "C/2025 R2 (SWAN)", "240P/NEAT", "C-9999"]
OLD = ".glass, .panel, .btn, .chip, .tag, .tagpick, .tally, .tally-key, .nights, .empty-card"   # the rounded-glass page's parts
# what the page shows, read the same way for every comet
READ = """() => { const $ = s => document.querySelector(s), on = e => !!e && !e.closest('[hidden]') && e.getClientRects().length > 0;
  return { id: $('#c-id').textContent, cat: on($('#c-cat')) ? $('#c-cat').textContent.trim() : null,
    map: on($('#c-mini-dot')) && on($('#c-find')) && $('#c-find').textContent.trim(), where: $('#c-where').textContent,
    photos: on($('#c-photos-panel')) ? document.querySelectorAll('#c-photos figure img').length : 0,
    dates: [...document.querySelectorAll('#c-photos figure')].map(f => f.textContent.trim()),
    measures: on($('#c-measures')) ? [...document.querySelectorAll('#c-measures [data-f]')].map(e => e.textContent.trim()) : null,
    points: on($('#spec')) ? document.querySelectorAll('#spec circle').length : 0,
    co2: on($('.co2')) ? $('.co2').textContent : null,
    empty: on($('#c-empty')) ? $('#c-empty').textContent : null, visits: [...document.querySelectorAll('#c-empty .visits a')].map(a => a.getAttribute('href')),
    patch: on($('#c-patch')), tags: on($('.verdict')) ? [...document.querySelectorAll('.verdict [data-t]')].map(e => [e.dataset.t, +e.textContent]) : null,
    radios: [...document.forms['c-compose']?.elements ?? []].filter(x => x.name === 'tag').length, head: $('#t-head').textContent.trim(),
    posts: [...document.querySelectorAll('#t-list .post .body')].map(p => p.textContent), form: on($('.talk .composer')),
    missing: on($('.missing')) ? $('.missing').textContent : null, old: [...document.querySelectorAll('main :is(""" + OLD + """)')].map(e => e.className) }; }"""
CLIPPED = """() => { const W = innerWidth, out = [];
  for (const e of document.querySelectorAll('main *')) { const r = e.getBoundingClientRect();
    if (r.width && r.height && getComputedStyle(e).visibility !== 'hidden' && (r.right > W + 1 || r.left < -1)) out.push(e.id || e.className || e.tagName); }
  return { overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - W, out: out.slice(0, 5) }; }"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        api = await p.request.new_context()
        want = {}
        for cid in IDS:
            r = await api.get(BASE + "/api/comets/" + urllib.parse.quote(cid, safe=""))
            assert r.status == (404 if cid == "C-9999" else 200), f"GET /api/comets/{cid}: HTTP {r.status}"   # only C-9999 is missing
            want[cid] = await r.json() if r.ok else None
        seen = []
        for w in (1440, 800, 390):
            ctx = await b.new_context(viewport={"width": w, "height": 900})
            await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
            pg = await ctx.new_page()
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            for cid in IDS:
                c, why = want[cid], f"{cid} at {w}px"
                await pg.goto(BASE + "/comet.html?id=" + urllib.parse.quote(cid, safe=""))
                await pg.wait_for_function("document.getElementById('c-id').textContent.trim().length > 1")
                await pg.wait_for_timeout(400)
                g = await pg.evaluate(READ)
                assert not g["old"], f"{why}: older glass parts {g['old']}"
                if c is None:   # a missing id: the message and a way back, no map, tags or form
                    assert g["id"] == "Comet not found" and "See all comets" in (g["missing"] or ""), f"{why}: {g['id']!r}, {g['missing']!r}"
                    assert not g["map"] and g["tags"] is None and not g["form"] and g["cat"] is None, f"{why}: parts of a comet page show"
                else:
                    assert g["id"] == cid and g["cat"], f"{why}: title {g['id']!r}, label {g['cat']!r}"
                    assert g["map"] == "Find on map" and g["where"].startswith("RA "), f"{why}: Where it is shows {g['map']!r}, {g['where']!r}"
                    assert g["tags"] == [[k, c["tags"][k]] for k in ("comet", "asteroid", "glitch", "unsure")] and g["radios"] == 4, f"{why}: tags {g['tags']}, {g['radios']} tag rows in the form"
                    assert g["head"] and g["form"], f"{why}: no tally line or comment form"
                    assert g["posts"] == [m["body"] for m in c["comments"] if m["body"]], f"{why}: comments {g['posts']}"
                    d = c["detail"] or {}
                    if d.get("photos"):   # measured: photos with dates, the four numbers, the spectrum, the CO2 verdict
                        assert g["photos"] == len(d["photos"]) and all(g["dates"]), f"{why}: {g['photos']} photos for {len(d['photos'])}"
                        assert g["measures"] and all(g["measures"]) and g["measures"][3] == str(d["exposures"]), f"{why}: measures {g['measures']}"
                        assert g["points"] >= sum(len(v) for v in d["spectrum"].values()), f"{why}: {g['points']} spectrum points"
                        assert g["co2"] == {"detected": "CO2 glow detected", "quiet": "No gas glow"}.get(d.get("co2_verdict")), f"{why}: CO2 badge {g['co2']!r}"
                    elif d.get("spherex") is not None:   # known, not measured: one link per SPHEREx visit
                        assert "photographed it" in g["empty"] and g["visits"] and all(h.startswith("timelapse.html?ra=") for h in g["visits"]), f"{why}: visits {g['visits']}"
                        assert not g["photos"] and g["measures"] is None, f"{why}: measured parts show"
                    else: raise AssertionError(f"{why}: neither measured nor photographed by SPHEREx")
                r = await pg.evaluate(CLIPPED)
                assert r["overflow"] <= 0 and not r["out"], f"{why}: overflow {r['overflow']}, past the edge {r['out']}"
            assert not errors, f"{w}px: page errors {errors}"
            seen.append(w)
            await ctx.close()
        await b.close()
    print(f"PASS comet page: {', '.join(IDS)} show their parts in Ming's style (no glass panels), and fit at {', '.join(map(str, seen))} px")

asyncio.run(main())
