"""Browser check for "Discuss this": a dot on the time-lapse becomes a candidate others can see and tag. Needs the app up
(npm run dev, with worker/.dev.vars holding Turnstile's test secret) and the network (IRSA and NASA's S3 copy of SPHEREx,
for the live time-lapse and the candidate page's frames; Cloudflare, for the Turnstile test widget). SkyBoT is stubbed
(GET /api/known is answered here), so whether a known object is near the dot is decided by the test.
Run: uv run -q --with playwright python web/tests/discuss_ui.py [base url] [WIDTHxHEIGHT] [screenshot dir]
     (default http://127.0.0.1:8787, 1440x900, no screenshots)
1. A live spot near Barnard's Star, then a click on a random dot there (each run a new spot): Undiscovered opens the sheet in place of
   the right column, with no known object near.
2. Post (Comet, a comment, Turnstile's test key) lands on the candidate page: the id, Candidate, the byline, the comment,
   the tally and the frames.
3. Explore shows it as a hollow comet marker, labelled candidate.
4. Back on the same dot and visit: Discovered, "Found as <id>", and the arrow opens the same page.
5. Another visit of that dot, with SkyBoT putting 2001 FM127 30 arcsec away: the sheet leads with "It's 2001 FM127",
   and that logs a sighting (POST /api/sightings) and closes the sheet with "Logged as 2001 FM127"."""
import asyncio, json, os, random, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
W, H = map(int, (sys.argv[2] if len(sys.argv) > 2 else "1440x900").split("x"))
SHOTS = sys.argv[3] if len(sys.argv) > 3 else None
TAG = "%dx%d" % (W, H)
known = {"near": False}   # what the SkyBoT stub answers


async def stub_known(route):   # /api/known?ra=&dec=&t=: nothing, or one asteroid 30 arcsec north of the asked spot
    q = dict(re.findall(r"[?&](\w+)=([^&]*)", route.request.url))
    ra, dec, t = float(q["ra"]), float(q["dec"]), float(q["t"])
    rocks = [{"name": "2001 FM127", "ra": ra, "dec": round(dec + 30 / 3600, 5), "mag": 20.9, "err": 0}] if known["near"] else []
    await route.fulfill(status=200, content_type="application/json", body=json.dumps({"ra": ra, "dec": dec, "t": t, "comets": [], "asteroids": rocks, "omitted": 0}))


async def shot(pg, name, at=None):   # the window as the person sees it; on a phone, scrolled so `at` is in the middle
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        if at and W < 900: await pg.locator(at).first.evaluate("e => e.scrollIntoView({ block: 'center' })")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(SHOTS, f"{name}-{TAG}.png"))


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": W, "height": H})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.user', JSON.stringify({ name: 'tester', via: 'demo' })) } catch {}")
        await ctx.route("**/api/known?*", stub_known)
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: "ViewTransition" in str(e) or errors.append(str(e)))   # a page change during a view transition is not ours
        label = lambda: pg.locator("#state-label").text_content()

        async def built():   # a live time-lapse has landed on screen
            await pg.wait_for_function("/visits, built/.test(document.getElementById('status')?.textContent || '') && __lapse.state.m?.key?.startsWith('live')", timeout=240000)

        async def visit(k):   # the k-th visit on screen, its known objects answered, its near check read
            knob = pg.locator("#play"); await knob.focus(); await knob.press("Home")
            for _ in range(k): await knob.press("ArrowRight")
            await pg.wait_for_function(f"__lapse.state.i === {k} && __lapse.state.m.frames[{k}].known?.left === 0", timeout=60000)
            await pg.wait_for_timeout(600)   # GET /api/candidates/near

        # 1. a live spot within half a degree of Barnard's Star (each run its own), then a click on a dot: it re-centres there
        await pg.goto(f"{BASE}/timelapse.html?ra={269.4463 + random.uniform(-.5, .5):.4f}&dec={4.7671 + random.uniform(-.5, .5):.4f}&det=D1")
        await built()
        await pg.locator("#patch").scroll_into_view_if_needed()
        box = await pg.locator("#patch").bounding_box()
        for _ in range(4):   # a spot nobody reported in this visit (the local database keeps earlier runs)
            await pg.locator("#patch").click(position={"x": box["width"] * random.uniform(.2, .8), "y": box["height"] * random.uniform(.2, .8)})
            await built()
            n = await pg.evaluate("__lapse.state.m.frames.length"); k = random.randrange(n)
            await visit(k)
            if await label() == "Undiscovered": break
        assert await label() == "Undiscovered", "no fresh spot found"
        spot = await pg.evaluate("(({ m }) => ({ ra: m.ra, dec: m.dec, det: m.detector, n: m.frames.length }))(__lapse.state)")
        # opened while the time-lapse plays: playback stops, so the next visit does not close the sheet
        await pg.evaluate("__lapse.state.playing = true; __lapse.state.last = performance.now(); document.getElementById('state').click()")
        await pg.wait_for_selector("#talk", state="visible")
        await pg.wait_for_timeout(2500)
        assert await pg.locator("#talk").is_visible() and not await pg.evaluate("__lapse.state.playing"), "playback went on and closed the sheet"
        assert not await pg.locator(".pv-mini").is_visible() and not await pg.locator(".pstage > .pv-desc").is_visible(), "the sheet did not replace the right column"
        assert "RA" in await pg.locator("#talk [data-f=where]").text_content()
        assert await pg.locator("#talk .talk-form").is_visible() and not await pg.locator("#talk .match").is_visible(), "a known object was offered with none near"
        assert "tester" in await pg.locator("#talk [data-f=as]").text_content()
        assert await pg.locator("#talk .pv-post").is_disabled(), "Post enabled before a tag is picked"
        await shot(pg, "1-sheet", "#talk")

        # 2. Post: Comet and a comment, through Turnstile's test widget
        await pg.click("#talk label.pv-row:has([value=comet])")
        await pg.fill("#talk textarea", "Moves between visits <b>not bold</b>")
        i0 = await pg.evaluate("__lapse.state.i")   # the arrow keys move the caret in the comment, not the visit
        for key in ["ArrowLeft", "ArrowRight", "ArrowRight"]: await pg.press("#talk textarea", key)
        assert await pg.evaluate("__lapse.state.i") == i0 and await pg.locator("#talk").is_visible(), "an arrow key in the comment changed the visit"
        await pg.wait_for_function("window.turnstile?.getResponse?.()", timeout=60000)
        await pg.click("#talk .pv-post")
        await pg.wait_for_url(re.compile(r"/candidate(\.html)?\?id=C-\d{4}$"), timeout=30000)
        cid = pg.url.split("id=")[1]
        await pg.wait_for_function("document.getElementById('c-id').textContent.startsWith('C-')")
        assert await pg.locator("#c-id").text_content() == cid
        assert await pg.locator("#c-status").text_content() == "Candidate"
        by = await pg.locator("#c-by").text_content()
        assert "tester" in by and spot["det"] in by, by
        assert await pg.locator("#c-talk .post .body").first.text_content() == "Moves between visits <b>not bold</b>", "comment not shown as text"
        assert await pg.locator("[data-t=comet]").text_content() == "1"
        lapse = await pg.locator("#c-lapse").get_attribute("href")
        assert f"ra={spot['ra']:.4f}" in lapse and f"det={spot['det']}" in lapse, lapse
        await pg.wait_for_function(f"document.querySelectorAll('#c-frames figure').length === {spot['n']}", timeout=240000)
        assert await pg.locator("#c-frames .ring:not(.earlier)").count() == 1, "the reported visit is not the one ringed orange"
        await shot(pg, "2-candidate")
        if W < 900: await shot(pg, "2-candidate-tags", ".cpage .right")

        # 3. Explore: a hollow comet marker labelled candidate; from "Where it is", its card says candidate
        await pg.goto(f"{BASE}/explore.html")
        mk = pg.locator(".mk.comet", has=pg.locator("b", has_text=re.compile(f"^{cid}$")))
        await mk.wait_for(state="attached", timeout=30000)
        assert "open" in await mk.get_attribute("class"), "candidate marker is not hollow"
        assert await mk.get_attribute("aria-label") == f"{cid} (candidate)"
        await pg.goto(f"{BASE}/candidate.html?id={cid}")
        await pg.click("#c-find")
        await pg.wait_for_url(re.compile(r"/explore(\.html)?\?focus="))
        if W >= 900:   # Explore has no map cards on phones (styles.css): there the marker's name shows instead
            await pg.wait_for_selector("#card-comet:not([hidden])")
            assert await pg.locator("#card-comet [data-f=id]").text_content() == cid
            assert await pg.locator("#card-comet .tag").text_content() == "candidate"
        else: await mk.locator("b").wait_for(state="visible")
        await shot(pg, "5-explore", ".mk.focus, .mk.sel")

        # 4. the same dot in the same visit: Discovered, and its arrow opens the same page
        known["near"] = True   # for step 5: SkyBoT now puts 2001 FM127 by the dot (asked once per visit, as the page loads)
        await pg.goto(f"{BASE}/timelapse.html?ra={spot['ra']:.4f}&dec={spot['dec']:.4f}&det={spot['det']}")
        await built()
        await visit(k)
        await pg.wait_for_function("document.getElementById('state-label').textContent === 'Discovered'", timeout=15000)
        assert cid in await pg.locator("#vName").text_content(), "no Found as line"
        assert "tester" in await pg.locator("#vName .by").text_content()
        await pg.locator("#state").scroll_into_view_if_needed()
        await shot(pg, "3-duplicate", "#state")
        await pg.click("#state")
        await pg.wait_for_url(re.compile(rf"/candidate(\.html)?\?id={cid}$"))

        # 5. another visit of the dot, a known asteroid predicted 30 arcsec away: "It's 2001 FM127" logs a sighting
        await pg.go_back()
        await built()
        for k2 in [x for x in range(spot["n"]) if x != k]:   # a visit nobody reported this dot in
            await visit(k2)
            if await label() == "Undiscovered": break
        assert await label() == "Undiscovered"
        await pg.click("#state")
        its = pg.locator("#talk [data-f=its]")
        await its.wait_for(state="visible", timeout=15000)
        assert await its.text_content() == "It's 2001 FM127" and not await pg.locator("#talk .talk-form").is_visible()
        assert "Asteroid · mag 20.9" in await pg.locator("#talk [data-f=kwhat]").text_content()
        await shot(pg, "4-known", "#talk")
        async with pg.expect_response("**/api/sightings") as r:
            await its.click()
        res = await (await r.value).json()
        assert (await r.value).status == 201 and res["sighting"]["name"] == "2001 FM127", res
        await pg.wait_for_selector("#talk", state="hidden")
        assert await pg.locator("#status").text_content() == "Logged as 2001 FM127"
        assert await label() == "Undiscovered", "a sighting made a candidate"
        # "Something else" shows the form instead
        await pg.click("#state")
        await its.wait_for(state="visible", timeout=15000)
        await pg.click("#talk [data-f=else]")
        assert await pg.locator("#talk .talk-form").is_visible() and not await its.is_visible()
        # the sheet fits the window: no sideways scroll
        assert await pg.evaluate("document.documentElement.scrollWidth <= innerWidth"), "page scrolls sideways"
        assert not errors, errors
        await b.close()
    print(f"PASS discuss ({TAG}): sheet in place of the right column, Post made {cid} and its page, hollow candidate marker on Explore, "
          "the same dot reads Discovered and opens it, a known asteroid offers It's 2001 FM127 and logs a sighting")

asyncio.run(main())
