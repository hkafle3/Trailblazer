"""Browser check for the Forums page (forums.js) in headless Chrome: thread order from GET /api/threads, then search,
filters, the URL, and a failed load on a fixed set of threads (the page's /api/threads is answered by this script).
Needs the app up (npm run dev). Run: uv run -q --with playwright python web/tests/forums_ui.py [base url]"""
import asyncio, json, sys, time
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
NOW, DAY = int(time.time() * 1000), 864e5
say = lambda author, body, ago, tag=None: {"author": author, "tag": tag, "body": body, "created_at": int(NOW - ago * DAY)}
NO = {"comet": 0, "asteroid": 0, "glitch": 0, "unsure": 0, "star": 0}
# newest activity first, as the Worker sends them. North; south; on the Milky Way's centre (south too), a year old
THREADS = [
    {"id": "C-0001", "kind": "comet", "ra": 10, "dec": 40, "day": 1, "real": False, "tags": {**NO, "comet": 2}, "last": int(NOW - 2 * DAY),
     "comments": [say("orbit_owl", "The tail points away from the Sun.", 2, "comet")]},
    {"id": "C/2025 R2 (SWAN)", "kind": "known", "ra": 200, "dec": -30, "day": 1, "real": True, "tags": NO, "last": int(NOW - 60 * DAY),
     "comments": [say(f"hunter_{n}", f"Bright coma, night {n}.", 64 - n) for n in range(5)]},
    {"id": "C-0003", "kind": "comet", "ra": 266.4, "dec": -28.9, "day": 1, "real": False, "tags": NO, "last": int(NOW - 400 * DAY),
     "comments": [say("stargazer", "<img src=x onerror=alert(1)> looks like a glitch", 400)]},
]
IDS = "() => [...document.querySelectorAll('#threads .thread h3')].map(h => h.textContent)"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")

        # the Worker: threads newest activity first, comments oldest first, last = the newest comment, no empty bodies
        threads = (await (await ctx.request.get(BASE + "/api/threads")).json())["threads"]
        assert threads, "no threads in the local database (npm run db:local seeds some)"
        lasts = [t["last"] for t in threads]
        assert lasts == sorted(lasts, reverse=True), f"threads are not newest first: {lasts}"
        for t in threads:
            times = [c["created_at"] for c in t["comments"]]
            assert times == sorted(times) and t["last"] == times[-1], f"{t['id']}: comments out of order or wrong last"
            assert all(c["body"] for c in t["comments"]), f"{t['id']} has a vote with no text"
        print(f"PASS /api/threads: {len(threads)} threads newest first, comments oldest first, no empty votes")

        pg = await ctx.new_page()
        answer = {"status": 200, "body": json.dumps({"threads": THREADS})}
        await pg.route("**/api/threads", lambda r: r.fulfill(status=answer["status"], content_type="application/json", body=answer["body"]))
        await pg.goto(BASE + "/forums.html"); await pg.wait_for_selector("#threads .thread")
        shown = lambda: pg.evaluate(IDS)
        assert await shown() == [t["id"] for t in THREADS], f"order: {await shown()}"
        assert await pg.text_content("#count") == "3 threads, newest activity first"
        assert await pg.locator("#threads img").count() == 0 and "<img src=x" in await pg.text_content("#threads"), "a comment was parsed as HTML"
        assert await pg.text_content("#threads .thread >> nth=1 >> .t-more") == "2 more comments"

        async def search(text):
            await pg.fill("#q", text); await pg.press("#q", "Enter")
        await search("coma")
        assert await shown() == ["C/2025 R2 (SWAN)"] and await pg.text_content("#count") == "1 of 3 threads"
        marks = await pg.eval_on_selector_all("#threads mark", "ms => ms.map(m => m.textContent.toLowerCase())")
        assert marks and set(marks) == {"coma"}, f"highlights: {marks}"
        await search("sun tail")   # every word, in any order
        assert await shown() == ["C-0001"]
        await search("sun coma")
        assert await shown() == [] and "No threads match" in await pg.text_content("#threads")
        await search("")
        for region, want in [("north", ["C-0001"]), ("south", ["C/2025 R2 (SWAN)", "C-0003"]), ("galaxy", ["C-0003"]), ("", [t["id"] for t in THREADS])]:
            await pg.select_option("#region", region)
            assert await shown() == want, f"region {region!r}: {await shown()}"
        for days, want in [("7", ["C-0001"]), ("365", ["C-0001", "C/2025 R2 (SWAN)"]), ("", [t["id"] for t in THREADS])]:
            await pg.select_option("#date", days)
            assert await shown() == want, f"date {days!r}: {await shown()}"
        await pg.check("#known")
        assert await shown() == ["C/2025 R2 (SWAN)"]
        await pg.uncheck("#known")
        print("PASS Forums: order kept, comments as text, search by every word with highlights, regions, dates, Known")

        # the search and filters live in the URL, and come back from it
        await search("coma"); await pg.select_option("#region", "south"); await pg.check("#known")
        assert await pg.evaluate("location.search") == "?q=coma&region=south&known=1"
        await pg.reload(); await pg.wait_for_selector("#threads .thread")
        assert [await pg.input_value("#q"), await pg.input_value("#region"), await pg.is_checked("#known")] == ["coma", "south", True]
        assert await shown() == ["C/2025 R2 (SWAN)"]
        print("PASS Forums URL: search and filters are kept in it and restored on reload")

        # a failed load keeps saying so while the filters change
        answer.update(status=503, body='{"error":"database is not answering, try again"}')
        await pg.goto(BASE + "/forums.html"); await pg.wait_for_selector("#threads .f-empty")
        await pg.check("#known"); await pg.select_option("#region", "north"); await search("tail")
        assert "Threads did not load" in await pg.text_content("#threads"), f"error replaced: {await pg.text_content('#threads')!r}"
        print("PASS Forums failed load: the error stays while filters and search change")
        await b.close()

asyncio.run(main())
