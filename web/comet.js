// Comet page: one comet from /api/comets/:id (D1). Real comets carry measured photos and a SPHEREx spectrum
// in `detail` (bake/comet_spectrum.py); the rest carry the SPHEREx photos JPL's path crosses.
import { fwd, trackAt, trackPath, dayParam, dayDate, MJD0, RAD } from './skymap.js';
import { visitShots, knownPhoto, paint, pool } from './live/cutout.js';
const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');   // no id: the list of known comets
const MJD_UNIX = 40587, day = dayParam();   // ?day=: the date on Explore's timeline when this page was opened from the map
const date = (mjd, opts) => new Date((mjd - MJD_UNIX) * 864e5).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

function ago(ms) {
  const m = (Date.now() - ms) / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 10080) return `${Math.round(m / 1440)} d`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function talk(c) {
  const t = c.tags, n = t.comet + t.asteroid + t.glitch + t.unsure;
  $('t-head').textContent = n ? `${t.comet} of ${n} say comet` : 'No tags yet';
  if (c.kind === 'comet' && n) { $('c-verdict').textContent = t.comet / n >= .6 ? 'Likely comet' : 'Undecided'; $('c-verdict').hidden = false; }
  for (const k of ['comet', 'asteroid', 'glitch', 'unsure']) document.querySelector(`[data-t=${k}]`).textContent = t[k];
  const list = $('t-list');
  list.replaceChildren();
  for (const m of c.comments.filter(m => m.body)) list.append(comment(m));   // tags without text still count as votes
  if (!c.comments.some(m => m.body)) list.append(el('p', 'pv-info', 'Nobody has said anything yet.'));
  function comment(m) {   // one box each, as on the candidate page: name and time in his info type, the tag as his legend dot
    const box = el('article', 'pv-frame post'), who = el('p', 'pv-info');
    who.append(el('b', null, m.author), ` · ${ago(m.created_at)}`);
    const name = k => (k === 'unsure' ? 'not sure' : k), before = earlierTag(m);
    if (m.tag) { const g = el('span', 'lg', name(m.tag)); g.style.setProperty('--c', `var(--${m.tag})`); g.prepend(el('i')); who.append(g); }
    if (m.tag && before && before !== m.tag) who.append(el('span', 'was', ` (was ${name(before)})`));
    box.append(who, el('p', 'body', m.body));
    return box;
  }
  function earlierTag(m) {
    const mine = c.comments.filter(x => x.author === m.author && x.tag && x.created_at < m.created_at);
    return mine.length ? mine[mine.length - 1].tag : null;
  }
}

function photos(d) {
  const box = $('c-photos'), shots = [...d.photos].sort((a, b) => a.mjd - b.mjd);
  // the year too when the photos span more than one, so 27 Oct, 2 Jan and 9 Sep read in order
  const yr = new Set(shots.map(p => date(p.mjd, { year: 'numeric' }))).size > 1 ? { year: 'numeric' } : {};
  const items = shots.map((p, i) => {
    const f = el('figure', i === shots.length - 1 ? 'now' : '');
    const plate = el('div', 'plate pv-mini'), last = i === shots.length - 1;
    const img = el('img'); img.src = `data/comets/${d.dir ?? '3i-atlas'}/${p.file}`; img.alt = `${d.name ?? 'The comet'} on ${date(p.mjd, { day: 'numeric', month: 'short' })}`;
    const ring = el('span', last ? 'ring' : 'ring earlier'); ring.style.left = '50%'; ring.style.top = '50%';
    plate.append(img, ring);
    f.title = `${p.lam.toFixed(2)} µm`;
    f.append(plate, date(p.mjd, { day: 'numeric', month: 'short', ...yr, hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''));
    box.append(f);
    return { fig: f, src: img.src, alt: img.alt, mjd: p.mjd, ring: 'ring', label: date(p.mjd, { day: 'numeric', month: 'short', year: 'numeric' }) };
  });
  $('c-photos-panel').hidden = false;
  // it opens on the photo where the comet is brightest (the most light measured at it), then plays on in date order
  player(items, shots.reduce((b, p, k) => (p.flux > shots[b].flux ? k : b), 0));
}

// The photo strip's player: one large frame above the thumbnails, stepping through them in date order and looping,
// under the time-lapse's own timeline (patch.css .tl: a dot per photo, the date over the play/pause handle).
// Every photo is centred on the comet, so the comet holds still in the ring while the stars slide past.
// items: [{ fig, src, alt, mjd, label, ring }]; it opens on photo `start` and starts playing from there when it scrolls
// into view, except with reduced motion. Live photos (start null): each src arrives later (set), and the frame stays empty
// until open(k) names the one to open on, once all are built, so it never opens on a weak photo while a clear one loads.
// Clicking a thumbnail shows it (and pauses); arrow keys step the handle.
const PLAY_MS = 600;
function player(items, start = null) {
  const N = items.length, wrap = el('div', 'player');
  wrap.innerHTML = `<div class="pv-mini big"><img alt=""><span class="ring" style="left:50%;top:50%"></span></div>
    <div class="tl"><div class="tl-line"><div class="tl-dots" aria-hidden="true"></div><output class="tl-date">&nbsp;</output>
    <button class="tl-knob" type="button" role="slider" aria-label="Photo. Paused; press to play the photos in turn, arrow keys step." aria-valuemin="0" aria-valuemax="${N - 1}" aria-valuenow="0">
    <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 5.5v13L6 12z"/></svg>
    <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1"/><rect x="13.4" y="6" width="3.6" height="12" rx="1"/></svg>
    </button></div></div>`;
  $('c-photos-panel').prepend(wrap);
  const [img, ring, line, knob, out] = ['img', '.ring', '.tl-line', '.tl-knob', '.tl-date'].map(q => wrap.querySelector(q));
  const t0 = items[0].mjd, span = items[N - 1].mjd - t0, pos = m => (span ? 4 + 92 * (m - t0) / span : 50) + '%';
  for (const it of items) { const d = el('i', 'tl-visit'); d.style.left = pos(it.mjd); wrap.querySelector('.tl-dots').append(d); }
  let i = -1, timer = null, touched = false, inView = false, wait = start == null;
  ring.style.visibility = 'hidden';   // no ring over an empty frame
  const go = k => {
    const it = items[k];
    if (!it.src) return;
    i = k; img.src = it.src; img.alt = it.alt; ring.className = it.ring; ring.style.visibility = '';
    line.style.setProperty('--x', pos(it.mjd)); out.textContent = it.label;
    const h = out.offsetWidth / 2;   // the date stays over the handle, but never past the line's ends (a phone's first photo)
    out.style.left = `clamp(${h}px, ${pos(it.mjd)}, calc(100% - ${h}px))`;
    knob.setAttribute('aria-valuenow', k); knob.setAttribute('aria-valuetext', `Photo ${k + 1} of ${N}, ${it.label}`);
    items.forEach((x, n) => x.fig.classList.toggle('on', n === k));
    wrap.dataset.i = k;
  };
  const step = s => { for (let n = 1; n <= N; n++) { const k = (((i + s * n) % N) + N) % N; if (items[k].src) return go(k); } };
  const play = on => {
    touched = true;
    clearInterval(timer); timer = on ? setInterval(() => step(1), PLAY_MS) : null; knob.classList.toggle('on', on); wrap.dataset.playing = on ? '1' : '';
    knob.setAttribute('aria-label', on ? 'Photo. Playing; press to pause, arrow keys step.' : 'Photo. Paused; press to play the photos in turn, arrow keys step.');
  };
  knob.addEventListener('click', () => play(!timer));
  knob.addEventListener('keydown', e => {
    const s = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (s) { e.preventDefault(); play(false); step(s); }
  });
  items.forEach((it, k) => it.fig.addEventListener('click', () => { if (it.src) { play(false); go(k); } }));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  new IntersectionObserver((es, o) => { if (es.some(e => e.isIntersecting)) { o.disconnect(); inView = true; if (!calm && !wait) play(true); } }).observe(wrap);
  if (!wait) go(start);
  return {
    set(k, src) { items[k].src = src; },   // a live photo is built: its thumbnail can be clicked
    open(k) { wait = false; if (touched || !items[k]?.src) return; go(k); if (inView && !calm) play(true); },
  };
}

// A badge by the title only when the measurement is clear: "detected" or "quiet" (bake/comet_spectrum.py co2_verdict)
function co2Badge(state) {
  const text = { detected: 'CO2 glow detected', quiet: 'No gas glow' }[state];
  if (!text) return;
  const b = el('span', `pv-info lg co2 ${state}`, text);   // his legend dot: orange for a glow, grey for none
  b.style.setProperty('--c', state === 'detected' ? 'var(--comet)' : '#aeb6c6'); b.prepend(el('i'));
  b.title = state === 'detected' ? 'SPHEREx sees extra light at 4.26 µm, where carbon dioxide gas glows'
    : 'The comet is clearly seen, with no extra light at 4.26 µm';
  $('c-cat').after(b);
}

function measures(d) {
  const m = $('c-measures');
  m.querySelector('[data-f=speed]').textContent = d.speed_arcsec_per_hour;
  m.querySelector('[data-f=dir]').textContent = d.direction[0].toUpperCase() + d.direction.slice(1);
  m.querySelector('[data-f=first]').textContent = date(d.first_mjd, { day: 'numeric', month: 'short', year: 'numeric' });
  m.querySelector('[data-f=n]').textContent = d.exposures;
  m.hidden = false;
}

// Measured points with their noise, plus a running median per month. Wavelength axis is linear, 0.75-5 um.
function spectrum(d) {
  const svg = $('spec'), NS = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };
  const months = Object.entries(d.spectrum).filter(([, pts]) => pts.length);
  const all = months.flatMap(([, p]) => p);
  // Compressed brightness axis (asinh, linear near zero): December's coma is ~20x brighter than August's,
  // and a straight axis would flatten August to a line. Noise around zero stays readable either way.
  const S = 5, h = f => Math.asinh(f / S), top = h(Math.max(...all.map(p => p.flux)) * 1.15), bottom = h(Math.min(0, ...all.map(p => p.flux)));
  // draw at about the screen's width so the 11-unit text stays readable on a phone (desktop keeps 900);
  // the panel must be visible first, or its width reads as 0
  $('c-spec-panel').hidden = false;
  const W = Math.round(Math.min(900, Math.max(380, svg.clientWidth * 1.15)));
  svg.setAttribute('viewBox', `0 0 ${W} 250`);
  const X0 = 52, X1 = W - 10, Y0 = 30, Y1 = 214;
  const sx = l => X0 + (l - .75) / 4.25 * (X1 - X0), sy = f => Y1 - (Math.min(top, Math.max(bottom, h(f))) - bottom) / (top - bottom) * (Y1 - Y0);
  add('rect', { class: 'band', x: sx(4.20), y: Y0, width: sx(4.32) - sx(4.20), height: Y1 - Y0 });
  for (const l of [1, 2, 3, 4, 5]) { add('line', { class: 'grid', x1: sx(l), x2: sx(l), y1: Y0, y2: Y1 }); add('text', { x: sx(l), y: Y1 + 20, 'text-anchor': 'middle' }, `${l} µm`); }
  for (const t of [0, 10, 100, 1000].filter(t => h(t) <= top)) {
    add('line', { class: 'grid', x1: X0, x2: X1, y1: sy(t), y2: sy(t) });
    add('text', { x: X0 - 8, y: sy(t) + 4, 'text-anchor': 'end' }, t ? `${t} mJy` : '0');
  }
  const legend = $('c-legend');
  // the month that carries the CO2 verdict is orange and solid; every other month is pale and dashed
  const key = (Object.entries(d.co2 ?? {}).find(([, v]) => v.state === d.co2_verdict && v.state !== 'unclear') ?? months[0])[0];
  months.forEach(([month, pts]) => {
    const hl = month === key, k = hl ? 0 : 1, cls = hl ? 'curve' : 'rock';
    for (const p of pts) {
      add('line', { class: `err m${k}`, x1: sx(p.lam), x2: sx(p.lam), y1: sy(p.flux - p.err), y2: sy(p.flux + p.err) });
      add('circle', { class: `m${k}`, cx: sx(p.lam), cy: sy(p.flux), r: 2.2 }).append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${p.lam.toFixed(3)} µm: ${p.flux.toFixed(1)} ± ${p.err.toFixed(1)} mJy` }));
    }
    const line = [];   // running median in 0.1 um steps
    for (let l = .75; l <= 5; l += .1) {
      const v = pts.filter(p => Math.abs(p.lam - l) <= .08).map(p => p.flux).sort((a, b) => a - b);
      if (v.length) line.push([sx(l), sy(v[v.length >> 1])]);
    }
    add('path', { class: cls, d: line.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('') });
    const s = el('span'), i = el('i');
    if (!hl) i.className = 'pale';
    s.append(i, new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
    legend.append(s);
  });
  // where each gas would glow, as guides along the top: a label here marks a wavelength, not a detection
  // (the CO2 badge by the title is the verdict; bake/comet_spectrum.py has the rule)
  for (const [l, name] of [[4.26, 'Carbon dioxide'], [2.7, 'Water']]) {
    add('text', { class: 'lab', x: sx(l), y: Y0 - 12, 'text-anchor': 'middle' }, name);
    add('text', { x: sx(l), y: Y0 + 2, 'text-anchor': 'middle' }, `${l} µm`);
  }
  // what the CO2 band measured, in a few words (the badge by the title gives the verdict; bake/comet_spectrum.py has the rule)
  const v = d.co2 && Object.values(d.co2), best = v && (v.find(x => x.state === d.co2_verdict) ?? v[0]);
  const co2 = !best ? '' : best.state === 'unclear' ? ' · CO2 band: not enough signal to tell'
    : ` · CO2 band ${best.excess >= 0 ? '+' : ''}${best.excess} ± ${best.sigma} mJy over nearby light`;
  $('c-spec-note').textContent = `${all.length} SPHEREx measurements${co2}`;
  co2Badge(d.co2_verdict);
  $('c-spec-panel').hidden = false;
}

// "Where it is": the comet on the all-sky picture, placed exactly as Explore places it (skymap.js). A comet with a
// JPL path shows the path, its place on `day` and that date; one without keeps its fixed place.
// "Find on map" opens Explore on the same day with this comet picked out.
function where(c) {
  const at = trackAt(c.track, day), [ra, dec] = at ?? [c.ra, c.dec], [u, v] = fwd(ra, dec), dot = $('c-mini-dot');
  dot.style.left = u * 100 + '%'; dot.style.top = v * 100 + '%'; dot.hidden = false;
  $('c-where').textContent = `RA ${ra.toFixed(1)}\u00b0   Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}\u00b0`;
  if (at) {
    $('c-when').textContent = dayDate(day, { month: 'short', day: 'numeric', year: 'numeric' });
    $('c-mini-path').setAttribute('d', trackPath(c.track));
  }
  const find = $('c-find');
  find.href = `explore.html?day=${day}&focus=${encodeURIComponent(c.id)}`;
  find.hidden = false;
}

// A known comet from JPL's catalog: when SPHEREx photographed it (matched to the survey's photo outlines),
// each with a link that opens that patch on that date. Its spectrum is not measured yet.
function known(c) {
  const shots = c.detail.spherex, box = $('c-empty');
  const first = box.querySelector('.actions');   // the new lines go above the button
  box.insertBefore(el('h2', null, shots.length ? `SPHEREx photographed it ${shots.length} times` : 'Not in a SPHEREx photo yet'), first);
  // one link per visit (photos less than 5 days after the previous one are one visit), on the visit's photo the strip
  // below shows: the time-lapse opens on that visit, centred on where the comet was, with that spot ringed
  const picks = visitShots(shots), list = el('div', 'visits');
  for (const v of picks) {   // each photo carries the comet's exact position at that moment (bake/known_comets.py)
    const a = el('a', 'visit', date(MJD0 + v.day, { day: 'numeric', month: 'short', year: 'numeric' }));
    a.href = `timelapse.html?ra=${v.ra.toFixed(4)}&dec=${v.dec.toFixed(4)}&det=D1&t=${(MJD0 + v.day).toFixed(4)}`;
    a.title = `Open the time-lapse on this visit, centred on where it was (RA ${v.ra.toFixed(2)}, Dec ${v.dec.toFixed(2)})`;
    list.append(a);
  }
  if (picks.length) knownPhotos(c, picks);
  box.insertBefore(list, first); box.insertBefore(el('p', 'pv-info', 'Known comet from JPL. Its spectrum is not measured yet.'), first);
  if (c.detail.faint) box.insertBefore(el('p', 'pv-info', `Predicted too faint to see clearly in SPHEREx photos (brightest magnitude ${c.detail.mag_in_photo ?? 'unknown'} while photographed).`), first);
  box.hidden = false;
}

// A known comet's photos, built here from NASA's SPHEREx images (live/cutout.js): one per visit, centred on JPL's
// position for that exposure, so the comet (if SPHEREx sees it) sits in the ring and the stars move. Each photo says
// whether the comet is there: its light at the ring minus the same spot's light in photos without it (SNR 5 or more
// is "Seen"). Built when the strip scrolls into view, two photos at a time.
const magAt = (mags, d) => mags?.length ? mags.reduce((b, m) => (Math.abs(m[0] - d) < Math.abs(b[0] - d) ? m : b))[1] : null;
function knownPhotos(c, picks) {
  const box = $('c-photos'), panel = $('c-photos-panel'), note = el('p', 'pv-info frames-note', 'Building the photos from NASA\u2019s SPHEREx images\u2026');
  const yr = new Set(picks.map(s => date(MJD0 + s.day, { year: 'numeric' }))).size > 1 ? { year: 'numeric' } : {};
  const items = picks.map(s => {
    const fig = el('figure'), plate = el('div', 'plate pv-mini'), cv = el('canvas'), ringEl = el('span', 'ring earlier'), vis = el('span', 'pv-info vis', '\u00a0');
    ringEl.style.left = ringEl.style.top = '50%'; plate.append(cv, ringEl);
    const label = date(MJD0 + s.day, { day: 'numeric', month: 'short', ...yr });
    fig.append(plate, label, vis); box.append(fig);
    return { fig, cv, ringEl, vis, s, mjd: MJD0 + s.day, label: date(MJD0 + s.day, { day: 'numeric', month: 'short', year: 'numeric' }), alt: `${c.id} on ${label}`, ring: 'ring earlier' };
  });
  // said once, under the strip, when a photo had a star's saturated centre filled in (live/cutout.js paint)
  const cores = el('p', 'pv-info cores', 'Bright star centres are filled in: SPHEREx saturates there.');
  cores.hidden = true;
  panel.append(note, cores); panel.hidden = false;
  const pl = player(items);
  let started = false;
  new IntersectionObserver(async (es, o) => {
    if (started || !es.some(e => e.isIntersecting)) return;
    started = true; o.disconnect();
    let done = 0;
    await pool(items, 2, async (it, k) => {
      try {
        const p = await knownPhoto(it.s), mag = magAt(c.detail.mags, it.s.day);
        if (paint(it.cv, p)) cores.hidden = false;
        Object.assign(it.fig.dataset, { verdict: p.verdict, snr: p.snr == null ? '' : p.snr.toFixed(1), ra: it.s.ra, dec: it.s.dec });
        // fewer comparison photos than wanted (one failed to load, or few at this wavelength): the number is less sure
        it.vis.textContent = p.verdict === 'seen' ? `Seen \u00b7 SNR ${Math.round(p.snr)}${p.few ? ' \u00b7 less sure' : ''}`
          : p.verdict === 'faint' ? `Too faint${mag ? ` \u00b7 mag ${mag.toFixed(1)}` : ''}` : 'Cannot measure';
        it.fig.title = p.snr == null ? `Not measured: ${p.why}` : `SNR ${p.snr.toFixed(1)} at the ring, after taking away what the same spot shows at the same wavelength in ${p.refs} photo${p.refs === 1 ? '' : 's'} without the comet${p.few ? ' (less sure: fewer photos to compare with)' : ''}${mag ? `; JPL magnitude ${mag.toFixed(1)}` : ''}`;
        if (p.few) it.fig.dataset.few = '1';
        it.ring = it.ringEl.className = p.verdict === 'seen' ? 'ring' : 'ring earlier';
        pl.set(k, it.cv.toDataURL()); it.mag = mag;
      } catch (e) { it.vis.textContent = 'Photo unavailable'; it.fig.dataset.verdict = 'error'; console.warn(e); }
      note.textContent = `Built ${++done} of ${items.length} photos\u2026`;
    });
    const count = v => items.filter(it => it.fig.dataset.verdict === v).length, seen = count('seen'), faint = count('faint'), n = items.length;
    const ms = items.map(it => magAt(c.detail.mags, it.s.day)).filter(m => m != null), lo = Math.min(...ms).toFixed(1), hi = Math.max(...ms).toFixed(1);
    // "could not see" only from measured visits: a photo that failed or could not be measured says nothing about brightness
    note.textContent = seen ? `Seen in ${seen} of ${n} visit${n === 1 ? '' : 's'}: light in the ring at SNR 5 or more, once the stars there are taken away.`
      : !faint ? `These photos could not be measured.`
      : `SPHEREx could not see it in ${faint < n ? `${faint} of ${n} visits` : n === 1 ? 'this visit' : 'any visit'}${ms.length ? ` (JPL magnitude ${lo === hi ? lo : `${lo} to ${hi}`})` : ''}. The ring shows where JPL says it was.`;
    // the player opens on the clearest photo: the highest SNR where it is seen, else where JPL has it brightest
    const best = (v, f) => items.reduce((b, it) => (it.fig.dataset.verdict === v && (b < 0 || f(it) > f(items[b])) ? items.indexOf(it) : b), -1);
    pl.open(seen ? best('seen', it => +it.fig.dataset.snr) : best('faint', it => -(it.mag ?? 99)));
  }).observe(panel);
}

// The API's rule for names; a stored name that breaks it (e.g. "Zoë") falls back to the nickname field
const NAME = /^[A-Za-z0-9 _.-]{1,24}$/;
let nameRefused = false;   // set when the API refused the stored name
function userName() {
  let n = window.CH_USER?.name;
  if (!n) try { n = JSON.parse(localStorage.getItem('ch.user'))?.name; } catch {}
  n = typeof n === 'string' ? n.trim() : '';
  return !nameRefused && NAME.test(n) ? n : null;
}

function composer(c) {
  const form = document.querySelector('.composer'), text = form.querySelector('textarea'), nick = form.querySelector('.nick');
  const btn = form.querySelector('button'), note = $('c-note'), hint = note.textContent;
  let submitting = false;
  const sync = () => {
    nick.hidden = !!userName();
    for (const x of form.elements) if (x.tagName === 'INPUT') x.disabled = submitting;   // the tag rows too (form="c-compose")
    text.readOnly = submitting;
    btn.disabled = submitting || !text.value.trim() || (!nick.hidden && !nick.value.trim());
  };
  const say = (msg, err) => { note.textContent = msg; note.classList.toggle('err', !!err); };
  text.addEventListener('input', sync); nick.addEventListener('input', sync);
  window.addEventListener('ch:user', () => { nameRefused = false; sync(); });
  sync();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    const token = window.turnstile?.getResponse() || form.querySelector('[name=cf-turnstile-response]')?.value;
    if (!token) return say('One moment, checking you are human…', true);
    const sent = text.value, tag = form.elements.tag.value;
    const stored = userName(), author = stored || nick.value.trim();
    submitting = true; sync();
    try {
      const r = await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comet_id: c.id, body: sent, author, turnstile: token, ...(tag ? { tag } : {}) }) });
      const out = await r.json().catch(() => ({}));
      if (r.status === 400 && out.field === 'author' && stored) nameRefused = true;   // show the nickname field instead
      if (!r.ok) throw new Error(out.error || `Could not post (${r.status})`);
      c.comments.push(out.comment); c.tags = out.tags;
      talk(c);
      if (text.value === sent) { text.value = ''; form.elements.tag.forEach(x => { x.checked = false; }); }
      say(hint);
    } catch (err) {
      say(err.message, true);
    } finally {
      window.turnstile?.reset();   // a token works once
      submitting = false; sync();
    }
  });
}

// The Comets tab: every known comet SPHEREx photographed, in four groups by result: CO2 glow, No clear signal, Could be
// measured and Too faint (folded). One element per comet (item()); styles.css lays it out as a square tile on a phone
// when it has a photo, and as a dense row otherwise. A photo is the measured comet's brightest, or for the others the
// clearest photo SPHEREx saw it in (bake/known_thumbs.py), both as GET /api/comets `thumb`. Search and the filter row
// change every group; a search opens Too faint when it matches there.
const GROUP = c => (c.co2 === 'detected' ? 'c' : c.co2 ? 'u' : c.faint ? 'f' : 'o');
const BADGE = { c: ['co2', 'CO2'], u: ['flat', 'no signal'], o: ['open', 'not measured'], f: ['faint', 'too faint'] };
// regions as on Forums (forums.js): north/south by Dec, near the ecliptic within 15 degrees of it; here at the comet's place on `day`
const eclLat = (ra, dec) => Math.asin(Math.sin(dec * RAD) * Math.cos(23.44 * RAD) - Math.cos(dec * RAD) * Math.sin(23.44 * RAD) * Math.sin(ra * RAD)) / RAD;
const REGION = { north: ([, dec]) => dec >= 0, south: ([, dec]) => dec < 0, ecliptic: ([ra, dec]) => Math.abs(eclLat(ra, dec)) < 15 };
const byPhotos = (a, b) => (b.photos ?? 0) - (a.photos ?? 0);
const SORT = {   // "Result": a CO2 glow first; then, and in the other groups, the most photographed first
  '': (a, b) => (b.co2 === 'detected') - (a.co2 === 'detected') || byPhotos(a, b),
  photos: byPhotos,
  name: (a, b) => a.id.localeCompare(b.id),
};
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>';

function item(c, href) {   // Ming's round white arrow on the right; the photo in a ring (orange for a CO2 glow)
  const k = GROUP(c), [g, tag] = BADGE[k], a = el('a', `it k-${g}${c.thumb ? ' has' : ''}`), ph = el('span', 'ph'), t = el('span', 't'), go = el('span', 'go');
  a.href = href; a.dataset.id = c.id; if (c.co2) a.dataset.co2 = c.co2;
  if (c.thumb) { const img = el('img'); img.src = c.thumb; img.alt = ''; img.decoding = 'async'; if (k === 'f') img.loading = 'lazy'; ph.append(img); }
  else ph.append(el('i', `g g-${g}`));   // no photo: an empty ring with the group's glyph
  const b = el('span', 'badge'); b.append(el('i', `g g-${g}`), tag); ph.append(b);   // the tile's corner badge (phone)
  t.append(el('b', null, c.id));
  if (k === 'c') t.append(el('i', 'g g-co2'));
  go.innerHTML = ARROW;
  const tx = el('span', 'tx'); tx.append(t, el('span', 's', `${c.photos ?? 0} photos`));
  a.append(ph, tx, go);
  return a;
}

function list() {
  for (const e of document.querySelectorAll('.comet-head, .comet-grid, .comet-side')) e.hidden = true;
  document.querySelector('main').classList.add('comets');
  $('c-list').hidden = false;
  document.title = 'Comets · Trailblazer';
  // each select's box shows its chosen option's text (the select itself is see-through on top)
  const label = s => { s.parentNode.querySelector('.v').textContent = s.selectedOptions[0].textContent; };
  fetch('/api/comets').then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(({ comets }) => {
    const known = comets.filter(c => c.kind === 'known' && c.real).map(c => ({ ...c, at: trackAt(c.track, day) ?? [c.ra, c.dec] }));
    const href = c => `comet.html?id=${encodeURIComponent(c.id)}&day=${day}`;
    const faint = $('s-f');
    let asked = false;   // Too faint as the visitor left it; a search opens it while it matches there, then puts it back
    faint.querySelector('summary').addEventListener('click', () => { asked = !faint.open; });
    const render = () => {
      const q = $('l-q').value.trim().toLowerCase(), region = REGION[$('l-region').value], sort = SORT[$('l-sort').value];
      const shown = known.filter(c => (!q || c.id.toLowerCase().includes(q)) && (!region || region(c.at))).sort(sort);
      for (const k of 'cuof') {
        const s = $(`s-${k}`), items = shown.filter(c => GROUP(c) === k);
        s.querySelector('.n').textContent = items.length;
        s.hidden = !items.length;
        (k === 'f' ? s.querySelector('.rows') : s).replaceChildren(...(k === 'f' ? [] : [s.querySelector('.sec')]), ...items.map(c => item(c, href(c))));
      }
      const top = shown.filter(c => GROUP(c) !== 'f').length;
      $('s-all').querySelector('.n').textContent = top; $('s-all').hidden = !top;
      faint.open = q ? !faint.hidden : asked;
      $('l-none').hidden = shown.length > 0;
      $('l-status').textContent = shown.length ? `${shown.length} comet${shown.length === 1 ? '' : 's'}` : 'No comets match.';
    };
    for (const k of ['l-region', 'l-sort']) { label($(k)); $(k).addEventListener('input', e => label(e.target)); }
    for (const k of ['l-q', 'l-region', 'l-sort']) $(k).addEventListener('input', render);
    render();
  }).catch(err => { $('l-none').textContent = $('l-status').textContent = 'Comets are unavailable right now.'; $('l-none').hidden = false; console.warn(err); });
}

if (!id) list();
else fetch(`/api/comets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(c => {
  if (c.candidate) return location.replace(`candidate.html?id=${encodeURIComponent(c.id)}`);   // a dot reported from a time-lapse has its own page
  document.title = `${c.id} · Trailblazer`;
  $('c-id').textContent = c.id;
  $('c-cat').querySelector('span').textContent = c.kind === 'known' ? (c.detail?.photos ? 'Known comet · measured by SPHEREx' : 'Known comet · JPL catalog') : 'Not in any catalog';
  where(c);
  if (c.detail?.photos) { photos(c.detail); measures(c.detail); spectrum(c.detail); }
  else if (c.detail?.spherex) known(c);
  talk(c);
  composer(c);
}).catch(err => {   // a 404 is a wrong name; anything else is the network or the database
  console.warn(err);
  $('c-id').textContent = err === 404 ? 'Comet not found' : 'Could not load this comet';
  $('c-cat').hidden = true;
  for (const e of document.querySelectorAll('.comet-grid, .comet-side')) e.hidden = true;   // no empty tallies or comment form for a comet that is not there
  const p = el('p', 'pv-frame pv-info missing'), a = el('a', null, 'See all comets');
  a.href = 'comet.html';
  p.append(err === 404 ? 'There is no comet by that name. ' : 'Try again in a moment. ', a);
  document.querySelector('.comet-head').after(p);
});
