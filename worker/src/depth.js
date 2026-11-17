// GET /api/depth: every object in a time-lapse patch that has a catalog distance, for one logarithmic depth scale.
// Known asteroids and comets (IMCCE SkyBoT, at the visit time), stars with a good parallax (ESA Gaia DR3) and galaxies
// with a usable redshift (SIMBAD, Harvard mirror). Anything without a usable distance is "unknown", never given a number;
// a source that fails is "unavailable", never an older copy. Contract and rules: docs/api.md, "GET /api/depth".
// Pure parts (rules, readers) are tested offline by worker/depth.test.mjs; worker/depth_eval.py checks the live endpoint.

export const R = 0.15, LIMIT = 1000, DEADLINE = 4000;   // cone radius (deg), rows kept per list (CPU: about 3 to 10 ms per 1000 rows), ms before "pending"
const AU_PC = 1 / 206264.80624709636, C = 299792.458, H0 = 70, OM = 0.3, OL = 0.7;
const ZP = 0.017, ZMIN = 0.01, VPEC = 300;   // Gaia parallax zero point (mas), lowest redshift placed, peculiar velocity (km/s)
const TTL = { stars: 30 * 86400, galaxies: 7 * 86400, sso: 7 * 86400 };
const ESA = 'https://gea.esac.esa.int/tap-server/tap/sync', SIMBAD = 'https://simbad.harvard.edu/simbad/sim-tap/sync';
const LABEL = { sso: 'SkyBoT', stars: 'Gaia archive', galaxies: 'SIMBAD' };

// ---------- distance rules ----------
// Gaia DR3 parallax (mas) and its error -> [distance, near end, far end] in parsecs: inverse parallax after one global
// zero point (an approximation of Lindegren et al. 2021, which varies with magnitude, colour and position), formal 1-sigma
// ends. Only for parallax_over_error > 5 and RUWE < 1.4 (a clean single-star fit), which keeps p - err well above zero.
export function starDistance(plx, err) {
  const p = plx + ZP;
  return [1000 / p, 1000 / (p + err), 1000 / (p - err)];
}

// comoving distance (pc) in flat LCDM: (c/H0) * integral of 1/E(z) from 0 to z. A table of the integral every 0.001
// in z (built once, about 1 ms: Simpson's rule on each step), plus Simpson's rule over the remainder: within 1e-9 of a
// 20,000-step integral (worker/depth.test.mjs).
const DZ = 0.01, ZTAB = 12;
const invE = x => 1 / Math.sqrt(OM * (1 + x) ** 3 + OL);
const simpson = (a, b, n) => { const h = (b - a) / n; let s = invE(a) + invE(b); for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * invE(a + k * h); return s * h / 3; };
let table = null;
export function comovingPc(z) {
  if (!(z > 0)) return 0;
  if (!table) { table = new Float64Array(ZTAB / DZ + 1); for (let k = 1; k < table.length; k++) table[k] = table[k - 1] + simpson((k - 1) * DZ, k * DZ, 8); }
  const k = Math.min(table.length - 1, Math.floor(z / DZ)), rest = z - k * DZ;
  return C / H0 * 1e6 * (table[k] + simpson(k * DZ, z, 2 * Math.max(1, Math.ceil(rest / (DZ / 4)))));
}

// why a SIMBAD galaxy gets no distance, or null when it gets one (first reason wins)
export function galaxyReason(z, qual, nature) {
  if (z == null) return 'no redshift';
  if (nature != null && !nature.startsWith('s')) return 'redshift not spectroscopic';   // s, se, sa: spectroscopic; p: photometric
  if (!['A', 'B', 'C', 'D'].includes(qual)) return 'redshift quality E';
  if (z < ZMIN) return 'z below 0.01';
  return null;
}
// the same rule in ADQL, and its complement written out (NULL makes NOT unsafe)
const PLACED = `rvz_redshift >= ${ZMIN} AND rvz_qual IN ('A','B','C','D') AND (rvz_nature IS NULL OR rvz_nature LIKE 's%')`;
const UNPLACED = `(rvz_redshift IS NULL OR rvz_redshift < ${ZMIN} OR rvz_qual IS NULL OR rvz_qual NOT IN ('A','B','C','D') OR (rvz_nature IS NOT NULL AND rvz_nature NOT LIKE 's%'))`;

// redshift, its error -> [distance, near, far] in parsecs. rvz_err is km/s for type v and redshift units otherwise (TAP
// says km/s for all, but type z errors run up to 0.9 on photometric z of 2.7: measured 2026-11-17). A 300 km/s
// peculiar-velocity floor is added in quadrature; with no measured error the interval is that floor alone (unc_basis).
export function galaxyDistance(z, err, type) {
  const sm = err == null ? 0 : type === 'v' ? err * (1 + z) / C : err;
  const sz = Math.hypot(sm, VPEC * (1 + z) / C);
  return [comovingPc(z), comovingPc(Math.max(z - sz, 0)), comovingPc(z + sz)];
}

// ---------- readers ----------
// CSV with quoted fields (SIMBAD quotes names; IRSA's cloud_access holds JSON with commas)
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1) rows.push(row); row = []; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const GAIA_HEAD = 'source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag,ruwe,pmra,pmdec';
const STAR_CUT = 'parallax_over_error > 5 AND ruwe < 1.4';
export function readGaia(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.replace(/\s/g, '') !== GAIA_HEAD) throw new Error('Gaia sent no table');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(','), [ra, dec, plx, err] = v.slice(1, 5).map(Number), opt = x => (x.trim() === '' ? null : Number(x));
    // the cut itself is applied by the archive on its own columns; here only what the arithmetic and the answer need
    if (v.length !== 9 || !/^\d+$/.test(v[0].trim()) || !(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) || !(err > 0) || !(plx > err))
      throw new Error(`Gaia row ${i} unreadable`);
    const [d, lo, hi] = starDistance(plx, err);
    out.push({ id: v[0].trim(), ra, dec, g: opt(v[5]), pmra: opt(v[7]), pmdec: opt(v[8]),
      raw: { parallax_mas: plx, parallax_error_mas: err, ruwe: opt(v[6]) }, d_pc: d, d_lo_pc: lo, d_hi_pc: hi });
  }
  return out;
}

// "n\n270" -> 270 (both archives answer COUNT(*) AS n like this)
export function readCount(text) {
  const [head, value] = text.trim().split(/\r?\n/);
  if (head?.replace(/["\s]/g, '') !== 'n' || !/^\d+$/.test(value?.trim() ?? '')) throw new Error('archive sent no count');
  return Number(value);
}

const SIMBAD_COLS = ['oid', 'main_id', 'otype', 'ra', 'dec', 'rvz_redshift', 'rvz_err', 'rvz_type', 'rvz_qual', 'rvz_nature'];
// SIMBAD rows -> galaxies. placed says which query they came from; a row the JS rule disagrees with is an error, so
// the ADQL and the JS rule can never drift apart silently.
export function readSimbad(text, placed) {
  if (text.split(/\r?\n/, 1)[0].replace(/["\s]/g, '') !== SIMBAD_COLS.join(',')) throw new Error('SIMBAD sent no table');
  const num = x => (x == null || x.trim() === '' ? null : Number(x));
  return parseCsv(text).map(r => {
    const z = num(r.rvz_redshift), err = num(r.rvz_err), ra = num(r.ra), dec = num(r.dec);
    const raw = { z, z_err: err, z_type: r.rvz_type?.trim() || null, qual: r.rvz_qual?.trim() || null, nature: r.rvz_nature?.trim() || null };
    if (!r.main_id || !(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) || [z, err].some(x => Number.isNaN(x))) throw new Error('SIMBAD row unreadable');
    const reason = galaxyReason(z, raw.qual, raw.nature);
    if ((reason === null) !== placed) throw new Error(`SIMBAD row ${r.main_id} does not match the rule`);
    const o = { id: r.main_id, otype: r.otype, ra, dec, raw };
    if (!placed) return { ...o, reason };
    const [d, lo, hi] = galaxyDistance(z, err, raw.z_type);
    return { ...o, d_pc: d, d_lo_pc: lo, d_hi_pc: hi, unc_basis: err == null ? 'peculiar velocity only' : 'measured and peculiar velocity' };
  });
}

// ---------- SkyBoT (shared with /api/known) ----------
export const skybotUrl = (ra, dec, t, output) => `https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?${new URLSearchParams({
  '-ep': String(t + 2400000.5), '-ra': String(ra), '-dec': String(dec), '-rd': String(R),
  '-mime': 'json', '-output': output, '-objFilter': '101', '-from': 'comet-hunt' })}`;

// hours "16 28 36.29" or degrees "-16 48 16.4" -> decimal degrees
function sexagesimal(text, hours) {
  const n = String(text).trim().match(/[+-]?\d+(?:\.\d+)?/g);
  if (!n) return NaN;
  const sign = /^\s*-/.test(text) ? -1 : 1;
  const [a, b = 0, c = 0] = n.map(x => Math.abs(Number(x)));
  return sign * (a + b / 60 + c / 3600) * (hours ? 15 : 1);
}

// one SkyBoT row -> { name, ra, dec, mag, err }, or null when it cannot be read (then the whole answer is unavailable)
export function skybotRow(r) {
  if (!r || typeof r !== 'object' || typeof r.Class !== 'string' || !r.Class.trim() || !String(r.Name || r.Num || '').trim()) return null;   // no name: unrelated rows would merge into one path
  const hms = /^\s*(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*$/.exec(r['RA (hms)'] ?? ''), dms = /^\s*[+-]?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*$/.exec(r['DEC (dms)'] ?? '');
  if (!hms || !dms || +hms[2] >= 60 || +hms[3] >= 60 || +dms[2] >= 60 || +dms[3] >= 60) return null;
  const ra = sexagesimal(r['RA (hms)'], true), dec = sexagesimal(r['DEC (dms)'], false);
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) return null;
  const vm = r['VMag (mag)'];   // a magnitude may be missing (null or empty), never garbled
  if (vm != null && vm !== '' && !Number.isFinite(Number(vm))) return null;
  const mag = Number(vm);
  return { name: String(r.Name || r.Num), ra: +ra.toFixed(5), dec: +dec.toFixed(5), mag: Number.isFinite(mag) && mag > 0 ? mag : null, err: Number(r['Err (arcsec)']) || 0 };
}

// SkyBoT's answer (status, text) -> the sso source. 204 is "nothing in the cone"; a blank 200 or a row that cannot be
// read is an error, never a partial list. A row without a numeric geocentric distance goes to unknown.
export function readSkybot(status, text) {
  const rows = status === 204 ? [] : text.trim() ? JSON.parse(text) : null;
  if (!Array.isArray(rows)) throw new Error('SkyBoT sent no list');
  const placed = [], unknown = [];
  for (const r of rows) {
    const b = skybotRow(r);
    if (!b) throw new Error('SkyBoT row unreadable');
    const o = { name: b.name, num: r.Num ?? null, class: r.Class, ra: b.ra, dec: b.dec, mag: b.mag, err_arcsec: b.err };
    const dg = r['dg (ua)'], dh = r['dh (ua)'];
    if (typeof dg === 'number' && dg > 0)
      placed.push({ ...o, raw: { dg_au: dg, dh_au: typeof dh === 'number' ? dh : null }, d_pc: dg * AU_PC, d_lo_pc: null, d_hi_pc: null });
    else unknown.push({ ...o, raw: { dg_au: null }, reason: 'no distance' });
  }
  return { status: 'ok', source: 'IMCCE SkyBoT', observer: 'geocentre', count: placed.length, truncated: false, placed, unknown };
}

// ---------- the endpoint ----------
// fail= and fresh= are honoured only in local dev (DEPTH_FAULTS=1 in worker/.dev.vars, never in wrangler.toml)
export function devFlags(url, env) {
  if (env?.DEPTH_FAULTS !== '1') return { faults: new Set(), fresh: false };
  return { faults: new Set((url.searchParams.get('fail') || '').split(',').filter(Boolean)), fresh: url.searchParams.get('fresh') === '1' };
}

const tapUrl = (base, query) => `${base}?${new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query })}`;

// rows (asked for one more than kept) must agree with an exact count of the same query, so a silent upstream row cap or
// a cut-off body is an error, never a short list
function agree(rows, n) {
  if (rows.length !== Math.min(n, LIMIT + 1)) throw new Error(`archive sent ${rows.length} rows for a count of ${n}`);
  return { rows: rows.slice(0, LIMIT), n, truncated: n > LIMIT };
}

const builders = {
  // brightest first, so a truncated list keeps what a picture shows. Positions are Gaia's epoch 2016.0 (pmra, pmdec given).
  async stars({ ra, dec }, get) {
    const cone = `FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT(ra, dec), CIRCLE(${ra}, ${dec}, ${R}))`;
    const [rowsText, goodText, totalText] = await Promise.all([
      get(tapUrl(ESA, `SELECT TOP ${LIMIT + 1} ${GAIA_HEAD} ${cone} AND ${STAR_CUT} ORDER BY phot_g_mean_mag, source_id`)),
      get(tapUrl(ESA, `SELECT COUNT(*) AS n ${cone} AND ${STAR_CUT}`)), get(tapUrl(ESA, `SELECT COUNT(*) AS n ${cone}`))]);
    const { rows, n, truncated } = agree(readGaia(rowsText), readCount(goodText));
    return { status: 'ok', source: 'ESA Gaia DR3', epoch: 2016.0, count: n, truncated, limit: LIMIT, unknown_count: readCount(totalText) - n, placed: rows };
  },
  async galaxies({ ra, dec }, get) {
    const cone = `FROM basic WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, ${R}))=1 AND otype='G..'`;
    const list = async (rule, placed) => {
      const [rows, n] = await Promise.all([get(tapUrl(SIMBAD, `SELECT TOP ${LIMIT + 1} ${SIMBAD_COLS.join(', ')} ${cone} AND ${rule} ORDER BY oid`)),
        get(tapUrl(SIMBAD, `SELECT COUNT(*) AS n ${cone} AND ${rule}`))]);
      return agree(readSimbad(rows, placed), readCount(n));
    };
    const [p, u] = await Promise.all([list(PLACED, true), list(UNPLACED, false)]);
    return { status: 'ok', source: 'SIMBAD (Harvard mirror)', count: p.n, truncated: p.truncated, limit: LIMIT,
      unknown_count: u.n, unknown_truncated: u.truncated, placed: p.rows, unknown: u.rows };
  },
  async sso({ ra, dec, t }, get, getWithStatus) {
    return { ...readSkybot(...await getWithStatus(skybotUrl(ra, dec, t, 'basic'))), epoch_jd: t + 2400000.5 };
  },
};

// Each source on its own: a cached answer, else the archive. Only ok answers are cached. No sharing of in-flight fetches
// between requests: Workers drops a promise settled outside the request that made it.
async function source(name, p, deps) {
  if (deps.faults.has(name)) throw new Error('forced failure (dev)');
  const key = `https://depth.cache/v3/${name}?ra=${p.ra.toFixed(4)}&dec=${p.dec.toFixed(4)}${name === 'sso' ? `&t=${p.t.toFixed(4)}` : ''}`;
  if (!deps.fresh) {
    const hit = await deps.cache.match(key).catch(() => null);
    if (hit) return hit.text();
  }
  const body = await builders[name](p, deps.get, deps.getWithStatus);
  const text = JSON.stringify({ ...body, fetched_at: new Date().toISOString() });
  try { await deps.cache.put(key, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL[name]}` } })); }
  catch (e) { console.warn('depth cache', e); }   // not cached this time; the answer is still good
  return text;
}

// p: { ra, dec, t } already checked and rounded (t may be null). deps: { get, getWithStatus, cache, faults, fresh, waitUntil }.
// Returns { body, complete }: body is JSON text; complete is false when any source is pending or unavailable.
export async function depthAnswer(p, deps) {
  let timer;
  const LATE = {}, late = new Promise(res => { timer = setTimeout(res, DEADLINE, LATE); });
  let complete = true;
  const parts = await Promise.all(['sso', 'stars', 'galaxies'].map(async name => {
    if (name === 'sso' && p.t == null) return `"sso":{"status":"skipped","reason":"no t given"}`;
    const job = source(name, p, deps).catch(e => ({ error: e }));
    const r = await Promise.race([job, late]);
    if (typeof r === 'string') return `"${name}":${r}`;
    complete = false;
    if (r === LATE) {
      deps.waitUntil(job);   // keeps fetching after the answer goes out, and caches the result for the next ask
      return `"${name}":${JSON.stringify({ status: 'pending', retry_after: 5 })}`;
    }
    const forced = r.error?.message === 'forced failure (dev)';
    if (!forced) console.warn('depth', name, r.error);
    return `"${name}":${JSON.stringify({ status: 'unavailable', error: forced ? r.error.message : `${LABEL[name]} is not answering`, retry_after: 30 })}`;
  }));
  clearTimeout(timer);
  const head = JSON.stringify({ ra: p.ra, dec: p.dec, t: p.t, radius_deg: R, rules: 'depth-v1' });
  return { body: `${head.slice(0, -1)},"sources":{${parts.join(',')}}}`, complete };
}
