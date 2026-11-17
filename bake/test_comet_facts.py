"""Checks for bake/comet_facts.py's visit verdicts (R8) and what a visit shows, without the network.
Run: uv run -q --with numpy python bake/test_comet_facts.py"""
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]   # comet_facts reads its own arguments at import
sys.path.insert(0, str(Path(__file__).parent))
from comet_facts import visit_verdict, more_to_measure, show

M = lambda verdict, snr=None, obs="o", det="D1", png=True: dict(verdict=verdict, snr=snr, obs=obs, det=det, png=f"web/data/comets/visits/x/{obs}_{det}.png", png_ok=png, lam=1.0, t=1.0, ra=1.0, dec=1.0)

# the review's six-picture visit: five sampled pictures below SNR 5, the sixth (unsampled) at SNR 10
six = [M("faint", 1.2, f"p{k}") for k in range(5)]
assert visit_verdict(six, n=6) == "unseen", "five of six measured and all faint is not a non-detection"
assert visit_verdict(six + [M("seen", 10.0, "p5")], n=6) == "seen", "the sixth picture's detection makes the visit seen"
assert visit_verdict(six + [M("faint", 0.4, "p5")], n=6) == "faint", "all six measured and all below 5: not detected"
# what to measure next: every remaining picture of a visit not seen, up to the cap, spread through the visit
pics = [dict(obs=f"p{k}", det="D1", t=float(k)) for k in range(6)]
assert [p["obs"] for p in more_to_measure(pics, [f"p{k}_D1" for k in range(5)], cap=12)] == ["p5"], "the unsampled sixth picture is measured"
assert len(more_to_measure([dict(obs=f"p{k}", det="D1", t=float(k)) for k in range(100)], [], cap=12)) == 12, "a large visit is measured up to the cap"
# a failed or unusable measurement is never a non-detection (the removed known_photos_fail_ui.py's rule, now in the bake)
assert visit_verdict([M("error"), M("error", obs="b")], n=2) == "unmeasured", "pictures that failed to load: could not be measured"
assert visit_verdict([M("unmeasured"), M("error", obs="b")], n=2) == "unmeasured"
assert visit_verdict([M("error"), M("faint", 1.0, "b")], n=2) == "faint", "every picture tried; the one valid is faint"
# a fragment's detection within 25 arcsec of its parent's position is the parent's light as likely as its own
assert visit_verdict([M("seen", 15.1)], n=1, near_parent=12.2) == "parent"
assert visit_verdict([M("seen", 15.1)], n=1, near_parent=None) == "seen"
# what a visit shows is the measurement it quotes: the clearest detection's own picture and SNR
got = [M("seen", 8.6, "a", "D3"), M("seen", 30.2, "b", "D5"), M("faint", 2.0, "c")]
s = show(got)
assert (s["pic"]["obs"], s["pic"]["det"], s["snr"], s["img"]) == ("b", "D5", 30.2, "data/comets/visits/x/b_D5.png"), s
assert show([M("seen", 30.2, "b", "D5", png=False), M("seen", 8.6, "a", "D3")])["snr"] == 8.6, "the clearest detection with a picture to show"
assert show([M("faint", 2.0, "c")])["snr"] is None and show([M("faint", 2.0, "c")])["img"].endswith("c_D1.png")
print("PASS bake/comet_facts.py visit verdicts and pictures")
