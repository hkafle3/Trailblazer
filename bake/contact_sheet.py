"""One image of every baked flipbook frame, for eyeballing -> vision/real-frames.png.
Run: uv run --with pillow python bake/contact_sheet.py
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FLIP, OUT = ROOT / "web/data/flip", ROOT / "vision/real-frames.png"
KEYS = ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]
PAD, LW = 24, 230
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 15)

mans = [json.loads((FLIP / k / "manifest.json").read_text()) for k in KEYS]
S = max(1, 288 // mans[0]["grid"])  # about 288 px per frame
G = mans[0]["grid"] * S
cols = max(len(m["frames"]) for m in mans)
im = Image.new("RGB", (LW + cols * (G + PAD) + PAD, 40 + len(KEYS) * (G + 60)), (8, 10, 16))
d = ImageDraw.Draw(im)
d.text((PAD, 10), f"Real SPHEREx frames: one per survey visit, median of up to 4 exposures, north up, "
       f"{mans[0]['grid'] * mans[0]['arcsec_per_pixel'] / 60:.0f} arcmin wide, shown at {S}x", fill=(200, 208, 220), font=small)
y = 40
for m in mans:
    d.text((PAD, y + G // 2 - 30), m["name"], fill=(232, 236, 242), font=font)
    d.text((PAD, y + G // 2), f"detector {m['detector']}", fill=(154, 166, 184), font=small)
    for i, f in enumerate(m["frames"]):
        x, c, cy = LW + i * (G + PAD), LW + i * (G + PAD) + G // 2, y + G // 2
        im.paste(Image.open(FLIP / m["key"] / f["file"]).resize((G, G), Image.NEAREST).convert("RGB"), (x, y))
        for a, b in [((c - 28, cy), (c - 12, cy)), ((c + 12, cy), (c + 28, cy)), ((c, cy - 28), (c, cy - 12)), ((c, cy + 12), (c, cy + 28))]:
            d.line([a, b], fill=(255, 154, 77), width=2)
        d.text((x, y + G + 6), f["start"], fill=(154, 166, 184), font=small)
    y += G + 60
im.save(OUT)
print(OUT, im.size)
