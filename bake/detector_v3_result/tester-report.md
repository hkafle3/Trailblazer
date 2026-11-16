1. Leakage

The evaluated “run” path does not read injection truth or a held-out target list. However, detector_v3.py can read held-out positions through its separate “templates” command: line 365 loads the entire detector_v3_fields.json before selecting ['dev']. That file contains final targets starting at line 305. This is an exposure in the template-building path, not evidence that final detection used target positions.

Application data files read:
- <field_dir>/field.json and exposures.json: lines 141, 202–203, 411.
- <field_dir>/gaia.csv, catwise.csv, twomass.csv, allwise.csv: lines 131–136.
- Every exposure file named by exposures.json, normally exp/*.npz: line 76.
- bake/detector_v3_templates.json: line 287.
- detector-v3/stageA/<cache_key>.pkl, when present: lines 403–404.
- web/data/wavemaps.json through F.wave(): detector_v3_fetch.py:137–143.
- Additionally, “templates” reads bake/detector_v3_fields.json and the development fields’ inputs: lines 365–371.
- “plot” reads its supplied out.json: line 428.

Application files opened for writing are the Stage A .pkl.tmp cache, supplied out.json, output .usable.npz, templates JSON when building templates, and plot PNGs: lines 399, 406, 418, 421, 445. manifest.json is existence-checked, not opened by the detector.

The claim at detector_v3.py:3 that it reads one field directory “and nothing else” is therefore inaccurate.

2. Freeze

I ran both requested commands.

git log --oneline shows HEAD is 570e70f. Relevant history, newest first:
570e70f detector freeze
7441991 development spectrum changes
aea6530 input manifest
59180db detector draft
7b8147a evaluator fix
b03202a selection rule
b5f0c1b evaluator freeze

git diff 570e70f HEAD -- bake/ produced no diff. detector_v3.py, detector_v3_templates.json and detector_v3_frozen.json have no changes after 570e70f.

git diff 7b8147a HEAD -- bake/detector_v3_eval.py also produced no diff. Its path history shows no subsequent evaluator commits. A tracked-file status check under bake/ was clean.

The current templates and input-manifest SHA256 values also exactly match detector_v3_frozen.json:5–6.

3. Report numbers

No numerical mismatches in result.md’s five-row check table, allowing its displayed rounding.

Checked against eval_final/eval.json:
- 12/12 recovered, zero invalid, all rank 1.
- Plants: 129/144 = 89.5833%; worst bin 11/16 = 68.75%; every other gated bin has at least 13/16.
- False candidates: zero; area 5.6912185529629635; plane area 0.27644072296296296; five null variants each have 20 runs and zero candidates.
- Artifacts: zero hits, 240 tests, five nearby mover records, 80 incompletely present tests; flash peak 5435 sigma, zero candidates within 60 arcsec.
- Controls: zero cold, six valid not_cold.

The report adds plant intervals absent from the evaluator’s rows. Independently calculated 90% Clopper-Pearson intervals support them:
129/144: 0.844139–0.934686.
11/16: 0.451653–0.867889.

4. Independent classifications

Check 1: PASS. All 12 detail.heldout records have rank 1, speed ratios between 0.974714 and 1.180490, and angles no greater than 5.180215 degrees. All position matches also pass, as checked below. This satisfies evaluator docstring lines 19–23.

Check 2: FAIL. Recounting detail.plants.list gives 16 plants in every cell. At the frozen W2 limit of 14.0, the nine gated cells contain:
15/16, 13/16, 14/16;
16/16, 15/16, 11/16;
16/16, 14/16, 15/16.
The pooled 129/144 passes, but 11/16 fails the required 80% per-cell bar. See docstring lines 24–35.

Check 3: PASS. detail.false.list is empty. The upper bound is -ln(0.05)/5.6912185529629635 = 0.526378 per square degree. Area exceeds 3, and f04 has b=15 degrees with 0.276441 usable square degrees. See docstring lines 36–41.

Check 4: PASS under the frozen evaluator rules. detail.artifacts has hits=[], n=240, and a present flash with zero nearby candidates. No artifact runs are listed as missing. The implementation reports incomplete injections but does not invalidate them: evaluator lines 404–417. The binding-plan limitation is discussed below.

Check 5: PASS. All six detail.controls records have cold=false, stage="spectrum", verdict="not_cold", valid=true. Six exceeds the required five. See docstring lines 48–50.

I agree with all five recorded classifications under the evaluator’s rules.

5. Every final baseline candidate

I derived baseline directories using SHA256(seed + ":" + field + ":base")[:12], matching evaluator lines 93–96. Seed:
570e70f37d91246bd9691dc89183df41637f3069

Separations in arcsec, calculated from each out.json candidate and its field’s target at MJD 61000:

f01 / 28b2130a9a19: 0.825926
f02 / 1a931b48f274: 0.543044
f05 / b5ea6aab2494: 1.651929
f08 / 6afc91580eb3: 1.685211
f09 / da2eac5d7f09: 0.221412
f11 / e2a81e45b951: 0.160385
f12 / 001877f44dbc: 0.610455
f13 / d3982c3191ed: 0.191828
f14 / e44b98a81200: 0.797014
f16 / 9fd534836ade: 0.621992
f18 / b5bbbae6e46e: 0.654316
f19 / 3c08fea7e1b4: 0.559912

Each has exactly one candidate. The other eight baseline fields have none. No candidate is outside 6 arcsec.

6. Overstatements and missing deviations

The artifact claim needs qualification. Summing truth/final/*.json shows:
- 100 pixel-artifact tests fully present.
- 51 partially present.
- 29 with zero requested additions present.
- 60 mask-edge tests intentionally have no pixel additions.

result.md:12 discloses the 80 incomplete tests, but line 96 presents “240 planted artifacts” without that qualification. Binding amendment F5 requires confirming each artifact is present (plan.md:60), and incomplete data require an INCOMPLETE evaluation (line 77). This shortfall is missing from the deviation list. The frozen evaluator’s PASS does not establish full compliance with F5.

Persistence also differs from F5. The plan specifies fixed detector coordinates across visits. Evaluator lines 264–269 instead use four consecutive exposures spanning less than 0.02 days. This deviation is unlisted.

M1 is only partly implemented. The detector calculates and stores per-pass affine inverses at line 183, but never applies Minv in forced photometry. spectrum() uses the fitted track through world2pix(), which applies exposure translations only (lines 93–96, 290–296). The unused affine inverse is an unreported limitation against plan.md:63.

The template-building access to the full final target list should be disclosed alongside the procedural holdout claim. I found no target-list access in the evaluated run path, but the stronger isolation claim is unsupported.

Finally, result.md:39 attributes check 2’s failure mainly to bright-neighbour seed loss. Its own failing-bin breakdown contains only one such case, f05-m06. Recovering that case alone would give 12/16, still below the required 13/16.

No files were changed, and no detector or prohibited evaluator commands were run. Historical claims that final fields were never inspected and scoring occurred exactly once cannot be established from the current artifacts alone.
