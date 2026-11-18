// The candidate page's Then and now box with its second tab, Colors (the approved mockup, yoshi/deliverables/space-apps-2026/
// colors-mockup). The tabs sit in a shell the blink never re-renders: thenandnow.js draws into #tn-then and its band switch
// into the title row; this file draws Colors into #tn-colors from the result live/colorsworker.js returns (baked for the
// showcase, else built in this browser once the reader starts it). Every word and number here comes from that result:
// no verdict, count or value is written in this file. Strings from the data are escaped.
// window.__colors holds what was drawn (the result, the pass, the chart's scale) for the page tests.
import { thenAndNow, CREDITS } from './thenandnow.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gl = (html, text, cls = '') => `<button type="button" class="gl ${cls}" data-g="${esc(text)}">${html}</button>`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mjdDate = m => new Date(Date.UTC(1858, 10, 17) + m * 864e5);
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const nWord = n => NUM[n] ?? String(n);
const fx = v => Math.abs(v).toFixed(1);
const G = {
  micron: 'A micron (µm) is a millionth of a metre. Our eyes see 0.4 to 0.7 µm, so everything on this chart is infrared, invisible to the eye.',
  pass: n => `SPHEREx maps the whole sky every six months. Each map that covered this star is a pass.${n > 1 ? ` "All" combines the ${nWord(n)}.` : ''}`,
  mjy: 'Brightness in millijansky (mJy), the unit astronomers use for faint sources. Higher on the chart means more light at that colour.',
  bare: n => `What this star gives off on its own: ${n} stars with the same colours and brightness, measured in the same SPHEREx pictures, scaled to this star. The band shows how much they differ.`,
};
const ICON = {
  then: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M17 4v16"/><path d="M3 9l4-4 4 4M13 15l4 4 4-4"/></svg>',
  colors: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19h18"/><path d="M3 15c3 0 4-5 7-5s3 3 5 1 3-7 6-7"/></svg>',
  rise: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h7c4 0 6-3 7-6s2-6 4-7"/></svg>',
  spike: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16h8l1-11 1 11h8"/></svg>',
  dip: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h7l2 7 2-7h7"/></svg>',
  seam: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16h8v-6h10"/><path d="M11 4v16" stroke-dasharray="2 2.5"/></svg>',
  'seen': '<svg class="ok" viewBox="0 0 24 24" aria-label="seen"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  'not seen': '<svg class="ok no" viewBox="0 0 24 24" aria-label="not seen"><path d="M6 12h12"/></svg>',
  inconclusive: '<svg class="ok unsure" viewBox="0 0 24 24" aria-label="inconclusive"><path d="M9.2 9.3a2.9 2.9 0 1 1 3.8 2.8c-.6.2-1 .8-1 1.4v.8"/><path d="M12 17.6v.1"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  spectrum: '<svg class="big" viewBox="0 0 48 48" aria-hidden="true"><path d="M6 40h36"/><path d="M6 32c6 0 8-12 14-12s6 6 10 2 6-14 12-14"/></svg>',
  down: '<svg class="big" viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="9" width="34" height="26" rx="3"/><path d="M7 29l9-8 7 6 5-4 13 10"/><path d="M4 4l40 40"/></svg>',
  unsure: '<svg class="big" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17"/><path d="M19 19a5 5 0 1 1 6.5 4.8c-1 .3-1.5 1.2-1.5 2.2v2"/><circle cx="24" cy="33.5" r=".8"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
};
const RAMP = [[0, [120, 170, 255]], [.2, [110, 225, 255]], [.4, [140, 255, 170]], [.6, [255, 235, 120]], [.8, [255, 160, 80]], [1, [255, 95, 95]]];   // live/spectral.js colourOf
const colourOf = um => { const t = Math.min(1, Math.max(0, (um - 0.75) / 4.25)); for (let n = 1; n < RAMP.length; n++) if (t <= RAMP[n][0]) { const [t0, a] = RAMP[n - 1], [t1, b] = RAMP[n], f = (t - t0) / (t1 - t0); return `rgb(${a.map((v, k) => Math.round(v + f * (b[k] - v))).join(',')})`; } return 'rgb(255,95,95)'; };
const bnu = (l, T) => 1 / (l ** 3 * Math.expm1(Math.min(14387.77 / (l * T), 700)));
// a step of 1, 2, 2.5, 4 or 5 times a power of ten giving about three grid lines up to the data's top
function niceTop(v) {
  const raw = v / 3, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 4, 5, 10].map(k => k * p).find(s => s >= raw);
  return { top: step * Math.ceil(v / step), step };
}

// the words of one result: rows, reading, the measured-how text
function words(R) {
  const fp = R.fingerprints ?? {}, all = R.passes?.find(p => p.key === 'all'), n = R.comparisons?.n ?? 0, F = R.fits?.all;
  const npass = (R.passes ?? []).filter(p => p.key !== 'all' && p.lam.length).length;
  const why = row => (row?.verdict === 'inconclusive' ? `Inconclusive: ${row.reason}.` : '');
  const sp = fp.spike?.sigma ?? {}, dp = fp.dip?.sigma ?? {}, sens = fp.seam?.sensitivity;
  const rows = [
    { hl: 'rise', icon: 'rise', text: 'Smooth rise from 3 µm', v: fp.rise?.verdict,
      g: why(fp.rise) || (fp.rise?.verdict === 'seen'
        ? `New warm dust. Star alone misses the ${all.lam.length} colours by far; star plus dust at ${F.T} K fits them within the noise.`
        : `No new dust. The bare star alone fits the ${all.lam.length} colours within the noise.`) },
    { hl: 'spike', icon: 'spike', text: 'Narrow spikes', v: fp.spike?.verdict,
      g: why(fp.spike) || `Hot gas shines at exact colours, such as hydrogen's Brackett alpha line at 4.05 µm. ${fp.spike?.verdict === 'seen'
        ? `Here ${Object.entries(sp).filter(([, s]) => s >= 3).map(([k, s]) => `${k.replace(/^.* /, '')} µm stands ${fx(s)} times the noise above the curve`).join(' and ')}.`
        : `None here: 4.05 µm sits on the curve (${fx(sp['Br alpha 4.05'])} times the noise).`}` },
    { hl: 'dip', icon: 'dip', text: 'Dips at 3.0 and 4.27 µm', v: fp.dip?.verdict,
      g: why(fp.dip) || `Ice swallows exact colours: water ice at 3.0 µm, carbon dioxide ice at 4.27 µm. ${fp.dip?.verdict === 'seen'
        ? `Here ${Object.entries(dp).filter(([, s]) => s <= -3).map(([k, s]) => `${k.replace(/^.* /, '')} µm falls ${fx(s)} times the noise below the curve`).join(' and ')}.`
        : `Neither dips below the curve by more than the noise (${fx(dp['water ice 3.0'])} and ${fx(dp['CO2 ice 4.27'])} times it).`}` },
    { hl: 'seam', icon: 'seam', text: 'Jumps at detector seams', v: fp.seam?.verdict,
      g: why(fp.seam) || `SPHEREx splits the colours across six detectors. A jump exactly at a seam (3.82 or 4.42 µm) would mean a calibration error. ${fp.seam?.verdict === 'seen'
        ? `This star jumps at ${Object.entries(fp.seam.steps).filter(([, s]) => Math.abs(s.jump) >= s.limit).map(([e]) => `${e} µm`).join(' and ')}, so its rise is not trusted.`
        : fp.rise?.verdict === 'seen' ? 'The rise runs straight across both.' : 'None here.'}${sens ? ` Jumps under about ${Math.round(sens * 100)}% can't be ruled out for this star.` : ''}` },
  ];
  return { rows, n, npass, all };
}

export function candidateBox(box, { ra, dec, name = '', onResult = () => {} }) {
  const Q = new URLSearchParams(location.search);
  box.innerHTML = `<div class="tn-top"><div class="tn-tabs" role="tablist" aria-label="View">
      <button type="button" class="tn-tab" role="tab" id="tn-h" data-tab="then" aria-controls="tn-then">${ICON.then}Then and now</button><button type="button" class="tn-tab" role="tab" id="co-h" data-tab="colors" aria-controls="tn-colors">${ICON.colors}Colors</button></div>
    <div class="wl" id="tn-then-wl"></div><div class="wl co-wl" hidden></div></div>
    <div id="tn-then" role="tabpanel" aria-labelledby="tn-h"></div><div id="tn-colors" role="tabpanel" aria-labelledby="co-h" hidden></div>`;
  const $ = s => box.querySelector(s), tabs = $('.tn-tabs'), thenWl = $('#tn-then-wl'), coWl = $('.co-wl'), thenBox = $('#tn-then'), coBox = $('#tn-colors');
  const events = [], blink = thenAndNow(thenBox, { ra, dec, mode: 'page', head: thenWl, onResult: r => { events.push(['blink result', performance.now()]); onResult(r); } });
  const S = { view: 'then', pass: 0, hl: '', state: 'checking', result: null, source: null, est: null, prog: null, id: 0, pts: [] };
  const pub = window.__colors = { S, drawn: null, events };   // events: when results arrived (the budget test's long tasks)
  const worker = new Worker(new URL('./live/colorsworker.js', import.meta.url), { type: 'module' });
  worker.onerror = e => { e.preventDefault(); if (S.state === 'building' || S.state === 'checking') { S.state = 'result'; S.result = { state: 'unavailable', reason: 'Colors could not be built in this browser' }; render(); } };
  worker.onmessage = ({ data: m }) => {
    if (m.id === S.estId) { if (m.type === 'estimate') S.est = m; else if (m.type === 'result' && S.state === 'offer') { S.state = 'result'; S.result = m.result; } render(); return; }
    if (m.id !== S.id) return;
    if (m.type === 'baked') { S.result = m.result; S.source = 'baked'; S.state = 'result'; if (Q.get('tab') !== 'then') setView('colors'); render(); return; }
    if (m.type === 'none') { S.state = 'offer'; setView(Q.get('tab') === 'colors' ? 'colors' : S.view); return; }
    if (m.type === 'progress') { S.prog = m; progressOnly(); return; }
    if (m.type === 'result') { events.push(['colors result', performance.now()]); S.result = m.result; S.source = m.source; S.state = 'result'; render(); events.push(['colors drawn', performance.now()]); }
  };
  const ask = (mode) => { S.id = Date.now() + Math.random(); worker.postMessage({ id: S.id, ra, dec, api: '', mode }); };
  ask('baked');

  function setView(v, focus) {
    S.view = v; box.dataset.view = v;
    for (const t of tabs.children) { const on = t.dataset.tab === v; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
    thenBox.hidden = thenWl.hidden = v !== 'then'; coBox.hidden = v !== 'colors'; coWl.hidden = v !== 'colors' || !hasChart();
    blink.setActive(v === 'then');
    if (v === 'colors' && S.state === 'offer' && !S.estId) { S.estId = Date.now() + Math.random(); worker.postMessage({ id: S.estId, ra, dec, api: '', mode: 'estimate' }); }
    if (v === 'colors') render();
  }
  tabs.addEventListener('click', e => { const t = e.target.closest('.tn-tab'); if (t) setView(t.dataset.tab); });
  tabs.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setView(S.view === 'then' ? 'colors' : 'then', true); } });
  coBox.addEventListener('click', e => {
    if (e.target.closest('[data-start]')) { S.state = 'building'; S.prog = null; ask('live'); render(); }
    if (e.target.closest('[data-retry]')) { S.state = 'building'; S.prog = null; ask('live'); render(); }
  });
  const hasChart = () => S.state === 'result' && (S.result?.passes ?? []).some(p => p.key === 'all' && p.lam.length);

  // ---------- render ----------
  function render() {
    coWl.hidden = S.view !== 'colors' || !hasChart();
    if (S.view !== 'colors') return;
    const openHow = coBox.querySelector('.co-how')?.open, openCred = coBox.querySelector('.credits-d')?.open;
    coBox.dataset.state = S.state === 'result' ? S.result.state : S.state;
    if (S.state === 'checking') coBox.innerHTML = msg('', 'Looking for this star\'s colours', '', true);
    else if (S.state === 'offer') {
      const e = S.est, gb = e ? (e.bytes / 1e9).toFixed(1) : null;
      coBox.innerHTML = `<div class="blink down co-msg" role="status" data-state="offer"><div class="down-msg">${ICON.spectrum}<h3>See this star's colours</h3>
        <p>${e ? `This measures the star in all ${e.exposures} SPHEREx pictures of it, so your browser downloads about ${gb} GB. It takes a few minutes.` : 'Counting the SPHEREx pictures of this star.'}</p>
        <button type="button" class="btn-line" data-start${e ? '' : ' disabled'}>Download ${e ? `${gb} GB` : ''} and measure</button></div></div>${CREDITS}`;
    } else if (S.state === 'building') coBox.innerHTML = msg('', 'Building the spectrum', S.prog?.text ?? 'Starting', true) + CREDITS;
    else if (!hasChart()) {
      const R = S.result, down = R.state === 'unavailable';
      coBox.innerHTML = `<div class="blink down co-msg" role="status" data-state="${esc(R.state)}"><div class="down-msg">${down ? ICON.down : ICON.unsure}<h3>${down ? 'The data are not available right now' : 'Inconclusive'}</h3>
        <p>${esc(R.reason[0].toUpperCase() + R.reason.slice(1))}${down ? '. Try again in a few minutes.' : '.'}</p>${down ? `<button type="button" class="btn-line" data-retry>${ICON.retry}Try again</button>` : ''}</div></div>${CREDITS}`;
    } else full();
    if (openHow) coBox.querySelector('.co-how')?.setAttribute('open', '');
    if (openCred) coBox.querySelector('.credits-d')?.setAttribute('open', '');
  }
  function msg(icon, h, p, bar) {
    const t = S.prog?.total, f = t ? S.prog.done / t : null;
    return `<div class="blink down co-msg" role="status" data-state="${S.state}"><div class="down-msg">${icon}<h3>${esc(h)}</h3>${p ? `<p class="prog">${esc(p)}${S.prog?.bytes ? ` (${(S.prog.bytes / 1e9).toFixed(2)} GB)` : ''}</p>` : ''}${bar ? `<div class="bar${f !== null ? ' det' : ''}"><i${f !== null ? ` style="width:${(f * 100).toFixed(1)}%"` : ''}></i></div>` : ''}</div></div>`;
  }
  function progressOnly() {
    if (S.view !== 'colors' || S.state !== 'building') return;
    coBox.innerHTML = msg('', 'Building the spectrum', S.prog?.text ?? 'Starting', true) + CREDITS;
  }

  function full() {
    const R = S.result, W = words(R), P = passList(R);
    coWl.innerHTML = `${gl('Pass', G.pass(W.npass))}<div class="tn-seg co-seg" role="tablist" aria-label="Pass">${P.map((p, i) => `<button type="button" role="tab" data-pass="${i}" aria-label="${esc(p.say)}"><span class="lg">${esc(p.lg)}</span><span class="sh">${esc(p.sh)}</span></button>`).join('')}</div>`;
    S.pass = Math.min(S.pass, P.length - 1);
    const old = R.old ?? [], tm = old.find(o => o.survey === '2MASS'), wi = old.find(o => o.survey === 'WISE');
    coBox.innerHTML = `<div class="co-body">
      <div class="co-chart">
        <div class="co-axisname">${gl('mJy', G.mjy)}<span></span></div>
        <svg id="co-svg" role="img" aria-label=""></svg>
        <div class="co-key"><span><i class="k-dot"></i><span id="co-now">SPHEREx</span></span>
          ${tm ? `<span><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>2MASS ${yearOf(tm)}</span>` : ''}
          ${wi ? `<span><svg viewBox="0 0 12 12"><path d="M6 .8L11.2 6 6 11.2.8 6z" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>WISE ${yearOf(wi)}</span>` : ''}
          ${gl('<i class="k-bare"></i>bare star', G.bare(W.n))}</div>
      </div>
      <div class="co-res-col"><div class="res co-res"><p class="band" id="co-band"></p><div class="big" id="co-big"></div><p class="near" id="co-near"></p></div>
        <ul class="checks co-checks">${W.rows.map(r => `<li><button type="button" class="chk gl co-chk" data-hl="${r.hl}" data-v="${esc(r.v)}" data-g="${esc(r.g)}">${ICON[r.icon]}<span>${esc(r.text)}</span>${ICON[r.v] ?? ICON.inconclusive}</button></li>`).join('')}</ul></div>
    </div>
    <details class="diffbox co-how"><summary><span>How this was measured</span>${ICON.chev}</summary><div class="diff-in">${how(R, W).map(p => `<p>${esc(p)}</p>`).join('')}</div></details>${CREDITS}`;
    const seg = coWl.querySelector('.co-seg');
    seg.onclick = e => { const b = e.target.closest('button'); if (b) { S.pass = +b.dataset.pass; draw(); } };
    seg.onkeydown = e => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (d) { e.preventDefault(); S.pass = (S.pass + d + P.length) % P.length; draw(); seg.children[S.pass].focus(); } };
    for (const r of coBox.querySelectorAll('.co-chk')) {
      r.addEventListener('mouseenter', () => setHl(r.dataset.hl)); r.addEventListener('mouseleave', () => setHl(''));
      r.addEventListener('focus', () => setHl(r.dataset.hl)); r.addEventListener('blur', () => setHl(''));
      r.addEventListener('pointerdown', () => setHl(r.dataset.hl));
    }
    draw();
  }
  const setHl = h => { S.hl = h; const s = coBox.querySelector('#co-svg'); if (s) s.dataset.hl = h; };
  const yearOf = o => (o.jd ? new Date((o.jd - 2440587.5) * 864e5).getUTCFullYear() : mjdDate(o.mjd.filter(Number.isFinite).reduce((a, b) => a + b, 0) / o.mjd.filter(Number.isFinite).length).getUTCFullYear());
  function passList(R) {
    const ps = R.passes.filter(p => p.lam.length), n = ps.filter(p => p.key !== 'all').length;
    // "All" with the passes when there are two or more; a lone pass alone; "All" alone when no single pass has colours
    return ps.filter(p => (p.key === 'all' ? n !== 1 : true)).map(p => {
      if (p.key === 'all') return { ...p, lg: 'All', sh: 'All', say: `all ${nWord(n)} passes` };
      const d = mjdDate(p.mjd); return { ...p, lg: `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`, sh: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`, say: `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
    });
  }
  function how(R, W) {
    const out = [`Each dot is one colour band of SPHEREx light from this star, measured the same way in every picture. The bare star line comes from ${W.n} stars that matched this one in 2000 and 2010, in the same pictures, so camera quirks cancel.`];
    const near = (R.old ?? []).every(o => Math.abs(o.mjy - bareAt(R.bare, o.lam)) <= 3 * Math.hypot(o.err ?? 0, spreadAt(R.bare, o.lam)));
    const rise = R.fingerprints?.rise?.verdict === 'seen', T = R.fingerprints?.temperature, cs = R.comparison_systematic;
    if (R.old?.length) out.push(`The ${[...new Set(R.old.map(yearOf))].join(' and ')} points are put on SPHEREx's scale with those same stars. ${near ? (rise ? 'They sit near the bare star line, far below today\'s dots past 3 µm: back then this looked like an ordinary star.' : 'They sit near the bare star line.') : 'Some of them sit off the bare star line.'}`);
    if (T?.verdict === 'seen' && cs) out.push(`The fit gives ${T.T} K (likely ${T.T_1sigma[0]} to ${T.T_1sigma[1]} K) and ${Math.round(R.excess_46 * 100)}% extra light at 4.6 µm. Choosing a different set of comparison stars moves these by about ${Math.round(cs.T_sys)} K and ${Math.round(cs.excess_46_sys * 100)} points, so read the temperature as ${T.T} ± ${Math.round(Math.hypot(cs.T_sys, (T.T_1sigma[1] - T.T_1sigma[0]) / 2))} K.`);
    if (rise) out.push('Not yet confirmed by another telescope. A spectrum from one (for example IRTF) is the next step.');
    return out;
  }

  // ---------- the chart (the mockup's, every value from the result) ----------
  const NS = 'http://www.w3.org/2000/svg';
  function draw() {
    const R = S.result, P = passList(R), p = P[S.pass], k = R.fits[p.key], svg = coBox.querySelector('#co-svg'), fp = R.fingerprints, W = words(R);
    if (!svg) return;
    for (const b of coWl.querySelectorAll('.co-seg button')) { const on = +b.dataset.pass === S.pass; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
    const B = R.bare, bare = l => bareAt(B, l), b46 = bare(4.6), rise = fp.rise?.verdict === 'seen';
    // a pass's own temperature only when its own dust is detected (5 times its noise) and off the grid's edges
    const own = f => f && f.b >= 5 * f.b_err && f.T > 200 && f.T < 2500, dust = fp.temperature?.verdict === 'seen' && (p.key === 'all' || own(k));
    const cs = R.comparison_systematic, pct = Math.round((p.key === 'all' ? R.excess_46 : k.b / b46) * 100);
    // the reading
    coBox.querySelector('#co-band').innerHTML = `${gl('0.75–5 µm', G.micron)} · ${esc(p.say)}`;
    const big = coBox.querySelector('#co-big'), near = coBox.querySelector('#co-near'), res = coBox.querySelector('.co-res');
    res.classList.toggle('wait', !dust && fp.rise?.verdict !== 'not seen');
    if (dust) {
      const T1 = p.key === 'all' ? fp.temperature.T_1sigma : k.T_1sigma, sys = p.key === 'all' && cs ? `; the choice of comparison stars alone moves it by about ${Math.round(cs.T_sys)} K` : '';
      big.innerHTML = `<b>${k.T} K</b><span>${gl('warm dust', `Dust grains near the star, warmed by it, glow in infrared like a stove ring. This glow fits dust at ${k.T} K, about ${Math.round(k.T - 273)} °C (likely ${T1[0]} to ${T1[1]} K${sys}).`)}</span>`;
      const pf = R.passes.filter(q => q.key !== 'all' && R.fits[q.key]).map(q => R.fits[q.key]);
      const steps = pf.slice(1).map((f, i) => Math.abs(f.b - pf[i].b) / Math.hypot(f.b_err, pf[i].b_err)), up = pf.every((f, i) => !i || f.b > pf[i - 1].b);
      const grew = pf.length > 1 ? ` Over the ${nWord(pf.length)} passes it went ${pf.map(f => f.b.toFixed(2)).join(', ')} mJy. ${Math.max(...steps) < 3 ? `Each step is within about ${Math.max(1, Math.round(Math.max(...steps)))} times the noise: ${up ? 'a hint of growth, not yet a finding' : 'no clear change between passes'}.` : 'At least one step is larger than three times the noise.'}` : '';
      const sysx = p.key === 'all' && cs ? ` The choice of comparison stars alone moves the ${pct}% by about ${Math.round(cs.excess_46_sys * 100)} points.` : '';
      near.innerHTML = gl(`+${pct}% light at 4.6 µm`, `The dust adds ${k.b.toFixed(2)} mJy at 4.6 µm on top of the bare star's ${b46.toFixed(2)}, so ${p.key === 'all' ? 'the star now shines' : 'it shone'} about ${(1 + k.b / b46).toFixed(1)} times as bright there.${grew}${sysx}`);
    } else if (fp.temperature?.verdict === 'seen') {
      big.innerHTML = '';
      near.textContent = `In this pass alone the dust is not detected: ${k.b.toFixed(2)} ± ${k.b_err.toFixed(2)} mJy at 4.6 µm. All passes together give ${R.fits.all.T} K.`;
    } else if (fp.rise?.verdict === 'not seen') {
      big.innerHTML = `<b>No dust</b><span>${gl('star alone', 'The bare star fits every colour within the noise, so there is no dust to measure.')}</span>`;
      near.innerHTML = gl(`${pct >= 0 ? '+' : ''}${pct}% light at 4.6 µm`, `The fit puts ${k.b.toFixed(2)} mJy of extra light at 4.6 µm on the bare star's ${b46.toFixed(2)}, within the noise (${k.b_err.toFixed(2)}).`);
    } else {
      big.innerHTML = '';
      near.textContent = `Inconclusive: ${fp.temperature?.reason ?? R.reason}.`;
    }
    coBox.querySelector('#co-now').textContent = `SPHEREx ${p.key === 'all' ? spanYears(R) : p.lg}`;
    // geometry; the top of the scale from the data drawn in any pass, so switching passes keeps one scale
    const W0 = Math.max(280, Math.round(svg.clientWidth || 560)), narrow = W0 < 480, H = Math.round(Math.min(400, Math.max(220, W0 * (narrow ? 0.74 : 0.6))));
    // (error bars past the top are clipped there, as in the mockup: the dots, curves and band set the scale)
    const vmax = Math.max(...R.passes.flatMap(q => q.mjy), ...B.mjy.map((v, i) => v + B.spread[i]), ...R.passes.flatMap(q => q.fit), ...(R.old ?? []).map(o => o.mjy));
    const { top: YMAX, step } = niceTop(vmax * 1.02);
    svg.setAttribute('viewBox', `0 0 ${W0} ${H}`); svg.style.aspectRatio = `${W0} / ${H}`; svg.replaceChildren(); svg.dataset.hl = S.hl;
    const X0 = 30, X1 = W0 - 6, Y0 = 16, Y1 = H - 30;
    const sx = l => X0 + (l - 0.75) / 4.25 * (X1 - X0), sy = v => Y1 - v / YMAX * (Y1 - Y0);
    const add = (tag, a, parent = svg) => { const e = document.createElementNS(NS, tag); for (const n in a) e.setAttribute(n, a[n]); parent.append(e); return e; };
    const line = (xy, cls) => add('polyline', { class: cls, points: xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
    for (let v = 0; v <= YMAX + 1e-9; v += step) { add('line', { class: 'grid', x1: X0, x2: X1, y1: sy(v), y2: sy(v) }); add('text', { x: X0 - 6, y: sy(v) + 3.5, 'text-anchor': 'end' }).textContent = +v.toFixed(2); }
    for (const l of [1, 2, 3, 4, 5]) add('text', { x: sx(l), y: Y1 + 22, 'text-anchor': l === 5 ? 'end' : 'middle' }).textContent = `${l} µm`;
    const grad = add('linearGradient', { id: 'co-ramp', x1: 0, x2: 1, y1: 0, y2: 0 }, add('defs', {}));
    for (const [t, c] of RAMP) add('stop', { offset: t, 'stop-color': `rgb(${c.join(',')})` }, grad);
    add('rect', { x: X0, y: Y1 + 3, width: X1 - X0, height: 3, fill: 'url(#co-ramp)', opacity: .55, rx: 1 });
    add('line', { class: 'axis', x1: X0, x2: X1, y1: Y1, y2: Y1 });
    add('polygon', { class: 'bare-band', points: [...B.lam.map((l, i) => `${sx(l).toFixed(1)},${sy(B.mjy[i] + B.spread[i]).toFixed(1)}`), ...B.lam.map((l, i) => `${sx(l).toFixed(1)},${sy(B.mjy[i] - B.spread[i]).toFixed(1)}`).reverse()].join(' ') });
    line(B.lam.map((l, i) => [sx(l), sy(B.mjy[i])]), 'bare');
    // the fitted star (+ dust) curve from where the curve leaves the bare star; the extra light only when the rise is seen
    const fitPts = p.lam.map((l, i) => [l, p.fit[i]]).filter(([l]) => l >= 2.42), area = fitPts.map(([l, f]) => [l, Math.max(f, bare(l)), bare(l)]);
    if (rise) add('polygon', { class: 'extra', points: [...area.map(([l, f]) => `${sx(l).toFixed(1)},${sy(f).toFixed(1)}`), ...area.map(([l, , b]) => `${sx(l).toFixed(1)},${sy(b).toFixed(1)}`).reverse()].join(' ') });
    line(fitPts.map(([l, f]) => [sx(l), sy(f)]), 'fit');   // the fitted curve as computed; only the shaded area stops at the bare star
    const mark = (l, label, cls, anchor = 'middle') => { add('line', { class: `mark ${cls}`, x1: sx(l), x2: sx(l), y1: Y0, y2: Y1 }); add('text', { class: `mark-lab ${cls}`, x: sx(l), y: Y0 - 4, 'text-anchor': anchor }).textContent = label; };
    mark(4.05, 'Brα 4.05', 'hl-spike'); mark(3.0, 'water ice', 'hl-dip'); mark(4.27, 'CO₂ ice', 'hl-dip', 'end'); mark(3.82, 'seam', 'hl-seam', 'end'); mark(4.42, 'seam', 'hl-seam', 'start');
    const pts = [];
    p.lam.forEach((l, i) => {
      const y = p.mjy[i], e = p.err[i], c = colourOf(l), x = sx(l);
      add('line', { class: 'err', x1: x, x2: x, y1: sy(Math.max(0, y - e)), y2: sy(Math.min(YMAX, y + e)), stroke: c, 'data-i': i });
      add('circle', { class: 'dot', cx: x, cy: sy(y), r: narrow ? 2.4 : 2.8, fill: c, 'data-i': i });
      const b = bare(l), ex = Math.round((y / b - 1) * 100);
      pts.push([x, sy(y), `${l.toFixed(2)} µm, ${p.say}: ${y.toFixed(2)} ± ${e.toFixed(2)} mJy. Bare star ${b.toFixed(2)}${l >= 2.42 ? ` (${ex >= 0 ? '+' : ''}${ex}%)` : ''}.`]);
    });
    for (const o of R.old ?? []) {
      const x = sx(o.lam), y = sy(o.mjy), s = narrow ? 4.2 : 5, nm = o.survey === '2MASS' ? `2MASS ${o.band === 'K' ? 'Ks' : o.band}` : `WISE ${o.band}`;
      if (o.err) add('line', { class: 'old-err', x1: x, x2: x, y1: sy(o.mjy - o.err), y2: sy(o.mjy + o.err) });
      if (o.survey === '2MASS') add('rect', { class: 'old', x: x - s, y: y - s, width: 2 * s, height: 2 * s, 'data-band': o.band });
      else add('path', { class: 'old', d: `M${x} ${y - s * 1.25}L${x + s * 1.25} ${y}L${x} ${y + s * 1.25}L${x - s * 1.25} ${y}Z`, 'data-band': o.band });
      pts.push([x, y, `${nm}, ${whenOf(o)}: ${o.mjy.toFixed(2)} mJy on SPHEREx's scale (${o.raw_mjy.toFixed(2)} as catalogued). Bare star ${bare(o.lam).toFixed(2)}.`]);
    }
    const lb = B.lam.length - 1;
    add('text', { class: 'lab-bare', x: X1, y: sy(B.mjy[lb] - B.spread[lb]) + 13, 'text-anchor': 'end' }).textContent = 'bare star';
    if (rise && area.length) { const le = narrow ? 4.15 : 4.25, fe = area.reduce((a, r) => (Math.abs(r[0] - le) < Math.abs(a[0] - le) ? r : a)); add('text', { class: 'lab-extra', x: sx(fe[0]), y: sy((fe[1] + fe[2]) / 2) + 4, 'text-anchor': 'middle' }).textContent = 'extra light'; }
    add('line', { class: 'cross', x1: 0, x2: 0, y1: Y0, y2: Y1, visibility: 'hidden', id: 'co-cross' });
    add('circle', { class: 'ring', r: 6, visibility: 'hidden', id: 'co-ring' });
    const oldNear = (R.old ?? []).every(o => Math.abs(o.mjy - bare(o.lam)) <= 3 * Math.hypot(o.err ?? 0, spreadAt(B, o.lam)));
    svg.setAttribute('aria-label', `Spectrum of ${name || 'this star'}, ${p.say}: ${p.lam.length} SPHEREx colours from 0.75 to 5 µm. ${rise ? `Matches the bare star up to about 3 µm, then rises above it; at 4.6 µm it has ${pct}% extra light, fitted by dust at ${k.T} K.` : 'It follows the bare star.'}${R.old?.length ? ` The older points sit ${oldNear ? 'on' : 'off'} the bare star line.` : ''}`);
    S.pts = pts;
    pub.drawn = { pass: p.key, W: W0, H, X0, X1, Y0, Y1, YMAX, rows: W.rows.map(r => [r.hl, r.v]) };
  }
  const spanYears = R => { const ys = R.passes.filter(q => q.mjd).map(q => mjdDate(q.mjd).getUTCFullYear()), a = Math.min(...ys), b = Math.max(...ys); return a === b ? `${a}` : `${a}–${String(b).slice(2)}`; };
  const whenOf = o => (o.jd ? (d => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`)(new Date((o.jd - 2440587.5) * 864e5)) : (d => `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`)(mjdDate(o.mjd.filter(Number.isFinite).reduce((a, b) => a + b, 0) / o.mjd.filter(Number.isFinite).length)));
  addEventListener('resize', () => { if (S.view === 'colors' && hasChart()) draw(); });

  // hover or tap: the nearest point, in the box's gloss card (#tn-tip, thenandnow.js)
  const tip = () => document.getElementById('tn-tip');
  function showAt(r, text) { const t = tip(); t.textContent = text; t.classList.add('on'); const w = Math.min(260, innerWidth - 24); t.style.maxWidth = w + 'px'; const tw = t.offsetWidth, th = t.offsetHeight;
    t.style.left = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), innerWidth - tw - 12) + 'px'; let y = r.bottom + 8; if (y + th > innerHeight - 8) y = r.top - th - 8; t.style.top = y + 'px'; }
  function pointAt(e) {
    const svg = coBox.querySelector('#co-svg'), Rc = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, s = vb.width / Rc.width, x = (e.clientX - Rc.left) * s, y = (e.clientY - Rc.top) * s;
    let best = null, bd = 1e9; for (const q of S.pts) { const d = Math.hypot(q[0] - x, (q[1] - y) * 0.35); if (d < bd) { bd = d; best = q; } }
    const ring = svg.querySelector('#co-ring'), cross = svg.querySelector('#co-cross');
    if (!best || bd > 26 * s) { ring.setAttribute('visibility', 'hidden'); cross.setAttribute('visibility', 'hidden'); tip().classList.remove('on'); return; }
    ring.setAttribute('cx', best[0]); ring.setAttribute('cy', best[1]); ring.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', best[0]); cross.setAttribute('x2', best[0]); cross.setAttribute('visibility', 'visible');
    const px = Rc.left + best[0] / s, py = Rc.top + best[1] / s; showAt({ left: px - 6, right: px + 6, top: py - 10, bottom: py + 10, width: 12 }, best[2]);
  }
  coBox.addEventListener('pointermove', e => { if (e.target.closest('#co-svg')) pointAt(e); });
  coBox.addEventListener('pointerdown', e => { if (e.target.closest('#co-svg')) pointAt(e); });
  coBox.addEventListener('pointerleave', () => { coBox.querySelector('#co-ring')?.setAttribute('visibility', 'hidden'); coBox.querySelector('#co-cross')?.setAttribute('visibility', 'hidden'); tip()?.classList.remove('on'); });
  pub.point = i => { const q = S.pts[i], svg = coBox.querySelector('#co-svg'), Rc = svg.getBoundingClientRect(), s = svg.viewBox.baseVal.width / Rc.width; pointAt({ clientX: Rc.left + q[0] / s, clientY: Rc.top + q[1] / s }); };
  pub.texts = () => S.pts.map(q => q[2]);
  pub.setHl = setHl;
  pub.setPass = i => { S.pass = i; draw(); };

  setView(Q.get('tab') === 'colors' ? 'colors' : 'then');
  return blink;
}
// linear in wavelength on the bare star's bins (clamped at the ends), as the mockup
export function bareAt(B, l) { let i = 0; while (i < B.lam.length - 2 && B.lam[i + 1] < l) i++; const f = (l - B.lam[i]) / (B.lam[i + 1] - B.lam[i]); return B.mjy[i] + Math.max(0, Math.min(1, f)) * (B.mjy[i + 1] - B.mjy[i]); }
function spreadAt(B, l) { let i = 0; while (i < B.lam.length - 2 && B.lam[i + 1] < l) i++; const f = Math.max(0, Math.min(1, (l - B.lam[i]) / (B.lam[i + 1] - B.lam[i]))); return B.spread[i] + f * (B.spread[i + 1] - B.spread[i]); }
