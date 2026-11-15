"""frames/*.jpg + frames.json + events.json -> comet-catcher-demo.mp4 (1440x810, 60 fps).
Each frame keeps its real timing; spans marked fast (page loads, time-lapse builds) play SPEED x faster."""
import json, subprocess
from pathlib import Path

D = Path(__file__).parent
SPEED = 6.0
ts = json.loads((D / "frames.json").read_text())
ev = json.loads((D / "events.json").read_text())
spans, start = [], None
for e in ev:
    if e.get("fast") is True: start = e["t"]
    elif e.get("fast") is False and start is not None: spans.append((start, e["t"])); start = None


def out_time(t):   # real time -> edited time
    cut = sum((min(t, b) - a) * (1 - 1 / SPEED) for a, b in spans if t > a)
    return t - cut


T = [out_time(t) for t in ts]
lines = []
for i in range(len(ts)):
    dur = (T[i + 1] - T[i]) if i + 1 < len(ts) else 1.0
    if dur <= 0: continue
    lines += [f"file 'frames/{i:06d}.jpg'", f"duration {dur:.6f}"]
lines.append(f"file 'frames/{len(ts) - 1:06d}.jpg'")
(D / "concat.txt").write_text("\n".join(lines) + "\n")
out = D / "comet-catcher-demo.mp4"
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(D / "concat.txt"),
                "-vf", "scale=1440:810:flags=lanczos,fps=60,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", str(out)], check=True)
print(f"{len(spans)} sped-up spans; {T[-1]:.1f} s from {ts[-1]:.1f} s; wrote {out.name}")
chap = [(round(out_time(e['t']), 1), e['cap']) for e in ev if e.get('cap')]
(D / "chapters.txt").write_text("\n".join(f"{int(t // 60)}:{int(t % 60):02d}  {c}" for t, c in chap) + "\n")
print((D / "chapters.txt").read_text())
