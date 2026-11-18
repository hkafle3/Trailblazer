// End-to-end parity against colors_ref, using colors_dump's independent intermediates.
// node web/tests/colors_parity.mjs FIXTURE_DIR REF_JSON [RA DEC]
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseCards, worldToPix } from "../live/fits.js";
import { parseCsv, parseVsx, checkColumns, catalogueStep, footprint, starOn, prepExposure, mulberry32, Refused, build, finish, parity } from "../live/colors.js";
const [dir, reference, raArg, decArg] = process.argv.slice(2);
if (!dir || !reference) {
  console.error("Usage: node web/tests/colors_parity.mjs <fixture_dir> <ref.json> [ra dec]");
  process.exit(1);
}
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8")), ref = json(reference), field = json(path.join(dir, "field.json"));
const ra = raArg == null ? ref.star.ra : Number(raArg), dec = decArg == null ? ref.star.dec : Number(decArg);
const dumps = path.resolve(dir, "../../dumps", path.basename(dir)), manifest = json(path.join(dumps, "manifest.json"));
const cats = {};
for (const name of ["twomass", "catwise", "allwise", "gaia", "simbad", "vsx"]) {
  const text = fs.readFileSync(path.join(dir, name + (name === "vsx" ? ".tsv" : ".csv")), "utf8");
  cats[name] = name === "vsx" ? parseVsx(text) : parseCsv(text);
  checkColumns(name, cats[name], text.split(/\r?\n/)[0]);
}
const metadata = json(path.join(dir, "exposures.json"));
const typed = (file, Type) => {
  const b = fs.readFileSync(file);
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const exposures = metadata.map((e) => ({ ...e, hdr: parseCards(Buffer.from(e.hdr, "latin1")).h, img: typed(path.join(dir, e.file + ".img"), Float32Array), flg: typed(path.join(dir, e.file + ".flg"), Int32Array) }));
function npy(file) {
  const b = fs.readFileSync(file), major = b[6], len = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8), off = (major === 1 ? 10 : 12) + len, h = b.subarray(major === 1 ? 10 : 12, off).toString("latin1"), dtype = /'descr':\s*'([^']+)'/.exec(h)[1], Type = { "|b1": Uint8Array, "<f4": Float32Array, "<f8": Float64Array, "<i4": Int32Array }[dtype];
  if (!Type) throw new Error(`unsupported npy ${dtype}`);
  return new Type(b.buffer.slice(b.byteOffset + off, b.byteOffset + b.length));
}
let failures = 0, number = 0;
function check(label, ok, numbers) {
  number++;
  console.log(`${ok ? "PASS" : "FAIL"} ${number}. ${label}: ${typeof numbers === "string" ? numbers : JSON.stringify(numbers)}`);
  if (!ok) failures++;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const relative = (a, b) => a === b ? 0 : a == null || b == null ? Infinity : Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const start = performance.now(), ctx = catalogueStep(cats, ra, dec);
console.log(`Catalogue: ${ctx.K?.ra.length} components, ${ctx.cand?.length} candidates, ${((performance.now() - start) / 1e3).toFixed(3)} s`);
if (ctx.result) throw new Error(`catalogueStep refused: ${JSON.stringify(ctx.result)}`);
const on = exposures.map((e) => [e, starOn(ctx, e)]).filter(([, p]) => p);
const saturated = on.map(([e, p]) => {
  for (let y = p.yi - 1; y <= p.yi + 1; y++) for (let x = p.xi - 1; x <= p.xi + 1; x++) if (e.flg[y * e.w + x] & (1 << 1 | 1 << 15)) return true;
  return false;
});
const prepStart = performance.now(), prepared = on.map(([e]) => prepExposure(ctx, e)), prepSeconds = (performance.now() - prepStart) / 1e3;
console.log(`Prep: ${prepared.length} exposures, ${prepSeconds.toFixed(3)} s`);
const { result: actual, rows, psfs, stampRows: stampActual } = parity.finishDetails(ctx, prepared, { exposures_listed: exposures.length, saturated }), seconds = (performance.now() - start) / 1e3;
check("comparison selection", equal(actual.comparisons, ref.comparisons), { n: actual.comparisons?.n, scale: actual.comparisons?.scale, dropped_moving: actual.comparisons?.dropped_moving, dropped_unmeasured: actual.comparisons?.dropped_unmeasured });
const verdicts = (r) => ({ state: r.state, reason: r.reason, fingerprints: Object.fromEntries(Object.entries(r.fingerprints || {}).map(([k, v]) => [k, [v.verdict, v.reason]])) });
check("state and fingerprint strings", equal(verdicts(actual), verdicts(ref)), verdicts(actual));
let bins = true, curves = true, counts = 0;
const max = { flux: 0, error: 0, sigma: 0, bare: 0 };
for (const r of ref.passes || []) {
  const a = actual.passes?.find((p) => p.key === r.key);
  bins &&= !!a && equal(a.lam, r.lam);
  if (!a) {
    curves = false;
    continue;
  }
  for (const [key2, label] of [["mjy", "flux"], ["err", "error"], ["sigma", "sigma"]]) {
    if (!equal(a[key2]?.length, r[key2]?.length)) {
      curves = false;
      continue;
    }
    for (let i = 0; i < (r[key2]?.length || 0); i++) {
      const d = relative(a[key2][i], r[key2][i]);
      max[label] = Math.max(max[label], d);
      curves &&= d <= 0.01;
      counts++;
    }
  }
}
if (ref.bare) {
  bins &&= equal(actual.bare?.lam, ref.bare.lam);
  for (const key2 of ["mjy", "spread"]) for (let i = 0; i < ref.bare[key2].length; i++) {
    const d = relative(actual.bare?.[key2]?.[i], ref.bare[key2][i]);
    max.bare = Math.max(max.bare, d);
    curves &&= d <= 0.01;
  }
}
check("pass bins, fluxes, errors, sigma and bare star", bins && curves, { bins, values: counts, max_relative: max });
let fitsOk = true;
const fits = [];
for (const [k, r] of Object.entries(ref.fits || {})) {
  const a = actual.fits?.[k];
  if (!r) {
    fitsOk &&= a === null;
    continue;
  }
  if (!a) {
    fitsOk = false;
    continue;
  }
  const da = relative(a.a, r.a), db = Math.abs(a.b - r.b), dT = Math.abs(a.T - r.T), checkT = ref.fingerprints.rise.verdict === "seen";
  fitsOk &&= da <= 0.02 && db <= Math.max(0.02, 0.02 * Math.abs(r.b)) && (!checkT || dT <= 10);
  fits.push({ key: k, a: a.a, b: a.b, T: a.T, a_relative: da, b_absolute: db, T_delta: dT, T_checked: checkT });
}
check("fits", fitsOk, fits);
let mismatch = 0, maskPixels = 0, sigMax = 0, shiftMax = 0, subMax = 0;
const prepNumbers = [];
for (const d of manifest.exposures) {
  const a = prepared.find((e) => e.obs === d.obs && e.det === d.det);
  if (!a) {
    mismatch++;
    continue;
  }
  const bad = npy(path.join(dumps, d.prefix + ".bad.npy")), sub = npy(path.join(dumps, d.prefix + ".sub.npy"));
  if (bad.length !== a.bad.length) mismatch++;
  for (let i = 0; i < bad.length; i++) {
    maskPixels++;
    if (bad[i] !== a.bad[i]) mismatch++;
    if (Number.isFinite(sub[i]) && Number.isFinite(a.sub[i])) subMax = Math.max(subMax, Math.abs(sub[i] - a.sub[i]));
  }
  const sd = relative(a.sig_ap, d.sig_ap), sh = Math.max(...a.shift.map((v, i) => relative(v, d.shift[i])));
  sigMax = Math.max(sigMax, sd);
  shiftMax = Math.max(shiftMax, sh);
  prepNumbers.push({ obs: d.obs, det: d.det, sig_ap: a.sig_ap, shift: a.shift });
}
check("five prep masks, aperture noise and shift", manifest.exposures.length === 5 && mismatch === 0 && sigMax <= 1e-4 && shiftMax <= 1e-4, { pixels: maskPixels, mismatches: mismatch, sig_relative: sigMax, shift_relative: shiftMax, sub_absolute: subMax, exposures: prepNumbers });
const stampRef = json(path.join(dumps, "stamp_rows.json"));
const key = (r) => `${r.component}/${r.det}/${r.obs}`, stampMap = new Map(stampActual.map((r) => [key(r), r])), stampKeys = equal(stampRef.map(key).sort(), stampActual.map(key).sort());
let fluxMax = 0;
for (const r of stampRef) fluxMax = Math.max(fluxMax, relative(stampMap.get(key(r))?.row[2], r.row[2]));
check("stamp_fit component and exposure sets and flux", stampKeys && fluxMax <= 0.01, { reference: stampRef.length, actual: stampActual.length, same_set: stampKeys, max_flux_relative: fluxMax });
let wcsMax = 0;
for (const d of manifest.wcs) {
  const e = exposures.find((e2) => e2.obs === d.obs && e2.det === d.det);
  for (const p of d.points) {
    const xy = worldToPix(e.hdr, p.ra, p.dec);
    wcsMax = Math.max(wcsMax, ...xy.map((v, i) => Math.abs(v - p.pixel[i])));
  }
}
check("WCS against astropy on three exposures", manifest.wcs.length === 3 && wcsMax <= 1e-6, { exposures: manifest.wcs.length, max_pixel_error: wcsMax });
let psfMax = 0;
for (const d of ["D1", "D2", "D3", "D4", "D5", "D6"]) if (psfs[d]) {
  const r = npy(path.join(dumps, d + ".psf.npy"));
  for (let i = 0; i < r.length; i++) psfMax = Math.max(psfMax, Math.abs(psfs[d][i] - r[i]));
}
check("PSF stamp counts and coefficients", equal(actual.data.psf_stamps, manifest.psf_stamps) && psfMax <= 1e-5, { counts: actual.data.psf_stamps, max_coefficient_absolute: psfMax });
const sourceRef = json(path.join(dumps, "spectra.json")), sourceActual = parity.perSource(rows, [ctx.T, ...ctx.cand], actual.passes_mjd);
let sourceMax = 0, sourceBins = true, sourceValues = 0;
for (const [i, R] of Object.entries(sourceRef)) {
  if (!sourceActual[i]) {
    sourceBins = false;
    continue;
  }
  for (const [k, pair] of Object.entries(R)) {
    if (k === "raw") continue;
    for (let j = 0; j < 2; j++) for (let b = 0; b < pair[j].length; b++) {
      const a = sourceActual[i][k][j][b], r = pair[j][b];
      if (r === null) {
        sourceBins &&= !Number.isFinite(a);
        continue;
      }
      sourceBins &&= Number.isFinite(a);
      sourceMax = Math.max(sourceMax, relative(a, r));
      sourceValues++;
    }
  }
}
check("per-source binned spectra", sourceBins && sourceMax <= 0.01, { sources: Object.keys(sourceRef).length, values: sourceValues, same_bins: sourceBins, max_relative: sourceMax });
let footprintBad = 0;
for (const e of exposures) {
  const f = footprint(e.hdr, field.ra, field.dec);
  if (!f || f.x0 !== e.x0 || f.y0 !== e.y0 || f.x1 - f.x0 !== e.w || f.y1 - f.y0 !== e.h) footprintBad++;
}
check("field footprint bounds", footprintBad === 0, { exposures: exposures.length, mismatches: footprintBad });
check("single-thread build performance", seconds < 90, { exposures: exposures.length, build_seconds: seconds, prep_seconds: prepSeconds });
const probes = json(path.join(dumps, "numerics.json")), errors = {};
function probe(name, a, b, tolerance = 1e-10) {
  let worst = 0, ok = true;
  function compare(a2, b2) {
    if (Array.isArray(b2)) {
      if (a2.length !== b2.length) ok = false;
      for (let i = 0; i < b2.length; i++) compare(a2[i], b2[i]);
    } else if (b2 === null) {
      if (Number.isFinite(a2)) ok = false;
    } else {
      worst = Math.max(worst, Math.abs(Number(a2) - Number(b2)));
      if (!Number.isFinite(worst)) ok = false;
    }
  }
  compare(a, b);
  errors[name] = worst;
  return ok && worst <= tolerance;
}
let probesOk = true;
const probeImage = Float32Array.from(probes.mesh_input.flat(), (v) => v === null ? NaN : v);
probesOk = probe("mesh", parity.mesh(probeImage, 43, 37), probes.mesh.flat(), 1e-6) && probesOk;
const splineInput = Float64Array.from(probes.spline_input.flat()), coeff = parity.splineFilter(splineInput, 15, 15);
probesOk = probe("spline", coeff, probes.spline.flat()) && probesOk;
probesOk = probe("map_boundary", probes.coords.map(([y, x]) => parity.mapCoordinate(coeff, 15, 15, y, x)), probes.mapped) && probesOk;
probesOk = probe("shift_nearest", parity.shift(splineInput, 15, 15, 0.3, -0.4), probes.shift.flat()) && probesOk;
for (const d of Object.keys(probes.wave)) probesOk = probe("wave_" + d, [[0, 0], [500.3, 900.7], [-10, 2050]].map(([y, x]) => parity.wave(d, y, x)), probes.wave[d]) && probesOk;
probesOk = probe("median", parity.median([3, 1, 2, 7]), probes.median) && probesOk;
probesOk = probe("percentile", [16, 50, 84].map((p) => parity.percentile([3, 1, 2, 7], p)), probes.percentile) && probesOk;
probesOk = probe("interp", [-1, 0.5, 4].map((x) => parity.interp(x, [0, 1, 3], [2, 4, 1])), probes.interp) && probesOk;
probesOk = probe("digitize", [-0.1, 0, 1, 3].map((x) => parity.digitize(x, [0, 1, 3])), probes.digitize) && probesOk;
probesOk = probe("inverse", parity.inverse([4, 2, 1, 3], 2), probes.inverse.flat()) && probesOk;
const rng = mulberry32(20261118);
probesOk = probe("mulberry32", Array.from({ length: 32 }, () => rng()), probes.rng, 0) && probesOk;
const probePrep = prepExposure({ gaia: [] }, { img: probeImage, flg: Int32Array.from(probes.prep_flags.flat()), w: 43, h: 37, x0: 0, y0: 0, t: 58e3, det: "D1", obs: "probe", hdr: {} });
probesOk = probe("dilation_bad", probePrep.bad, probes.prep_bad.flat(), 0) && probesOk;
probesOk = probe("prep_sub", probePrep.sub, probes.prep_sub.flat(), 1e-6) && probesOk;
probesOk = probe("float32_convolution_sigma", probePrep.sig_ap, probes.prep_sig, 1e-7) && probesOk;
check("SciPy and NumPy numerical probes", probesOk, { scipy: probes.scipy, max_absolute: errors });
let contractsOk = equal(parseCsv('a,b\r\n"x,y","say ""hi""\r\nnext"\r\n'), [{ a: "x,y", b: 'say "hi"\r\nnext' }]) && equal(parseCsv('a\n""\n\n""'), [{ a: "" }, { a: "" }]);
let refused = 0;
for (const [call, message] of [
  [() => parseVsx("not a table"), "the vsx catalogue is not a VizieR table"],
  [() => parseVsx("OID	Name\n\n"), "the vsx catalogue lacks Type, RAJ2000, DEJ2000"],
  [() => checkColumns("simbad", [], "main_id,ra,dec"), "the simbad catalogue lacks otype"]
]) {
  try {
    call();
    contractsOk = false;
  } catch (e) {
    contractsOk &&= e instanceof Refused && e.message === message;
    refused++;
  }
}
const vsxText = "# comment\nOID	Name	Type	RAJ2000	DEJ2000\n 	 	 	deg	deg\n---	---	---	---	---\n1	 Test 	V	2	3\n";
contractsOk &&= equal(parseVsx(vsxText), [{ OID: "1", Name: "Test", Type: "V", RAJ2000: "2", DEJ2000: "3" }]);
const noCoverage = { v: 1, method: "colors-v1", state: "no-coverage", reason: "SPHEREx has no pictures of this star" };
contractsOk &&= equal(build({ cats, exposures: [], ra, dec }), noCoverage) && equal(finish(ctx, [], { exposures_listed: 0, saturated: [] }), noCoverage);
check("CSV, VSX, refusal and composition contracts", contractsOk, { quoted_csv_cases: 2, vsx_rows: 1, refusals: refused, no_coverage_paths: 2 });
let ancillaryOk = true, ancillaryMax = 0, ancillaryValues = 0;
function compareAncillary(a, b) {
  if (b === null) {
    ancillaryOk &&= a === null;
    return;
  }
  if (typeof b === "number") {
    const delta = Math.abs(a - b);
    ancillaryOk &&= Number.isFinite(a) && (delta <= 1e-5 || relative(a, b) <= 0.01);
    ancillaryMax = Math.max(ancillaryMax, delta);
    ancillaryValues++;
    return;
  }
  if (typeof b === "object") {
    ancillaryOk &&= !!a && equal(Object.keys(a || {}).sort(), Object.keys(b).sort());
    for (const k of Object.keys(b)) compareAncillary(a?.[k], b[k]);
  } else ancillaryOk &&= a === b;
}
for (const k of ["star", "data", "passes_mjd", "saturation", "aS", "excess_46", "excess_by_detector", "comparison_systematic", "old"]) if (k in ref) compareAncillary(actual[k], ref[k]);
ancillaryOk &&= equal(Object.keys(actual).sort(), Object.keys(ref).sort());
check("result keys, metadata, historical points and bootstrap", ancillaryOk, { numeric_values: ancillaryValues, max_absolute: ancillaryMax, bootstrap_n: actual.comparison_systematic?.n ?? null, old_bands: actual.old?.map((r) => r.band) ?? [] });
console.log(`${path.basename(dir)}: ${failures ? "FAIL" : "PASS"}, ${seconds.toFixed(3)} s build, ${failures} failed checks`);
process.exitCode = failures ? 1 : 0;
