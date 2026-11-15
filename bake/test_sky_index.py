"""The builder's row checks refuse what Codex's third review found getting past the Worker's per-row checks.
Run: uv run --with numpy python bake/test_sky_index.py   (uses the committed fixture worker/fixtures/sky/d1.bin)"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import sky_index as X

first, rows = X.read_index(Path(__file__).parent.parent / "worker/fixtures/sky/d1.bin")
t, n = rows["t"].copy(), rows["n"].reshape(-1, 4, 3).astype(float)
truth = X.corners_from_normals(n)   # the fixture's own corners, as the "image corners" for these checks
assert X.check_rows(t, n, first, truth) == [], X.check_rows(t, n, first, truth)


def refused(what, t2, n2):
    errs = X.check_rows(t2, n2, first, truth)
    assert errs, f"{what} was not refused"
    print(f"refused, {what}: {errs[0]}")


k = int(first[np.argmax(np.diff(first))])   # the first row of the fullest cell, and its neighbour
f = n.copy(); f[k, 2] *= -1
refused("a flipped normal", t, f)
c = n.copy(); c[k, 2] = -c[k, 0]
refused("a collapsed footprint (edge 2 exactly opposite edge 0)", t, c)
t2 = t.copy(); t2[k] += 1e-7
refused("t not on 6 decimals", t2, n)
t3 = t.copy(); t3[k], t3[k + 1] = t[k] + 0.5, t[k + 1] - 0.5
refused("rows out of time order", t3, n)
z = n.copy(); z[k] = 0
refused("zero normals", t, z)
print("ok")
