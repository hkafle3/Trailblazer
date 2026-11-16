"""Check table (markdown) from OUTDIR/<slot>_<num>.json, the bars of test.md, plus the overall verdict.

Run: python3 bake/asteroid_spectra/table.py OUTDIR > OUTDIR/table.md
"""
import json, sys
from pathlib import Path

OUT = Path(sys.argv[1])
ORDER = ["T0", "S1", "S2", "S3", "C1", "C2", "C3", "V1", "X1", "F1", "F2"]
res = sorted((json.loads(f.read_text()) for f in OUT.glob("[TSCVXF][0-9]_*.json")), key=lambda r: ORDER.index(r["slot"]))
pf = lambda b: "pass" if b else "FAIL"
print("| Slot | Asteroid | Class | Pred. SNR | Images used | (a) channels SNR>=5 (refl.) | (b) null |z|<3, broadband z | "
      "(c) slope SPHEREx vs Gaia (per um) | (d) D, call | (e) single SNR, stack SNR |")
print("|---|---|---|---|---|---|---|---|---|---|")
for r in res:
    a, b, c, d, e = r["a"], r["b"], r["c"], r["d"], r["e"]
    cs = "no Gaia" if not c else f"{c['spherex'][0]:+.3f}+-{c['spherex'][1]:.3f} vs {c['gaia'][0]:+.3f}+-{c['gaia'][1]:.3f}, z {c['z']:+.1f}: {pf(c['pass_'])}"
    ds = f"D {d['D']:.3f}+-{d['sD']:.3f}, {d['call']} (exp. {d['expected']}): {pf(d['pass_'])}" if d["D"] is not None else "no data: FAIL"
    es = f"{e['single_snr_median']:.1f}, {e['broadband_snr']:.0f}" + (f": {pf(e['pass_'])}" if "pass_" in e else "")
    print(f"| {r['slot']} | ({r['num']}) {r['name']} | {r['cls']} | {r['pred_snr']:.1f} | {r['n_used']} of {r['n_img']} | "
          f"{a['channels_snr5']} ({a['refl_channels_snr5']}) of {a['channels_with_data']}: {pf(a['pass_'])} | "
          f"{b['within3']}/{b['null_channels']}, " + ", ".join(f"{z:+.1f}" for z in b["broadband_z"]) + f": {pf(b['pass_'])} | {cs} | {ds} | {es} |")
conf = [r for r in res if r["slot"] != "T0"]
if conf:
    ab = all(r["a"]["pass_"] and r["b"]["pass_"] for r in conf)
    e_ok = all(r["e"]["pass_"] for r in conf if r["slot"] in ("F1", "F2"))
    nd = sum(r["d"]["pass_"] for r in conf)
    print(f"\nConfirmation set: (a) {sum(r['a']['pass_'] for r in conf)}/{len(conf)}, (b) {sum(r['b']['pass_'] for r in conf)}/{len(conf)}, "
          f"(e) {sum(r['e'].get('pass_', False) for r in conf if r['slot'] in ('F1', 'F2'))}/2, (d) {nd}/{len(conf)}, "
          f"(c) {sum(bool(r['c'] and r['c']['pass_']) for r in conf)}/{sum(bool(r['c']) for r in conf)} (reported only). "
          f"Overall: {'PASS' if ab and e_ok and nd >= 0.8 * len(conf) and len(conf) == 10 else 'FAIL'}")
