"""Sky labels, the frame-time budget (plan evaluator 3): the deep zoom flight of deep_zoom_measure.py (8 s from the whole sky
to the deepest zoom, a 2 s rest, a 6 s pan, a 2 s rest) on main and on this branch, 3 runs each, alternating, at
1440 x 900 DPR 2 and at 390 x 844 DPR 3 with the CPU slowed 4x. Compared by the median of the runs.
Pass, per window: every branch run has 95% of frames within 17 ms and none over 50 ms (deep_zoom_measure's check 4), and
the branch's median p95 is at most 1 ms above main's. The time of one layout() call is printed, not judged.
Run: uv run -q --with playwright python web/tests/labels_measure.py <main base url> <branch base url> [runs]"""
import asyncio, json, statistics, sys
from playwright.async_api import async_playwright
import deep_zoom_ui as T
from deep_zoom_ui import check, open_page, STARS
from deep_zoom_measure import FLIGHT, pct

MAIN, BRANCH = sys.argv[1], sys.argv[2]
RUNS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
LAYOUT_MS = """async () => { const m = window.skyLabels; if (!m) return null; const t = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); m.layout(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return t[10]; }"""

async def run(b, base, w, h, dpr, phone):
    T.BASE = base
    pg = await open_page(b, w, h, dpr, phone, less_motion=False)
    if phone: await (await pg.context.new_cdp_session(pg)).send("Emulation.setCPUThrottlingRate", dict(rate=4))
    r = await pg.evaluate(FLIGHT, list(STARS["Barnard"]))
    lay = await pg.evaluate(LAYOUT_MS)
    errs = pg.errs; await pg.context.close()
    fr = r["fr"]
    return dict(p95=pct(fr, 95), worst=max(fr), frames=len(fr), layout_ms=lay, errs=errs)

async def main():
    out = {}
    async with async_playwright() as p:
        b = await T.launch(p)
        for name, w, h, dpr, phone in (("desktop", 1440, 900, 2, False), ("phone", 390, 844, 3, True)):
            res = {"main": [], "branch": []}
            for i in range(RUNS):
                for side, base in (("main", MAIN), ("branch", BRANCH)) if i % 2 == 0 else (("branch", BRANCH), ("main", MAIN)):   # main first, then alternating
                    r = await run(b, base, w, h, dpr, phone); res[side].append(r)
                    print(f"  {name} {side} run {i + 1}: p95 {r['p95']:.2f} ms, worst {r['worst']:.1f} ms, {r['frames']} frames, layout {r['layout_ms']} ms", flush=True)
            mm = statistics.median(r["p95"] for r in res["main"]); mb = statistics.median(r["p95"] for r in res["branch"])
            ok_runs = all(r["p95"] <= 17 and r["worst"] <= 50 for r in res["branch"])
            check(ok_runs, f"budget ({name})", "branch runs: " + ", ".join(f"p95 {r['p95']:.1f} worst {r['worst']:.1f}" for r in res["branch"]) + " (17 and 50 ms allowed)")
            check(mb - mm <= 1, f"no slower than main ({name})", f"median p95 main {mm:.2f} ms, branch {mb:.2f} ms, difference {mb - mm:+.2f} ms (1 ms allowed)")
            check(not any(r["errs"] for r in res["branch"]), f"no page errors ({name})", str([r["errs"][:2] for r in res["branch"] if r["errs"]]))
            lays = [r["layout_ms"] for r in res["branch"] if r["layout_ms"] is not None]
            out[name] = dict(main_p95=[round(r["p95"], 2) for r in res["main"]], branch_p95=[round(r["p95"], 2) for r in res["branch"]],
                             main_worst=[round(r["worst"], 1) for r in res["main"]], branch_worst=[round(r["worst"], 1) for r in res["branch"]],
                             median_main=round(mm, 2), median_branch=round(mb, 2), layout_ms=lays)
        await b.close()
    print(json.dumps(out)); print("ALL PASS" if not T.fails else f"{len(T.fails)} FAILED: {T.fails}"); sys.exit(1 if T.fails else 0)
asyncio.run(main())
