// Colors (web/live/colorsworker.js): the catalogues of a spot, and the baked showcase. Contract in docs/api.md.
//   GET /api/cat?cat=2mass|catwise|allwise|gaia|simbad|vsx&ra=&dec=   the catalogue's rows in a 0.275 degree cone, as the
//     archive sent them (CSV; VSX as VizieR's tab-separated text), from R2 (OLDSKY) or, on a rate-limited miss, from the
//     archive: IRSA's TAP for the first four, SIMBAD's TAP at CDS (else its CfA mirror), VSX from VizieR at CDS (else CfA)
//     CatWISE, AllWISE and Gaia ask IRSA's Gator first (about 5 s for a dense cone, where TAP takes 10 to 60 s) and keep
//     its IPAC table as it came (text/plain; the browser reads both: colorsworker.js), TAP when Gator fails
//   GET /api/cat?cat=neowise|catwise&ra=&dec=&r=   a small cone of r arcsec (3 to 30; default 5) about a spot rounded to
//     0.0001 degree, for the Brightness change card: NEOWISE-R single exposures (neowiser_p1bs_psd), or the CatWISE rows of
//     the star itself (its first numbers before the whole field arrives). Gator first, then TAP; a small Gator table is
//     rewritten here to TAP's CSV columns
//   GET /api/colors?ra=&dec=   the baked Colors result at this spot (bake/colors_bake.mjs), or 404
// Only fetching here (the plan's 10 ms CPU): the browser parses and checks every row. What is stored must look like the
// table asked for (its header first, a complete last line) and come from a listed host, with no redirect; an error, an
// HTML page or a cut-short answer is never stored, so a later request asks again.
import { posKey, bakedAt } from './oldsky.js';

const R = 0.275, R_AS = 990, MAX = 8 << 20, TIMEOUT = 60000;   // IRSA's TAP takes up to about 30 s for a dense CatWISE cone
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const cone = (ra, dec) => `CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${R}))=1`;
const irsa = q => [`https://irsa.ipac.caltech.edu/TAP/sync?FORMAT=csv&QUERY=${encodeURIComponent(q)}`];
const simbad = q => ['simbad.cds.unistra.fr', 'simbad.harvard.edu'].map(h => `https://${h}/simbad/sim-tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`);
const NEO_COLS = 'ra,dec,mjd,w1mpro,w1sigmpro,w1snr,w2mpro,w2sigmpro,w2snr,qual_frame,qi_fact,saa_sep,moon_masked,cc_flags';
const neowise = (ra, dec, r) => [`https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?${new URLSearchParams({ catalog: 'neowiser_p1bs_psd', spatial: 'cone', objstr: `${ra} ${dec}`, radius: r, radunits: 'arcsec', outfmt: 1, selcols: NEO_COLS })}`,
  `https://irsa.ipac.caltech.edu/TAP/sync?FORMAT=csv&QUERY=${encodeURIComponent(`SELECT ${NEO_COLS} FROM neowiser_p1bs_psd WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${+(r / 3600).toFixed(6)}))=1`)}`];
// Gator's cone search, the columns of the TAP query in the same order
const gator = (catalog, cols, ra, dec, rArcsec) => `https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?${new URLSearchParams({ catalog, spatial: 'cone', objstr: `${ra} ${dec}`, radius: rArcsec, radunits: 'arcsec', outfmt: 1, selcols: cols })}`;
const CW_COLS = 'source_name,source_id,ra,dec,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro_pm,w1sigmpro_pm,w2mpro_pm,w2sigmpro_pm,nb,ab_flags,cc_flags';
const AW_COLS = 'designation,ra,dec,w1mpro,w1sigmpro,w2mpro,w2sigmpro,nb,cc_flags,w1mjdmean,w2mjdmean';
const GA_COLS = 'source_id,ra,dec,pmra,pmdec,pmra_error,pmdec_error,parallax,phot_g_mean_mag,bp_rp,ruwe,phot_variable_flag';
const vizier = (ra, dec) => ['vizier.cds.unistra.fr', 'vizier.cfa.harvard.edu'].map(h => `https://${h}/viz-bin/asu-tsv?-source=B/vsx/vsx&-c=${ra}%20${dec}&-c.rd=${R}&-out=OID,Name,Type,RAJ2000,DEJ2000&-out.max=unlimited&-oc.form=dec`);
// each catalogue: where it comes from (tried in order), its first column (the answer must start with it), its file type
export const CATS = {
  '2mass': { need: ['designation', 'ra', 'dec', 'j_m', 'h_m', 'k_m', 'j_cmsig', 'h_cmsig', 'k_cmsig', 'ph_qual', 'jdate'], first: 'designation', type: 'text/csv', urls: (ra, dec) => irsa(`SELECT designation,ra,dec,err_maj,j_m,h_m,k_m,j_cmsig,h_cmsig,k_cmsig,ph_qual,jdate FROM fp_psc WHERE ${cone(ra, dec)}`) },
  // r: a small cone (arcsec) of the star alone, Gator's few rows rewritten to CSV; else the whole field, Gator's table kept
  catwise: { need: CW_COLS.split(','), first: 'source_name', type: 'text/csv', urls: (ra, dec, r) => (r ? [gator('catwise_2020', CW_COLS, ra, dec, r), ...irsa(`SELECT ${CW_COLS} FROM catwise_2020 WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${+(r / 3600).toFixed(6)}))=1`)]
    : [gator('catwise_2020', CW_COLS, ra, dec, R_AS), ...irsa(`SELECT ${CW_COLS} FROM catwise_2020 WHERE ${cone(ra, dec)}`)]) },
  allwise: { need: AW_COLS.split(','), first: 'designation', type: 'text/csv', urls: (ra, dec) => [gator('allwise_p3as_psd', AW_COLS, ra, dec, R_AS), ...irsa(`SELECT ${AW_COLS} FROM allwise_p3as_psd WHERE ${cone(ra, dec)}`)] },
  // Gator's Gaia cone is not cut at G 20 or to stars with a motion: the browser keeps the rows TAP's query would
  gaia: { need: ['source_id', 'ra', 'dec', 'pmra', 'pmdec', 'phot_g_mean_mag', 'phot_variable_flag'], first: 'source_id', type: 'text/csv', urls: (ra, dec) => [gator('gaia_dr3_source', GA_COLS, ra, dec, R_AS), ...irsa(`SELECT ${GA_COLS} FROM gaia_dr3_source WHERE phot_g_mean_mag < 20 AND pmra IS NOT NULL AND ${cone(ra, dec)}`)] },
  simbad: { need: ['main_id', 'otype', 'ra', 'dec'], first: 'main_id', type: 'text/csv', urls: (ra, dec) => simbad(`SELECT main_id,otype,ra,dec FROM basic WHERE ${cone(ra, dec)}`) },
  vsx: { need: ['OID', 'Name', 'Type', 'RAJ2000', 'DEJ2000'], first: 'OID', type: 'text/tab-separated-values', urls: vizier },
  neowise: { need: NEO_COLS.split(','), first: 'ra', type: 'text/csv', urls: neowise },
};
const HOSTS = new Set(['irsa.ipac.caltech.edu', 'simbad.cds.unistra.fr', 'simbad.harvard.edu', 'vizier.cds.unistra.fr', 'vizier.cfa.harvard.edu']);

const round3 = v => Math.sign(v) * Math.round(Math.abs(v) * 1000) / 1000;
export function readCat(url) {
  const q = url.searchParams, cat = q.get('cat') ?? '';
  if (!Object.hasOwn(CATS, cat)) return { error: `cat must be one of ${Object.keys(CATS).join(', ')}` };
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  if (!q.get('ra')?.trim() || !Number.isFinite(ra) || ra < 0 || ra >= 360) return { error: 'ra must be 0 to 360' };
  if (!q.get('dec')?.trim() || !Number.isFinite(dec) || dec < -90 || dec > 90) return { error: 'dec must be -90 to 90' };
  if (cat === 'neowise' || (cat === 'catwise' && q.has('r'))) {   // a cone of a few arcsec: 0.001 degree (3.6") would be too coarse a key
    const rad = q.has('r') ? Number(q.get('r')) : 5;
    if (!Number.isInteger(rad) || rad < 3 || rad > 30) return { error: 'r must be a whole number of arcsec, 3 to 30' };
    const r4 = v => Math.sign(v) * Math.round(Math.abs(v) * 1e4) / 1e4, r = r4(ra) % 360, d = r4(dec);
    return { cat, ra: r, dec: d, r: rad, key: `cat/v1/${cat}/${r.toFixed(4)}${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(4)}_${rad}.csv` };
  }
  const r = round3(ra) % 360, d = round3(dec);
  return { cat, ra: r, dec: d, key: `cat/v1/${cat}/${posKey(r, d)}.${cat === 'vsx' ? 'tsv' : 'csv'}` };
}

// Gator's IPAC table (|name|name| header, then whitespace-separated rows, "null" when empty) -> CSV of the columns asked
// for, in their order. Any other answer (an error page, a message) is returned as it is and fails the header check.
export function ipacToCsv(bytes, cols) {
  const text = new TextDecoder().decode(bytes), lines = text.split('\n'), h = lines.findIndex(l => l.startsWith('|'));
  if (!text.startsWith('\\') || h < 0 || !text.endsWith('\n')) return bytes;   // cut short: refused by the header check as it is
  const names = lines[h].split('|').map(c => c.trim()).filter(Boolean), at = cols.map(c => names.indexOf(c));
  if (at.some(i => i < 0)) return bytes;
  const rows = lines.slice(h + 1).filter(l => l.trim() && !l.startsWith('|') && !l.startsWith('\\')).map(l => l.trim().split(/\s+/));
  const said = /\\RowsRetrieved\s*=\s*(\d+)/.exec(text);   // Gator says how many rows it sent: all of them must be here
  if (rows.some(v => v.length !== names.length) || (said && +said[1] !== rows.length)) return bytes;
  return new TextEncoder().encode([cols.join(','), ...rows.map(v => at.map(i => (v[i] === 'null' ? '' : v[i])).join(','))].join('\n') + '\n');
}

// one archive answer: listed host, no redirect, 200, not HTML, at most MAX bytes, the table's header first, complete
export async function fetchTable(u, first, need, fetchFn = fetch, small = false) {
  const url = new URL(u);
  if (url.protocol !== 'https:' || !HOSTS.has(url.host)) throw new Error(`not a listed archive: ${url.host}`);
  // VizieR's CfA mirror answers 500 to a request without a User-Agent
  const r = await fetchFn(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'comet-hunt/1 (TrailBlazer, NASA Space Apps)' } });
  if (r.status >= 300 && r.status < 400 || r.type === 'opaqueredirect') { r.body?.cancel?.(); throw new Error(`${url.host} redirected (${r.status})`); }
  if (r.status !== 200) { r.body?.cancel?.(); throw new Error(`${url.host} HTTP ${r.status}`); }   // never a partial (206) answer
  if (/html|xml/i.test(r.headers.get('Content-Type') ?? '')) { r.body?.cancel?.(); throw new Error(`${url.host} sent a page, not a table`); }
  if (Number(r.headers.get('Content-Length')) > MAX) { r.body?.cancel?.(); throw new Error('answer too large'); }
  // read with the cap enforced as it streams, so an answer without a length cannot fill the isolate's memory
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (let c; !(c = await reader.read()).done;) {
    n += c.value.byteLength;
    if (n > MAX) { reader.cancel().catch(() => {}); throw new Error('answer too large'); }
    parts.push(c.value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  if (r.headers.get('Content-Length') && Number(r.headers.get('Content-Length')) !== n) throw new Error(`${url.host} sent a short table`);
  if (!url.pathname.includes('/Gator/')) return checkHead(out, url, first, need);
  return small ? checkHead(ipacToCsv(out, need), url, first, need) : checkIpac(out, url, need);
}
// a whole field's Gator table, kept as it came (rewriting thousands of rows would cost the Worker's CPU): its header line
// must name every needed column, it must end in a whole line and hold as many rows as it says. A single pass over the
// bytes counts the rows.
function checkIpac(out, url, need) {
  const n = out.length, head = new TextDecoder().decode(out.subarray(0, Math.min(n, 16384))), lines = head.split('\n');
  const h = lines.findIndex(l => l.startsWith('|')), said = /\\RowsRetrieved\s*=\s*(\d+)/.exec(head);
  if (out[0] !== 92 || h < 0 || !said) throw new Error(`${url.host} sent no table`);
  const names = lines[h].split('|').map(c => c.trim()).filter(Boolean);
  if (need.some(c => !names.includes(c))) throw new Error(`${url.host} sent no table with the needed columns`);
  if (out[n - 1] !== 10) throw new Error(`${url.host} sent a short table`);
  let rows = 0, start = 0;
  for (let i = 0; i < n; i++) if (out[i] === 10) { const c = out[start]; if (i > start && c !== 92 && c !== 124) rows++; start = i + 1; }   // not \ or |
  if (rows !== +said[1]) throw new Error(`${url.host} sent ${rows} of ${said[1]} rows`);
  return out;
}
function checkHead(out, url, first, need) {
  const n = out.length;
  // the header: CSV's first line, or for VizieR the first line that is not a comment; and a complete last line
  const head = new TextDecoder().decode(out.subarray(0, Math.min(n, 8192)));
  const line = first === 'OID' ? head.split('\n').find(l => l && !l.startsWith('#')) ?? '' : head.split('\n')[0];
  // every column the browser needs (colors_ref.REQUIRED): a table missing one is never stored, or every visit would refuse it
  const cols = line.replace(/\r$/, '').split(first === 'OID' ? '\t' : ',').map(c => c.trim().replace(/^"|"$/g, ''));
  if (cols[0] !== first || need.some(c => !cols.includes(c))) throw new Error(`${url.host} sent no ${first} table with the needed columns`);
  if (out[n - 1] !== 10) throw new Error(`${url.host} sent a short table`);
  return out;
}

export async function cat(request, url, env, deps = {}) {
  const req = readCat(url), fetchFn = deps.fetch ?? fetch;
  if (req.error) return json({ error: req.error }, 400);
  if (!env.OLDSKY) return json({ error: 'catalogue unavailable', reason: 'no store' }, 503);
  const C = CATS[req.cat], hit = await env.OLDSKY.get(req.key);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': hit.httpMetadata?.contentType || C.type, ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Cat': 'hit' } });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.CAT_LIMIT && !(await env.CAT_LIMIT.limit({ key: `cat:${ip}` })).success)
    return json({ error: 'too many new spots, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
  const errors = [];
  for (const u of C.urls(req.ra, req.dec, req.r)) {
    let bytes;
    try { bytes = await fetchTable(u, C.first, C.need, fetchFn, req.r != null); } catch (e) { errors.push(e.message); continue; }
    const type = bytes[0] === 92 ? 'text/plain' : C.type;   // a Gator table kept as it came: IPAC, not CSV
    await env.OLDSKY.put(req.key, bytes, { httpMetadata: { contentType: type }, customMetadata: { source: new URL(u).host, fetched: new Date().toISOString() } });
    return new Response(bytes, { headers: { 'Content-Type': type, ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Cat': 'miss' } });
  }
  return json({ error: 'catalogue unavailable', reason: errors.join('; ') }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
}

// GET /api/colors?ra=&dec=: the baked Colors result here (colors/v1/<pos>/result.json, centre within 2 arcsec), or 404
export const colorsBaked = (url, env) => bakedAt(url, env, 'colors/v1', 'no baked colors here');
