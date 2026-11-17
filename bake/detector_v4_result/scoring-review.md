1. **Freeze:** No changes found. HEAD is `734dc40`; the requested diff is empty, and the worktree is clean. The evaluator also has no changes since `ccf9fba`. The eight commits are `734dc40`, `ccf9fba`, `ab31c2b`, `8216043`, `504fc44`, `570e70f`, `7441991`, `aea6530`. All five SHA256 entries in `bake/detector_v4_frozen.json:5–9` match current files: templates, input manifest, evaluator, injection PSF and archive model. `final.log:1` records the correct full freeze hash as both seed and HEAD.

2. **Leakage:** The `run` path reads:
   
   - Input directory: `field.json`, `exposures.json`, `gaia.csv`, `catwise.csv`, `twomass.csv`, `allwise.csv`, and exposure NPZ files named in `exposures.json`.
   - `bake/detector_v4_templates.json`.
   - `web/data/wavemaps.json`.
   - An existing `stageA/<cache_key>.pkl`, when available.
   
   It imports `detector_v3_fetch.py` and `detector_cold.py` as plumbing. No run-path code reads truth, `detector_v4_fields.json`, development target metadata or literature target positions. Ordinary catalogue positions and the field centre are inputs. Evidence: `detector_v4.py:87,138–154,349–355,482–483,649–662`; `detector_v3_fetch.py:138–141`.

3. **Recomputed checks:** I agree with every reported outcome, using the frozen rules in `detector_v4_eval.py:11–48`.
   
   **1 PASS:** 12/13 recovered, all rank 1, with valid positions and motions. The 90% interval is 0.68366–0.99606. **1Y PASS:** all three Y targets recovered (“claim holds”). **2 PASS:** 135/144; all nine gated bins contain 16 plants and recover at least 13. Conditional recovery is 135/137. **2C FAIL:** 60/72 pooled, but five bins fall below 7/8. **3 PASS:** zero false candidates over 6.21002655 deg²; upper bound `−ln(0.05)/area = 0.48240249` deg⁻². Plane area is 0.27604692 deg²; all 110 null outputs contain zero candidates. **4 INVALID:** 262/264 required artifacts, zero unexplained candidates. **4F PASS:** recorded flash strength 5,435 sigma and zero baseline candidates within 60″. **5 PASS:** six valid `not_cold` controls, zero cold. Overall **INVALID** follows.

4. **Every final baseline candidate:** Separations below are arcseconds from the field target at MJD 61000, independently calculated from the hashed baseline outputs:
   
   `f03-001 0.097`; `f04-001 0.620`; `f05-001 0.582`; `f07-001 1.024`; `f11-001 0.909`; `f13-001 0.608`; `f14-001 0.404`; `f15-001 1.785`; `f16-001 0.215`; `f17-001 0.165`; `f19-001 0.094`; `f20-001 1.017`.
   
   Fields **f01, f02, f06, f08, f09, f10, f12, f18, f21 and f22** have no candidates. Each remaining field has exactly its single candidate listed above. **No candidate is outside the held-out target set.**

5. **Check 4 inventory:** Required/placed counts from `truth/final/<field>.json` are **12/12 for each of f01–f09, f11–f14 and f16–f22**; **f10 is 12/11; f15 is 12/11**. Every complete field contains four singles, three pairs, two persistence cases and three mask-edge cases. Both short fields contain only one persistence case.
   
   Totals: **264 required, 262 placed**, comprising 88 singles, 66 pairs, 42 persistence cases and 66 mask-edge cases. All **388 pixel components** are marked verified. The missing persistence cases correctly make the result **INVALID**, under `detector_v4_eval.py:43,628–630`. Zero new candidates cannot override missing required cases.

6. **Numerical table comparison:** **No numerical mismatches found**, allowing the displayed rounding, in the check table, all 18 legacy-bin counts, target table, survivor spectrum table, control table or crowding comparison. Independently matching the v3 outputs reproduces **126/144 legacy recovery, worst bin 12/16; 0/72 crowded recovery; 8/13 targets; all three Y targets missed; zero false candidates**. The reported confidence intervals also round correctly. Sources: `eval_final/eval.json`, `eval_final_out_v3/eval.json` and the individual baseline/mover outputs.

7. **Prose corrections and limitations:**
   
   **Development artifacts:** `result.md:162` incorrectly says development Check 4 is invalid only because of `dev_0937`. That field lacks three pairs, but **dev_m2 also lacks one persistence case**. Both appear in `eval_dev_out_c5/eval.json:13790–13792`. The total is 368/372. Calling those inputs products of the “frozen evaluator code” at line 143 also conflicts with the acknowledged precommit placement change.
   
   **Development comparisons:** “Each row adds one change” (`result.md:145`) overstates the isolation. Crowded photometry and A8 change together, followed by PSF_SYS, Q_MAX and two templates together. Their separate contributions are not established by that table.
   
   **Impostor margin:** The cached sample supports the stated v4 maximum of 19, hence an 11-point margin. However, the same table gives the comparison classifier a maximum of 20, hence **10 points**, not the 12 implied at line 175. Final controls exceed the methane threshold at 58.34 and 63.88, so the positive development margin does not generalize. Line 113 also overreaches for f10: its **29.6436 is already below 30**, so share was not its only barrier.
   
   **Crowding:** “Fixed in astrometry” (`result.md:124`) is too categorical. Two plants with catalogue rows remain motion-ambiguous. **Five of nine bins fail**, including four at 6/8, alongside the highlighted 5/8 bin. The pooled improvement is real, but the frozen crowding bar remains unmet.
   
   **Other claims:** Calling f05-m08 an “archive gap” (`result.md:125`) is unsupported: its truth record has `row=true`; the output establishes only “no mover record.” Finally, lines 56 and 217 wrongly dismiss v3 Check 5: it uses baseline outputs and validly measures **6/6 controls**, independently of artifact runs.