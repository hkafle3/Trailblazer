"""Smooth demo of Comet Catcher (start the dev server on 8790 with a fresh database first; pass another base URL as the first argument) -> frames/*.jpg + frames.json (timestamps) + events.json (captions, fast-forward spans).
Hidden Chrome on the GPU, 1440x810 frames (the screencast sends CSS-pixel size), every frame Chrome paints (CDP screencast),
an eased cursor and captions drawn in the page. Run against the local demo server (fresh database, test Turnstile key)."""
import asyncio, base64, json, math, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790"
OUT = Path(__file__).parent
FR = OUT / "frames"
OVERLAY = """
(() => {
  const css = document.createElement('style');
  css.textContent = `
    #demo-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: rgba(255,255,255,.92); box-shadow: 0 0 0 2px rgba(5,7,13,.55), 0 0 18px rgba(255,255,255,.45); pointer-events: none;
      transition: transform .14s ease, opacity .3s; transform: translate(-60px,-60px); }
    #demo-cursor.down { width: 16px; height: 16px; margin: -8px 0 0 -8px; }
    .demo-ripple { position: fixed; z-index: 2147483646; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.8); pointer-events: none; animation: demo-rip .55s ease-out forwards; }
    @keyframes demo-rip { to { width: 64px; height: 64px; margin: -32px 0 0 -32px; opacity: 0; } }
    #demo-cap { position: fixed; z-index: 2147483645; left: 50%; top: 42px; transform: translate(-50%, -40%); opacity: 0;
      padding: 8px 18px; border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12);
      color: #eef3fb; font: 500 15px Geist, system-ui, sans-serif; letter-spacing: .1px;
      white-space: nowrap; pointer-events: none; transition: opacity .45s ease, transform .45s ease; }
    #demo-cap.on { opacity: 1; transform: translate(-50%, -50%); }`;
  const add = () => {
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = 'demo-cursor'; document.documentElement.appendChild(c);
    const k = document.createElement('div'); k.id = 'demo-cap'; document.documentElement.appendChild(k);
    addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
    addEventListener('mousedown', e => { c.classList.add('down'); const r = document.createElement('div'); r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
    const last = JSON.parse(sessionStorage.getItem('demo-pos') || 'null'); if (last) c.style.transform = `translate(${last[0]}px, ${last[1]}px)`;
    const cap = sessionStorage.getItem('demo-cap'); if (cap) { k.textContent = cap; requestAnimationFrame(() => k.classList.add('on')); }
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', add) : add();
  try { localStorage.setItem('ch.tour', '1'); } catch {}
})();"""

events, frames = [], []


async def main():
    FR.mkdir(exist_ok=True)
    for f in FR.glob("*.jpg"): f.unlink()
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True, args=["--hide-scrollbars"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 810}, device_scale_factor=4 / 3)
        await ctx.add_init_script(OVERLAY)
        pg = await ctx.new_page()
        cdp = await ctx.new_cdp_session(pg)
        t0 = [None]

        def on_frame(e):
            ts = e["metadata"]["timestamp"]
            if t0[0] is None: t0[0] = ts - (time.time() - wall0)   # put frames on the same clock as the captions
            n = len(frames)
            (FR / f"{n:06d}.jpg").write_bytes(base64.b64decode(e["data"]))
            frames.append(ts - t0[0])
            asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": e["sessionId"]}))
        cdp.on("Page.screencastFrame", on_frame)
        now = lambda: (time.time() - wall0)
        pos = [720.0, 600.0]

        async def safe(js, arg):   # page bookkeeping; a navigation in flight is fine (the init script restores it)
            for _ in range(20):
                try: return await pg.evaluate(js, arg)
                except Exception as e:
                    if 'context was destroyed' not in str(e) and 'navigation' not in str(e): raise
                    await pg.wait_for_timeout(150)

        async def cap(text):
            events.append({"t": now(), "cap": text}); print(f"{now():6.1f}s cap: {text}", flush=True)
            await safe("t => { sessionStorage.setItem('demo-cap', t); const k = document.getElementById('demo-cap'); if (!k) return;"
                              " k.classList.remove('on'); setTimeout(() => { k.textContent = t; k.classList.toggle('on', !!t); }, t ? 300 : 0); }", text)

        async def fast(on):   # spans to speed up in the edit (loading, waiting)
            events.append({"t": now(), "fast": on})

        async def move(x, y, ms=None):
            x0, y0 = pos; d = math.hypot(x - x0, y - y0)
            ms = ms or max(350, min(1100, 260 + d * 0.9))
            n = max(8, int(ms / 16))
            for i in range(1, n + 1):
                k = i / n; e = 4 * k ** 3 if k < .5 else 1 - (-2 * k + 2) ** 3 / 2   # ease in-out cubic
                await pg.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e)
                await pg.wait_for_timeout(16)
            pos[:] = [x, y]
            await safe("p => sessionStorage.setItem('demo-pos', JSON.stringify(p))", pos)

        async def box(loc):
            loc = pg.locator(loc) if isinstance(loc, str) else loc
            await loc.first.scroll_into_view_if_needed()
            return await loc.first.bounding_box()

        async def click(loc, pause=700, hold=250):
            bb = await box(loc)
            await move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
            await pg.wait_for_timeout(hold)
            await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up()
            await pg.wait_for_timeout(pause)

        async def type_(text, delay=55):
            for ch in text: await pg.keyboard.type(ch); await pg.wait_for_timeout(delay)

        async def scroll(dy, ms=900):
            n = max(10, ms // 16); done = 0
            for i in range(1, n + 1):
                k = i / n; e = 4 * k ** 3 if k < .5 else 1 - (-2 * k + 2) ** 3 / 2
                step = dy * e - done; done += step
                await pg.mouse.wheel(0, step); await pg.wait_for_timeout(16)

        async def built(timeout=90):
            await fast(True)
            try: await pg.wait_for_function("/visits, built|No SPHEREx|always work|answering/.test(document.getElementById('status')?.textContent||'')", timeout=timeout * 1000)
            except Exception:
                await pg.screenshot(path=str(OUT / "fail.png")); print("FAIL", pg.url, await pg.evaluate("document.getElementById('status')?.textContent")); raise
            await pg.wait_for_timeout(400); await fast(False)

        async def goto(url, settle=2500):
            await fast(True); await pg.goto(url); await pg.wait_for_load_state("load"); await pg.wait_for_timeout(settle); await fast(False)

        wall0 = time.time()
        await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 90, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})

        # 1. the sky
        await goto(BASE + "/explore.html", 4000)
        await cap("SPHEREx photographs the whole sky in infrared")
        await pg.wait_for_timeout(3500)
        await cap("Replay how the sky filled in, pass by pass")
        await click("#play", 9000)
        # 2. deep field
        await cap("The poles are deep fields, photographed 53x as often")
        nb = await box(".mk.deep >> nth=0 >> i")
        await move(nb["x"] + nb["width"] / 2, nb["y"] + nb["height"] / 2); await pg.wait_for_timeout(1400)
        await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up()
        await cap("")
        await built()
        await cap("Each frame is one visit. Open any spot on the sky")
        await click("#play", 7000)
        # 3. Barnard's Star
        await cap("Barnard's Star moves 10″ a year, measured from the photos")
        await goto(BASE + "/explore.html", 2500)
        await click("#examples > summary", 900)
        await click('#examples a:has-text("Barnard")', 0)
        await pg.wait_for_url("**/timelapse.html?target=barnard*"); await pg.wait_for_load_state("load"); await pg.wait_for_timeout(1500)
        await click("#play", 6500)
        await click("#play", 600)
        await cap("Difference view: orange got brighter, blue dimmer")
        await click("label:has(#diff)", 1200)
        lt = await box(".tl-visit >> nth=-1"); await move(lt["x"] + lt["width"] / 2, lt["y"] + lt["height"] / 2); await pg.wait_for_timeout(300)   # a press on the line picks the nearest visit
        await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up(); await pg.wait_for_timeout(3200)
        await click("label:has(#diff)", 900)
        # 4. another detector
        await cap("Six detectors, six infrared colours")
        await click("#det", 400)
        await pg.keyboard.press("Escape")
        await pg.select_option("#det", "D5")
        await built(); await pg.wait_for_timeout(2800)
        # 5. comets
        await cap("3I/ATLAS, the interstellar comet SPHEREx targeted")
        await click("nav a[href='comet.html']", 0)
        await fast(True); await pg.wait_for_load_state("load"); await pg.wait_for_selector(".crow"); await pg.wait_for_timeout(600); await fast(False)
        await pg.wait_for_timeout(1800)   # the list of known comets, then open 3I/ATLAS from it
        await click('.crow:has-text("3I/ATLAS")', 0)
        await fast(True); await pg.wait_for_load_state("load"); await pg.wait_for_timeout(2500); await fast(False)
        await pg.wait_for_timeout(2500)
        await cap("Its spectrum shows carbon dioxide glowing at 4.26 µm")
        await move(720, 560); await scroll(430); await pg.wait_for_timeout(4500)
        await scroll(-430); await pg.wait_for_timeout(600)
        await cap("Open any comet: C/2025 R2 (SWAN) glows too")
        await click("nav a[href='comet.html']", 0)
        await fast(True); await pg.wait_for_load_state("load"); await pg.wait_for_selector(".crow"); await fast(False)
        await click('.crow:has-text("C/2025 R2 (SWAN)")', 0)
        await fast(True); await pg.wait_for_load_state("load"); await pg.wait_for_timeout(2500); await fast(False)
        await pg.wait_for_timeout(2200)
        await move(720, 560); await scroll(430); await pg.wait_for_timeout(3800); await scroll(-430); await pg.wait_for_timeout(500)
        # 6. sign in and tag
        await cap("Sign in, tag what you see, say why. A tag is a vote")
        await click(".topbar .authbox .av", 500)   # the account circle opens a menu with Sign in
        await click(".authbox button[role=menuitem]:text-is('Sign in')", 900)
        await click("input[placeholder='Pick a name']", 200); await pg.locator("input[placeholder='Pick a name']").press_sequentially("Ada", delay=90)
        await pg.wait_for_timeout(300); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(1300)
        await click("label:has(input[name=tag][value=comet])", 700)
        await click("textarea", 200); await type_("Fuzzy, with a tail. It moves between the January photos.", 32)
        await pg.wait_for_timeout(500)
        await click('button[type=submit]:has-text("Post")', 2600)
        # 7. guide
        await cap("A short guide teaches how to spot a moving dot")
        await goto(BASE + "/guide.html", 3500)   # the Trailblazer header has no Guide link
        await click("button:has-text('Show me')", 4500)
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(700)
        # end
        await cap("")
        await goto(BASE + "/explore.html", 3000)
        await cap("Comet Catcher: real SPHEREx data, anyone can help")
        await move(720, 450); await pg.wait_for_timeout(4500)
        await cap(""); await pg.wait_for_timeout(900)
        await cdp.send("Page.stopScreencast"); await pg.wait_for_timeout(300)
        await ctx.close(); await b.close()
    (OUT / "frames.json").write_text(json.dumps(frames)); (OUT / "events.json").write_text(json.dumps(events, indent=1))
    print(len(frames), "frames,", round(frames[-1], 1), "s;", len(events), "events")

asyncio.run(main())
