// Port of bake/colors_ref.py. All positions are 0-based full-frame pixels.
import { worldToPix, tanDeproject, parseCards } from "./fits.js";
const AS = 206264.806, RAD = Math.PI / 180, MJD_CW = 57170, MJD_GAIA = 57388.5;
const PH = 7, TILE = 8, MJY_PIX = 1e9 * (6.15 / AS) ** 2;
const BAD = [0, 1, 2, 6, 9, 10, 11, 15, 17, 22, 23, 24, 25, 27, 28, 29].reduce((a, b) => a | 1 << b, 0);
const GROW = 1 << 1 | 1 << 26, SAT = 1 << 1 | 1 << 15;
const DETS = ["D1", "D2", "D3", "D4", "D5", "D6"], SCALES = [1, 1.5, 2, 3, 5, 8], TGRID = Array.from({ length: 231 }, (_, i) => 200 + 10 * i);
const ZP = { J: 1594e3, H: 1024e3, K: 666700, W1: 309540, W2: 171790 };
const WIN = { J: [1.11, 1.39], H: [1.5, 1.8], K: [2, 2.31] }, WL = { J: 1.235, H: 1.662, K: 2.159, W1: 3.35, W2: 4.6 };
const EDGES = Array.from({ length: Math.ceil((Math.log(5) - Math.log(0.75) + 1e-9) * 40) }, (_, i) => Math.exp(Math.log(0.75) + i / 40));
EDGES[EDGES.length - 1] = 5;
const CEN = EDGES.slice(1).map((v, i) => Math.sqrt(v * EDGES[i])), DETEDGE = [1.1, 1.64, 2.42, 3.82, 4.42];
const DEDGES = Array.from({ length: 31 }, (_, i) => 2.6 * (1 + 1 / 45) ** i);
DEDGES[30] = Math.max(DEDGES[30], 5);
const REQUIRED = {
  twomass: "designation ra dec j_m h_m k_m j_cmsig h_cmsig k_cmsig ph_qual jdate",
  catwise: "source_name source_id ra dec ra_pm dec_pm pmra pmdec sigpmra sigpmdec w1mpro_pm w1sigmpro_pm w2mpro_pm w2sigmpro_pm nb ab_flags cc_flags",
  allwise: "designation ra dec w1mpro w1sigmpro w2mpro w2sigmpro nb cc_flags w1mjdmean w2mjdmean",
  gaia: "source_id ra dec pmra pmdec phot_g_mean_mag phot_variable_flag",
  simbad: "main_id otype ra dec",
  vsx: "OID Name Type RAJ2000 DEJ2000"
};
const VAR_OTYPE = /(V\*|Ir\*|Or\*|Er\*|RI\*|FU\*|Y\*O|Y\*\?|TT\*|Ae\*|pr\*|LP\*|Mi\*|RR\*|Ce\*|EB\*|El\*|dS\*|Ro\*|BY\*|RS\*|AGN|QSO|Sy1|Sy2|SyG|Bla|BLL|No\*|CV\*|SN\*|C\*|S\*|AB\*|OH\*|WR\*|bC\*|gD\*|Pu\*|HH|YSO|TTS|Ext|Be\*)/;
const fl = (v) => v === "" || v == null || v === "null" ? NaN : Number(v);
const sum = (a) => a.reduce((s, v) => s + v, 0), mean = (a) => sum(a) / a.length;
const mag2mjy = (m, b) => ZP[b] * 10 ** (-0.4 * m);
const r4 = (v) => v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(6));
const range = (n) => Array.from({ length: n }, (_, i) => i);
const round = (x) => {
  const f = Math.floor(x), d = x - f;
  return d === 0.5 ? f + (f % 2 !== 0 ? 1 : 0) : Math.round(x);
};
class Refused extends Error {
  constructor(message) {
    super(message);
    this.name = "Refused";
  }
}
// csv.DictReader, including RFC 4180 quotes, escaped quotes and embedded newlines.
function csvRecords(text) {
  const records = [];
  let row = [], field = "", quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\r" && c !== "\n") started = true;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (started) records.push(row);
      row = [];
      field = "";
      started = false;
    } else field += c;
  }
  if (started) {
    row.push(field);
    records.push(row);
  }
  return records;
}
function parseCsv(text) {
  const [head = [], ...records] = csvRecords(text);
  return records.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? null])));
}
function checkColumns(name, rows, headerLine = "") {
  const cols = rows.length ? Object.keys(rows[0]) : headerLine.trim().split(",");
  const missing = REQUIRED[name].split(" ").filter((c) => !cols.includes(c));
  if (missing.length) throw new Refused(`the ${name} catalogue lacks ${missing.join(", ")}`);
}
function parseVsx(text) {
  const L = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (!L.length || !L[0].startsWith("OID")) throw new Refused("the vsx catalogue is not a VizieR table");
  const h = L[0].split("	").map((v) => v.trim());
  const missing = REQUIRED.vsx.split(" ").filter((c) => !h.includes(c));
  if (missing.length) throw new Refused(`the vsx catalogue lacks ${missing.join(", ")}`);
  return L.slice(3).map((l) => Object.fromEntries(l.split("	").slice(0, h.length).map((v, i) => [h[i], v.trim()])));
}
function header(h) {
  return typeof h === "string" ? parseCards(Uint8Array.from(h, (c) => c.charCodeAt(0) & 255)).h : h;
}
function tan(ra, dec, ra0, dec0) {
  const a = ra * RAD, d = dec * RAD, a0 = ra0 * RAD, d0 = dec0 * RAD, c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  return [AS * Math.cos(d) * Math.sin(a - a0) / c, AS * (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c];
}
function sep(ra, dec, r, d) {
  return Math.acos(Math.max(-1, Math.min(1, Math.sin(dec * RAD) * Math.sin(d * RAD) + Math.cos(dec * RAD) * Math.cos(d * RAD) * Math.cos((ra - r) * RAD)))) / RAD * 3600;
}
function nearest(points, p) {
  let dist = Infinity, index = 0;
  for (let j = 0; j < points.length; j++) {
    const d = (points[j][0] - p[0]) ** 2 + (points[j][1] - p[1]) ** 2;
    if (d < dist) {
      dist = d;
      index = j;
    }
  }
  return [Math.sqrt(dist), index];
}
function median(a) {
  if (!a.length) return NaN;
  const b = new Float64Array(a), k = b.length >> 1;
  for (let i = 0; i < b.length; i++) if (Number.isNaN(b[i])) return NaN;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const pivot = b[lo + hi >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (b[i] < pivot) i++;
      while (b[j] > pivot) j--;
      if (i <= j) {
        const t = b[i];
        b[i++] = b[j];
        b[j--] = t;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  if (b.length % 2) return b[k];
  let lower = -Infinity;
  for (let i = 0; i < k; i++) if (b[i] > lower) lower = b[i];
  return (lower + b[k]) / 2;
}
function nanmedian(a) {
  const values = [];
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) values.push(a[i]);
  return median(values);
}
function robustSigma(a) {
  const values = new Float64Array(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) values[n++] = a[i];
  const v = values.subarray(0, n), m = median(v);
  for (let i = 0; i < n; i++) v[i] = Math.abs(v[i] - m);
  return 1.4826 * median(v);
}
function percentile(a, p) {
  const b = Array.from(a).sort((x, y) => x - y), k = (b.length - 1) * p / 100, i = Math.floor(k);
  return b[i] + (b[Math.min(i + 1, b.length - 1)] - b[i]) * (k - i);
}
function digitize(x, edges) {
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const m = lo + hi >> 1;
    if (x >= edges[m]) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function interp(x, c, v) {
  if (x <= c[0]) return v[0];
  if (x >= c.at(-1)) return v.at(-1);
  const i = digitize(x, c) - 1;
  return v[i] + (v[i + 1] - v[i]) * (x - c[i]) / (c[i + 1] - c[i]);
}
// decade.components and merge. Gaia IDs stay strings to retain all 64 bits.
function components(C, A, G) {
  C = C.filter((r) => fl(r.w1mpro_pm) < 16.5 || fl(r.w2mpro_pm) < 16);
  let K = C.map((r) => {
    const pe = fl(r.pmra), pn = fl(r.pmdec), se = fl(r.sigpmra), sn = fl(r.sigpmdec), keep = Math.hypot(pe / (se > 0 ? se : Infinity), pn / (sn > 0 ? sn : Infinity)) > 3;
    return { ra: fl(r.ra_pm), dec: fl(r.dec_pm), pme: keep ? pe : 0, pmn: keep ? pn : 0, w1: fl(r.w1mpro_pm), w2: fl(r.w2mpro_pm), e1: fl(r.w1sigmpro_pm), e2: fl(r.w2sigmpro_pm), gaia: "-1", name: r.source_name, src: "cw", sid: r.source_id, nb: r.nb ? Math.trunc(fl(r.nb)) : 1, ab: r.ab_flags || "00", cc: (r.cc_flags || "0000").slice(0, 2) };
  });
  const ra0 = mean(K.map((r) => r.ra)), dec0 = mean(K.map((r) => r.dec));
  const g = G.map((r) => {
    const dt = (MJD_CW - MJD_GAIA) / 365.25, d = fl(r.dec);
    return [fl(r.ra) + fl(r.pmra) * dt / 36e5 / Math.cos(d * RAD), d + fl(r.pmdec) * dt / 36e5];
  });
  // cKDTree rejects nonfinite coordinates in the reference too.
  const gp = g.map(([r, d]) => tan(r, d, ra0, dec0));
  if (G.length) for (const k of K) {
    const [d, j] = nearest(gp, tan(k.ra, k.dec, ra0, dec0));
    if (d < 1) Object.assign(k, { ra: g[j][0], dec: g[j][1], pme: fl(G[j].pmra) / 1e3, pmn: fl(G[j].pmdec) / 1e3, gaia: G[j].source_id });
  }
  const cwRa0=mean(K.map(r=>r.ra)),cwDec0=mean(K.map(r=>r.dec));
  const kp = K.map((r) => tan(r.ra, r.dec, cwRa0, cwDec0));
  for (const r of A.filter((r2) => fl(r2.w1mpro) < 10)) if (nearest(kp, tan(fl(r.ra), fl(r.dec), cwRa0, cwDec0))[0] > 3) K.push({ ra: fl(r.ra), dec: fl(r.dec), pme: 0, pmn: 0, w1: fl(r.w1mpro), w2: fl(r.w2mpro), e1: fl(r.w1sigmpro), e2: fl(r.w2sigmpro), gaia: "-1", name: r.designation, src: "aw", sid: r.designation, nb: Math.trunc(fl(r.nb)), ab: "00", cc: (r.cc_flags || "0000").slice(0, 2) });
  const mergedRa0=mean(K.map(k=>k.ra)),mergedDec0=mean(K.map(k=>k.dec));
  const points = K.map(r=>tan(r.ra,r.dec,mergedRa0,mergedDec0)), par = range(K.length);
  function root(i) {
    while (par[i] !== i) {
      par[i] = par[par[i]];
      i = par[i];
    }
    return i;
  }
  for (let i = 0; i < K.length; i++) for (let j = i + 1; j < K.length; j++) if (Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) <= 6) par[root(i)] = root(j);
  const groups =  new Map();
  for (let i = 0; i < K.length; i++) {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const f = (m) => Number.isFinite(m) ? 10 ** (-0.4 * m) : 0, wt = K.map((r) => f(r.w1) + f(r.w2) || 1e-12);
  K = Array.from(groups.values(), (g2) => {
    let b = g2[0];
    for (const i of g2) if (wt[i] > wt[b]) b = i;
    const out = { ...K[b], nmem: g2.length, members: g2.map((i) => K[i].name).join("|") };
    if (g2.length > 1) {
      const tot = sum(g2.map((i) => wt[i]));
      out.ra = sum(g2.map((i) => K[i].ra * wt[i])) / tot;
      out.dec = sum(g2.map((i) => K[i].dec * wt[i])) / tot;
      for (const [m, e] of [["w1", "e1"], ["w2", "e2"]]) {
        const tot2 = sum(g2.map((i) => f(K[i][m])));
        out[m] = tot2 > 0 ? -2.5 * Math.log10(tot2) : NaN;
        out[e] = tot2 > 0 ? Math.sqrt(sum(g2.map((i) => (f(K[i][m]) * K[i][e]) ** 2).filter(Number.isFinite))) / tot2 : NaN;
      }
      out.nb = Math.max(1, Math.max(...g2.map((i) => K[i].nb)) - (g2.length - 1));
    }
    return out;
  });
  return Object.fromEntries(Object.keys(K[0] || {}).map((k) => [k, K.map((r) => r[k])]));
}
const inconclusive = (state, reason) => ({ v: 1, method: "colors-v1", state, reason });
function catalogueStep(cats, ra, dec) {
  const { twomass: TM, catwise: CW, allwise: AW, gaia: GA } = cats, K = components(CW, AW, GA), n = K.ra.length;
  const ds = K.ra.map((r, i) => sep(r, K.dec[i], ra, dec)), T = ds.indexOf(Math.min(...ds));
  if (!(ds[T] <= 2)) return { result: inconclusive("no-star", "no catalogued star within 2 arcsec of this spot") };
  const ra0 = mean(K.ra), dec0 = mean(K.dec), kp = K.ra.map((r, i) => tan(r, K.dec[i], ra0, dec0));
  const tp = TM.map((r) => tan(fl(r.ra), fl(r.dec), ra0, dec0)), match = kp.map((p) => nearest(tp, p));
  const tm = (key) => match.map(([d, j]) => d < 2 ? fl(TM[j][key]) : NaN), J = tm("j_m"), Hm = tm("h_m"), Km = tm("k_m"), qual = match.map(([d, j]) => d < 2 ? TM[j].ph_qual : "XXX");
  const vars = [...GA.filter((r) => r.phot_variable_flag === "VARIABLE"), ...cats.simbad.filter((r) => VAR_OTYPE.test(r.otype || "")), ...cats.vsx.map((r) => ({ ra: r.RAJ2000, dec: r.DEJ2000 }))].filter((r) => Number.isFinite(fl(r.ra)) && Number.isFinite(fl(r.dec))).map((r) => tan(fl(r.ra), fl(r.dec), ra0, dec0));
  const w1 = K.w1.map((v) => Number.isNaN(v) ? 99 : v), NORM = qual[T] === "AAA" ? "K" : "W1";
  const col = i => NORM === "K"
    ? [J[i]-Hm[i],Hm[i]-Km[i],Km[i]-w1[i],w1[i]-K.w2[i]]
    : [w1[i]-K.w2[i]];
  const tol=NORM==="K"?[0.12,0.1,0.1,0.1]:[0.1];
  const cand=range(n).filter(i=>{
    if(i===T||K.nmem[i]!==1)return false;
    const base=NORM==="K"
      ? qual[i]==="AAA"&&Number.isFinite(Km[i])&&Math.abs(Km[i]-Km[T])<=1.5&&Km[i]>9
      : Number.isFinite(w1[i])&&Number.isFinite(K.w2[i])&&Math.abs(w1[i]-w1[T])<=1;
    if(!base||nearest(vars,kp[i])[0]<5)return false;
    const crowded=kp.some((p,j)=>j!==i&&Math.hypot(p[0]-kp[i][0],p[1]-kp[i][1])<=15&&w1[j]<w1[i]+2.5);
    return !crowded;
  });
  const normflux = (i) => mag2mjy(NORM === "K" ? Km[i] : w1[i], NORM);
  const gaia = GA.map((r) => [fl(r.ra), fl(r.dec), fl(r.pmra), fl(r.pmdec), fl(r.phot_g_mean_mag)]).filter((r) => r[4] > 10.5 && r[4] < 17);
  const star = { name: K.name[T], ra: r4(K.ra[T]), dec: r4(K.dec[T]), sep_arcsec: r4(ds[T]), norm: NORM, twomass: { J: r4(J[T]), H: r4(Hm[T]), K: r4(Km[T]), qual: qual[T] }, catwise: { W1: r4(K.w1[T]), W2: r4(K.w2[T]) } };
  return { K, T, NORM, cand, gaia, col, tol, normflux, star, TM, AW };
}
// detector_v3_fetch.field: 36 edge samples, Python int(clip(...)).
function footprint(hdr, fieldRa, fieldDec) {
  const h = header(hdr), xx = [], yy = [];
  for (let i = 0; i < 9; i++) {
    const edge = -600 + 150 * i;
    for (const [x, y] of [[edge, -600], [edge, 600], [-600, edge], [600, edge]]) {
      const [r, d] = tanDeproject({ CRVAL1: fieldRa, CRVAL2: fieldDec }, x / AS / RAD, y / AS / RAD), p = worldToPix(h, r, d);
      if (!p || !Number.isFinite(p[0] + p[1])) return null;
      xx.push(p[0]);
      yy.push(p[1]);
    }
  }
  const clip = (v) => Math.trunc(Math.max(0, Math.min(2040, v))), x0 = clip(Math.min(...xx) - 8), x1 = clip(Math.max(...xx) + 9), y0 = clip(Math.min(...yy) - 8), y1 = clip(Math.max(...yy) + 9);
  return x1 - x0 < 16 || y1 - y0 < 16 ? null : { x0, x1, y0, y1 };
}
function skyPos(K, t, i) {
  const dt = (t - MJD_CW) / 365.25;
  return [K.ra[i] + K.pme[i] * dt / 3600 / Math.cos(K.dec[i] * RAD), K.dec[i] + K.pmn[i] * dt / 3600];
}
function starOn(ctx, e) {
  const p = worldToPix(header(e.hdr), ...skyPos(ctx.K, e.t, ctx.T));
  if (!p) return null;
  const xi = round(p[0] - e.x0), yi = round(p[1] - e.y0);
  return Number.isFinite(xi) && Number.isFinite(yi) && xi >= 1 && xi < e.w - 1 && yi >= 1 && yi < e.h - 1 ? { xi, yi } : null;
}
const positionCache =  new WeakMap();
function positions(K, a) {
  const cached = positionCache.get(a);
  if (cached?.K === K) return cached.xy;
  const x = new Float64Array(K.ra.length), y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const p = worldToPix(a.hdr, ...skyPos(K, a.t, i));
    x[i] = p ? p[0] - a.x0 + a.shift[0] : NaN;
    y[i] = p ? p[1] - a.y0 + a.shift[1] : NaN;
  }
  const xy = [x, y];
  positionCache.set(a, { K, xy });
  return xy;
}
// numpy float32 clipped block medians; scipy zoom(grid_mode=False) aligns end centres.
function mesh(a, W, H, B = 16) {
  const w = Math.ceil(W / B), h = Math.ceil(H / B), g = new Float32Array(w * h);
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
    let mad = function(m2) {
      for (let i = 0; i < v.length; i++) deviations[i] = Math.abs(Math.fround(v[i] - m2));
      return Math.fround(median(deviations.subarray(0, v.length)));
    };
    let v = [];
    for (let y = by * B; y < Math.min(H, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x++) if (Number.isFinite(a[y * W + x])) v.push(a[y * W + x]);
    const deviations = new Float32Array(B * B);
    let m = Math.fround(median(v)), s = Math.fround(1.4826 * mad(m));
    for (let k = 0; k < 2; k++) {
      let n = 0;
      const limit = Math.fround(2.5 * s);
      for (let i = 0; i < v.length; i++) if (Math.abs(Math.fround(v[i] - m)) <= limit) v[n++] = v[i];
      v.length = n;
      m = Math.fround(median(v));
      s = Math.fround(Math.fround(1.4826 * mad(m)) / 0.9);
    }
    g[by * w + bx] = m;
  }
  const fill = nanmedian(g);
  for (let i = 0; i < g.length; i++) if (!Number.isFinite(g[i])) g[i] = fill;
  const out = new Float32Array(W * H), sx = (w - 1) / (w * B - 1), sy = (h - 1) / (h * B - 1);
  for (let y = 0; y < H; y++) {
    const yy = y * sy, j = Math.floor(yy), fy = yy - j, j1 = Math.min(j + 1, h - 1);
    for (let x = 0; x < W; x++) {
      const xx = x * sx, i = Math.floor(xx), fx = xx - i, i1 = Math.min(i + 1, w - 1);
      out[y * W + x] = (g[j * w + i] * (1 - fx) + g[j * w + i1] * fx) * (1 - fy) + (g[j1 * w + i] * (1 - fx) + g[j1 * w + i1] * fx) * fy;
    }
  }
  return out;
}
function apWeights() {
  const k = new Float32Array(49);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    let n = 0;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (((5 * x + i + 0.5) / 5 - 3.5) ** 2 + ((5 * y + j + 0.5) / 5 - 3.5) ** 2 <= 1.75 ** 2) n++;
    k[y * 7 + x] = n / 25;
  }
  return k;
}
const K0 = apWeights();
function dilate(flg, W, H) {
  const b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (flg[y * W + x] & GROW) for (let dy = -3; dy <= 3; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    const r = 3 - Math.abs(dy);
    for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) b[yy * W + xx] = 1;
  }
  return b;
}
function prepExposure(ctx, e) {
  const { w: W, h: H } = e, img = e.img instanceof Float32Array ? e.img : new Float32Array(e.img), bad = dilate(e.flg, W, H), masked = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) {
    bad[i] ||= !Number.isFinite(img[i]) || !!(e.flg[i] & BAD);
    masked[i] = bad[i] ? NaN : img[i];
  }
  const bg = mesh(masked, W, H), sub = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) sub[i] = bad[i] ? NaN : img[i] - bg[i];
  const aperture = new Float32Array(img.length);
  let nAperture = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, ok = true;
    for (let dy = -3; dy <= 3; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const k = K0[(dy + 3) * 7 + dx + 3], xx = x + dx;
        if (!k || xx < 0 || xx >= W) continue;
        const i = yy * W + xx;
        if (bad[i]) ok = false;
        else s += sub[i] * k;
      }
    }
    if (ok) aperture[nAperture++] = s;
  }
  const v = aperture.subarray(0, nAperture), m = Math.fround(median(v));
  for (let i = 0; i < v.length; i++) v[i] = Math.abs(Math.fround(v[i] - m));
  const sig = v.length > 200 ? Math.fround(Math.fround(1.4826) * Math.fround(median(v))) : NaN;
  const a = { ...e, img, bad, sub, sig_ap: sig, shift: [0, 0], nstar: 0, hdr: header(e.hdr) };
  const off = [];
  for (const g of ctx.gaia) {
    const dt = (e.t - MJD_GAIA) / 365.25, p = worldToPix(a.hdr, g[0] + g[2] * dt / 36e5 / Math.cos(g[1] * RAD), g[1] + g[3] * dt / 36e5);
    if (!p) continue;
    const xx = p[0] - e.x0, yy = p[1] - e.y0, xi = round(xx), yi = round(yy);
    if (!(xi >= 8 && xi < W - 8 && yi >= 8 && yi < H - 8)) continue;
    let s = 0, sx = 0, sy = 0, ok = true;
    for (let y = yi - 2; y <= yi + 2; y++) for (let x = xi - 2; x <= xi + 2; x++) {
      const i = y * W + x;
      if (bad[i]) ok = false;
      s += sub[i];
      sx += sub[i] * x;
      sy += sub[i] * y;
    }
    if (!ok || s < 25 * sig) continue;
    off.push([sx / s - xx, sy / s - yy]);
  }
  if (off.length >= 8) {
    a.shift = [median(off.map((v2) => v2[0])), median(off.map((v2) => v2[1]))];
    a.nstar = off.length;
  }
  return a;
}
// scipy cubic spline_filter. Mirror (whole-sample) and nearest prefilter's reflect boundaries.
function splineLine(v, mirror) {
  const n = v.length;
  if (n === 1) return Float64Array.of(v[0]);
  const c = new Float64Array(n), d = new Float64Array(n);
  let diag = mirror ? 4 : 5;
  c[0] = (mirror ? 2 : 1) / diag;
  d[0] = 6 * v[0] / diag;
  for (let i = 1; i < n; i++) {
    const lower = mirror && i === n - 1 ? 2 : 1;
    diag = (i === n - 1 && !mirror ? 5 : 4) - lower * c[i - 1];
    c[i] = (i === n - 1 ? 0 : 1) / diag;
    d[i] = (6 * v[i] - lower * d[i - 1]) / diag;
  }
  for (let i = n - 2; i >= 0; i--) d[i] -= c[i] * d[i + 1];
  return d;
}
function splineFilter(a, W, H, mirror = true) {
  const out = new Float64Array(a), v = new Float64Array(Math.max(W, H));
  // scipy filters axis 0 before axis 1.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) v[y] = out[y * W + x];
    const f = splineLine(v.subarray(0, H), mirror);
    for (let y = 0; y < H; y++) out[y * W + x] = f[y];
  }
  for (let y = 0; y < H; y++) out.set(splineLine(out.subarray(y * W, (y + 1) * W), mirror), y * W);
  return out;
}
function mirrorIndex(i, n) {
  const m = 2 * n - 2;
  if (!m) return 0;
  i = (i % m + m) % m;
  return i < n ? i : m - i;
}
function cubicWeights(t) {
  const u = 1 - t;
  return [u * u * u / 6, (3 * t * t * t - 6 * t * t + 4) / 6, (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, t * t * t / 6];
}
function mapCoordinate(a, W, H, y, x) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1 || !Number.isFinite(x + y)) return 0;
  const ix = Math.floor(x), iy = Math.floor(y), wx = cubicWeights(x - ix), wy = cubicWeights(y - iy);
  let s = 0;
  for (let j = 0; j < 4; j++) {
    const row = mirrorIndex(iy + j - 1, H) * W;
    for (let i = 0; i < 4; i++) s += a[row + mirrorIndex(ix + i - 1, W)] * wx[i] * wy[j];
  }
  return s;
}
function shift(a, W, H, dy, dx) {
  // scipy _prepad_for_spline_filter(mode='nearest') pads twelve edge pixels.
  const pad = 12, w = W + 24, h = H + 24, p = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = a[Math.max(0, Math.min(H - 1, y - pad)) * W + Math.max(0, Math.min(W - 1, x - pad))];
  const c = splineFilter(p, w, h, false), out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = mapCoordinate(c, w, h, y - dy + pad, x - dx + pad);
  return out;
}
function badBox(a, xi, yi, r) {
  for (let y = yi - r; y <= yi + r; y++) for (let x = xi - r; x <= xi + r; x++) if (a.bad[y * a.w + x]) return true;
  return false;
}
// phot_lead.psfs: all exposures, isolated W1=9..12 stars, twenty stamps per detector.
function psfs(X, K) {
  const r0 = mean(K.ra), d0 = mean(K.dec), p = K.ra.map((r, i) => tan(r, K.dec[i], r0, d0)), w1 = K.w1.map((v) => Number.isNaN(v) ? 99 : v);
  const iso = range(w1.length).filter((i) => w1[i] > 9 && w1[i] < 12 && p.every((v, j) => j === i || Math.hypot(v[0] - p[i][0], v[1] - p[i][1]) > 20 || w1[j] > w1[i] + 3)), out = {};
  for (const det of DETS) {
    const stamps = [];
    for (const a of X) if (a.det === det) {
      const [px, py] = positions(K, a);
      for (const i of iso) {
        const xx = px[i], yy = py[i], xi = round(xx), yi = round(yy);
        if (!(xi >= 11 && xi < a.w - 11 && yi >= 11 && yi < a.h - 11) || badBox(a, xi, yi, 10)) continue;
        const c = new Float64Array(441), ring = [];
        for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) {
          const v = a.img[(yi + y) * a.w + xi + x];
          c[(y + 10) * 21 + x + 10] = v;
          if (Math.hypot(x, y) > 7.5) ring.push(v);
        }
        const med = median(ring);
        for (let j = 0; j < c.length; j++) c[j] -= med;
        let core = 0;
        for (let y = 3; y < 18; y++) for (let x = 3; x < 18; x++) core += c[y * 21 + x];
        if (core <= 0 || c[220] < 10 * a.sig_ap) continue;
        const shifted = shift(c, 21, 21, yi - yy, xi - xx), stamp = new Float64Array(225);
        let total2 = 0;
        for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
          const v = shifted[(y + 3) * 21 + x + 3];
          stamp[y * 15 + x] = v;
          total2 += v;
        }
        for (let j = 0; j < 225; j++) stamp[j] /= total2;
        stamps.push(stamp);
      }
    }
    out[det + "_n"] = stamps.length;
    if (stamps.length < 20) {
      out[det] = null;
      continue;
    }
    const p2 = Float64Array.from({ length: 225 }, (_, i) => median(stamps.map((s) => s[i]))), total = sum(p2);
    for (let i = 0; i < p2.length; i++) p2[i] /= total;
    out[det] = splineFilter(p2, 15, 15);
  }
  return out;
}
// numpy.linalg.inv: double precision Gauss-Jordan elimination with partial pivoting.
function inverse(A, n) {
  const a = new Float64Array(A), inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i * n + k]) > Math.abs(a[pivot * n + k])) pivot = i;
    if (a[pivot * n + k] === 0 || !Number.isFinite(a[pivot * n + k])) return null;
    if (pivot !== k) for (let j = 0; j < n; j++) {
      let t = a[k * n + j];
      a[k * n + j] = a[pivot * n + j];
      a[pivot * n + j] = t;
      t = inv[k * n + j];
      inv[k * n + j] = inv[pivot * n + j];
      inv[pivot * n + j] = t;
    }
    const v = a[k * n + k];
    for (let j = 0; j < n; j++) {
      a[k * n + j] /= v;
      inv[k * n + j] /= v;
    }
    for (let i = 0; i < n; i++) if (i !== k) {
      const f = a[i * n + k];
      for (let j = 0; j < n; j++) {
        a[i * n + j] -= f * a[k * n + j];
        inv[i * n + j] -= f * inv[k * n + j];
      }
    }
  }
  return inv;
}
function wave(det, y, x) {
  const m = WAVEMAPS[det], idx = (grid, p) => Math.max(0, Math.min(grid.length - 2, digitize(p + 1, grid) - 1)), i = idx(m.x, x), j = idx(m.y, y), fx = (x + 1 - m.x[i]) / (m.x[i + 1] - m.x[i]), fy = (y + 1 - m.y[j]) / (m.y[j + 1] - m.y[j]);
  return (m.lam[j][i] * (1 - fx) + m.lam[j][i + 1] * fx) * (1 - fy) + (m.lam[j + 1][i] * (1 - fx) + m.lam[j + 1][i + 1] * fx) * fy;
}
// colors_ref.stamp_fit: component columns plus one constant per eight-pixel tile.
function stampFit(a, K, psf, meas) {
  if (!Number.isFinite(a.sig_ap)) return [];
  const W = a.w, H = a.h, [px, py] = positions(K, a), xi = Int32Array.from(px, round), yi = Int32Array.from(py, round), inn = range(px.length).filter((i) => Number.isFinite(px[i] + py[i]) && px[i] > -3 && px[i] < W + 2 && py[i] > -3 && py[i] < H + 2);
  const good = (i) => !a.bad[i] && Number.isFinite(a.sub[i]), sp = robustSigma(a.sub), nxt = Math.ceil(W / TILE), out = [];
  for (const q of meas) {
    const x0 = inn.includes(q) ? xi[q] : -1e6, y0 = inn.includes(q) ? yi[q] : -1e6;
    if (!(x0 >= 2 && x0 < W - 2 && y0 >= 2 && y0 < H - 2)) continue;
    let core = true;
    for (let y = y0 - 1; y <= y0 + 1; y++) for (let x = x0 - 1; x <= x0 + 1; x++) if (!good(y * W + x)) core = false;
    if (!core) continue;
    const gx = [], gy = [], b = [], tiles = [], tileMap =  new Map();
    for (let y = Math.max(0, y0 - PH); y < Math.min(H, y0 + PH + 1); y++) for (let x = Math.max(0, x0 - PH); x < Math.min(W, x0 + PH + 1); x++) if (good(y * W + x)) {
      gx.push(x);
      gy.push(y);
      b.push(a.sub[y * W + x]);
      const t = Math.floor(y / TILE) * nxt + Math.floor(x / TILE);
      if (!tileMap.has(t)) tileMap.set(t, tileMap.size);
      tiles.push(tileMap.get(t));
    }
    const near = [q, ...inn.filter((c) => c !== q && Math.abs(xi[c] - x0) <= 2 * PH && Math.abs(yi[c] - y0) <= 2 * PH)], n = near.length + tileMap.size, cols = [];
    for (const c of near) {
      const v = new Float64Array(gx.length);
      for (let i = 0; i < v.length; i++) if (Math.abs(gy[i] - yi[c]) <= PH && Math.abs(gx[i] - xi[c]) <= PH) {
        const z = mapCoordinate(psf, 15, 15, PH + gy[i] - py[c], PH + gx[i] - px[c]);
        v[i] = Math.abs(z) <= 1e-6 ? 0 : z;
      }
      cols.push(v);
    }
    const N = new Float64Array(n * n), rhs = new Float64Array(n);
    for (let i = 0; i < b.length; i++) {
      const t = near.length + tiles[i];
      N[t * n + t]++;
      rhs[t] += b[i];
      for (let j = 0; j < near.length; j++) {
        const v = cols[j][i];
        rhs[j] += v * b[i];
        N[j * n + t] += v;
        N[t * n + j] += v;
        for (let k = 0; k <= j; k++) N[j * n + k] += v * cols[k][i];
      }
    }
    for (let j = 0; j < near.length; j++) for (let k = 0; k < j; k++) N[k * n + j] = N[j * n + k];
    const dg = range(n).map((i) => N[i * n + i]), live = range(n).filter((i) => dg[i] > 0);
    if (dg[0] <= 0) continue;
    const nl = live.length, reg = 1e-9 * Math.max(1, ...dg), Nl = new Float64Array(nl * nl);
    for (let i = 0; i < nl; i++) for (let j = 0; j < nl; j++) Nl[i * nl + j] = N[live[i] * n + live[j]] + (i === j ? reg : 0);
    const inv = inverse(Nl, nl);
    if (!inv) continue;
    let flux = 0;
    for (let j = 0; j < nl; j++) flux += inv[j] * rhs[live[j]];
    out.push([q, wave(a.det, py[q] - a.shift[1] + a.y0, px[q] - a.shift[0] + a.x0), flux * MJY_PIX, Math.sqrt(inv[0]) * sp * MJY_PIX, a.t]);
  }
  return out;
}
// spectrum.py binned, decade.pass_groups and per-source pass assignment.
function binned(rows, edges = EDGES, centres = false) {
  const M = new Float64Array(edges.length - 1).fill(NaN), S = M.slice(), C = M.slice(), groups = range(M.length).map(() => []);
  for (const r of rows) {
    const j = digitize(r[0], edges) - 1;
    if (j >= 0 && j < M.length && (centres || Number.isFinite(r[1]) && Number.isFinite(r[2]) && r[2] > 0)) groups[j].push(r);
  }
  for (let j = 0; j < M.length; j++) {
    const g = groups[j];
    if (!g.length) continue;
    let w = 0, f = 0, l = 0;
    for (const r of g) {
      const wt = 1 / r[2] ** 2;
      w += wt;
      f += wt * r[1];
      l += wt * r[0];
    }
    const mu = f / w;
    let chi = 0;
    for (const r of g) chi += (r[1] - mu) ** 2 / r[2] ** 2;
    M[j] = mu;
    S[j] = 1 / Math.sqrt(w) * (g.length > 1 ? Math.max(1, Math.sqrt(chi / (g.length - 1))) : 1);
    C[j] = l / w;
  }
  if (centres) {
    const ix = range(groups.length).filter((i) => groups[i].length);
    return [ix.map((i) => C[i]), ix.map((i) => M[i]), ix.map((i) => S[i])];
  }
  return [M, S];
}
function passGroups(t, gap = 60) {
  const o = range(t.length).sort((a, b) => t[a] - t[b]), lab = new Int32Array(t.length);
  let k = 0;
  for (let i = 0; i < o.length; i++) {
    if (i && t[o[i]] - t[o[i - 1]] > gap) k++;
    lab[o[i]] = k;
  }
  return lab;
}
function perSource(rows, idx, passes) {
  const out = {};
  for (const i of idx) {
    const rr = rows.filter((r) => r[0] === i);
    if (!rr.length) continue;
    const raw = rr.filter((r) => Number.isFinite(r[2]) && Number.isFinite(r[3])).map((r) => r.slice(1)), R = { all: binned(raw), raw };
    for (let k = 0; k < passes.length; k++) R[k] = binned(raw.filter((r) => {
      let j = 0;
      for (let n = 1; n < passes.length; n++) if (Math.abs(r[3] - passes[n]) < Math.abs(r[3] - passes[j])) j = n;
      return j === k;
    }));
    out[i] = R;
  }
  return out;
}
function bandMean(M, S, lo, hi) {
  const inb = range(CEN.length).filter((i) => CEN[i] >= lo && CEN[i] <= hi), m = inb.filter((i) => Number.isFinite(M[i]));
  return !m.length || m.length < 0.6 * inb.length ? [NaN, NaN] : [mean(m.map((i) => M[i])), Math.sqrt(sum(m.map((i) => S[i] ** 2))) / m.length];
}
function pairZ(R, npass, floor = 0.0225) {
  const v = range(npass).map((k) => bandMean(...R[k], 3, 5)).filter((v2) => Number.isFinite(v2[0])), out = [];
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) out.push((v[i][0] - v[j][0]) / Math.sqrt(v[i][1] ** 2 + v[j][1] ** 2 + floor ** 2 * (v[i][0] ** 2 + v[j][0] ** 2)));
  return out;
}
function bnu(l, T) {
  return 1 / (l ** 3 * Math.expm1(Math.min(14387.77 / (l * T), 700)));
}
const BB = TGRID.map((T) => CEN.map((l) => bnu(l, T) / bnu(4.6, T)));
function fitPass(M, S, Tm, spread, nn, FK) {
  const idx = range(CEN.length).filter((i) => Number.isFinite(M[i]) && Number.isFinite(Tm[i]) && nn[i] >= 5 && CEN[i] >= 0.75);
  if (idx.length < 4) return null;
  const y = idx.map((i) => M[i]), ph = idx.map((i) => Tm[i] * FK), lam = idx.map((i) => CEN[i]), sig = idx.map((i) => Math.sqrt(S[i] ** 2 + (spread[i] * FK) ** 2)), w = sig.map((s) => 1 / s ** 2);
  let pp = 0, yp = 0;
  for (let i = 0; i < idx.length; i++) {
    pp += w[i] * ph[i] ** 2;
    yp += w[i] * y[i] * ph[i];
  }
  const a0 = yp / pp, chi0 = sum(y.map((v, i) => ((v - a0 * ph[i]) / sig[i]) ** 2)), prof = [];
  let best = null;
  for (let k = 0; k < TGRID.length; k++) {
    let pb = 0, bb = 0, yb = 0;
    const B = BB[k];
    for (let i = 0; i < idx.length; i++) {
      const b2 = B[idx[i]];
      pb += w[i] * ph[i] * b2;
      bb += w[i] * b2 * b2;
      yb += w[i] * y[i] * b2;
    }
    const inv = inverse(Float64Array.of(pp, pb, pb, bb), 2);
    if (!inv) continue;
    const a = inv[0] * yp + inv[1] * yb, b = inv[2] * yp + inv[3] * yb;
    let ch = 0;
    for (let i = 0; i < idx.length; i++) ch += ((y[i] - a * ph[i] - b * B[idx[i]]) / sig[i]) ** 2;
    prof.push([ch, TGRID[k]]);
    if (best === null || ch < best.ch) best = { ch, T: TGRID[k], a, b, inv };
  }
  const inT = prof.filter((v) => v[0] <= best.ch + 1).map((v) => v[1]);
  return { n: y.length, a_star: a0, chi2_star: chi0, dof_star: y.length - 1, a: best.a, b: best.b, b_err: Math.sqrt(best.inv[3]), T: best.T, T_1sigma: [Math.min(...inT), Math.max(...inT)], chi2_star_dust: best.ch, dof_star_dust: y.length - 3, _y: y, _sig: sig, _ph: ph, _lam: lam, _S: idx.map((i) => S[i]), _spread: idx.map((i) => spread[i] * FK) };
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = Math.imul(a ^ a >>> 15, a | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function template(A) {
  const Tm = new Float64Array(CEN.length), spread = Tm.slice(), nn = Tm.slice();
  for (let i = 0; i < Tm.length; i++) {
    const v = A.map((a) => a[i]).filter(Number.isFinite), m = median(v);
    Tm[i] = m;
    spread[i] = 1.4826 * median(v.map((x) => Math.abs(x - m)));
    nn[i] = v.length;
  }
  return [Tm, spread, nn];
}
function starScale(f, NORM) {
  const ix = range(f.n).filter((i) => f._lam[i] < 2.42);
  return NORM === "K" && ix.length ? sum(ix.map((i) => f._y[i] * f._ph[i] / f._sig[i] ** 2)) / sum(ix.map((i) => f._ph[i] ** 2 / f._sig[i] ** 2)) : 1;
}
function comparisonSystematic(S, T, comp, normflux, FK, NORM) {
  const rnd = mulberry32(20261118), A0 = comp.map((i) => Array.from(S[i].all[0], (v) => v / normflux(i))), Ts = [], Xs = [];
  for (let k = 0; k < 200; k++) {
    const A = comp.map(() => A0[Math.floor(rnd() * comp.length)]), f = fitPass(...S[T].all, ...template(A), FK);
    if (!f) continue;
    const aS = starScale(f, NORM);
    Ts.push(f.T);
    Xs.push(f.b / interp(4.6, f._lam, f._ph.map((v) => aS * v)));
  }
  if (Ts.length < 100) return null;
  const pT = [16, 50, 84].map((p) => percentile(Ts, p)), pX = [16, 50, 84].map((p) => percentile(Xs, p));
  return { n: Ts.length, T: pT, T_sys: (pT[2] - pT[0]) / 2, excess_46: pX, excess_46_sys: (pX[2] - pX[0]) / 2 };
}
// colors_ref fingerprints: exact verdict text and thresholds.
const ROWS = ["rise", "temperature", "spike", "dip", "seam"];
function allRows(verdict, reason) {
  return Object.fromEntries(ROWS.map((k) => [k, { verdict, reason }]));
}
// colors_ref.fingerprints (plan deviation 2: seams first, on the star-only residuals rs; snr = flux over sigma per bin)
function fingerprints(lam, r, F, exd, NORM, rs, snr) {
  const chi = F.chi2_star_dust / Math.max(1, F.dof_star_dust);
  if (chi > 3) return allRows("inconclusive", `the best fit misses the colours (chi2 per point ${chi.toFixed(1)}, 3 at most)`);
  const vals = {}, missing = [];
  for (const e of [3.82, 4.42]) {
    const lo = range(lam.length).filter((i) => lam[i] < e && lam[i] > e - 0.25), hi = range(lam.length).filter((i) => lam[i] > e && lam[i] < e + 0.25);
    if (lo.length < 2 || hi.length < 2) {
      missing.push(e);
      continue;
    }
    const limit = 3 * Math.sqrt(1 / lo.length + 1 / hi.length);
    vals[String(e)] = { jump: mean(hi.map((i) => rs[i])) - mean(lo.map((i) => rs[i])), limit, n: [lo.length, hi.length], sensitivity: limit / mean(hi.map((i) => snr[i])) };
  }
  const jumps = [3.82, 4.42].filter((e) => vals[String(e)] && Math.abs(vals[String(e)].jump) >= vals[String(e)].limit), sv = Object.values(vals).map((v) => v.sensitivity);
  const seam = { verdict: jumps.length ? "seen" : missing.length ? "inconclusive" : "not seen", reason: !jumps.length && missing.length ? `too few colours on both sides of ${missing.map((e) => e.toFixed(2)).join(" and ")} um` : "", steps: vals, sensitivity: sv.length ? Math.max(...sv) : null };
  const out = {}, nlo = lam.filter((l) => l < 2.42).length, nhi = lam.filter((l) => l >= 3.82).length, dchi = F.chi2_star - F.chi2_star_dust, nsig = F.b_err > 0 ? F.b / F.b_err : 0;
  if (NORM !== "K") out.rise = { verdict: "inconclusive", reason: "no clean 2MASS Ks" };
  else if (jumps.length) out.rise = { verdict: "inconclusive", reason: `possible calibration jump at ${jumps.map((e) => e.toFixed(2)).join(" and ")} um` };
  else if (nlo < 5 || nhi < 5) out.rise = { verdict: "inconclusive", reason: `too few colours: ${nlo} below 2.42 um and ${nhi} above 3.82 um, 5 each needed` };
  else {
    const flat = ["D1", "D2", "D3"].every((d) => !exd[d] || Math.abs(exd[d].mean) <= 3 * exd[d].err);
    out.rise = { verdict: dchi >= 25 && nsig >= 5 && flat ? "seen" : "not seen", reason: "", dchi2: dchi, b_sigma: nsig, flat_below: flat };
  }
  if (out.rise.verdict === "seen") out.temperature = F.T <= 200 || F.T >= 2500 ? { verdict: "inconclusive", reason: "the temperature is at the edge of the 200 to 2500 K grid" } : { verdict: "seen", reason: "", T: F.T, T_1sigma: F.T_1sigma };
  else out.temperature = out.rise.verdict === "inconclusive" ? { verdict: "inconclusive", reason: out.rise.reason } : { verdict: "not seen", reason: "no dust to measure" };
  for (const [kind, lines] of Object.entries({ spike: [[3.29, "PAH 3.29"], [4.05, "Br alpha 4.05"]], dip: [[3, "water ice 3.0"], [4.27, "CO2 ice 4.27"]] })) {
    const vals2 = {}, missing2 = [];
    for (const [l0, lab] of lines) {
      const ix = range(lam.length).filter((i) => Math.abs(Math.log(lam[i] / l0)) <= 1 / 80);
      if (!ix.length) {
        missing2.push(lab);
        continue;
      }
      ix.sort((a, b) => Math.abs(Math.log(lam[a] / l0)) - Math.abs(Math.log(lam[b] / l0)));
      vals2[lab] = r[ix[0]];
    }
    const seen2 = Object.values(vals2).some((v) => kind === "spike" ? v >= 3 : v <= -3);
    out[kind] = { verdict: seen2 ? "seen" : missing2.length ? "inconclusive" : "not seen", reason: !seen2 && missing2.length ? `no SPHEREx colour at ${missing2.map((m) => m.slice(m.indexOf(" ") + 1)).join(" or ")} um` : "", sigma: vals2 };
  }
  out.seam = seam;
  return out;
}
// decade's WISE synthesis, used only for the historical catalogue scale.
let RSR;
function rsr() {
  if (!RSR) {
    RSR = {};
    for (const band of ["W1", "W2"]) {
      const { lam, r } = BANDS[band], w = lam.map((l, i) => r[i] / l * (i === 0 ? lam[1] - l : i === lam.length - 1 ? l - lam[i - 1] : (lam[i + 1] - lam[i - 1]) / 2)), s = sum(w);
      RSR[band] = [lam, w.map((v) => v / s)];
    }
  }
  return RSR;
}
function synth(c, mu, e, band) {
  const [lam, w] = rsr()[band];
  if (c.length < 2) return [NaN, 0];
  c = c.slice();
  mu = mu.slice();
  e = e.slice();
  if (band === "W2") {
    const tail = range(c.length).filter((i) => c[i] >= 4.8);
    if (tail.length) {
      const wt = tail.map((i) => 1 / e[i] ** 2), s = sum(wt);
      c.push(5.6);
      mu.push(sum(tail.map((i, j) => wt[j] * mu[i])) / s);
      e.push(1 / Math.sqrt(s));
    }
  }
  let f = 0, cov = 0;
  for (let i = 0; i < lam.length; i++) {
    f += w[i] * interp(lam[i], c, mu);
    if (Math.min(...c.map((v) => Math.abs(lam[i] - v))) <= 0.12 || band === "W2" && c.at(-1) === 5.6 && lam[i] > 5) cov += w[i];
  }
  return [f, cov];
}
function bandLimits(b) {
  const [lam, w] = rsr()[b];
  let cw = 0, lo, hi;
  for (let i = 0; i < w.length; i++) {
    cw += w[i];
    if (lo == null && cw >= 0.01) lo = lam[i];
    if (hi == null && cw >= 0.99) hi = lam[i];
  }
  return [lo, Math.min(hi, 5)];
}
function wiseFlux(raw, band) {
  const rows = raw.filter((r) => r[0] >= 2.4);
  if (!rows.length) return NaN;
  const lab = passGroups(rows.map((r) => r[3])), P = [];
  for (const k of new Set(lab)) {
    const [c, mu, e] = binned(rows.filter((_, i) => lab[i] === k), DEDGES, true), [lo, hi] = bandLimits(band), inb = c.filter((v) => v >= lo && v <= hi);
    if (inb.length < 3) continue;
    const bounds = [lo, ...inb, hi], gap = Math.max(...bounds.slice(1).map((v, i) => v - bounds[i])), [fx, cov] = synth(c, mu, e, band);
    if (cov >= 0.8 && gap <= 0.25) P.push(fx);
  }
  return P.length ? mean(P) : NaN;
}
function oldPoints(S, comp, T, K, TM, AW) {
  const ra = K.ra[T], dec = K.dec[T], nearestRow = (R) => {
    if (!R.length) return null;
    const ds = R.map((r) => sep(fl(r.ra), fl(r.dec), ra, dec)), i = ds.indexOf(Math.min(...ds));
    return ds[i] <= 2 ? R[i] : null;
  }, t2 = nearestRow(TM), aw = nearestRow(AW), ra0 = mean(K.ra), dec0 = mean(K.dec), tp = TM.map((r) => tan(fl(r.ra), fl(r.dec), ra0, dec0)), match = K.ra.map((r, i) => nearest(tp, tan(r, K.dec[i], ra0, dec0))), mag = { W1: K.w1, W2: K.w2 };
  for (const b of ["J", "H", "K"]) mag[b] = match.map(([d, j]) => d < 2 ? fl(TM[j][b.toLowerCase() + "_m"]) : NaN);
  const out = [];
  for (const b of ["J", "H", "K", "W1", "W2"]) {
    const row = WIN[b] ? t2 : aw;
    if (!row) continue;
    const key = b.toLowerCase(), m0 = fl(row[WIN[b] ? key + "_m" : key + "mpro"]), e0 = fl(row[WIN[b] ? key + "_cmsig" : key + "sigmpro"]);
    if (!Number.isFinite(m0)) continue;
    const ratios = [];
    for (const i of comp) {
      const v = WIN[b] ? bandMean(...S[i].all, ...WIN[b])[0] : wiseFlux(S[i].raw, b);
      if (Number.isFinite(v) && Number.isFinite(mag[b][i]) && v > 0) ratios.push(v / mag2mjy(mag[b][i], b));
    }
    if (ratios.length < 5) continue;
    const k = median(ratios), raw = mag2mjy(m0, b), date = WIN[b] ? { jd: fl(row.jdate) } : { mjd: [fl(row.w1mjdmean), fl(row.w2mjdmean)] };
    out.push({ band: b, survey: WIN[b] ? "2MASS" : "WISE", lam: WL[b], mag: m0, mag_err: r4(e0), raw_mjy: r4(raw), scale: r4(k), n_comp: ratios.length, mjy: r4(raw * k), err: Number.isFinite(e0) ? r4(raw * k * 0.921 * e0) : null, ...date });
  }
  return out;
}
function saturation(res, sat) {
  if (sat) {
    const why = `too bright, saturated in ${res.saturation.n} of ${res.saturation.of} exposures`;
    res.fingerprints = allRows("inconclusive", why);
    res.state = "inconclusive";
    res.reason = why;
  }
}
// colors_ref.spectrum_result, including comparison self-check and seeded bootstrap.
function spectrumResult(ctx, rows, used) {
  const { T, cand, col, tol, normflux, NORM, star, K, TM, AW } = ctx, res = { v: 1, method: "colors-v1", state: "ok", reason: "", star, data: used }, st = rows.filter((r2) => r2[0] === T);
  if (!st.length) {
    res.state = "inconclusive";
    res.reason = "SPHEREx measured no colours of this star";
    res.fingerprints = allRows("inconclusive", res.reason);
    // a star saturated in every exposure leaves no measurements: the saturation is still the reason given
    res.saturation = { n: used.saturated, of: used.exposures_on_star };
    saturation(res, 2 * used.saturated >= used.exposures_on_star && used.saturated > 0);
    return res;
  }
  const times = Array.from(new Set(st.map((r2) => r2[4]))).sort((a, b) => a - b), g = passGroups(times), passes = Array.from(new Set(g), (k) => mean(times.filter((_, i) => g[i] === k))), S = perSource(rows, [T, ...cand], passes), ct = col(T), dc = cand.map((i) => col(i).map((v, k) => Math.abs(v - ct[k]))), mov = Object.fromEntries(cand.map((i) => [i, S[i] ? pairZ(S[i], passes.length).some((z) => Math.abs(z) > 3) : false]));
  let comp = [], within = [], scale;
  for (scale of SCALES) {
    within = cand.filter((i, j) => dc[j].every((v, k) => v <= tol[k] * scale));
    comp = within.filter((i) => S[i] && !mov[i]);
    if (comp.length >= 12) break;
  }
  // for..of retains the final scale, even if the minimum was never reached.
  res.comparisons = { n: comp.length, scale, names: comp.map((i) => K.name[i]), dropped_moving: within.filter((i) => mov[i]).map((i) => K.name[i]), dropped_unmeasured: within.filter((i) => !S[i]).map((i) => K.name[i]) };
  res.passes_mjd = passes;
  res.saturation = { n: used.saturated, of: used.exposures_on_star };
  const sat = 2 * used.saturated >= used.exposures_on_star && used.saturated > 0;
  if (comp.length < 12) {
    res.state = "inconclusive";
    res.reason = `${comp.length} clean comparison stars, 12 needed`;
    res.fingerprints = allRows("inconclusive", res.reason);
    saturation(res, sat);
    return res;
  }
  const FK = normflux(T), fits = {}, curves = [];
  let keep;
  for (const pk of ["all", ...range(passes.length)]) {
    const A = comp.map((i) => Array.from(S[i][pk][0], (v) => v / normflux(i))), f2 = fitPass(...S[T][pk], ...template(A), FK), key = String(pk);
    if (!f2) {
      fits[key] = null;
      curves.push({ key, mjd: pk === "all" ? null : passes[pk], lam: [], mjy: [], err: [], fit: [] });
      continue;
    }
    fits[key] = Object.fromEntries(Object.entries(f2).filter(([k]) => !k.startsWith("_")));
    const fit = f2._lam.map((l, i) => f2.a * f2._ph[i] + f2.b * bnu(l, f2.T) / bnu(4.6, f2.T));
    curves.push({ key, mjd: pk === "all" ? null : passes[pk], lam: f2._lam.map(r4), mjy: f2._y.map(r4), err: f2._S.map(r4), fit: fit.map(r4), sigma: f2._sig.map(r4) });
    if (pk === "all") keep = f2;
  }
  res.fits = fits;
  res.passes = curves;
  if (!fits.all) {
    res.state = "inconclusive";
    res.reason = "SPHEREx measured too few colours of this star";
    res.fingerprints = allRows("inconclusive", res.reason);
    saturation(res, sat);
    return res;
  }
  const f = keep, lam = f._lam, y = f._y, ph = f._ph, sig = f._sig, aS = starScale(f, NORM);
  res.aS = aS;
  res.bare = { lam: lam.map(r4), mjy: ph.map((v) => r4(aS * v)), spread: f._spread.map((v) => r4(aS * v)) };
  res.excess_46 = f.b / interp(4.6, lam, ph.map((v) => aS * v));
  res.comparison_systematic = comparisonSystematic(S, T, comp, normflux, FK, NORM);
  const ex = y.map((v, i) => v / (aS * ph[i]) - 1), exs = sig.map((v, i) => v / (aS * ph[i])), exd = {};
  for (let d = 0; d < 6; d++) {
    const ix = range(lam.length).filter((i) => digitize(lam[i], DETEDGE) === d);
    if (!ix.length) continue;
    const sw = sum(ix.map((i) => 1 / exs[i] ** 2));
    exd["D" + (d + 1)] = { mean: sum(ix.map((i) => ex[i] / exs[i] ** 2)) / sw, err: 1 / Math.sqrt(sw), n: ix.length };
  }
  res.excess_by_detector = exd;
  const r = lam.map((l, i) => (y[i] - f.a * ph[i] - f.b * bnu(l, f.T) / bnu(4.6, f.T)) / sig[i]);
  const rs = lam.map((l, i) => (y[i] - f.a_star * ph[i]) / sig[i]);   // residuals from the star alone, for the seams
  res.fingerprints = fingerprints(lam, r, f, exd, NORM, rs, y.map((v, i) => v / sig[i]));
  res.old = oldPoints(S, comp, T, K, TM, AW);
  saturation(res, sat);
  return res;
}
function clean(o) {
  if (typeof o === "number") return Number.isFinite(o) ? o : null;
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return Array.from(o, clean);
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)]));
  return o;
}
function finishDetails(ctx, prepared, info) {
  const P = psfs(prepared, ctx.K), X = prepared.filter((a) => P[a.det]), rows = [], stampRows = [];
  for (const a of X) for (const row of stampFit(a, ctx.K, P[a.det], [ctx.T, ...ctx.cand])) {
    rows.push(row);
    stampRows.push({ component: row[0], obs: a.obs, det: a.det, row });
  }
  const used = { exposures_listed: info.exposures_listed, exposures_on_star: prepared.length, exposures_used: X.length, by_det: Object.fromEntries(DETS.map((d) => [d, X.filter((a) => a.det === d).length])), saturated: Array.isArray(info.saturated) || ArrayBuffer.isView(info.saturated) ? Array.from(info.saturated).filter(Boolean).length : info.saturated ?? 0, psf_stamps: Object.fromEntries(DETS.map((d) => [d, P[d + "_n"]])), detectors_dropped: DETS.filter((d) => !P[d]) };
  return { result: clean(spectrumResult(ctx, rows, used)), rows, used, psfs: P, stampRows };
}
// info = {exposures_listed, saturated: boolean[]}, counted from the raw 3x3 FLAGS cores.
function finish(ctx, prepared, info) {
  if (!prepared.length) return inconclusive("no-coverage", "SPHEREx has no pictures of this star");
  return finishDetails(ctx, prepared, info).result;
}
function build({ cats, exposures, ra, dec }) {
  const ctx = catalogueStep(cats, ra, dec);
  if (ctx.result) return ctx.result;
  const on = exposures.map((e) => [e, starOn(ctx, e)]).filter(([, p]) => p);
  if (!on.length) return inconclusive("no-coverage", "SPHEREx has no pictures of this star");
  const saturated = on.map(([e, p]) => {
    for (let y = p.yi - 1; y <= p.yi + 1; y++) for (let x = p.xi - 1; x <= p.xi + 1; x++) if (e.flg[y * e.w + x] & SAT) return true;
    return false;
  });
  return finish(ctx, on.map(([e]) => prepExposure(ctx, e)), { exposures_listed: exposures.length, saturated });
}
// Exposed numerical stages let parity tests compare the actual implementation to SciPy dumps.
const parity = { spectrumResult, median, nanmedian, percentile, interp, digitize, inverse, mesh, splineFilter, mapCoordinate, shift, wave, psfs, stampFit, perSource, binned, finishDetails, clean, round, EDGES, CEN };
// Calibration tables from web/data. Embedded for synchronous, fetch-free Worker and Node math.
const WAVEMAPS = { "D5": { "x": [1, 205, 409, 613, 817, 1021, 1224, 1428, 1632, 1836, 2040], "y": [1, 205, 409, 613, 817, 1021, 1224, 1428, 1632, 1836, 2040], "lam": [[4.442564010620117, 4.436503887176514, 4.431736469268799, 4.427868366241455, 4.425892353057861, 4.424615859985352, 4.4253129959106445, 4.427002429962158, 4.430232524871826, 4.434625148773193, 4.430353164672852], [4.377189636230469, 4.370883941650391, 4.365771770477295, 4.362113952636719, 4.359809398651123, 4.358780860900879, 4.359400272369385, 4.360989093780518, 4.364133358001709, 4.368796348571777, 4.374618053436279], [4.312100887298584, 4.30546236038208, 4.3006768226623535, 4.29699182510376, 4.29469633102417, 4.293691635131836, 4.294063568115234, 4.295957088470459, 4.299124717712402, 4.303781032562256, 4.309535026550293], [4.248101711273193, 4.24173641204834, 4.23642110824585, 4.232631206512451, 4.230118274688721, 4.229182243347168, 4.229538917541504, 4.231507778167725, 4.234678745269775, 4.239555358886719, 4.24558162689209], [4.184720516204834, 4.1779704093933105, 4.172718048095703, 4.168896198272705, 4.166420936584473, 4.165445327758789, 4.165789604187012, 4.167738914489746, 4.171182155609131, 4.175848484039307, 4.181941509246826], [4.121625900268555, 4.114863872528076, 4.109426021575928, 4.105574131011963, 4.103089332580566, 4.10207462310791, 4.10261869430542, 4.104575157165527, 4.107874393463135, 4.112637519836426, 4.118851661682129], [4.059550762176514, 4.052577018737793, 4.047321796417236, 4.043458461761475, 4.04075288772583, 4.039791584014893, 4.040197372436523, 4.042209625244141, 4.04566764831543, 4.050528526306152, 4.056746482849121], [3.9980034828186035, 3.9909958839416504, 3.9854085445404053, 3.981487274169922, 3.978816270828247, 3.9778072834014893, 3.978306531906128, 3.9803860187530518, 3.98372745513916, 3.9887919425964355, 3.995328903198242], [3.9371190071105957, 3.9302022457122803, 3.9245758056640625, 3.9206888675689697, 3.918046712875366, 3.916982412338257, 3.91752028465271, 3.919560432434082, 3.9228992462158203, 3.9279613494873047, 3.9343936443328857], [3.877725601196289, 3.8706233501434326, 3.864978551864624, 3.8609585762023926, 3.858476161956787, 3.8574957847595215, 3.8579742908477783, 3.8597638607025146, 3.86337947845459, 3.868361234664917, 3.874680995941162], [3.819418430328369, 3.8121964931488037, 3.8065624237060547, 3.8023288249969482, 3.7995235919952393, 3.7983829975128174, 3.7990334033966064, 3.8010382652282715, 3.804699659347534, 3.8096933364868164, 3.8163936138153076]] }, "D6": { "x": [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], "y": [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], "lam": [[5.0246148109436035, 5.015927791595459, 5.010992527008057, 5.00850248336792, 5.005344390869141, 5.007336616516113, 5.010132789611816, 5.016265392303467, 5.0234527587890625], [4.943892002105713, 4.936691761016846, 4.930865287780762, 4.927822589874268, 4.9262285232543945, 4.927697658538818, 4.930447101593018, 4.936077117919922, 4.943716526031494], [4.864654541015625, 4.857144355773926, 4.852049350738525, 4.848381042480469, 4.847075939178467, 4.848371982574463, 4.85129976272583, 4.85642147064209, 4.8640828132629395], [4.787806034088135, 4.780540943145752, 4.77560567855835, 4.7719573974609375, 4.770531177520752, 4.771413326263428, 4.774899959564209, 4.779879570007324, 4.787158489227295], [4.712541103363037, 4.704856872558594, 4.699166297912598, 4.695034980773926, 4.694945812225342, 4.6953887939453125, 4.6983795166015625, 4.704232215881348, 4.711520671844482], [4.6373772621154785, 4.629187107086182, 4.624125957489014, 4.62029504776001, 4.619022846221924, 4.619770050048828, 4.623473644256592, 4.628484725952148, 4.636253356933594], [4.562898635864258, 4.555534839630127, 4.5492262840271, 4.546346187591553, 4.544740200042725, 4.5456671714782715, 4.54896879196167, 4.554266452789307, 4.56168794631958], [4.49076509475708, 4.483063220977783, 4.477247714996338, 4.473445892333984, 4.472282886505127, 4.473067283630371, 4.476583480834961, 4.48192834854126, 4.489685535430908], [4.421267986297607, 4.413187026977539, 4.406857490539551, 4.4030442237854, 4.401752948760986, 4.402713775634766, 4.406254768371582, 4.412075519561768, 4.420076847076416]] }, "D2": { "x": [1, 205, 409, 613, 817, 1021, 1224, 1428, 1632, 1836, 2040], "y": [1, 205, 409, 613, 817, 1021, 1224, 1428, 1632, 1836, 2040], "lam": [[1.6676968336105347, 1.661122441291809, 1.6563327312469482, 1.652663230895996, 1.6506717205047607, 1.650076985359192, 1.6508198976516724, 1.6530604362487793, 1.6566145420074463, 1.661590337753296, 1.667456865310669], [1.5999464988708496, 1.5937159061431885, 1.5888856649398804, 1.5852752923965454, 1.583357810974121, 1.5825269222259521, 1.5833616256713867, 1.585565209388733, 1.5891653299331665, 1.5942021608352661, 1.6004220247268677], [1.5342187881469727, 1.5278810262680054, 1.5230178833007812, 1.5195703506469727, 1.5173577070236206, 1.51681387424469, 1.5176620483398438, 1.5197211503982544, 1.523263692855835, 1.5283266305923462, 1.5347235202789307], [1.4705637693405151, 1.4645007848739624, 1.4597307443618774, 1.456342101097107, 1.4543004035949707, 1.4539847373962402, 1.4546375274658203, 1.4566824436187744, 1.460086464881897, 1.4650719165802002, 1.4711546897888184], [1.4102576971054077, 1.404449224472046, 1.399863362312317, 1.39662504196167, 1.3946775197982788, 1.3941357135772705, 1.3948851823806763, 1.3968682289123535, 1.400170087814331, 1.4048243761062622, 1.4107800722122192], [1.3532891273498535, 1.3474916219711304, 1.342956304550171, 1.3397737741470337, 1.3379513025283813, 1.337396502494812, 1.3380181789398193, 1.3400940895080566, 1.3433871269226074, 1.3479247093200684, 1.3537909984588623], [1.2988735437393188, 1.2932655811309814, 1.2886734008789062, 1.2854517698287964, 1.2836190462112427, 1.283225178718567, 1.2838077545166016, 1.2858057022094727, 1.2891634702682495, 1.293660044670105, 1.29935884475708], [1.2461870908737183, 1.2404729127883911, 1.2360950708389282, 1.2331492900848389, 1.2311362028121948, 1.2307060956954956, 1.231114387512207, 1.2333804368972778, 1.236498475074768, 1.2408771514892578, 1.2464889287948608], [1.1952638626098633, 1.1897903680801392, 1.1854249238967896, 1.1823008060455322, 1.18063223361969, 1.1801018714904785, 1.1806589365005493, 1.182831883430481, 1.1855682134628296, 1.1900546550750732, 1.19588041305542], [1.1460320949554443, 1.1409335136413574, 1.1366888284683228, 1.1337589025497437, 1.1320555210113525, 1.13129723072052, 1.132095456123352, 1.1339545249938965, 1.1368236541748047, 1.1411964893341064, 1.1467058658599854], [1.1006391048431396, 1.0949058532714844, 1.0908247232437134, 1.088171124458313, 1.0861222743988037, 1.0859156847000122, 1.0863670110702515, 1.0884605646133423, 1.091017723083496, 1.09539794921875, 1.1006288528442383]] }, "D3": { "x": [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], "y": [1, 36, 71, 105, 140, 141, 379, 617, 855, 1091, 1326, 1564, 1802, 2040], "lam": [[2.4326555728912354, 2.4266512393951416, 2.4226410388946533, 2.419560194015503, 2.4191675186157227, 2.420260429382324, 2.4231297969818115, 2.4280595779418945, 2.43906569480896], [2.424534320831299, 2.4171526432037354, 2.4127607345581055, 2.4094295501708984, 2.408616065979004, 2.410360336303711, 2.4135124683380127, 2.4189131259918213, 2.4249582290649414], [2.4133379459381104, 2.406186103820801, 2.3996026515960693, 2.3955929279327393, 2.3941378593444824, 2.3954997062683105, 2.4005274772644043, 2.4074110984802246, 2.4153549671173096], [2.4013760089874268, 2.391752004623413, 2.384036064147949, 2.3793179988861084, 2.3780312538146973, 2.379455089569092, 2.38472580909729, 2.392542839050293, 2.403092861175537], [2.385993003845215, 2.3752918243408203, 2.3679327964782715, 2.3631200790405273, 2.3617265224456787, 2.3633713722229004, 2.3684139251708984, 2.376190185546875, 2.387273073196411], [2.3854477405548096, 2.3749568462371826, 2.367375612258911, 2.36276912689209, 2.3611741065979004, 2.362860918045044, 2.3679144382476807, 2.3756914138793945, 2.38686466217041], [2.277549982070923, 2.266653060913086, 2.2590677738189697, 2.254420757293701, 2.2531354427337646, 2.254612922668457, 2.25925874710083, 2.2673590183258057, 2.2782552242279053], [2.17293643951416, 2.1618101596832275, 2.1543755531311035, 2.1500465869903564, 2.1484756469726562, 2.150312900543213, 2.1550536155700684, 2.1630780696868896, 2.1735739707946777], [2.0720434188842773, 2.061460256576538, 2.0541303157806396, 2.0498602390289307, 2.0484888553619385, 2.050021171569824, 2.0546510219573975, 2.0625360012054443, 2.073112964630127], [1.977522373199463, 1.9673786163330078, 1.9604032039642334, 1.9560260772705078, 1.954636573791504, 1.9561190605163574, 1.960654377937317, 1.9680086374282837, 1.9786286354064941], [1.8875356912612915, 1.8777587413787842, 1.8705251216888428, 1.8663859367370605, 1.8649754524230957, 1.866510272026062, 1.8709449768066406, 1.878480315208435, 1.8886066675186157], [1.7999072074890137, 1.7898975610733032, 1.7826237678527832, 1.7786200046539307, 1.7773735523223877, 1.778780460357666, 1.783138394355774, 1.7903249263763428, 1.8006583452224731], [1.7165381908416748, 1.706872820854187, 1.7001689672470093, 1.6961485147476196, 1.694699764251709, 1.696274757385254, 1.7005236148834229, 1.7076746225357056, 1.7175041437149048], [1.6378695964813232, 1.6284738779067993, 1.6214935779571533, 1.6176462173461914, 1.6162567138671875, 1.6178308725357056, 1.6218512058258057, 1.6290119886398315, 1.6385772228240967]] }, "D1": { "x": [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], "y": [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], "lam": [[1.1261659860610962, 1.1208453178405762, 1.1172394752502441, 1.1152187585830688, 1.114574909210205, 1.1151646375656128, 1.1173837184906006, 1.1211949586868286, 1.1262781620025635], [1.069422960281372, 1.0642753839492798, 1.0604321956634521, 1.0584584474563599, 1.0577929019927979, 1.0586574077606201, 1.0608150959014893, 1.0645229816436768, 1.0696961879730225], [1.0151877403259277, 1.010291576385498, 1.006690263748169, 1.0046544075012207, 1.003920555114746, 1.004791498184204, 1.0070793628692627, 1.0107581615447998, 1.0156455039978027], [0.9637761116027832, 0.9589639902114868, 0.9555547833442688, 0.9536013603210449, 0.9528701305389404, 0.9536875486373901, 0.9556993246078491, 0.9592326283454895, 0.9639773368835449], [0.915093719959259, 0.9104660749435425, 0.9070377945899963, 0.9050799012184143, 0.9042985439300537, 0.9051024317741394, 0.9072723388671875, 0.9107372760772705, 0.9156127572059631], [0.8689736723899841, 0.8644586205482483, 0.8611857891082764, 0.8592165112495422, 0.8585330843925476, 0.8594595789909363, 0.8613868355751038, 0.8647388219833374, 0.8693804740905762], [0.8255914449691772, 0.8208694458007812, 0.8177066445350647, 0.8156891465187073, 0.8154316544532776, 0.8157661557197571, 0.8178648948669434, 0.8212141990661621, 0.8260114192962646], [0.7839509844779968, 0.7791388034820557, 0.7761821150779724, 0.7742828726768494, 0.7739030122756958, 0.7742685079574585, 0.7760159373283386, 0.7793856859207153, 0.7838691473007202], [0.744381844997406, 0.7403125166893005, 0.7372785806655884, 0.7355348467826843, 0.7348951697349548, 0.7358571290969849, 0.7377235293388367, 0.7408007979393005, 0.7450241446495056]] }, "D4": { "x": [1, 171, 341, 511, 681, 851, 1021, 1190, 1360, 1530, 1700, 1870, 2040], "y": [1, 151, 301, 451, 601, 751, 901, 1050, 1200, 1350, 1500, 1650, 1800, 1801, 1841, 1881, 1921, 1960, 2e3, 2040], "lam": [[3.8628580570220947, 3.854133367538452, 3.841034412384033, 3.8315255641937256, 3.825032949447632, 3.8181607723236084, 3.8180816173553467, 3.8179638385772705, 3.8214523792266846, 3.8289620876312256, 3.839262008666992, 3.8476157188415527, 3.862156867980957], [3.7350995540618896, 3.722451686859131, 3.708923816680908, 3.7024288177490234, 3.6939210891723633, 3.689220666885376, 3.6887364387512207, 3.6893954277038574, 3.693483591079712, 3.697603702545166, 3.7073440551757812, 3.720512866973877, 3.7314517498016357], [3.609548568725586, 3.5945546627044678, 3.584479570388794, 3.575911283493042, 3.568321943283081, 3.5630364418029785, 3.5627479553222656, 3.5632622241973877, 3.568297863006592, 3.572908401489258, 3.581249713897705, 3.590463876724243, 3.6080679893493652], [3.48857045173645, 3.4719772338867188, 3.4624922275543213, 3.4534542560577393, 3.4457437992095947, 3.4425981044769287, 3.4415621757507324, 3.4420700073242188, 3.445413112640381, 3.4515209197998047, 3.4599270820617676, 3.4702389240264893, 3.4839630126953125], [3.3690667152404785, 3.3553366661071777, 3.3443658351898193, 3.3348324298858643, 3.3287224769592285, 3.3242392539978027, 3.323026657104492, 3.323028326034546, 3.327456474304199, 3.3335201740264893, 3.3413445949554443, 3.352374792098999, 3.3663814067840576], [3.2541749477386475, 3.240476608276367, 3.229295492172241, 3.220226287841797, 3.213768243789673, 3.2097249031066895, 3.208132028579712, 3.210484504699707, 3.212921142578125, 3.2185683250427246, 3.2263951301574707, 3.237032413482666, 3.249948501586914], [3.1418681144714355, 3.128692388534546, 3.11710262298584, 3.1096298694610596, 3.1025984287261963, 3.0991482734680176, 3.096630573272705, 3.0970520973205566, 3.1006457805633545, 3.106689691543579, 3.1147778034210205, 3.125565528869629, 3.1374616622924805], [3.0346457958221436, 3.0196759700775146, 3.0092742443084717, 3.0011050701141357, 2.9936904907226562, 2.9903597831726074, 2.989412307739258, 2.9914379119873047, 2.992934465408325, 2.9987175464630127, 3.0061404705047607, 3.0168330669403076, 3.0299086570739746], [2.929128885269165, 2.916076183319092, 2.9052956104278564, 2.896491289138794, 2.8900232315063477, 2.886920690536499, 2.8854525089263916, 2.8858394622802734, 2.889561414718628, 2.896172523498535, 2.902940034866333, 2.913029670715332, 2.923793315887451], [2.827758550643921, 2.8150413036346436, 2.8048794269561768, 2.7959537506103516, 2.7906923294067383, 2.7870707511901855, 2.78517746925354, 2.786350965499878, 2.7892839908599854, 2.794468879699707, 2.8022193908691406, 2.8122878074645996, 2.824187755584717], [2.730588436126709, 2.7179322242736816, 2.7079973220825195, 2.699751615524292, 2.6944305896759033, 2.6914353370666504, 2.689809560775757, 2.690703868865967, 2.6936051845550537, 2.698786735534668, 2.705937623977661, 2.715362071990967, 2.726670742034912], [2.637456178665161, 2.6252338886260986, 2.615382671356201, 2.607628583908081, 2.601212978363037, 2.5975804328918457, 2.5967845916748047, 2.5973997116088867, 2.5999162197113037, 2.605350971221924, 2.612902879714966, 2.622670888900757, 2.6338517665863037], [2.5473806858062744, 2.535545587539673, 2.52546763420105, 2.517458915710449, 2.5118086338043213, 2.508441209793091, 2.506816864013672, 2.507993459701538, 2.5109570026397705, 2.515699863433838, 2.52360200881958, 2.532487630844116, 2.5437328815460205], [2.546858787536621, 2.5349199771881104, 2.5247929096221924, 2.516925096511841, 2.51138973236084, 2.5077602863311768, 2.5063016414642334, 2.5074379444122314, 2.5104939937591553, 2.5151500701904297, 2.5229239463806152, 2.531895160675049, 2.54311203956604], [2.522603988647461, 2.5111122131347656, 2.5015876293182373, 2.493039846420288, 2.4875221252441406, 2.48419189453125, 2.4827723503112793, 2.4835731983184814, 2.4861931800842285, 2.4917356967926025, 2.498927116394043, 2.508800506591797, 2.52012300491333], [2.4992949962615967, 2.4876515865325928, 2.477719306945801, 2.4703917503356934, 2.4654452800750732, 2.462810754776001, 2.4612667560577393, 2.4616498947143555, 2.464432954788208, 2.4687979221343994, 2.4757494926452637, 2.484727144241333, 2.496218681335449], [2.476005792617798, 2.465104341506958, 2.4575278759002686, 2.4512386322021484, 2.4473698139190674, 2.4447712898254395, 2.4434080123901367, 2.444671154022217, 2.445878744125366, 2.449488878250122, 2.4549057483673096, 2.4627747535705566, 2.4730677604675293], [2.45629620552063, 2.447535276412964, 2.441279649734497, 2.4368984699249268, 2.4330294132232666, 2.4314124584198, 2.430112838745117, 2.4303786754608154, 2.4320197105407715, 2.434983015060425, 2.4396467208862305, 2.4450418949127197, 2.4533722400665283], [2.4403648376464844, 2.4331483840942383, 2.427109479904175, 2.4219472408294678, 2.4179208278656006, 2.415461778640747, 2.4130403995513916, 2.413606882095337, 2.4160075187683105, 2.420281410217285, 2.425475835800171, 2.4310901165008545, 2.4377822875976562], [2.427839517593384, 2.418769359588623, 2.4113051891326904, 2.40490984916687, 2.406317949295044, 2.4002113342285156, 2.398031234741211, 2.3996448516845703, 2.4012672901153564, 2.4029531478881836, 2.409942388534546, 2.4161903858184814, 2.4253108501434326]] } };
const BANDS = { "W1": { "lam": [2.6, 2.61, 2.62, 2.63, 2.64, 2.65, 2.66, 2.67, 2.68, 2.69, 2.7, 2.71, 2.72, 2.73, 2.74, 2.75, 2.76, 2.77, 2.78, 2.79, 2.8, 2.81, 2.82, 2.83, 2.84, 2.85, 2.86, 2.87, 2.88, 2.89, 2.9, 2.91, 2.92, 2.93, 2.94, 2.95, 2.96, 2.97, 2.98, 2.99, 3, 3.01, 3.02, 3.03, 3.04, 3.05, 3.06, 3.07, 3.08, 3.09, 3.1, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, 3.2, 3.21, 3.22, 3.23, 3.24, 3.25, 3.26, 3.27, 3.28, 3.29, 3.3, 3.31, 3.32, 3.33, 3.34, 3.35, 3.36, 3.37, 3.38, 3.39, 3.4, 3.41, 3.42, 3.43, 3.44, 3.45, 3.46, 3.47, 3.48, 3.49, 3.5, 3.51, 3.52, 3.53, 3.54, 3.55, 3.56, 3.57, 3.58, 3.59, 3.6, 3.61, 3.62, 3.63, 3.64, 3.65, 3.66, 3.67, 3.68, 3.69, 3.7, 3.71, 3.72, 3.73, 3.74, 3.75, 3.76, 3.77, 3.78, 3.79, 3.8, 3.81, 3.82, 3.83, 3.84, 3.85, 3.86, 3.87, 3.88, 3.89, 3.9, 3.91, 3.92, 3.93, 3.94, 3.95, 3.96, 3.97, 3.98, 3.99, 4], "r": [23718e-10, 35787e-8, 11801e-7, 92944e-8, 75095e-8, 8194e-7, 88183e-8, 10517e-7, 33867e-8, 51705e-8, 81846e-8, 87291e-7, 77299e-7, 46045e-7, 34356e-7, 73993e-7, 0.013747, 0.02355, 0.045209, 0.088875, 0.15556, 0.23009, 0.28369, 0.30687, 0.30425, 0.29415, 0.2821, 0.26809, 0.25501, 0.25401, 0.26625, 0.28903, 0.31501, 0.33782, 0.35702, 0.37356, 0.38865, 0.40548, 0.42145, 0.43263, 0.43701, 0.44142, 0.44584, 0.44534, 0.43787, 0.42836, 0.41477, 0.40008, 0.38227, 0.36736, 0.35944, 0.36771, 0.39539, 0.43755, 0.47689, 0.50722, 0.52844, 0.54461, 0.55879, 0.57201, 0.5832, 0.59027, 0.59737, 0.60239, 0.60637, 0.60293, 0.5984, 0.59596, 0.59993, 0.61787, 0.65317, 0.69947, 0.74821, 0.79179, 0.82254, 0.84021, 0.84052, 0.82651, 0.8102, 0.79056, 0.76957, 0.75847, 0.77522, 0.82117, 0.883, 0.93966, 0.97628, 0.99497, 1, 0.99831, 0.99774, 0.99727, 0.99666, 0.99615, 0.98857, 0.97513, 0.95694, 0.93631, 0.91555, 0.90286, 0.90067, 0.91379, 0.93642, 0.95798, 0.97013, 0.97518, 0.97546, 0.97572, 0.97478, 0.97381, 0.97295, 0.97436, 0.97456, 0.96743, 0.93949, 0.88456, 0.79862, 0.6829, 0.54804, 0.40726, 0.28186, 0.18529, 0.11568, 0.070803, 0.043646, 0.027601, 0.0176, 0.011016, 67609e-7, 47912e-7, 39844e-7, 3139e-6, 23814e-7, 22553e-7, 18119e-7, 1512e-6, 11342e-7, 65546e-8, 35449e-8, 4281e-8, 10032e-8] }, "W2": { "lam": [3.89, 3.9, 3.91, 3.92, 3.93, 3.94, 3.95, 3.96, 3.97, 3.98, 3.99, 4, 4.01, 4.02, 4.03, 4.04, 4.05, 4.06, 4.07, 4.08, 4.09, 4.1, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 4.18, 4.19, 4.2, 4.21, 4.22, 4.23, 4.24, 4.25, 4.26, 4.27, 4.28, 4.29, 4.3, 4.31, 4.32, 4.33, 4.34, 4.35, 4.36, 4.37, 4.38, 4.39, 4.4, 4.41, 4.42, 4.43, 4.44, 4.45, 4.46, 4.47, 4.48, 4.49, 4.5, 4.51, 4.52, 4.53, 4.54, 4.55, 4.56, 4.57, 4.58, 4.59, 4.6, 4.61, 4.62, 4.63, 4.64, 4.65, 4.66, 4.67, 4.68, 4.69, 4.7, 4.71, 4.72, 4.73, 4.74, 4.75, 4.76, 4.77, 4.78, 4.79, 4.8, 4.81, 4.82, 4.83, 4.84, 4.85, 4.86, 4.87, 4.88, 4.89, 4.9, 4.91, 4.92, 4.93, 4.94, 4.95, 4.96, 4.97, 4.98, 4.99, 5, 5.01, 5.02, 5.03, 5.04, 5.05, 5.06, 5.07, 5.08, 5.09, 5.1, 5.11, 5.12, 5.13, 5.14, 5.15, 5.16, 5.17, 5.18, 5.19, 5.2, 5.21, 5.22, 5.23, 5.24, 5.25, 5.26, 5.27, 5.28, 5.29, 5.3, 5.31, 5.32, 5.33, 5.34, 5.35, 5.36, 5.37, 5.38, 5.39, 5.4, 5.41, 5.42, 5.43, 5.44, 5.45, 5.46, 5.47, 5.48, 5.49, 5.5, 5.51, 5.52, 5.53, 5.54, 5.55, 5.56], "r": [10825e-8, 15454e-8, 22341e-8, 4175e-7, 56834e-8, 44113e-8, 13124e-7, 92633e-7, 0.011478, 0.014509, 0.018672, 0.024421, 0.034426, 0.050556, 0.075032, 0.11001, 0.15701, 0.22467, 0.3065, 0.39712, 0.49391, 0.58894, 0.67269, 0.74154, 0.79761, 0.83857, 0.86313, 0.88066, 0.89111, 0.89564, 0.89539, 0.89392, 0.88884, 0.88251, 0.87614, 0.877, 0.88028, 0.88114, 0.87832, 0.87794, 0.88121, 0.88818, 0.89517, 0.90219, 0.90675, 0.91008, 0.91094, 0.90805, 0.90514, 0.8997, 0.89172, 0.88495, 0.8794, 0.87382, 0.87074, 0.86636, 0.8645, 0.86517, 0.86966, 0.878, 0.88894, 0.90121, 0.9161, 0.92846, 0.94216, 0.95332, 0.96192, 0.96924, 0.97398, 0.97742, 0.97693, 0.97512, 0.97197, 0.96616, 0.96031, 0.95311, 0.94586, 0.93858, 0.93525, 0.93191, 0.93122, 0.93052, 0.93385, 0.93853, 0.94457, 0.95469, 0.96213, 0.97232, 0.97981, 0.98596, 0.98802, 0.99009, 0.9894, 0.9887, 0.98938, 0.98866, 0.98932, 0.98997, 0.99061, 0.99265, 0.99468, 0.99671, 0.99735, 0.99938, 1, 0.99921, 0.99699, 0.99475, 0.99108, 0.98596, 0.98081, 0.97135, 0.96327, 0.95228, 0.94125, 0.93016, 0.91902, 0.90783, 0.89659, 0.88675, 0.87686, 0.86693, 0.85403, 0.84107, 0.82073, 0.79883, 0.76361, 0.72676, 0.67647, 0.62007, 0.55602, 0.48564, 0.41662, 0.34717, 0.28359, 0.2256, 0.17504, 0.13546, 0.099248, 0.075935, 0.053213, 0.040746, 0.028307, 0.021081, 0.014697, 0.010435, 72372e-7, 40457e-7, 30484e-7, 22763e-7, 17339e-7, 12893e-7, 97294e-8, 73876e-8, 54885e-8, 39102e-8, 30953e-8, 21542e-8, 27863e-8, 31531e-8, 31353e-8, 25926e-8, 2251e-7, 19539e-8, 15012e-8, 13333e-8, 10424e-8, 60519e-9] } };
export {
  Refused,
  build,
  catalogueStep,
  checkColumns,
  finish,
  footprint,
  mulberry32,
  parity,
  parseCsv,
  parseVsx,
  prepExposure,
  starOn
};
