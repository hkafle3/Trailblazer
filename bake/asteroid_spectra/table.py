"""Check tables (markdown) from OUTDIR/<slot>_<num>.json: the bars of test.md for the frozen method (counted) and the
burst-chain method (reported), plus the overall verdict for each.

Run: python3 bake/asteroid_spectra/table.py OUTDIR > OUTDIR/table.md
"""
import json, sys
from pathlib import Path

OUT = Path(sys.argv[1])
ORDER = ["T0", "S1", "S2", "S3", "C1", "C2", "C3", "V1", "X1", "F1", "F2", "V1b", "X1b"]
res = sorted((json.loads(f.read_text()) for f in OUT.glob("*_*.json") if f.name.split("_")[0] in ORDER),
             key=lambda r: ORDER.index(r["slot"]))
pf = lambda b: "pass" if b else "FAIL"


def table(method):
    print(f"\n### Method: {method}\n")
    print("| Slot | Asteroid | Class | Pred. SNR | Images used | (a) channels SNR>=5 (reflected) | (b) null channels |z|<3; broadband z | "
          "(c) 0.75-1.0 um slope, SPHEREx vs Gaia (per um) | (d) band depth D, call | (e) median single SNR; broadband stack SNR |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for r in res:
        v = r[method]
        a, b, c, d, e = v["a"], v["b"], v["c"], v["d"], v["e"]
        cs = "no Gaia spectrum" if not c else f"{c['spherex'][0]:+.2f} +- {c['spherex'][1]:.2f} vs {c['gaia'][0]:+.2f} +- {c['gaia'][1]:.2f} (z {c['z']:+.1f}): {pf(c['pass_'])}"
        ds = (f"{d['D']:.3f} +- {d['sD']:.3f}, {d['call']} (expected {d['expected']}): {pf(d['pass_'])}" if d["D"] is not None
              else "not enough channels: FAIL")
        es = f"{e['single_snr_median']:.1f}; {e['broadband_snr']:.0f}" + (f": {pf(e['pass_'])}" if "pass_" in e else "")
        print(f"| {r['slot']} | ({r['num']}) {r['name']} | {r['cls']} | {r['pred_snr']:.1f} | {r['n_used']} of {r['n_img']} | "
              f"{a['channels_snr5']} ({a['refl_channels_snr5']}) of {a['channels_with_data']}: {pf(a['pass_'])} | "
              f"{b['within3']}/{b['null_channels']}; " + ", ".join(f"{z:+.1f}" for z in b["broadband_z"]) + f": {pf(b['pass_'])} | {cs} | {ds} | {es} |")
    conf = [r for r in res if r["slot"] in ORDER[1:11]]
    if conf:
        ok = lambda r, k: r[method][k]["pass_"]
        ab = all(ok(r, "a") and ok(r, "b") for r in conf)
        fe = [r for r in conf if r["slot"] in ("F1", "F2")]
        e_ok = len(fe) == 2 and all(r[method]["e"]["pass_"] for r in fe)
        nd = sum(ok(r, "d") for r in conf)
        print(f"\nConfirmation set ({len(conf)} of 10 measured): (a) {sum(ok(r, 'a') for r in conf)}/{len(conf)}, (b) {sum(ok(r, 'b') for r in conf)}/{len(conf)}, "
              f"(e) {sum(r[method]['e']['pass_'] for r in fe)}/2, (d) {nd}/{len(conf)}, "
              f"(c) {sum(bool(r[method]['c'] and r[method]['c']['pass_']) for r in conf)}/{sum(bool(r[method]['c']) for r in conf)} (reported only). "
              f"Overall: {'PASS' if ab and e_ok and nd >= 8 and len(conf) == 10 else 'FAIL'}")


table("frozen")
table("chain")
