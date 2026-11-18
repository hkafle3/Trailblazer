// Colors (web/live/colorsworker.js): the catalogues of a spot, and the baked showcase. Contract in docs/api.md.
//   GET /api/cat?cat=2mass|catwise|allwise|gaia|simbad|vsx&ra=&dec=   the catalogue's rows in a 0.275 degree cone, as the
//     archive sent them (CSV; VSX as VizieR's tab-separated text), from R2 (OLDSKY) or, on a rate-limited miss, from the
//     archive: IRSA's TAP for the first four, SIMBAD's TAP at CDS (else its CfA mirror), VSX from VizieR at CDS (else CfA)
//   GET /api/colors?ra=&dec=   the baked Colors result at this spot (bake/colors_bake.mjs), or 404
// Only fetching here (the plan's 10 ms CPU): the browser parses and checks every row. What is stored must look like the
// table asked for (its header first, a complete last line) and come from a listed host, with no redirect; an error, an
// HTML page or a cut-short answer is never stored, so a later request asks again.
import { posKey, bakedAt } from './oldsky.js';

const R = 0.275, MAX = 8 << 20, TIMEOUT = 25000;
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const cone = (ra, dec) => `CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${R}))=1`;
const irsa = q => [`https://irsa.ipac.caltech.edu/TAP/sync?FORMAT=csv&QUERY=${encodeURIComponent(q)}`];
const simbad = q => ['simbad.cds.unistra.fr', 'simbad.harvard.edu'].map(h => `https://${h}/simbad/sim-tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`);
const vizier = (ra, dec) => ['vizier.cds.unistra.fr', 'vizier.cfa.harvard.edu'].map(h => `https://${h}/viz-bin/asu-tsv?-source=B/vsx/vsx&-c=${ra}%20${dec}&-c.rd=${R}&-out=OID,Name,Type,RAJ2000,DEJ2000&-out.max=unlimited&-oc.form=dec`);
// each catalogue: where it comes from (tried in order), its first column (the answer must start with it), its file type
export const CATS = {
  '2mass': { first: 'designation', type: 'text/csv', urls: (ra, dec) => irsa(`SELECT designation,ra,dec,err_maj,j_m,h_m,k_m,j_cmsig,h_cmsig,k_cmsig,ph_qual,jdate FROM fp_psc WHERE ${cone(ra, dec)}`) },
  catwise: { first: 'source_name', type: 'text/csv', urls: (ra, dec) => irsa(`SELECT source_name,source_id,ra,dec,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro_pm,w1sigmpro_pm,w2mpro_pm,w2sigmpro_pm,nb,ab_flags,cc_flags FROM catwise_2020 WHERE ${cone(ra, dec)}`) },
  allwise: { first: 'designation', type: 'text/csv', urls: (ra, dec) => irsa(`SELECT designation,ra,dec,w1mpro,w1sigmpro,w2mpro,w2sigmpro,nb,cc_flags,w1mjdmean,w2mjdmean FROM allwise_p3as_psd WHERE ${cone(ra, dec)}`) },
  gaia: { first: 'source_id', type: 'text/csv', urls: (ra, dec) => irsa(`SELECT source_id,ra,dec,pmra,pmdec,pmra_error,pmdec_error,parallax,phot_g_mean_mag,bp_rp,ruwe,phot_variable_flag FROM gaia_dr3_source WHERE phot_g_mean_mag < 20 AND pmra IS NOT NULL AND ${cone(ra, dec)}`) },
  simbad: { first: 'main_id', type: 'text/csv', urls: (ra, dec) => simbad(`SELECT main_id,otype,ra,dec FROM basic WHERE ${cone(ra, dec)}`) },
  vsx: { first: 'OID', type: 'text/tab-separated-values', urls: vizier },
};
const HOSTS = new Set(['irsa.ipac.caltech.edu', 'simbad.cds.unistra.fr', 'simbad.harvard.edu', 'vizier.cds.unistra.fr', 'vizier.cfa.harvard.edu']);

const round3 = v => Math.sign(v) * Math.round(Math.abs(v) * 1000) / 1000;
export function readCat(url) {
  const q = url.searchParams, cat = q.get('cat') ?? '';
  if (!Object.hasOwn(CATS, cat)) return { error: `cat must be one of ${Object.keys(CATS).join(', ')}` };
  const ra = Number(q.get('ra')), dec = Number(q.get('dec'));
  if (!q.get('ra')?.trim() || !Number.isFinite(ra) || ra < 0 || ra >= 360) return { error: 'ra must be 0 to 360' };
  if (!q.get('dec')?.trim() || !Number.isFinite(dec) || dec < -90 || dec > 90) return { error: 'dec must be -90 to 90' };
  const r = round3(ra) % 360, d = round3(dec);
  return { cat, ra: r, dec: d, key: `cat/v1/${cat}/${posKey(r, d)}.${cat === 'vsx' ? 'tsv' : 'csv'}` };
}

// one archive answer: listed host, no redirect, 200, not HTML, at most MAX bytes, the table's header first, complete
export async function fetchTable(u, first, fetchFn = fetch) {
  const url = new URL(u);
  if (url.protocol !== 'https:' || !HOSTS.has(url.host)) throw new Error(`not a listed archive: ${url.host}`);
  const r = await fetchFn(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status >= 300 && r.status < 400 || r.type === 'opaqueredirect') { r.body?.cancel?.(); throw new Error(`${url.host} redirected (${r.status})`); }
  if (!r.ok) { r.body?.cancel?.(); throw new Error(`${url.host} HTTP ${r.status}`); }
  if (/html|xml/i.test(r.headers.get('Content-Type') ?? '')) { r.body?.cancel?.(); throw new Error(`${url.host} sent a page, not a table`); }
  if (Number(r.headers.get('Content-Length')) > MAX) { r.body?.cancel?.(); throw new Error('answer too large'); }
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (let c; !(c = await reader.read()).done;) {
    n += c.value.byteLength;
    if (n > MAX) { reader.cancel().catch(() => {}); throw new Error('answer too large'); }
    parts.push(c.value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  // the header: CSV's first line, or for VizieR the first line that is not a comment; and a complete last line
  const head = new TextDecoder().decode(out.subarray(0, Math.min(n, 8192)));
  const line = first === 'OID' ? head.split('\n').find(l => l && !l.startsWith('#')) ?? '' : head.split('\n')[0];
  if (!line.replace(/^"/, '').startsWith(first)) throw new Error(`${url.host} sent no ${first} table`);
  if (out[n - 1] !== 10) throw new Error(`${url.host} sent a short table`);
  return out;
}

export async function cat(request, url, env, deps = {}) {
  const req = readCat(url), fetchFn = deps.fetch ?? fetch;
  if (req.error) return json({ error: req.error }, 400);
  if (!env.OLDSKY) return json({ error: 'catalogue unavailable', reason: 'no store' }, 503);
  const C = CATS[req.cat], hit = await env.OLDSKY.get(req.key);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': C.type, ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Cat': 'hit' } });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.CAT_LIMIT && !(await env.CAT_LIMIT.limit({ key: `cat:${ip}` })).success)
    return json({ error: 'too many new spots, wait a minute', retry_after: 60 }, 429, { 'Retry-After': '60' });
  const errors = [];
  for (const u of C.urls(req.ra, req.dec)) {
    let bytes;
    try { bytes = await fetchTable(u, C.first, fetchFn); } catch (e) { errors.push(e.message); continue; }
    await env.OLDSKY.put(req.key, bytes, { httpMetadata: { contentType: C.type }, customMetadata: { source: new URL(u).host, fetched: new Date().toISOString() } });
    return new Response(bytes, { headers: { 'Content-Type': C.type, ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Cat': 'miss' } });
  }
  return json({ error: 'catalogue unavailable', reason: errors.join('; ') }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
}

// GET /api/colors?ra=&dec=: the baked Colors result here (colors/v1/<pos>/result.json, centre within 2 arcsec), or 404
export const colorsBaked = (url, env) => bakedAt(url, env, 'colors/v1', 'no baked colors here');
