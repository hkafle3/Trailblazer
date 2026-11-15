// Explore on phones (max-width 640px), direction A "full-screen map": the map is the page.
// One finger pans, two fingers zoom around their midpoint, a double tap zooms in, the wheel zooms too.
// The pan and zoom engine (W, X, Y, set, zoomAt, glide, the limits) is explore-view.js, shared with desktops.
// A tap on a marker opens a peek sheet instead of leaving the page; Layers and Examples open as bottom sheets.
// Desktop is untouched: every handler checks `phone` first, and leaving the phone width clears what this file set.
import { fwd, trackAt, dayDate } from './skymap.js';
import { W, X, Y, A, MAXW, hooks, measure, set, zoomAt, move, place, win, onView, atMin, glide, glideZoom, cancel } from './explore-view.js';
import { restore } from './explore-dive.js';   // back from a time-lapse, or a reload: the map where it was

const phone = matchMedia('(max-width: 640px)');
const $ = id => document.getElementById(id);
const stage = document.querySelector('.xstage'), wrap = document.querySelector('.map-wrap');
const sheet = $('csheet'), hint = $('maphint'), whole = $('whole'), HEAD = 60;
export { hooks };   // explore.js sets stop: a first touch on the map stops the replay

let touched = false;
// whole sky: the oval exactly as wide as the screen. The comet sheet's top is the bottom edge while it is open
const area = () => { const h = innerHeight, bar = $('tl').getBoundingClientRect().height; return { w: innerWidth, t: HEAD, b: h - bar, min: innerWidth, inset: sheetH }; };
const minW = () => A.min;
const sheetH = () => (sheet.hidden ? 0 : sheet.dataset.detent === 'full' ? Math.min(sheet.scrollHeight, A.b - 150) : 136);   // the comet sheet's height once it settles

onView(() => {   // after every pan and zoom: the whole-sky button, the zoom note, names placed again
  if (!phone.matches) return;
  whole.classList.toggle('on', atMin());
  $('zoomlvl').hidden = !atMin() || !hint.hidden;
  declutterSoon();
});
// the default view: the oval as tall as the space between the hint and the buttons, centred on [u] (3I/ATLAS once known)
let homeU = .5;
const homeView = () => { const H = A.b - A.t - 56, w = Math.min(MAXW, Math.max(minW(), 2 * H)); return [w, A.w / 2 - homeU * w, A.t + 56]; };
const wholeView = () => [minW(), 0, (A.t + A.b) / 2 - minW() / 4];
const focus = new URLSearchParams(location.search).get('focus');   // "Find on map": open on the whole sky, the comet's name in view

function start() {
  measure(area());
  if (focus) set(...wholeView()); else if (!restore()) set(...homeView());
  try { if (!localStorage.getItem('ch.maphint')) hint.hidden = false; } catch { hint.hidden = false; }
  $('zoomlvl').hidden = !atMin() || !hint.hidden;
}
function stop() {   // back to a desktop width: hand everything back to the desktop CSS
  for (const p of ['width', 'left', 'top']) wrap.style[p] = '';
  wrap.classList.remove('deep-zoom');
  pts.clear();   // a pinch still on the screen must not move the desktop's map
  closePeek();
  document.querySelectorAll('.mk.nm-off').forEach(m => m.classList.remove('nm-off'));
}

function hideHint() {
  if (hint.hidden || hint.classList.contains('out')) return;
  try { localStorage.setItem('ch.maphint', '1'); } catch { /* private mode: it shows again next time */ }
  hint.classList.add('out'); setTimeout(() => { hint.hidden = true; $('zoomlvl').hidden = !atMin(); }, 400);
}

// ---- gestures: pointers tracked in a Map. Listening on the window (no pointer capture) keeps clicks on their targets ----
const pts = new Map();
let last = null, moved = 0, many = false, downAt = 0, lastTap = null, swallowUntil = 0;
const snap = () => { const p = [...pts.values()], m = [(p[0][0] + (p[1] ?? p[0])[0]) / 2, (p[0][1] + (p[1] ?? p[0])[1]) / 2]; return { m, d: p[1] ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0 }; };
stage.addEventListener('pointerdown', e => {
  if (!phone.matches || e.target.closest('.tl') || (e.pointerType === 'mouse' && e.button)) return;
  cancel(); hooks.stop(); hideHint(); measure(area());
  if (!pts.size) { moved = 0; many = false; downAt = performance.now(); }
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size > 1) many = true;
  last = snap();
});
addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  const [px, py] = pts.get(e.pointerId);
  moved += Math.hypot(e.clientX - px, e.clientY - py);
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  const now = snap(), f = last.d && now.d ? now.d / last.d : 1;
  // pan by the midpoint's move, then scale by the change in finger distance around the new midpoint
  move(f, last.m[0], last.m[1], now.m[0], now.m[1]);
  last = now; touched = true;
});
function up(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (pts.size) { last = snap(); return; }
  if (moved >= 8 || many) { swallowUntil = performance.now() + 500; lastTap = null; if (atMin()) glide(...wholeView(), 200); return; }
  const t = performance.now(), here = [e.clientX, e.clientY];
  if (lastTap && t - lastTap.t < 320 && Math.hypot(here[0] - lastTap.p[0], here[1] - lastTap.p[1]) < 30) {   // double tap: zoom in 2x there
    lastTap = null; swallowUntil = t + 500;
    glideZoom(2, here[0], here[1], 250);
    touched = true;
  } else lastTap = { t, p: here };
}
addEventListener('pointerup', up);
addEventListener('pointercancel', up);
// a drag, a pinch or the second tap of a double tap is not a click; a tap on the sky while a sheet is open just closes it
stage.addEventListener('click', e => {
  if (!phone.matches) return;
  if (performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); return; }
  if (!sheet.hidden && !e.target.closest('.mk, .pin, .tl')) { closePeek(); e.stopPropagation(); }
}, true);
stage.addEventListener('wheel', e => {   // a trackpad or mouse on a narrow window
  if (!phone.matches) return;
  e.preventDefault(); measure(area()); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .002)), e.clientX, e.clientY); touched = true;
}, { passive: false });
document.addEventListener('gesturestart', e => { if (phone.matches) e.preventDefault(); });   // Safari: never zoom the page itself

whole.addEventListener('click', () => { measure(area()); touched = true; glide(...(atMin() ? homeView() : wholeView())); });

// ---- names: the way map apps place them. The picked marker first, then the featured comet, comets people found, the
// unexplored patch, deep fields, then known comets. A name goes right of its dot, else left, else it is dropped when it
// would leave the screen or cover a name already placed or another dot. Computed from W, X, Y without reading layout,
// so it can run while the replay moves the comets. Space Mono is monospaced: a name is 0.6em per letter. ----
let dq = 0;
function declutterSoon() { if (!dq) dq = setTimeout(() => { dq = 0; declutter(); }, 120); }
function declutter() {
  if (!phone.matches || !A) return;
  const rank = m => (m.classList.contains('pick') ? 0 : m.classList.contains('sel') ? 1 : m.classList.contains('focus') ? 1 : m.classList.contains('comet') ? 2 : m.classList.contains('patch') ? 3 : m.classList.contains('deep') ? 4 : 5);
  const marks = [...document.querySelectorAll('#marks .mk')].filter(m => !m.hidden && m.style.visibility !== 'hidden' && getComputedStyle(m).display !== 'none');
  const at = m => win(parseFloat(m.style.left) / 100, parseFloat(m.style.top) / 100);
  const dots = marks.map(m => { const [x, y] = at(m), r = m.classList.contains('deep') ? 6 : 5; return [x - r, y - r, x + r, y + r, m]; });
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const placed = [], out = new Map();
  for (const m of marks.sort((a, b) => rank(a) - rank(b))) {
    const b = m.querySelector('b'), [x, y] = at(m);
    if (!b) continue;
    const must = rank(m) <= 1, w = b.textContent.length * 7.2, o = m.classList.contains('deep') ? 18 : m.classList.contains('patch') ? 16 : 12;
    const box = left => (left ? [x - o - w, y - 8, x - o, y + 8] : [x + o, y - 8, x + o + w, y + 8]);
    const fits = r => r[0] >= 4 && r[2] <= A.w - 4 && !placed.some(p => hit(r, p)) && !dots.some(d => d[4] !== m && hit(r, d));
    let side = null;
    if (m.classList.contains('focus')) side = m.classList.contains('left');   // explore.js's nameSide() places that one
    else if (m.classList.contains('speck') || y < A.t + 8 || y > A.b - 8 || x < 0 || x > A.w) side = m === picked ? false : null;   // off screen: no name hanging in
    else side = fits(box(false)) ? false : fits(box(true)) ? true : must ? (x + o + w > A.w - 4) : null;
    out.set(m, side);
    if (side !== null) placed.push(box(side));
  }
  for (const [m, side] of out) {
    m.classList.toggle('nm-off', side === null);
    if (side !== null && !m.classList.contains('focus')) m.classList.toggle('left', side);
  }
}

// ---- the peek sheet: what a tapped marker is, where it is on the timeline's date, and its round arrow onward ----
let picked = null;
const day = () => +$('time').value;
const fmt = (d, o = { month: 'short', day: 'numeric', year: 'numeric' }) => dayDate(d, o);
const radec = (ra, dec) => `RA ${ra.toFixed(1)}° Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}°`;
const patchUrl = (ra, dec) => `timelapse.html?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&det=D1&diff=1`;
const where = m => {   // a comet from its path or place; a patch or deep field from the RA and Dec in its link
  const c = m.comet, q = new URL(m.href, location.href).searchParams;
  return c?.track?.length ? trackAt(c.track, day()) : c ? [c.ra, c.dec] : q.has('ra') ? [+q.get('ra'), +q.get('dec')] : null;
};
const q = f => sheet.querySelector(`[data-f=${f}]`);

function fill() {
  const m = picked, c = m.comet, pos = where(m), d = day();
  const name = c?.id ?? m.querySelector('b')?.textContent ?? '';
  let what = '', hot = false, kind = '';
  if (c?.kind === 'known') {
    what = { detected: 'CO2 glow detected', quiet: 'No gas glow' }[c.co2] ?? (c.photos ? 'No clear signal' : 'Known comet');
    hot = c.co2 === 'detected';
    kind = /^\d*I\//.test(c.id) ? 'Interstellar comet, known' : 'Comet, known';
  } else if (c) {
    what = c.candidate ? (m.classList.contains('open') ? 'Candidate' : 'Likely comet') : 'Found by people';
    hot = true; kind = c.candidate ? 'Reported dot' : 'Comet found by people';
  } else if (m.classList.contains('patch')) { what = 'Nobody has looked here'; hot = true; }
  else what = 'SPHEREx photographs here most often';
  q('name').textContent = name;
  q('what').textContent = what; q('what').classList.toggle('hot', hot);
  q('when').textContent = c?.track?.length ? `Position on ${fmt(d)}` : pos ? radec(...pos) : '';
  q('go').href = m.href; q('go').setAttribute('aria-label', c ? `Open ${name}` : 'Open this patch');
  const img = q('thumb');
  if (c?.thumb) img.src = c.thumb; else img.removeAttribute('src');
  const facts = [];
  if (kind) facts.push(['Kind', kind]);
  if (pos) facts.push([c?.track?.length ? fmt(d) : 'Where', radec(...pos)]);
  if (c?.photos) facts.push(['Photos', `${c.photos} SPHEREx visits`]);
  q('facts').replaceChildren(...facts.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
  q('pathrow').hidden = !c?.track?.length;
  q('open').href = m.href; q('openlabel').textContent = c?.kind === 'known' ? 'Open comet page' : c?.candidate ? 'Open its page' : 'Open this patch';
  q('patch').hidden = !pos || !c;
  if (pos) { q('patch').href = patchUrl(...pos); q('patchlabel').textContent = c?.track?.length ? `See this patch on ${fmt(d, { month: 'short', day: 'numeric' })}` : 'See this patch'; }
  drawPath();
}
function drawPath() {   // the picked comet's JPL path, dotted, across the whole SPHEREx timeline (split where RA wraps)
  const c = picked?.comet, el = $('pick-path');
  if (!c?.track?.length || !$('pk-path').checked) return el.setAttribute('d', '');
  let d = '', pu = null;
  for (const [, ra, dec] of c.track) {
    const [u, v] = fwd(ra, dec);
    d += (pu === null || Math.abs(u - pu) > .5 ? 'M' : 'L') + (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1);
    pu = u;
  }
  el.setAttribute('d', d);
}
$('pk-path').addEventListener('change', drawPath);

function openPeek(m) {
  picked?.classList.remove('pick');
  picked = m; m.classList.add('pick');
  for (const d of document.querySelectorAll('details.layers')) d.open = false;
  sheet.dataset.detent = 'peek'; sheet.hidden = false; sheet.scrollTop = 0;
  fill(); declutter(); bringIntoView();
}
function bringIntoView() {   // glide so the picked marker sits in the middle of the map left above the sheet
  if (!picked) return;
  measure(area());
  const m = picked, top = A.b - sheetH();
  glide(W, ...place(parseFloat(m.style.left) / 100, parseFloat(m.style.top) / 100, A.w / 2, (A.t + top) / 2));
}
const detent = d => { sheet.dataset.detent = d; bringIntoView(); };
function closePeek() {
  if (sheet.hidden) return;
  sheet.hidden = true; sheet.style.transform = '';
  picked?.classList.remove('pick'); picked = null; drawPath();
  if (A) set(W, X, Y);   // without the sheet the oval must fit the full map area again
}
// explore.js calls this for a click on a marker: on phones it opens the sheet and keeps the page
export function tap(e) {
  if (!phone.matches) return false;
  const m = e.target.closest('.mk');
  if (!m || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  e.preventDefault(); openPeek(m);
  return true;
}
sheet.querySelector('.sheet-x').addEventListener('click', closePeek);
addEventListener('keydown', e => { if (e.key === 'Escape' && phone.matches) { closePeek(); for (const d of document.querySelectorAll('details.layers')) d.open = false; } });

// swipe a sheet by its top: up expands the comet sheet, down collapses it or closes it; a tap on the handle toggles
function swipe(handle, sheetEl, onEnd) {
  let y0 = null, dy = 0;
  handle.addEventListener('pointerdown', e => { if (e.target.closest('.sheet-x')) return; y0 = e.clientY; dy = 0; sheetEl.classList.add('drag'); });
  addEventListener('pointermove', e => { if (y0 === null) return; dy = e.clientY - y0; sheetEl.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; });
  const end = () => {
    if (y0 === null) return;
    y0 = null; sheetEl.classList.remove('drag'); sheetEl.style.transform = '';
    if (Math.abs(dy) > 8) swallowUntil = performance.now() + 400;
    onEnd(dy);
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
}
for (const part of sheet.querySelectorAll('.cs-top, .ch')) swipe(part, sheet, dy => {
  if (dy < -24) detent('full');
  else if (dy > 24) { if (sheet.dataset.detent === 'full') detent('peek'); else closePeek(); }
  else if (part.classList.contains('cs-top')) detent(sheet.dataset.detent === 'full' ? 'peek' : 'full');
});
sheet.addEventListener('click', e => { if (performance.now() < swallowUntil && e.target.closest('a')) e.preventDefault(); }, true);
for (const det of document.querySelectorAll('details.layers')) {
  const body = det.querySelector('.layers-body');
  body.querySelector('.sheet-x').addEventListener('click', () => { det.open = false; });
  swipe(body.querySelector('.grab'), body, dy => { if (dy > 40) det.open = false; });
  swipe(body.querySelector('h2'), body, dy => { if (dy > 40) det.open = false; });
  det.addEventListener('toggle', () => {   // one sheet at a time
    if (!det.open || !phone.matches) return;
    closePeek(); hooks.stop();
    for (const o of document.querySelectorAll('details.layers')) if (o !== det) o.open = false;
  });
  body.addEventListener('change', declutterSoon);   // layers switched: names can take the room freed
}

// explore.js: the timeline moved (comets follow it), and the markers are all on the map
export function onDay() {
  if (!phone.matches) return;
  if (picked) { const c = picked.comet; if (c?.track?.length) fill(); }
  declutterSoon();
}
export function ready() {
  if (!phone.matches) return;
  const f = document.querySelector('#marks .mk.sel')?.comet;
  if (f && !touched && !focus && !history.state?.view) {   // centre the first view on 3I/ATLAS where the replay ends
    const [ra, dec] = f.track?.length ? trackAt(f.track, +$('time').max) : [f.ra, f.dec];
    homeU = fwd(ra, dec)[0]; measure(area()); set(...homeView());
  }
  declutter();
}

// start last: everything above is declared by now
if (phone.matches) start();
phone.addEventListener('change', () => (phone.matches ? start() : stop()));
addEventListener('resize', () => { if (phone.matches) { measure(area()); set(W, X, Y); } });
