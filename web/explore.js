// Explore: the all-sky map. One Mollweide projection places everything so markers, the coverage replay
// and the heat map line up with data/sky.jpg (RA increases to the left, RA 0 in the middle).
// Data: data/coverage.{png,json} (built by bake/sky_assets.py), /api/comets and /api/explored (worker/).
import { R2, RAD, wrap, fwdLon, fwd, trackAt, dayParam, dayDate, LAST_DAY, MJD0 } from './skymap.js';
// [u, v] -> [ra, dec], or null outside the oval
function inv(u, v) {
  const x = (u * 2 - 1) * 2 * R2, y = (1 - v * 2) * R2;
  if ((x / (2 * R2)) ** 2 + (y / R2) ** 2 > 1) return null;
  const th = Math.asin(y / R2), lon = Math.PI * x / (2 * R2 * Math.cos(th));
  return [((-lon / RAD) % 360 + 360) % 360, Math.asin((2 * th + Math.sin(2 * th)) / Math.PI) / RAD];
}
for (const [ra, dec] of [[0, 0], [77, 30.4], [266, -29], [181, 60], [179, -75]]) {   // projection round trip
  const [r2, d2] = inv(...fwd(ra, dec));
  console.assert(Math.abs(wrap(r2 - ra)) < 1e-3 && Math.abs(d2 - dec) < 1e-3, 'projection round trip failed', ra, dec);
}

const $ = id => document.getElementById(id);
const place = (el, ra, dec) => { const [u, v] = fwd(ra, dec); el.style.left = u * 100 + '%'; el.style.top = v * 100 + '%'; return u; };
const patchUrl = (ra, dec) => `timelapse.html?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&det=D1&diff=1`;
// a comet already found and named opens the same patch viewer, labelled Discovered (found=<its id>)
const foundUrl = (id, ra, dec) => `${patchUrl(ra, dec)}&found=${encodeURIComponent(id)}`;
const focus = new URLSearchParams(location.search).get('focus');   // ?focus=<comet>&day=<day>: "Find on map" on a comet's page
$('time').value = dayParam();
const getJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// ---- grid and ecliptic ----
{
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1); };
  let d = '';
  for (let lon = -120; lon <= 120; lon += 60) for (let dec = -90; dec <= 90; dec += 3) d += (dec === -90 ? 'M' : 'L') + P(lon, dec);
  for (let dec = -60; dec <= 60; dec += 30) d += 'M' + P(-180, dec) + 'L' + P(180, dec);
  $('grat').setAttribute('d', d);
  const eps = 23.44 * RAD, pts = [];
  for (let l = 0; l < 360; l += 2) {
    const ra = Math.atan2(Math.cos(eps) * Math.sin(l * RAD), Math.cos(l * RAD)) / RAD;
    pts.push([wrap(-ra), Math.asin(Math.sin(eps) * Math.sin(l * RAD)) / RAD]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  $('ecl').setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + P(p[0], p[1])).join(''));
}

// ---- click anywhere on the oval: drop a pin with a small card; "Look closer" opens that patch (difference view on) ----
const pin = $('pin'), readout = $('readout');
function showPin(ra, dec) {
  const u = place(pin, ra, dec), v = fwd(ra, dec)[1];
  pin.classList.toggle('left', u > 0.7);
  pin.classList.toggle('up', v > 0.62);
  pin.querySelector('[data-f=where]').textContent = `RA ${ra.toFixed(1)}\u00b0  Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}\u00b0`;
  pin.querySelector('[data-f=open]').href = patchUrl(ra, dec);
  pin.hidden = false;
  pin.querySelector('.pin-ring').style.animation = 'none'; void pin.offsetWidth; pin.querySelector('.pin-ring').style.animation = '';   // replay the drop
}
const skyAt = e => { const b = $('map').getBoundingClientRect(); return inv((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height); };
$('map').addEventListener('click', e => { const rd = skyAt(e); if (rd) showPin(...rd); });
$('map').addEventListener('pointermove', e => {   // live coordinates beside the pointer (hidden on touch by CSS)
  const rd = skyAt(e);
  readout.hidden = !rd;
  if (rd) { readout.textContent = `${rd[0].toFixed(1)}\u00b0  ${rd[1] >= 0 ? '+' : ''}${rd[1].toFixed(1)}\u00b0`; readout.style.left = e.clientX + 16 + 'px'; readout.style.top = e.clientY + 16 + 'px'; }
});
$('map').addEventListener('pointerleave', () => { readout.hidden = true; });
$('pin-x').addEventListener('click', () => { pin.hidden = true; });
addEventListener('keydown', e => { if (e.key === 'Escape') pin.hidden = true; });

// ---- markers from /api/comets: comets people found (orange) and known objects (blue) ----
// Known comets move: their marker follows the JPL path in `track` ([[day, ra, dec, magnitude], ...] every 10 days)
// and shows only while the comet is bright enough to see (magnitude 16 or brighter).
// The name of the comet opened with "Find on map" goes where it fits (measured, since names differ in length):
// right of the dot, or left when that would run past the map or the window, or, on a screen too narrow for
// either, under the dot and moved sideways until it is all in view.
function nameSide(el) {
  const b = el.querySelector('b'), map = $('map').getBoundingClientRect();
  if (!b) return;
  const lo = Math.max(map.left, 0), hi = Math.min(map.right, innerWidth);
  el.classList.remove('left', 'under'); b.style.transform = '';
  if (b.getBoundingClientRect().right <= hi) return;
  el.classList.add('left');
  if (b.getBoundingClientRect().left >= lo) return;
  el.classList.replace('left', 'under');
  const r = b.getBoundingClientRect();
  b.style.transform = `translateX(${Math.max(lo - r.left, Math.min(0, hi - r.right))}px)`;
}
const movers = [], links = [];   // links: every comet link (markers and the featured card), rewritten as the timeline moves
let cardTrack = null;   // the featured known comet's JPL path: its card follows it, with the date
function followTracks(day) {
  if (cardTrack) {
    const card = $('card-comet'), [ra, dec] = trackAt(cardTrack, day);
    card.classList.toggle('left', place(card, ra, dec) > 0.75);   // near the map's right edge the card sits to the left
    card.querySelector('[data-f=when]').textContent = `Position on ${dayDate(day, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  // a known comet's page opens on the same date; a found comet opens the patch where it is on that date, as Discovered
  // a candidate (a dot reported from a time-lapse) opens its own page, which has the time-lapse a click away
  for (const { el, id, found, track, ra, dec, candidate } of links)
    el.href = candidate ? `candidate.html?id=${encodeURIComponent(id)}` : found ? foundUrl(id, ...(track?.length ? trackAt(track, day) : [ra, dec])) : `comet.html?id=${encodeURIComponent(id)}&day=${day}`;
  for (const { el, track } of movers) {
    const [ra, dec, mag] = trackAt(track, day), bright = mag != null && mag <= 16;
    place(el, ra, dec);
    if (el.classList.contains('focus')) nameSide(el);
    // 3I/ATLAS stays findable as our measured comet, but dimmed while it is too faint to see (so does a comet
    // opened with "Find on map")
    // the rest hide, or show as a dim speck with the Faint comets layer on
    if (el.dataset.always === '1') el.classList.toggle('faint', !bright);
    else { el.hidden = !bright && !faintOn.checked; el.classList.toggle('speck', !bright); }
  }
}
// Faint comets layer: off by default, remembered in this browser (localStorage), redrawn at once when switched
const faintOn = $('ly-faint');
try { faintOn.checked = localStorage.getItem('ch.faint') === '1'; } catch { /* private mode: off */ }
faintOn.addEventListener('change', () => {
  try { localStorage.setItem('ch.faint', faintOn.checked ? '1' : '0'); } catch { /* private mode: fine */ }
  followTracks(+$('time').value);
});
let trailN = 0;
const cometsLoaded = getJson('/api/comets').then(({ comets }) => {
  const marks = $('marks'), card = $('card-comet');
  const votes = c => Object.values(c.tags || {}).reduce((a, b) => a + b, 0);
  // the card: 3I/ATLAS, our measured comet, following its JPL path. No card while a comet is being found, except a
  // candidate's ("Where it is" on its page), which says it is one
  const featured = focus ? comets.find(c => c.id === focus && c.candidate) : comets.find(c => c.id === '3I/ATLAS');
  for (const c of comets) {
    const a = document.createElement('a');
    a.className = `mk ${c.kind}`;
    if (c.id === focus && c !== featured) a.classList.add('focus'); else a.dataset.day = c.day ?? 0;   // a featured candidate's name is on its card   // the comet being found shows on any date
    a.innerHTML = '<i></i>';
    if (c.kind === 'comet') {
      a.style.setProperty('--tail', `${c.tail ?? -150}deg`);
      if (c.tags.comet / Math.max(1, votes(c)) < 0.6) a.classList.add('open');   // not settled yet: hollow marker
      if (c.candidate && votes(c) < 5) a.classList.add('open');   // a reported dot also needs 5 tags before it reads as likely
      if (c.candidate) a.setAttribute('aria-label', `${c.id} (${a.classList.contains('open') ? 'candidate' : 'likely comet'})`);
    } else a.setAttribute('aria-label', `${c.id} (known comet)`);
    if (c === featured) a.classList.add('sel');   // its name label is hidden while its card shows (styles.css)
    // comets people found open the patch viewer as Discovered (Ming); known comets open their page (main, PR #30)
    links.push({ el: a, id: c.id, found: c.kind === 'comet', track: c.track, ra: c.ra, dec: c.dec, candidate: c.candidate });   // followTracks() writes the link, with the timeline's day
    a.append(Object.assign(document.createElement('b'), { textContent: c.id }));
    if (c.kind === 'known' && c.id !== '3I/ATLAS') a.classList.add('peek');   // other known comets: name on hover
    if (c.track?.length) movers.push({ el: a, track: c.track });   // no path, or an empty one: it stays at its fixed place
    if (c.track?.length && (c.detail?.photos || c.id === '3I/ATLAS' || c.id === focus)) a.dataset.always = '1';
    if (c.kind === 'comet') {   // where it has been: a dotted trail behind the head, on the tail's side (the heading is illustrative)
      const ang = (c.tail ?? -150) * RAD, L = 70 + (c.id.charCodeAt(c.id.length - 1) % 5) * 14, bend = (c.id.charCodeAt(c.id.length - 2) % 2 ? 1 : -1) * .45;
      const ex = Math.cos(ang) * L, ey = Math.sin(ang) * L, cx = Math.cos(ang + bend) * L * .6, cy = Math.sin(ang + bend) * L * .6, gid = 'tg' + (trailN++);
      a.insertAdjacentHTML('beforeend', `<svg class="trail" aria-hidden="true"><defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"><stop offset="0" stop-color="#ff9a4d" stop-opacity="1"/><stop offset="1" stop-color="#ff9a4d" stop-opacity="0"/></linearGradient></defs><path d="M0 0Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="url(#${gid})"/></svg>`);
    }
    if (place(a, c.ra, c.dec) > 0.88) a.classList.add('left');   // label on the left only near the map's right edge
    marks.prepend(a);
  }
  if (featured) {
    links.push({ el: card, id: featured.id, found: featured.kind === 'comet', track: featured.track, ra: featured.ra, dec: featured.dec, candidate: featured.candidate });
    card.classList.add(featured.kind);   // the Comets found or Known objects layer shows or hides it with its marker (styles.css)
    card.dataset.day = featured.day ?? 0;
    card.querySelector('[data-f=id]').textContent = featured.id;
    const what = card.querySelector('[data-f=what]');
    if (featured.candidate) {   // a reported dot: candidate until 5 tags, most of them comet
      const n = votes(featured), t = featured.tags;
      what.textContent = n < 5 || t.comet / n < 0.6 ? 'candidate' : 'likely comet';
      card.querySelector('[data-f=when]').textContent = `${t.comet} of ${n} tags`;
    } else {   // its CO2 verdict, as on its page (bake/comet_spectrum.py); followTracks() places it and writes the date
      what.textContent = { detected: 'CO2 glow detected', quiet: 'No gas glow' }[featured.co2] ?? 'No clear signal';
      what.classList.add(featured.co2 === 'detected' ? 'comet' : 'unsure');
      cardTrack = featured.track?.length ? featured.track : null;   // no path (or an empty one): its fixed place, no date
    }
    if (!cardTrack) card.classList.toggle('left', place(card, featured.ra, featured.dec) > 0.75);
    card.hidden = false;
  }
  followTracks(+$('time').value);
  if (focus) { marks.append(...marks.querySelectorAll('.focus')); marks.querySelectorAll('.focus').forEach(nameSide); }   // on top of its neighbours, its name on the map
  showByDay();
}).catch(err => console.warn('comets unavailable', err));

// A click on a comet: the map zooms toward it, then the page changes and the map becomes that page's mini map
// (the shared view-transition-name "sky"). Browsers without page-to-page view transitions, and people who
// asked for less motion, follow the link as usual.
// The link is read at the click: the replay is paused and later clicks wait, so the page that opens is the one clicked.
// Clicks with a modifier key and middle clicks are left to the browser (new tab or window).
let leaving = false, stopReplay = () => {};
$('marks').addEventListener('click', e => {
  const a = e.target.closest('a[href^="comet.html"]');
  if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (leaving) return e.preventDefault();
  if (!('CSSViewTransitionRule' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  e.preventDefault();
  leaving = true; stopReplay();
  const url = a.href, stage = document.querySelector('.map-wrap'), go = () => { location.href = url; };
  stage.style.transformOrigin = `${a.style.left} ${a.style.top}`;
  stage.animate({ transform: ['none', 'scale(1.3)'] }, { duration: 200, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' }).finished.then(go, go);
});

// measured again when the window changes size, and once the map has finished scaling in (its size is off until then)
for (const [target, event] of [[window, 'resize'], [document.querySelector('.map-wrap'), 'animationend']])
  target.addEventListener(event, () => document.querySelectorAll('.mk.focus').forEach(nameSide));

// Back from a time-lapse: the browser may restore this page from memory, with the heat map from before; reload it
addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

// ---- heat map from /api/explored: patch-sized cells people have checked (mint), the rest stay dark ----
const exploredLoaded = getJson('/api/explored').then(({ cells, suggest }) => {
  const cv = $('heat'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const level = n => (n >= 20 ? 3 : n >= 5 ? 2 : 1);
  for (const c of cells) {
    const lon0 = wrap(-c.ra_max), lon1 = lon0 + (c.ra_max - c.ra_min);   // keeps a cell whole where RA wraps at 180
    g.beginPath();
    [[lon0, c.dec_max], [lon1, c.dec_max], [lon1, c.dec_min], [lon0, c.dec_min]].forEach(([l, d], k) => {
      const [u, v] = fwdLon(l, d); k ? g.lineTo(u * W, v * H) : g.moveTo(u * W, v * H);
    });
    g.closePath();
    g.fillStyle = `rgba(95,224,173,${[0, .26, .5, .82][level(c.checks)]})`; g.fill();
    g.strokeStyle = 'rgba(4,6,11,.75)'; g.lineWidth = 1.5; g.stroke();
  }
  const url = patchUrl(suggest.ra, suggest.dec), pin = document.createElement('a');
  pin.className = 'mk patch'; pin.href = url; pin.innerHTML = '<i></i><b>unexplored</b>';
  const right = place(pin, suggest.ra, suggest.dec) > 0.75;   // the suggestion can be anywhere: near the right edge, name and card go left
  pin.classList.toggle('left', right);
  $('marks').append(pin);
  const card = $('card-patch');
  place(card, suggest.ra, suggest.dec);
  card.classList.toggle('left', right);
  card.querySelector('[data-f=where]').textContent = `RA ${suggest.ra.toFixed(1)}  Dec ${suggest.dec >= 0 ? '+' : ''}${suggest.dec.toFixed(1)}`;
  card.querySelector('[data-f=open]').href = url;
}).catch(err => console.warn('explored unavailable', err));

// ---- phones: flip a name to the left of its marker when it would cover another name or dot, or run off screen ----
Promise.all([cometsLoaded, exploredLoaded]).then(() => {
  if (!matchMedia('(max-width: 640px)').matches) return;
  const box = el => el.getBoundingClientRect(), hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const marks = [...document.querySelectorAll('.mk')], dots = marks.map(m => box(m.querySelector('i'))), kept = [];
  for (const m of marks) {
    const b = m.querySelector('b');
    if (!b || !b.offsetWidth || m.classList.contains('focus')) continue;   // nameSide() places that one
    const bad = () => { const r = box(b); return r.left < 4 || r.right > innerWidth - 4 || kept.some(k => hit(r, k)) || dots.some((d, i) => marks[i] !== m && hit(r, d)); };
    if (bad()) { m.classList.toggle('left'); if (bad()) m.classList.toggle('left'); }
    kept.push(box(b));
  }
});

// ---- timeline (Homepage-2): a tick for every month SPHEREx photographed, the year under each January, ----
// the date over a round handle. The line runs from the first of the first month to the last day of data.
const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
function makeTimeline(meta, slider) {
  const DAY = 864e5, t0 = (meta.mjd0 - 40587) * DAY, start = new Date(t0), end = t0 + meta.days * DAY;
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1), span = end - from;
  const line = $('tl-line'), ticks = $('tl-ticks'), knob = $('play'), date = $('t-date');
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); Date.UTC(y, m, 1) <= end; m === 11 ? (y++, m = 0) : m++) {
    const t = document.createElement('span');
    t.className = 'tl-tick';
    t.style.left = (Date.UTC(y, m, 1) - from) / span * 100 + '%';
    t.innerHTML = `<b>${MONTHS[m]}</b>${m === 0 ? `<small>${y}</small>` : ''}`;
    ticks.append(t);
  }
  knob.setAttribute('aria-valuemax', meta.days);
  const api = {
    value: +slider.value, onScrub() {}, onPress() {},
    show(d) {   // put the handle and the date at day d
      const when = t0 + d * DAY, x = (when - from) / span * 100 + '%';
      line.style.setProperty('--x', x);
      date.textContent = new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      knob.setAttribute('aria-valuenow', d);
      knob.setAttribute('aria-valuetext', new Date(when).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
    },
  };
  const dayAt = e => { const b = line.getBoundingClientRect(); return Math.round((from + (e.clientX - b.left) / b.width * span - t0) / DAY); };
  // a press on the handle that does not move is a click (replay); any drag, or a press on the line, scrubs
  let down = null;
  $('tl').addEventListener('pointerdown', e => {
    if (e.button) return;
    down = { x: e.clientX, onKnob: knob.contains(e.target), moved: false };
    $('tl').setPointerCapture(e.pointerId);
    if (!down.onKnob) { down.moved = true; api.value = dayAt(e); api.onScrub(); }
    e.preventDefault(); knob.focus({ preventScroll: true });
  });
  $('tl').addEventListener('pointermove', e => {
    if (!down) return;
    if (!down.moved && Math.abs(e.clientX - down.x) < 4) return;
    down.moved = true; api.value = dayAt(e); api.onScrub();
  });
  const up = () => { if (down && !down.moved) api.onPress(); down = null; };
  $('tl').addEventListener('pointerup', up);
  $('tl').addEventListener('pointercancel', () => { down = null; });
  knob.addEventListener('keydown', e => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -30, PageUp: 30 }[e.key];
    if (step) { api.value = +slider.value + step * (e.shiftKey ? 7 : 1); api.onScrub(); }
    else if (e.key === 'Home') { api.value = 0; api.onScrub(); }
    else if (e.key === 'End') { api.value = meta.days; api.onScrub(); }
    else if (e.key === 'Enter' || e.key === ' ') api.onPress();
    else return;
    e.preventDefault();
  });
  return api;
}

// ---- SPHEREx coverage replay ----
// visits.png (bake/sky_assets.py): for each 0.5 degree cell, the start day of up to 6 visits (bursts of photos).
// The visit days for every pixel of the oval are looked up once, so moving the slider only compares numbers.
// Each frame: never photographed = dark; photographed = a veil that clears with each pass; any visit in the last
// FRESH days glows, so SPHEREx's scanning strip keeps moving across the sky for the whole timeline.
// SPHEREx's two deep fields, on the ecliptic poles where every scan circle crosses: the densest time-lapses and the
// most complete spectra. Numbers come from the real photo counts (bake/sky_assets.py deep_fields); a click opens one.
function deepFields(fields) {
  for (const f of fields) {
    if (!(f.sky > 0)) continue;   // no typical count to compare against
    const a = document.createElement('a'), times = Math.round(f.photos / f.sky);
    a.className = 'mk deep';
    a.href = patchUrl(f.ra, f.dec);
    a.title = `${f.name}: SPHEREx photographs here about ${times}x as often as a typical patch (${Math.round(f.photos)} photos vs ${Math.round(f.sky)}). Click to open it.`;
    a.innerHTML = '<i></i>';
    const b = document.createElement('b'); b.textContent = `Deep field ${times}x`; a.append(b);
    place(a, f.ra, f.dec);
    $('marks').append(a);
  }
}

let showByDay = () => {};
(async () => {
  const img = new Image(); img.src = 'data/visits.png';
  const [meta] = await Promise.all([getJson('data/coverage.json'), img.decode()]);   // both at once
  console.assert(meta.days === LAST_DAY && meta.mjd0 === MJD0, 'skymap.js is out of step with data/coverage.json');
  deepFields(meta.deep_fields ?? []);
  const src = Object.assign(document.createElement('canvas'), { width: 720, height: 1080 }).getContext('2d', { willReadFrequently: true });
  src.drawImage(img, 0, 0);
  const px = src.getImageData(0, 0, 720, 1080).data;

  const cv = $('cover'), g = cv.getContext('2d'), W = cv.width, H = cv.height, K = 6, NONE = 65535;
  const inOval = new Uint8Array(W * H), visits = new Uint16Array(W * H * K).fill(NONE);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const rd = inv((i + .5) / W, (j + .5) / H);
    if (!rd) continue;
    inOval[j * W + i] = 1;
    const cell = Math.min(359, Math.floor((90 - rd[1]) / meta.step)) * 720 + Math.min(719, Math.floor(rd[0] / meta.step));
    for (let v = 0; v < K; v++) {   // block v>>1 of the stacked image: visit 2k low byte in R, 2k+1 in G, high bits in B
      const q = ((v >> 1) * 360 * 720 + cell) * 4, day = px[q + (v & 1)] | (((px[q + 2] >> ((v & 1) * 4)) & 15) << 8);
      if (day) visits[(j * W + i) * K + v] = day - 1;
    }
  }

  const out = g.createImageData(W, H), o = out.data, slider = $('time'), timeline = makeTimeline(meta, slider);
  const FRESH = 9;   // days a newly photographed strip stays lit up
  showByDay = () => {
    for (const el of document.querySelectorAll('[data-day]')) el.style.visibility = +el.dataset.day <= +slider.value ? '' : 'hidden';
    followTracks(+slider.value);
  };
  const VEIL = [232, 110, 45, 0];   // darkness by passes so far: none, 1, 2, 3+
  function draw() {
    const d = +slider.value;
    for (let k = 0, q = 0; k < inOval.length; k++, q += 4) {
      if (!inOval[k]) { o[q + 3] = 0; continue; }
      let n = 0, age = Infinity;
      for (let v = 0, b = k * K; v < K; v++) {
        const t = visits[b + v];
        if (t <= d) { n++; age = Math.min(age, d - t); }
      }
      if (age < FRESH) { o[q] = 234; o[q + 1] = 241; o[q + 2] = 255; o[q + 3] = 90 * (1 - age / FRESH); }
      else { o[q] = 3; o[q + 1] = 5; o[q + 2] = 10; o[q + 3] = VEIL[Math.min(n, 3)]; }
    }
    g.putImageData(out, 0, 0);
    timeline.show(d);
    showByDay();
  }
  slider.max = meta.days;   // the handle starts on the last day, or on ?day= (set above)
  let queued = 0;   // many moves can arrive per frame while dragging: draw once per frame
  const setDay = d => { slider.value = Math.max(0, Math.min(meta.days, Math.round(d))); if (!queued) queued = requestAnimationFrame(() => { queued = 0; draw(); }); };
  draw();

  // the handle: drag to scrub, click to replay the sky filling in (click again to pause)
  let timer = 0;
  const play = $('play');
  const stop = () => { clearInterval(timer); timer = 0; play.classList.remove('on'); };
  stopReplay = stop;
  timeline.onScrub = () => { stop(); setDay(timeline.value); };
  timeline.onPress = () => {
    if (timer) return stop();
    if (+slider.value >= meta.days) setDay(0);
    play.classList.add('on');
    timer = setInterval(() => { setDay(+slider.value + 2); if (+slider.value >= meta.days) stop(); }, 40);
  };
  document.body.dataset.ready = '1';
})();
