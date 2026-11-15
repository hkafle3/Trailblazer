"""Video of SPHEREx building a comet's spectrum, one photo at a time -> design/clips/spectrum-<slug>.mp4

Left: the comet's photo for the current date (web/data/comets/<slug>/*.png). Right: every usable measurement
appears in the order SPHEREx took it, at its wavelength (each photo sees a different one), on the comet page's
compressed brightness axis. The carbon dioxide band (4.20-4.32 um) is shaded, and the clip ends on the verdict
from bake/comet_spectrum.py (the same rule as the page's badge).
Run: uv run -q --with matplotlib --with numpy --with pillow python design/clips/render_spectrum.py "3I/ATLAS"
"""
import json, re, subprocess, sys, tempfile
from datetime import datetime, timedelta
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BG, INK, MUTED, COMET, PAST = "#070a12", "#e9eef6", "#8b97ab", "#ff9a4d", "#dfe6f2"
VERDICT = {"detected": ("CO2 glow detected", COMET), "quiet": ("No gas glow", INK), "unclear": ("Not enough signal to tell", MUTED)}


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def date(mjd, fmt="%-d %b %Y"):
    return (datetime(1858, 11, 17) + timedelta(days=mjd)).strftime(fmt)


def render(name):
    d = json.loads((ROOT / "web/data/comets" / slug(name) / "comet.json").read_text())
    cache = ROOT / "bake/cache" / ("3iatlas" if name == "3I/ATLAS" else f"comets/{slug(name)}")
    pts = json.loads(next(f for f in (cache / "points-all-visits.json", cache / "points.json") if f.exists()).read_text())
    pts = sorted([p for p in pts if p["ok"]], key=lambda p: p["t"])
    months = list(d["spectrum"])
    # orange for the month that carries the verdict (3I/ATLAS: its first month), pale for the rest
    key = next((m for m, v in d["co2"].items() if v["state"] == d["co2_verdict"] and v["state"] != "unclear"), months[0])
    colour = {m: (COMET if m == key else PAST) for m in months}
    month = lambda t: date(t, "%Y-%m")
    photos = [(p["mjd"], np.asarray(Image.open(ROOT / "web/data/comets" / d["dir"] / p["file"]))) for p in d["photos"]]
    S = 5.0   # the page's asinh softening, mJy
    h = lambda f: np.arcsinh(np.asarray(f) / S)
    top, bottom = h(max(p["flux"] for p in pts) * 1.15), h(min(0, min(p["flux"] for p in pts)))
    per_frame = max(1, len(pts) // 120)   # about 4 seconds of build-up at 30 fps
    frames = list(range(per_frame, len(pts) + per_frame, per_frame)) + [len(pts)] * 75
    tmp = Path(tempfile.mkdtemp())
    for i, n in enumerate(frames):
        shown, now = pts[:min(n, len(pts))], pts[min(n, len(pts)) - 1]
        fig = plt.figure(figsize=(12.8, 7.2), dpi=100, facecolor=BG)
        fig.text(0.04, 0.92, d["name"], color=INK, fontsize=30, fontweight="bold")
        fig.text(0.04, 0.875, f"{len(shown)} of {len(pts)} SPHEREx measurements", color=MUTED, fontsize=13)
        axp = fig.add_axes([0.04, 0.2, 0.3, 0.6]); axp.axis("off")
        img = min(photos, key=lambda ph: abs(ph[0] - now["t"]))[1]
        axp.imshow(img, cmap="gray", vmin=0, vmax=255)
        axp.add_patch(plt.Circle((img.shape[1] / 2, img.shape[0] / 2), img.shape[0] * 0.09, fill=False, color=colour[month(now["t"])], lw=2))
        axp.set_title(date(now["t"], "%-d %b %Y  %H:%M"), color=colour[month(now["t"])], fontsize=14, family="monospace")
        ax = fig.add_axes([0.42, 0.2, 0.54, 0.6], facecolor=BG)
        ax.axvspan(4.20, 4.32, color=COMET, alpha=0.12, lw=0)
        ax.annotate("carbon dioxide 4.26 µm", (4.26, 1.01), xycoords=("data", "axes fraction"), color=INK, ha="center", va="bottom", fontsize=11)
        for m in months:
            sel = [p for p in shown if month(p["t"]) == m]
            if sel:
                ax.errorbar([p["lam"] for p in sel], h([p["flux"] for p in sel]),
                            yerr=[h([p["flux"] for p in sel]) - h([p["flux"] - p["err"] for p in sel]),
                                  h([p["flux"] + p["err"] for p in sel]) - h([p["flux"] for p in sel])],
                            fmt="o", ms=4.5, color=colour[m], ecolor=colour[m], elinewidth=0.6, alpha=0.9,
                            label=datetime.strptime(m, "%Y-%m").strftime("%B %Y"))
        ax.plot([now["lam"]], h([now["flux"]]), "o", ms=13, mfc="none", mec=INK, mew=1.5)
        ax.set_xlim(0.7, 5.05); ax.set_ylim(bottom, top)
        ticks = [t for t in (0, 10, 100, 1000) if h(t) <= top]
        ax.set_yticks(h(ticks)); ax.set_yticklabels([f"{t} mJy" if t else "0" for t in ticks])
        ax.set_xlabel("wavelength (µm)", color=MUTED, fontsize=12)
        for sp in ("top", "right"): ax.spines[sp].set_visible(False)
        for sp in ("left", "bottom"): ax.spines[sp].set_color("#263045")
        ax.tick_params(colors=MUTED, labelsize=11)
        ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=4, frameon=False, labelcolor=INK, fontsize=10.5,
                  handletextpad=0.3, columnspacing=1.2)   # above the chart, clear of the points
        if n >= len(pts):   # the verdict, over the last 2.5 seconds
            text, c = VERDICT[d["co2_verdict"]]
            hits = [(m, v) for m, v in d["co2"].items() if v["state"] == d["co2_verdict"] and "excess" in v]
            fmt = lambda x: f"{x:+.0f}" if abs(x) >= 10 else f"{x:+.1f}"
            detail = ("Extra light at 4.26 µm:  " + "  ·  ".join(f"{datetime.strptime(m, '%Y-%m').strftime('%b %Y')}: {fmt(v['excess'])} ± {v['sigma']:.1f} mJy" for m, v in hits[:2])
                      if hits and d["co2_verdict"] != "unclear" else
                      # unclear: either too faint to tell gas from noise, or never photographed in the band often enough
                      (lambda m, v: f"Too faint near 4.26 µm to tell gas from noise (best: {datetime.strptime(m, '%Y-%m').strftime('%B %Y')}, "
                                    f"{fmt(v['excess'])} ± {v['sigma']:.1f} mJy)")(*min(((m, v) for m, v in d["co2"].items() if "excess" in v), key=lambda mv: mv[1]["sigma"]))
                      if any("excess" in v for v in d["co2"].values()) else
                      f"Too few SPHEREx photos in the CO2 band to tell ({sum(v['n_band'] for v in d['co2'].values())} in all)")
            fig.text(0.42, 0.075, text, color=c, fontsize=24, fontweight="bold")
            fig.text(0.42, 0.035, detail, color=MUTED, fontsize=12)
        fig.savefig(tmp / f"{i:04d}.png", facecolor=BG)
        plt.close(fig)
    out = ROOT / "design/clips" / f"spectrum-{slug(name)}.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", str(tmp / "%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", str(out)], check=True)
    print(f"wrote {out.relative_to(ROOT)}: {len(frames)} frames, verdict {d['co2_verdict']}")


if __name__ == "__main__":
    for n in sys.argv[1:] or ["3I/ATLAS"]:
        render(n)
