// "Then and now": the older survey's picture of a spot against SPHEREx, blinked, with the measured change, the checks
// behind it, the difference image and the data credits. On the candidate page (mode 'page') and as the time-lapse's
// third tab (mode 'lapse'). The pictures and numbers come from live/blinkworker.js (baked for the showcase, else built
// here); this file only draws. Every string from the data is set with textContent or escaped.
// window.__blink holds what was drawn (each band's state and report, the stretch, the canvases) for the page tests.
import * as B from './live/blink.js';

const ORDER = ['Ks', 'W1', 'W2'];
const BAND = {
  Ks: { um: '2.2', wl: '2.16 µm', oldName: '2MASS', oldBand: 'Ks 2.16 µm', gloss: 'Infrared light, about 3 times the wavelength of red light. Invisible to the eye.' },
  W1: { um: '3.4', wl: '3.4 µm', oldName: 'AllWISE', oldBand: 'W1 3.4 µm', gloss: 'Infrared light, about 5 times the wavelength of red light. Invisible to the eye.' },
  W2: { um: '4.6', wl: '4.6 µm', oldName: 'AllWISE', oldBand: 'W2 4.6 µm', gloss: 'Infrared light, about 7 times the wavelength of red light. Invisible to the eye. Warm dust glows strongly here.' },
};
const G = {
  micron: 'A micron (µm) is a millionth of a metre. Our eyes see 0.4 to 0.7 µm. All three bands here are infrared.',
  wise: 'AllWISE adds every WISE picture of this spot from DATES into one. This many touched the star.',
  scan: '2MASS photographed this strip of sky once, on DATES, from a ground telescope.',
  sx: 'SPHEREx splits light into many narrow colours. This frame rebuilds the old survey\'s band from them, weighted the same way, so both frames see the same light.',
  arcmin: 'An arcminute is 1/60 of a degree. The full Moon is about 30 arcminutes across.',
  mask: 'Pixels where SPHEREx has no usable data. They are shown, never filled in.',
  matched: 'Matched pictures: north up, the same 2″ grid, the same brightness scale and the same sharpness, so only real change shows. Background levels matched for display.',
};
const ICON = {
  play: '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13L18.5 12z"/></svg>',
  pause: '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1"/><rect x="13.4" y="6" width="3.6" height="12" rx="1"/></svg>',
  match: '<svg class="mi" viewBox="0 0 24 24" role="img" aria-label="Matched pictures"><circle cx="8.5" cy="12" r="5"/><circle cx="15.5" cy="12" r="5"/></svg>',
  ok: '<svg class="ok" viewBox="0 0 24 24" aria-label="passed"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  no: '<svg class="ok no" viewBox="0 0 24 24" aria-label="not shown"><path d="M6 12h12"/></svg>',
  stars: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2"/><circle cx="17" cy="6" r="1.6"/><circle cx="12" cy="13" r="2.4"/><circle cx="5" cy="18" r="1.4"/><circle cx="18.5" cy="17.5" r="2"/></svg>',
  wave: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V15M10 19V11M16 19V6"/><path d="M3 21h18"/></svg>',
  spot: '<svg class="ci" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  down: '<svg class="big" viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="9" width="34" height="26" rx="3"/><path d="M7 29l9-8 7 6 5-4 13 10"/><path d="M4 4l40 40"/></svg>',
  unsure: '<svg class="big" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17"/><path d="M19 19a5 5 0 1 1 6.5 4.8c-1 .3-1.5 1.2-1.5 2.2v2"/><circle cx="24" cy="33.5" r=".8"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gl = (html, text) => `<button type="button" class="gl" data-g="${esc(text)}">${html}</button>`;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mon = s => `${MONTH[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const day = s => `${+s.slice(8, 10)} ${MONTH[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const year = s => { const d = new Date(s + 'T00:00:00Z'); return d.getUTCFullYear() + (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / (365.25 * 864e5); };
const span = (a, b) => (a.slice(0, 7) === b.slice(0, 7) ? mon(a) : a.slice(0, 4) === b.slice(0, 4) ? `${MONTH[+a.slice(5, 7) - 1]} to ${mon(b)}` : `${mon(a)} to ${mon(b)}`);

// what each band's result says, in words: the picture labels, the change, the checks
function words(band, m, context) {
  const r = m.report, o = r.old, s = r.spherex, b = BAND[band];
  const oldYear = o.dates[0].slice(0, 4), wise = /WISE/.test(o.survey), ratio = r.lead_ratio;
  const oldDates = wise ? span(o.dates[0], o.dates.at(-1)) : day(o.dates[0]);
  const oldExp = wise ? `${Math.round(o.coverage_frames_at_lead)} exposures` : `${o.tiles_at_lead.length} scan${o.tiles_at_lead.length === 1 ? '' : 's'}`;
  const [s0, s1] = s.dates_at_lead, nowYr = s0.slice(0, 4) === s1.slice(0, 4) ? s0.slice(0, 4) : `${s0.slice(0, 4)}–${s1.slice(2, 4)}`;
  const out = s.response_weight_outside_spherex >= 0.01 ? ` SPHEREx stops at 5.0 µm, so the last ${Math.round(100 * s.response_weight_outside_spherex)}% of this band is filled in from its edge.` : '';
  const change = Math.abs(r.lead_z_vs_field) < 3 ? 'same' : ratio > 1 ? 'brighter' : 'dimmer';
  const pct = Math.round(Math.abs(ratio - 1) * 100), sc = Math.round(r.field_scatter_robust_sigma * 100);
  return {
    oldYear, nowYr, oldT: wise ? (year(o.dates[0]) + year(o.dates.at(-1))) / 2 : year(o.dates[0]), nowT: (year(s0) + year(s1)) / 2,
    old: { yr: oldYear, l1: `<b>${b.oldName}</b> · ${esc(b.oldBand)}`, l2: `${esc(oldDates)} · ${gl(esc(oldExp), (wise ? G.wise : G.scan).replace('DATES', oldDates))}` },
    now: { yr: nowYr, l1: `<b>SPHEREx</b> · as ${band}, ${gl(`${s.synth_range_um[0].toFixed(2)}–${s.synth_range_um[1].toFixed(2)} µm`, G.sx + out)}`, l2: `${esc(span(s0, s1))} · ${s.exposures_at_lead} exposures` },
    show: `${ratio.toFixed(2)}×`, change,
    word: change === 'same' ? `the same as in ${oldYear}` : `${change} than in ${oldYear}`,
    wordGloss: change === 'same'
      ? `Within the noise. Nearby stars scatter by about ${sc}% between these two pictures, so a ${pct}% difference is consistent with no change.${band === 'Ks' ? ' This band is the control: a star alone should look the same here.' : ''}`
      : `SPHEREx (${s0.slice(0, 4)}-${s1.slice(2, 4)}) collects ${ratio.toFixed(2)} times the light ${b.oldName.replace('All', '')} saw from this star in ${oldYear}, after both pictures are matched on nearby stars.`,
    held: `${r.validation_stars} test stars, kept out of the matching, come out ${r.validation_median.toFixed(2)}× their ${oldYear} brightness (scatter ${r.field_scatter_robust_sigma.toFixed(2)}).`,
    spot: `It sits within ${Math.max(0.1, r.lead_shift_arcsec ?? 0).toFixed(1)}″ of where it was (1.5″ allowed), and the two pictures line up to ${Math.max(0.1, r.align_offset_arcsec.median).toFixed(1)}″.`,
  };
}
// across the bands: does the change grow with wavelength?
function trend(results, context) {
  const ok = ORDER.filter(k => results[k]?.state === 'ok').map(k => [k, results[k].report]);
  if (ok.length < 3) return { text: 'Change by wavelength', detail: 'Measured in every band that has a good comparison.', pass: false };
  const [ks, w1, w2] = ok.map(([, r]) => r), sig = Math.max(ks.field_scatter_robust_sigma, w1.field_scatter_robust_sigma, w2.field_scatter_robust_sigma);
  const same = ok.every(([, r]) => Math.abs(r.lead_z_vs_field) < 3);
  if (same) return { text: 'The same at every wavelength', detail: 'Unchanged within the noise at 2.2, 3.4 and 4.6 µm.', pass: true };
  if (w2.lead_ratio - w1.lead_ratio > sig && w1.lead_ratio - ks.lead_ratio > sig)
    return { text: 'Grows with wavelength', detail: `Brighter at longer wavelengths.${context?.dust_K ? ` That fits warm dust near the star, about ${context.dust_K} K.` : ''}`, pass: true };
  return { text: 'Differs by wavelength', detail: `${ok.map(([k, r]) => `${BAND[k].um} µm ${r.lead_ratio.toFixed(2)}×`).join(', ')}.`, pass: true };
}

export function thenAndNow(root, { ra, dec, mode = 'page', slots = {}, context = null, onResult = () => {} }) {
  const S = { band: 'W2', frame: 0, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, results: {}, progress: {}, active: mode === 'page' };
  const pub = window.__blink = { S, results: S.results, drawn: {} };
  let worker = null, timer = null;

  function start(live = false) {
    worker?.terminate();
    for (const k of Object.keys(S.results)) delete S.results[k];
    worker = new Worker(new URL('./live/blinkworker.js', import.meta.url), { type: 'module' });
    worker.onerror = e => { e.preventDefault(); for (const k of ORDER) if (!S.results[k]) S.results[k] = { state: 'spherex-unavailable', reason: 'The pictures could not be built in this browser' }; render(); };
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') { S.progress[m.band] = m.text; if (m.band === S.band) progressOnly(); return; }
      if (m.type === 'band') { S.results[m.band] = m; onResult(S.results); render(); }
      if (m.type === 'done') pub.done = m.source;
    };
    worker.postMessage({ id: Date.now(), ra, dec, api: '', bands: [S.band, ...['W2', 'W1', 'Ks'].filter(b => b !== S.band)], live });
    render();
  }

  // ---------- pieces ----------
  const bandSwitch = () => `<div class="tn-seg" role="tablist" aria-label="Wavelength">${ORDER.map(k => `<button type="button" role="tab" data-band="${k}" aria-selected="${k === S.band}">${BAND[k].um} µm</button>`).join('')}</div>`;
  function blinkBox(m) {
    if (!m) return `<div class="blink down" role="status" data-state="building"><div class="down-msg"><h3>Building the comparison</h3><p class="prog">${esc(S.progress[S.band] || 'Starting')}</p><div class="bar"><i></i></div></div></div>`;
    if (m.state === 'old-unavailable') return `<div class="blink down" role="status" data-state="old-unavailable"><div class="down-msg">${ICON.down}<h3>The old pictures are not available right now</h3><p>${esc(m.reason)}. Try again in a few minutes.</p><button type="button" class="btn-line" data-retry>${ICON.retry}Try again</button></div></div>`;
    if (m.state === 'spherex-unavailable') return `<div class="blink down" role="status" data-state="spherex-unavailable"><div class="down-msg">${ICON.down}<h3>The SPHEREx pictures are not available right now</h3><p>${esc(m.reason)}. Try again in a few minutes.</p><button type="button" class="btn-line" data-retry>${ICON.retry}Try again</button></div></div>`;
    if (m.state === 'comparison-unavailable') return `<div class="blink down" role="status" data-state="comparison-unavailable"><div class="down-msg">${ICON.down}<h3>No fair comparison in this band</h3><p>${esc(m.reason[0].toUpperCase() + m.reason.slice(1))}.</p></div></div>`;
    if (m.state === 'inconclusive') return `<div class="blink down" role="status" data-state="inconclusive"><div class="down-msg">${ICON.unsure}<h3>Inconclusive</h3><p>${esc(m.reason[0].toUpperCase() + m.reason.slice(1))}, so the two pictures cannot be compared fairly here.</p></div></div>`;
    return `<div class="blink" tabindex="0" role="img" aria-roledescription="blink" aria-label="" data-state="ok">
      <canvas class="fr" data-f="0" width="${B.CROP}" height="${B.CROP}"></canvas><canvas class="fr" data-f="1" width="${B.CROP}" height="${B.CROP}"></canvas>
      <canvas class="wide" data-w="0" width="${B.N}" height="${B.N}"></canvas><canvas class="wide" data-w="1" width="${B.N}" height="${B.N}"></canvas>
      <svg class="marks" viewBox="0 0 91 91" aria-hidden="true"><line x1="45.5" y1="34.5" x2="45.5" y2="39.3"/><line x1="45.5" y1="51.7" x2="45.5" y2="56.5"/><line x1="34.5" y1="45.5" x2="39.3" y2="45.5"/><line x1="51.7" y1="45.5" x2="56.5" y2="45.5"/></svg>
      <div class="flabel" aria-live="polite"><span class="yr"></span><span class="ln l1"></span><span class="ln l2"></span></div>
      <div class="corner l"><i class="scalebar"></i>${gl('1 arcmin', G.arcmin)}<span class="nodata" hidden><i></i>${gl('no data', G.mask)}</span></div>
      <div class="corner r">${gl(ICON.match, G.matched)}<svg class="compass" viewBox="0 0 30 30" aria-label="North up, east left"><path d="M24 24V8M24 8l-3 3M24 8l3 3M24 24H8M8 24l3-3M8 24l3 3"/><text x="22" y="5">N</text><text x="1" y="26.5">E</text></svg></div>
    </div>`;
  }
  function axis(w) {
    const t0 = 1999, t1 = 2027, x = t => ((t - t0) / (t1 - t0) * 100).toFixed(2) + '%';
    let ticks = '';
    for (let y = 2000; y <= 2026; y++) { const big = y % 5 === 0; ticks += `<i class="tick${big ? ' big' : ''}" style="left:${x(y)}">${big ? `<b${y % 10 ? ' class="minor"' : ''}>${y}</b>` : ''}</i>`; }
    return `<div class="ctl"><div class="axis"><div class="tl-line"><div class="track">${ticks}
      <button type="button" class="stop" data-to="0" style="left:${x(w.oldT)}" aria-label="Show the ${w.oldYear} picture"></button>
      <button type="button" class="stop" data-to="1" style="left:${x(w.nowT)}" aria-label="Show the SPHEREx picture"></button>
      <button type="button" class="knob" aria-label="Play or pause the blink" aria-keyshortcuts="Space">${ICON.play}${ICON.pause}</button></div></div></div></div>`;
  }
  function result(m, w) {
    const b = BAND[S.band];
    if (!m || m.state !== 'ok') {
      const say = !m ? 'Measured once both pictures load.' : m.state === 'old-unavailable' ? 'Older survey unavailable: measured once both pictures load.'
        : m.state === 'spherex-unavailable' ? 'SPHEREx unavailable: measured once both pictures load.' : m.state === 'inconclusive' ? `Inconclusive: ${m.reason}.` : `Comparison unavailable: ${m.reason}.`;
      return `<div class="res wait" data-state="${m?.state ?? 'building'}"><p class="band">${gl(b.wl, G.micron)}</p><p class="near">${esc(say)}</p></div>`;
    }
    return `<div class="res" data-state="ok"><p class="band">${gl(`${b.wl} · ${S.band}`, b.gloss)}</p><div class="big"><b>${w.show}</b><span>${gl(esc(w.word), w.wordGloss)}</span></div></div>`;
  }
  function bars() {
    const max = Math.max(2.1, ...ORDER.map(k => (S.results[k]?.state === 'ok' ? S.results[k].report.lead_ratio * 1.05 : 0)));
    return `<div class="bars">${ORDER.map(k => {
      const m = S.results[k], r = m?.state === 'ok' ? m.report.lead_ratio : null, c = k === S.band ? 'cur' : '';
      return `<span class="${c}">${BAND[k].um} µm</span><span class="base ${c}" style="--one:${(1 / max * 100).toFixed(1)}%"><i style="--w:${r === null ? 0 : (Math.max(0, r) / max * 100).toFixed(1)}%"></i></span><span class="${c}">${r === null ? '–' : `${r.toFixed(2)}×`}</span>`;
    }).join('')}</div>`;
  }
  function checks(m, w) {
    if (!m || m.state !== 'ok') return '';
    const t = trend(S.results, context), row = (icon, text, detail, pass, extra = '') =>
      `<li><button type="button" class="chk gl" data-g="${esc(detail)}">${ICON[icon]}<span>${esc(text)}</span>${pass ? ICON.ok : ICON.no}</button>${extra}</li>`;
    return `<ul class="checks">${row('stars', 'Nearby stars unchanged', w.held, true)}${row('wave', t.text, t.detail, t.pass, bars())}${row('spot', 'Same star, same spot', w.spot, true)}</ul>`;
  }
  function diffBox(m) {
    if (!m || m.state !== 'ok') return '';
    return `<details class="diffbox"><summary><span>Difference image</span>${ICON.chev}</summary>
      <div class="diff-in"><div class="dimg"><canvas data-diff width="181" height="181" role="img" aria-label="SPHEREx minus the old picture, 6 arcminutes wide"></canvas><svg class="marks" viewBox="0 0 181 181" aria-hidden="true"><line x1="90.5" y1="78" x2="90.5" y2="84"/><line x1="90.5" y1="97" x2="90.5" y2="103"/><line x1="78" y1="90.5" x2="84" y2="90.5"/><line x1="97" y1="90.5" x2="103" y2="90.5"/></svg></div>
      <div><p><span class="key"><i style="background:var(--comet)"></i>brighter now</span><span class="key"><i style="background:var(--known)"></i>dimmer</span></p>
      <p>Now minus then, 6 arcmin wide.</p><p>Rings around bright stars are not change: the two cameras blur stars slightly differently.</p></div></div></details>`;
  }
  const credits = `<details class="diffbox credits-d"><summary><span>Data credits</span>${ICON.chev}</summary><div class="credits"><p>This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration (Bock et al. 2026; spherex_dr1 and spherex_qr3, L2 l2b-v27).</p><p><b>WISE</b> UCLA and JPL/Caltech, funded by NASA (AllWISE Atlas) · <b>2MASS</b> UMass and IPAC/Caltech, funded by NASA and NSF (All-Sky Release) · <b>IRSA</b> NASA/IPAC Infrared Science Archive, funded by NASA, operated by Caltech · <b>Band curves</b> SVO Filter Profile Service</p></div></details>`;

  // ---------- render ----------
  function render() {
    const m = S.results[S.band], w = m?.state === 'ok' ? words(S.band, m, context) : null;
    const openDiff = root?.querySelector('.diffbox:not(.credits-d)')?.open, openCred = root?.querySelector('.credits-d')?.open;
    if (mode === 'page') {
      root.innerHTML = `<div class="tn-top"><h2 id="tn-h">Then and now</h2><div class="wl">${gl('Wavelength', G.micron)}${bandSwitch()}</div></div>
        <div class="tn-body"><div>${blinkBox(m)}${w ? axis(w) + '<p class="hint">Watch the marked star.</p>' : ''}</div><div>${result(m, w)}${checks(m, w)}</div></div>${diffBox(m)}${credits}`;
      if (openDiff) root.querySelector('.diffbox:not(.credits-d)')?.setAttribute('open', '');
      if (openCred) root.querySelector('.credits-d').setAttribute('open', '');
    } else {
      slots.band.innerHTML = bandSwitch();
      slots.blink.innerHTML = blinkBox(m);
      slots.ctl.innerHTML = w ? axis(w) : '';
      slots.say.innerHTML = w ? `<b>${w.show}</b>${gl(esc(w.word), w.wordGloss)}` : `<span class="res wait" data-state="${m?.state ?? 'building'}">${esc(m ? (m.state === 'ok' ? '' : m.reason || m.state) : S.progress[S.band] || 'Building the comparison')}</span>`;
      slots.facts.innerHTML = checks(m, w);
    }
    wire();
    if (m?.state === 'ok') draw(m, w);
    pub.state = m?.state ?? 'building';
    show();
  }
  function progressOnly() { const p = (mode === 'page' ? root : slots.blink).querySelector('.prog'); if (p) p.textContent = S.progress[S.band]; }

  // the frames: one shared stretch, the crop drawn from the wide frame's own pixels (an exact sub-array)
  function draw(m, w) {
    const box = (mode === 'page' ? root : slots.blink).querySelector('.blink');
    const { lo, hi } = m.report.display.stretch, wide = [m.frames.ow, m.frames.sw].map(a => B.encode(a, lo, hi));
    const drawn = { band: S.band, stretch: { lo, hi, kind: 'asinh10' }, F: m.info.F, quals: m.info.quals, smask: m.info.smask, lead_ratio: m.report.lead_ratio, masked: [] };
    wide.forEach((e, f) => {
      const cw = box.querySelector(`canvas[data-w="${f}"]`), px = B.rgba(e, B.N);
      cw.getContext('2d').putImageData(new ImageData(px, B.N, B.N), 0, 0);
      const h0 = (B.N - B.CROP) / 2, c = box.querySelector(`canvas[data-f="${f}"]`);
      c.getContext('2d').putImageData(cw.getContext('2d').getImageData(h0, h0, B.CROP, B.CROP), 0, 0);
      let n = 0; for (let y = 0; y < B.CROP; y++) for (let x = 0; x < B.CROP; x++) n += e.mask[(h0 + y) * B.N + h0 + x];
      drawn.masked.push(n);
    });
    pub.drawn = drawn;
    box.dataset.lo = lo; box.dataset.hi = hi;
    // the difference image: SPHEREx minus the old picture over the middle 6 arcmin, orange brighter, blue dimmer
    const dc = (mode === 'page' ? root : document).querySelector('[data-diff]');
    if (dc) {
      const n = 181, h0 = (B.N - n) / 2, img = new ImageData(n, n), A = Math.asinh(10), cs = getComputedStyle(document.documentElement);
      const col = (v, d) => (cs.getPropertyValue(v).trim().match(/[0-9a-f]{2}/gi) ?? d).map(h => parseInt(h, 16));
      const up = col('--comet', ['ff', '9a', '4d']), dn = col('--known', ['7f', 'b8', 'ff']);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        const k = (h0 + n - 1 - r) * B.N + h0 + c, d = m.frames.sw[k] - m.frames.ow[k], j = 4 * (r * n + c);
        if (!Number.isFinite(d)) { img.data.set([...B.MASK_RGB, 255], j); continue; }
        const v = Math.min(1, Math.asinh(Math.abs(d) / (hi - lo) * 10) / A), t = d > 0 ? up : dn;
        img.data.set([t[0] * v, t[1] * v, t[2] * v, 255], j);
      }
      dc.getContext('2d').putImageData(img, 0, 0);
    }
  }
  function show() {
    const scope = mode === 'page' ? root : slots.blink, box = scope.querySelector('.blink[data-state=ok]'), m = S.results[S.band];
    if (box && m?.state === 'ok') {
      const w = words(S.band, m, context), f = S.frame, L = f ? w.now : w.old;
      box.querySelectorAll('canvas.fr').forEach(c => c.classList.toggle('off', +c.dataset.f !== f));
      const fl = box.querySelector('.flabel');
      fl.querySelector('.yr').textContent = L.yr; fl.querySelector('.l1').innerHTML = L.l1; fl.querySelector('.l2').innerHTML = L.l2;
      box.querySelector('.nodata').hidden = !pub.drawn.masked?.[f];
      box.setAttribute('aria-label', `The same 3 arcminute patch, ${f ? `SPHEREx ${w.nowYr}` : `${BAND[S.band].oldName} ${w.oldYear}`}. The find is in the middle.`);
      box.style.setProperty('--px', box.clientWidth / B.CROP + 'px');
      box.dataset.frame = f;
    }
    const ax = (mode === 'page' ? root : slots.ctl).querySelector('.axis');
    if (ax) {
      const stop = ax.querySelector(`.stop[data-to="${S.frame}"]`);
      ax.querySelector('.knob').style.setProperty('--x', stop.style.left);
      ax.querySelector('.knob').classList.toggle('on', S.playing);
    }
  }
  function play(on) {
    S.playing = on; clearInterval(timer);
    if (on && S.active) timer = setInterval(() => { if (S.results[S.band]?.state === 'ok') { S.frame ^= 1; show(); } }, 850);
    show();
  }
  function flip() { play(false); S.frame ^= 1; show(); }
  function wire() {
    const scope = mode === 'page' ? [root] : Object.values(slots);
    for (const el of scope) {
      el.querySelectorAll('[data-band]').forEach(btn => btn.onclick = () => { S.band = btn.dataset.band; render(); });
      el.querySelectorAll('.knob').forEach(k => k.onclick = () => play(!S.playing));
      el.querySelectorAll('.stop').forEach(s => s.onclick = () => { play(false); S.frame = +s.dataset.to; show(); });
      el.querySelectorAll('.blink[tabindex]').forEach(b => b.onclick = e => { if (!e.target.closest('.gl')) flip(); });
      el.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => start(true));
      el.querySelectorAll('.tn-seg').forEach(seg => seg.onkeydown = e => {   // tabs: the arrows move between bands
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const i = (ORDER.indexOf(S.band) + (e.key === 'ArrowRight' ? 1 : 2)) % 3; S.band = ORDER[i]; render();
        (mode === 'page' ? root : slots.band).querySelector(`[data-band="${S.band}"]`)?.focus(); e.preventDefault(); e.stopPropagation();
      });
    }
  }
  // keyboard: F flips, Space plays and pauses (not in a text field, nor on a button)
  addEventListener('keydown', e => {
    if (!S.active || e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (S.results[S.band]?.state !== 'ok') return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); e.stopImmediatePropagation(); flip(); }
    else if (e.key === ' ' && !e.target.closest?.('button, summary, a')) { e.preventDefault(); e.stopImmediatePropagation(); play(!S.playing); }
  }, true);
  addEventListener('resize', show);
  tips();
  start();
  return {
    setActive(on) { S.active = on; play(on && !matchMedia('(prefers-reduced-motion: reduce)').matches); if (on) show(); },
    results: S.results,
  };
}

// ---------- gloss cards: on hover, focus or tap ----------
let tipsOn = false;
function tips() {
  if (tipsOn) return; tipsOn = true;
  const tip = document.createElement('div'); tip.id = 'tn-tip'; tip.setAttribute('role', 'tooltip'); document.body.append(tip);
  const open = el => {
    tip.textContent = el.dataset.g; tip.classList.add('on');
    const r = el.getBoundingClientRect(), w = Math.min(260, innerWidth - 24); tip.style.maxWidth = w + 'px';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), innerWidth - tw - 12) + 'px';
    let top = r.bottom + 8; if (top + th > innerHeight - 8) top = r.top - th - 8; tip.style.top = top + 'px';
    document.querySelectorAll('.gl.open').forEach(g => g.classList.remove('open')); el.classList.add('open');
  };
  const close = () => { tip.classList.remove('on'); document.querySelectorAll('.gl.open').forEach(g => g.classList.remove('open')); };
  document.addEventListener('mouseover', e => { const g = e.target.closest?.('.gl'); if (g) open(g); });
  document.addEventListener('mouseout', e => { if (e.target.closest?.('.gl')) close(); });
  document.addEventListener('focusin', e => { const g = e.target.closest?.('.gl'); g ? open(g) : close(); });
  document.addEventListener('click', e => { const g = e.target.closest?.('.gl'); if (g) { e.stopPropagation(); open(g); } else close(); }, true);
  addEventListener('wheel', close, { passive: true }); addEventListener('touchmove', close, { passive: true });
}
