# Detector v4: final evaluation (2026-11-16)

Overall: INVALID, so not a pass.
- Checks 1, 2, 3 and 5 PASS on the new held-out sky.
- Check 4 is INVALID. The frozen evaluator needed 264 artifacts and placed 262: two fields (f10, f15) got only one of their two persistence artifacts. The frozen rule makes check 4 INVALID when any required artifact is missing. On the 262 artifacts that were placed and verified, there were 0 new candidates.
- The separate crowding challenge (not part of the verdict) FAILS its own bar. 60 of 72 (83%) passes the 80% pooled bar, but five of the nine bins are below the 7 of 8 per-bin bar (four at 6 of 8, one at 5 of 8). On the same inputs v3 got 0 of 72.

Process:
- One final run from the freeze commit 734dc40, which is also the final seed. Nothing changed afterwards. Branch bake/detector-v4.
- Earlier commits: 8216043 selection, ab31c2b inputs, ccf9fba evaluator.
- The evaluator's own table is detector-v4/eval_final/table.md, and the full detail is detector-v4/eval_final/eval.json.

## Check table (22 new final fields f01 to f22, single run)

| check | bar | measured | interval | result |
|---|---|---|---|---|
| 1 held-out T/Y dwarfs | at least 80% recovered (top 3 in field, motion within 20% and 15 deg) | 12 of 13 recovered, all rank 1, 0 inputs unavailable, 0 runs missing | 90% Clopper-Pearson 0.68 to 1.00 | PASS |
| 1Y real Y dwarfs (claim, not gating; frozen in step 1) | every real Y target recovered | 3 of 3 (Y0.5, Y0, Y2) | | claim holds |
| 2 legacy isolated plants above the limit | every speed x W2-proxy bin brighter than 14.0 at least 13 of 16, and pooled at least 80% | pooled 135 of 144 (94%); worst bin 13 of 16 (0.6 to 1.2 arcsec/yr, W2 11.5 to 12.5); 135 of 137 among plants that kept their CatWISE row | pooled 0.89 to 0.97; worst bin 0.58 to 0.95 | PASS |
| 2C crowding challenge (separate, not gating) | at least 80% pooled and 7 of 8 in every bin | 60 of 72 (83%); worst bin 5 of 8 (0.6 to 1.2 arcsec/yr, W2 12.5 to 13.5); 60 of 71 with a CatWISE row | pooled 0.74 to 0.90 | FAIL |
| 3 false candidates on real sky | one-sided 95% Poisson bound under 1.0 per sq deg, at least 5.5 usable sq deg incl. a field at abs(b) 10 to 20 | 0 false candidates in 6.21 usable sq deg (plane field f08: 0.28 sq deg); nulls: 0 candidates in 110 runs (4 catalogue shifts and 1 motion reversal, 22 fields each) | bound 0.48 per sq deg | PASS |
| 4 artifacts | 0 new candidates anywhere in the artifact runs; every required artifact present and verified | 0 new candidates on 262 artifacts (388 components, all verified in the written pixels); 262 of 264 required placed (f10 and f15 each lack 1 persistence artifact after 80 placement attempts) | | INVALID |
| 4F Ed's flash (regression, field inspected before) | 0 baseline candidates within 60 arcsec | flash present in its exposure (5,435 sigma), 0 candidates within 60 arcsec | | PASS |
| 5 non-dwarf movers | 0 called cold and at least 5 of 6 with a valid non-methane verdict | 0 cold, 6 of 6 valid not_cold | | PASS |

Check 2, legacy plants (recovered / planted; W2 is the proxy, mean f_nu over 4.0 to 5.0 um, not the W2 passband):

| speed (arcsec/yr) | 11.5-12.5 | 12.5-13.5 | 13.5-14.0 | 14.0-14.5 | 14.5-15.0 | 15.0-15.5 |
|---|---|---|---|---|---|---|
| 0.3-0.6 | 15/16 | 16/16 | 16/16 | 15/16 | 13/16 | 4/16 |
| 0.6-1.2 | 13/16 | 15/16 | 15/16 | 14/16 | 13/16 | 4/16 |
| 1.2-3.0 | 16/16 | 14/16 | 15/16 | 15/16 | 14/16 | 6/16 |

Bins fainter than 14.0 are reported, not gated. Draws rejected while placing all plants: 572 outside the usable map, 1,352 not isolated, 356 too close to another plant, 21 with no suitable neighbour (crowding plants).

The 9 legacy misses above the limit:
- 7 plants had no CatWISE row. The evaluator withholds 2% at random, and they stay in the denominator. These were f03-m15, f06-m06, f07-m03, f14-m06, f17-m04, f19-m08 and f22-m06; 7 of 144 is more than the 2.9 expected.
- f05-m08 had no mover record.
- f12-m05 reached the spectrum stage and was called not_cold.

### Crowding challenge, compared with v3 (same final inputs, v3's frozen detector run on them)

| | v4 frozen | v3 frozen |
|---|---|---|
| crowding challenge, pooled | 60/72 (83%) | 0/72 |
| per bin (speed x W2 11.5-12.5 / 12.5-13.5 / 13.5-14.0) | 0.3-0.6: 6/8, 8/8, 6/8; 0.6-1.2: 8/8, 5/8, 6/8; 1.2-3.0: 8/8, 7/8, 6/8 | 0/8 in every bin |
| legacy plants above 14.0 | 135/144, worst bin 13/16 (PASS) | 126/144, worst bin 12/16 (FAIL) |
| held-out dwarfs (check 1) | 12/13 (PASS) | 8/13 (FAIL; all three Y dwarfs missed) |
| false candidates in 6.21 sq deg | 0 | 0 |

All 60 recovered crowding plants came through the archive-proposal path (D2). The 12 crowding misses:
- 9 reached the spectrum stage but were called not_cold.
- 2 were rejected as ambiguous, with a second viable CatWISE link.
- 1 had no CatWISE row.

Their neighbours have W2 9.1 to 12.5, at 13 to 22 arcsec. The comparison table is detector-v4/eval_final_out_v3/table.md. Its check 5 row (6 of 6 valid not_cold) is a real measurement from the baseline runs. Its check 4 and 4F rows are not, because v3 was not run on the artifact runs or the flash field.

## Held-out targets (check 1)

Seed paths and run directories are under detector-v4/runs/final/. "sep" is the distance of the candidate from the literature position at MJD 61000.

| field | target | stratum | SpT | lit pm | W2 | outcome | seed path | measured pm | speed ratio | angle (deg) | sep (arcsec) | run dir |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| f03 | 2MASS J03480772-6022270 | slow-bright | T7 | 0.82 | 12.57 | recovered | seed | 0.80 | 0.973 | 0.1 | 0.10 | 9b1c9282f8d5 |
| f04 | WISEPC J140518.40+553421.4 | fast-faint | Y0.5 (pec?) | 2.35 | 14.10 | recovered | seed | 2.51 | 1.070 | 0.2 | 0.62 | 875abbb753cb |
| f05 | WISEPA J085716.25+560407.6 | slow-faint | T8 | 0.75 | 14.19 | recovered | seed | 0.76 | 1.009 | 0.1 | 0.58 | 326cfdf063fd |
| f07 | WISE J235716.49+122741.8 | slow-faint | T6 | 0.51 | 14.10 | recovered | seed | 0.47 | 0.922 | 0.6 | 1.02 | b9a013bb0253 |
| f11 | WISEPA J044853.29-193548.5 | fast-faint | T5 pec | 1.18 | 14.23 | recovered | seed | 1.17 | 0.992 | 0.7 | 0.91 | 70fdf9c7eac8 |
| f13 | WISEPC J205628.90+145953.3 | extra Y | Y0 | 0.98 | 13.93 | recovered | proposal | 0.98 | 0.996 | 0.5 | 0.61 | 7ec114ddf802 |
| f14 | WISE J000517.48+373720.5 | fast-bright | T9 | 1.03 | 13.30 | recovered | seed | 1.02 | 0.991 | 0.4 | 0.40 | 90d42b36189a |
| f15 | WISEPA J182831.08+265037.8 | fast-faint | Y2 (or later) | 1.03 | 14.39 | recovered | proposal | 1.07 | 1.037 | 0.5 | 1.79 | 34166e497093 |
| f16 | 2MASS J07290002-3954043 | fast-bright | T8 pec | 1.75 | 13.00 | recovered | seed | 1.77 | 1.013 | 0.4 | 0.22 | f35d428718f3 |
| f17 | WISE J030919.67-501614.3 | slow-faint | T7 | 0.57 | 13.66 | recovered | seed | 0.58 | 1.015 | 0.6 | 0.16 | cf293c4d4c56 |
| f19 | WISEPA J045853.89+643452.9 | slow-bright | T8.5 | 0.37 | 13.01 | recovered | seed | 0.37 | 0.997 | 0.1 | 0.09 | 5350d8d45dd4 |
| f20 | 2MASSI J1217110-031113 | fast-bright | T7.5 | 1.06 | 13.27 | recovered | proposal | 1.06 | 1.000 | 2.2 | 1.02 | 1e71bbef3a8a |
| f21 | WISEPA J062720.07-111428.8 | slow-bright | T6 | 0.34 | 13.30 | missed: motion rejected (disagree) | proposal | 0.37 | (1.10) | (7.2) | 0.69 | d58e558a8c9a |

Each recovered target was the only candidate in its field.

The miss, WISE 0627-1114:
- It was measured in all three passes at S/N 37 to 41.
- Its CatWISE motion is (-0.02, -0.34) arcsec/yr. The SPHEREx-to-CatWISE displacement alone gives (-0.14, -0.41).
- The agreement test then reads chi-square 20 (p 5e-5, cut 1e-3), so the record stops at the motion stage.

Spectrum and motion evidence per survivor. dchi2 is the methane evidence and cold needs 30. Share is the dwarf templates' share of the 4 to 5 um light, and cold needs 0.5. q is the dwarf chi-square per bin, and cold needs at most 8.

| field | dchi2 | q | share | spectrum S/N | motion significance | photometry | SPHEREx/W2 flux ratio |
|---|---|---|---|---|---|---|---|
| f03 | 2,541 | 1.21 | 1.00 | 200 | 78 | aperture | 0.86 |
| f04 | 238 | 0.84 | 1.00 | 35 | 148 | aperture | 1.43 |
| f05 | 250 | 0.68 | 0.95 | 35 | 38 | aperture | 1.06 |
| f07 | 659 | 0.78 | 1.00 | 61 | 32 | aperture | 0.90 |
| f11 | 335 | 0.73 | 0.88 | 42 | 56 | aperture | 1.01 |
| f13 | 58 | 0.29 | 0.92 | 23 | 38 | neighbour fit | 0.87 |
| f14 | 424 | 0.79 | 1.00 | 54 | 75 | aperture | 0.93 |
| f15 | 35 | 0.36 | 1.00 | 17 | 40 | aperture | 1.07 |
| f16 | 243 | 0.19 | 0.97 | 54 | 88 | aperture | 0.96 |
| f17 | 502 | 0.90 | 0.96 | 63 | 51 | aperture | 1.03 |
| f19 | 289 | 0.73 | 0.97 | 64 | 26 | aperture | 0.91 |
| f20 | 639 | 0.42 | 1.00 | 135 | 62 | neighbour fit | 0.94 |

M-dwarf controls (check 5): all six reached the spectrum stage through the seed path, with motions within 0.012 arcsec/yr of Gaia.

| field | control | Gaia pm | measured pm | dchi2 | dwarf share | spectrum S/N | verdict |
|---|---|---|---|---|---|---|---|
| f01 | Gaia DR3 2647163824004282752 | 0.374 | 0.370 | 0.1 | 0.01 | 2,060 | not_cold |
| f02 | Gaia DR3 89186168428165632 | 0.315 | 0.313 | 58.3 | 0.22 | 1,779 | not_cold |
| f09 | Gaia DR3 1332410734823626240 | 1.395 | 1.386 | 63.9 | 0.29 | 541 | not_cold |
| f10 | Gaia DR3 6191263423829945600 | 0.348 | 0.336 | 29.6 | 0.20 | 492 | not_cold |
| f12 | Gaia DR3 6632815409369677568 | 0.382 | 0.379 | 0.1 | 0.01 | 1,067 | not_cold |
| f18 | Gaia DR3 4718266598246994048 | 0.382 | 0.393 | 0.2 | 0.03 | 3,074 | not_cold |

Impostor margins on the final fields. Every spectrum-stage mover that was not cold had dwarf share 0.29 or less. Their dchi2 values were 0, 0, 0, 0, 1, 14, 29.6, 58 and 64. Two M-dwarf controls (f02, f09) passed the dchi2 cut of 30, and only the share rule stopped them. A third (f10) sat at 29.6, just under the cut.

## Plots

One astrometry and spectrum PNG each, drawn by the frozen detector's plot command:
- Survivors, in detector-v4/plots/survivors/: f03-001, f04-001, f05-001, f07-001, f11-001, f13-001, f14-001, f15-001, f16-001, f17-001, f19-001 and f20-001 (.png).
- No control failed. For the record, controls and the missed target are in detector-v4/plots/controls_and_misses/: f01-001, f02-001, f09-001, f10-001, f12-001 and f18-001 for the controls, and f21-016 for the missed WISE 0627-1114.

## Solid and not solid

Solid
- Faint movers beside brighter stars, the v3 failure, are mostly found now. On the final sky the archive-proposal path with joint fits found 60 of 72 crowding plants; v3 found 0 of the same 72. Of the 12 misses, 9 failed in the spectrum and 2 stayed motion-ambiguous with their CatWISE rows present. In an early development probe on v3's old final runs (development data now), 7 of v3's 8 bright-neighbour misses came back.
- Legacy completeness rose from v3's 126 to 135 of 144 on the same final inputs, with every gated bin at 13 of 16 or better. Of the 9 misses, 7 had no CatWISE row (archive gaps that stay in the denominator), f05-m08 had its row but no mover record, and f12-m05 failed in the spectrum.
- Held-out dwarfs: 12 of 13 at rank 1, and each was the only candidate in its field. The three Y dwarfs, Y0 to Y2, were all recovered. v3 missed all three on the same inputs.
- False candidates: none in 6.21 sq deg. The 110 null runs gave none, as did the 262 placed artifacts and the flash field. In development there were none in 8.81 sq deg and 155 null runs.
- Archive priors do not manufacture motion agreement on these tests:
  - Shifted and reversed catalogues produced 39 to 79 proposal-path movers per null variant (110 runs). 5 of them reached the spectrum stage, and none became a candidate.
  - The M-dwarf controls found by the proposal path alone (development) were all correctly not_cold.

Not solid
- Check 4 is INVALID. Persistence needs one detector pixel that is unflagged in two exposures of one visit and in two later visits. In f10 and f15 that was found once instead of twice. The frozen rule turns the missing items into an INVALID check, not a pass.
- The crowding challenge fails its own per-bin bar: five of nine bins are under 7 of 8. Most crowded misses fail in the spectrum (9 of 12), not in astrometry. The neighbour-aware photometry uses one PSF per detector, built from the field's stars. Its change with wavelength inside a detector is not modelled; a wavelength-binned version was tried and made things worse. PSF_SYS (20% of the removed neighbour light) was chosen on development plants.
- The methane margin for impostors is thin, and the share rule now does most of the work. Two final M-dwarf controls reached dchi2 58 and 64, above the cut of 30, and were rejected only because the dwarf templates carried 22% and 29% of the 4 to 5 um light, under the 50% rule. On development the worst impostor was 11 under the cut. The final controls show the tail is wider than development measured. The common-error change (A8) and the added T9 and Y0 templates both add flexibility.
- The Y dwarfs pass with little room. WISE 1828+2650 (Y2) had dchi2 35 (cut 30), and WISE 2056+1459 had 58. The Y0 template comes from one development object (WISE 0410+1502, spectrum S/N 21), smoothed and floored at zero.
- Position errors from the joint fits have heavy tails. In a median pass, 4.7% of isolated Gaia stars fall beyond 3 sigma after calibration (worst 12.8%).
- The plant W2 is a proxy, and no source photon noise is added to plants. The injection PSF matches real stars' central-pixel fraction within 1 to 2%, but real stars carry 1 to 2.6% more light outside 7 x 7 pixels than the model.
- The sample is still small: 13 held-out targets (90% interval 0.68 to 1.00), 6.21 sq deg, 72 crowding plants.

## Development record (development fields only, before the freeze)

All numbers come from the 31 development fields: v3's 11 development fields plus v3's 20 final fields, which count as development in v4. Every configuration ran on the same development plants (288 legacy plants, 72 crowding plants and 368 artifacts written by the evaluator code before its commit, which differed from the committed version only in the pair rule), the same baselines and the same seeds. No final-field output existed before commit 734dc40.

Each row adds the listed changes to the row above it, except "frozen v4 without the crowded-spectrum fit", which removes one change. Two rows bundle changes: the crowded-spectrum fit came in together with A8, and PSF_SYS, Q_MAX and the templates came in together. Their separate effects come from the classifier comparison on cached spectra below, not from this table.

| configuration | legacy plants W2 under 14 | crowding challenge | held-out dev dwarfs | false candidates (8.81 sq deg) | new candidates in artifact runs | M-dwarf controls valid not_cold |
|---|---|---|---|---|---|---|
| v3 frozen detector (baseline) | 125/144 (worst bin 12/16, FAIL) | 1/72 | 19/20 | 0 | not run | 8/8 |
| + D3 joint fits (seed path only) | 127/144 (worst 12/16) | 1/72 | 19/20 | 0 | 0 | 8/8 |
| + D2 archive proposals | 135/144 (worst 12/16) | 55/72 | 19/20 | 0 | 0 | 8/8 |
| + crowded-spectrum neighbour fit (PSF_SYS 0) + A8 common errors | 135/144 (worst 13/16) | 42/72 | 18/20 (WISE 0410 became insufficient, dchi2 24) | 0 | 0 | 8/8 |
| frozen v4 (+ PSF_SYS 0.2, Q_MAX 8, T9 and Y0 templates) | 140/144 (worst 15/16) | 62/72 | 19/20 | 0 | 0 | 8/8 |
| frozen v4 without the crowded-spectrum fit | 140/144 (worst 15/16) | 58/72 | 19/20 | 0 | 0 | 8/8 |

The one development dwarf missed throughout is 2MASS J1503+2525. It sits inside v3's bright-star exclusion zone, so it is outside the searched sky.

Null runs for the frozen v4 configuration: 5 variants x 31 fields = 155 runs, 0 candidates. Paths of the null movers:
- Catalogue shifted 90 arcsec east, west, north and south: 34, 27, 18 and 30 proposal-path movers, none reaching the spectrum stage.
- Motions reversed: 114 proposal-path movers, 7 of them at the spectrum stage, none cold.

Check 4 on development data is INVALID because 368 of 372 required artifacts were placed. dev_0937 lacks its three pairs: its first pass has a single D6 exposure, and the development plants were written before the evaluator commit by code that still let pairs start in such a pass. dev_m2 lacks one persistence case. The committed evaluator draws pairs only from passes with 6 or more D6 exposures. That pair rule was the only difference between the development plant code and the committed evaluator.

Methane evidence margin (dchi2, cold needs 30), on cached development photometry. The samples are 2,040 random Gaia stars, 531 static no-Gaia CatWISE sources (galaxies and AGN), 26 crowded no-Gaia sources measured with aperture photometry, 16 crowded no-Gaia sources measured with the neighbour fit, and 8 M-dwarf controls, all on 17 development fields:

| sample | v3 classifier | frozen v4 classifier |
|---|---|---|
| random Gaia stars, max dchi2 | 6 | 6 |
| no-Gaia static sources, max dchi2 (all have dwarf share under 0.5) | 20 | 19 |
| crowded no-Gaia, aperture, max | 0 | 1 |
| crowded no-Gaia, neighbour fit, max | 4 | 9 |
| M-dwarf controls, max | 9 | 9 (shares 0.01 to 0.16) |
| real development T dwarfs, min (WISE 0410 excluded: it is the Y0 template donor) | 139 (WISE 2134) | 204 (WISE 2134; it is the T9 donor) |

On these samples the worst impostor sits 11 below the cut with the frozen v4 classifier (19 against 30). With the v3 classifier it sits 10 below (20); v3's own report gave 12 on its smaller development set. None of the impostors has a dwarf share of 0.5 or more together with a dchi2 above 6. The final M-dwarf controls (58 and 64, below) show that this development margin does not carry over to the held-out sky.

D3 calibration on the fields' own Gaia stars (89 passes):
- Formal errors were scaled up by a factor of 1.0 to 4.5 (median 2.05). The position floor was 0.15 arcsec, and the median was 181 stars per pass.
- Residual tails: in a median pass, 4.7% of isolated stars land beyond 3 sigma (worst pass 12.8%). For stars with a brighter neighbour within 30 arcsec the median is 0%, but on only about 5 stars per pass.
- Flux convention: aperture-map over PSF flux, median 0.874.
- Proposals: median 72 per field (max 567, in the dense field v3_f08). A median of 9 per field became measurable sources.

Proposal path alone (A19 diagnostic, seed path switched off): all 8 development M-dwarf controls reached the spectrum stage with the correct motion and a valid not_cold verdict (dchi2 0.1 to 9.2, share 0.01 to 0.16). Their null runs (shift east, reversed) gave 0 to 4 movers each, none at the spectrum stage and no candidates.

Choices made on development data:
- PSF_SYS (fraction of the removed neighbour light added to the error): compared on cached crowding-plant spectra at the spectrum stage. With Q_MAX 5, the crowding plants called cold were 21/46 at 0, 28/46 at 0.05, 31/46 at 0.1 and 32/46 at 0.2. With Q_MAX 8 they were 37/46 at 0.2 and 38/46 at 0.3. Impostors were unchanged at every value. Adopted 0.2, the smaller error inflation for almost the same recovery.
- Q_MAX (dwarf chi-square per bin): 5 to 8. Bright legacy plants failed at q 5.2 to 5.8 (4 of 31 in W2 11.5 to 12.5). With 8, all 31 pass and no impostor changes verdict.
- Templates: compared the T9 pec and Y0 donors raw and smoothed. Smoothed means a 3-bin median, then a 3-bin mean, floored at zero; the raw Y0 template has negative flux at short wavelengths, which is noise. Smoothed: faint plants 15/25 at W2 15 to 15.5, no-Gaia max 19. Raw: 19/25, no-Gaia max 16. Adopted the smoothed, floored version so that no template carries negative flux. Neither changes the verdict of any impostor.
- Crowded-spectrum neighbour fit: kept, at 62/72 versus 58/72 without it.
- Not adopted: per-detector PSFs split into three wavelength bins. On two crowded fields the dwarf share of the crowding plants fell from 0.6-0.7 to 0.0-0.3. The single PSF per detector was kept.
- Speed change, no effect on results: the D3 fit first used numerical derivatives; it was replaced by an analytic Jacobian that gives identical movers and calibration on a test field.

## Deviations from the plan and the binding amendments

Selection and process
1. Y dwarfs. The eligible Y pool held one extra after two Y dwarfs were drawn into the fast-faint stratum. The rule became "up to 2 extras, at least 2 real Y in total" before the step-1 commit and before any v4 data existed for those fields. The final set has 13 targets, 3 of them Y.
2. A selection bug (the excluded-name set contained None, which rejected every field centre) was found and fixed before the step-1 commit. The faulty lists were never committed or fetched.
3. Commits came in the planned order: 1 selection, 2 inputs, 3 evaluator, 4 freeze. The development plants were written by the evaluator code before its commit. That code differed from the committed version only in the pair-placement rule (see the development record).
4. The final field list has 22 fields: 13 targets, 6 controls, 1 plane field and 2 blank fields added for area. The old flash field is scored only as the separate 4F regression line, and its area is not counted.
5. Frozen evaluator thresholds used as written: the W2 limit is fixed at 14.0 (A1); the area bar is 5.5 sq deg; zero false candidates is reported but not required.
6. A15/A16 persistence. The schedule is two consecutive D6 exposures plus one exposure in each of two later visits (more than 1 day apart), at one detector pixel, with amplitudes 1, 0.5, 0.35 and 0.25. Placement failed for one persistence item in f10 and one in f15, which makes check 4 INVALID. Every placed component was verified in the written pixels: sum within 2% and centroid within 0.6 px.
7. The independent Codex scoring review ran after the final scoring, read-only, as instructed. Its findings are below.

Method
8. D1 (matched-filter seeding and global subtraction) was not built. As B2 allows, the original-image seeds are kept, CatWISE proposals are added (D2), and fits are local (D3).
9. A3. The proposal fit starts at the CatWISE-predicted position with no prior on the target position. A pass is accepted only if the fit ends within 6 arcsec (LINK_R) of that prediction, which is a selection window. Its effect is measured by the nulls (0 candidates), not removed.
10. A6. Neighbours are SPHEREx seeds and Gaia stars brighter than G 17 within 13 stack pixels (40 arcsec). Each neighbour's position has a 0.5 px prior around its own peak; the target is free. Extended sources are fitted as points, and unlisted sources are not modelled. The boundary was tested only through the calibration tails. Covariance comes from the full Jacobian and is scaled by the reduced chi-square when that is above 1. Errors are then scaled (median x2.05) and floored (0.15 arcsec) on the field's Gaia stars, and the pass tie is redone on the fitted positions.
11. A7. Forced photometry still applies a per-exposure translation, not the full affine inverse (as in v3). Median per-exposure offsets from Gaia stars are 0.03 to 0.05 px for D1 to D6. The motion flux ratio uses the joint-fit flux scaled to the aperture-map convention (median factor 0.874, measured on the field's stars).
12. A8. One common, data-driven error vector is used for both nested fits: a 3-bin median of the data times CAL_FLOOR, plus the measurement error.
13. A9. Template donors are development objects only (WISE 0410+1502 Y0, WISE 2134-7137 T9 pec), recorded in detector_v4_dev.json and kept disjoint from the injection donors. There are no planted Y dwarfs, so the Y claim rests only on the real Y targets.
14. A10. The archive model was measured on development catalogues. Crowded Gaia stars kept their CatWISE row more often (96%) than isolated ones (77%), so the row probability stays at v3's 98%. The position error scale is 1.26, the motion error scale 1.0, and the bias toward the neighbour 0.017 arcsec.
15. A11. The injection PSF is the measured ePSF zone, normalised over 15 x 15 pixels. The best-fit extra blur was 0 and the wing 0 to 8% per detector. Each plant gets a 0 to 0.3 px blur as the mismatch challenge. No source photon noise is added.
16. A14. The usable-sky recipe is v3's, unchanged, and both search paths are restricted to it. Excluded area over the final fields: 0.538 sq deg border, 0.146 bright stars, 0.013 D4 coverage, 0.002 for fewer than two tied passes.
17. A18. The stage-A cache keys on pixels, Gaia and 2MASS only. Every CatWISE-driven stage runs fresh each time. The null runs reuse the baseline's stage A and produce different movers, which shows a catalogue-only change is recomputed.
18. A19. There is no Gaia restriction on proposals; the static/blend Gaia check applies to both paths. The development diagnostic of the proposal path alone is in the development record.
19. Detector thresholds recalibrated on development data (A1): Q_MAX 5 to 8 and PSF_SYS 0.2. D_MIN 30, SHARE_MIN 0.5 and every motion-stage threshold are v3's.
20. The v3 comparison covers baseline and mover runs only. Its check 4 and 4F rows are not measurements; its checks 1, 2, 2C, 3 and 5 are.
21. The frozen detector keeps a diagnostic constant, SEED_PATH (True). It was switched off only in the development A19 diagnostic, through the development override that the freeze removed.

## Independent scoring review (Codex, read-only)

A read-only Codex pass (gpt-6.1-sol, high effort) reviewed the frozen code and the final outputs. The full text is detector-v4/scoring-review.md, the prompt is review-prompt.md and the run log is scoring-review.log.

What it confirmed:
- Freeze. Nothing changed after 734dc40 and nothing in the evaluator after ccf9fba. All five checksums in detector_v4_frozen.json match the files.
- Leakage. The run path reads only the field directory, the templates, the wavelength maps and its stage-A cache. It reads no truth, no field list and no target position.
- Check results. It recomputed all eight rows and agrees with every result, including overall INVALID.
- Candidates. All 12 baseline candidates sit 0.09 to 1.79 arcsec from their field's held-out target. The other 10 fields have none.
- Check 4 inventory. f10 and f15 each have 11 of 12 artifacts, and the INVALID follows the frozen rule.
- Numbers. It found no numerical mismatch in any table, the v3 comparison included.

Prose corrections it raised, all now applied above:
- Development check 4 also lacked one persistence case in dev_m2, so 368 of 372, not only dev_0937.
- The development table bundles changes in two rows.
- The v3 classifier's development impostor margin on these samples is 10, not 12.
- f10's control was already under the cut.
- "Fixed in astrometry" was too strong: 2 crowding misses stayed motion-ambiguous.
- Five of nine crowding bins, not one, are under 7 of 8.
- f05-m08 had its CatWISE row, so it is not an archive gap.
- v3's check 5 in the comparison is a valid measurement.

## Where things are

- Branch bake/detector-v4, worktree scratchpad/wt-detector-v4. Commits: 8216043 selection, ab31c2b inputs, ccf9fba evaluator, 734dc40 freeze.
- Final outputs, in scratchpad/detector-v4:
  - eval_final/ (table.md, eval.json), plus eval_final_out_v3/ for the v3 comparison.
  - runs/final/ with out.json, plus out_v3.json beside it.
  - truth/final/, final.log, final_tables.txt, plots/.
- Development: eval_dev_* (one per configuration), score_dev_*.txt and tmp/reclass*.txt.
- Development scripts are in scratchpad/detector-v4/src.
