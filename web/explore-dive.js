// Explore: zoom straight into a time-lapse, the way a street map drops into street view.
//
// At the map's deepest zoom a small frame (the aim) marks the middle of the view, with a "Dive in" button under it.
// Pressing the button, or zooming in further, opens the time-lapse of that spot: the frame grows into the photo while
// the sky inside it keeps zooming in, from the map's own sharp SPHEREx sky tiles (a copy of what explore-deep.js shows)
// to the first real frame. Back, or zooming out past the widest view in the time-lapse, plays it in reverse.
//
// How it works
//   The time-lapse is timelapse.html itself, loaded in a frame over the map (?embed=1). Nothing is rebuilt and nothing is
//   handed over: its build starts as soon as a dive is likely, and goes on while the dive plays. This page stays loaded
//   underneath, so going back shows the map exactly as it was.
//   The address bar is the time-lapse's own address (history.pushState), so a reload or a shared link opens the
//   time-lapse page on its own. Back pops that entry and the frame closes.
//   The map view (middle of the view, zoom, day) is also kept in this page's history entry, so Explore opens where it
//   was after a reload, or when the browser comes back from a time-lapse opened by a link.
//
// What starts a dive, and what does not
//   Only zooming in again once the map is already at its deepest: a scroll (or a pinch) that began there. A scroll
//   counts as a new one after 180 ms without wheel events, so a long scroll, or a trackpad's coasting, that merely
//   arrives at the deepest zoom stops there. The aim's outline fills as the scroll adds up and empties if it stops
//   short. Panning, double clicks and the zoom buttons never start one.
//
// Reduced motion: no flight. The time-lapse simply takes the map's place, and back swaps the map in again.
import { fwd, RAD } from './skymap.js';
import * as view from './explore-view.js';
import * as deep from './explore-deep.js';

const $ = id => document.getElementById(id);
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const wrapEl = document.querySelector('.map-wrap'), stageEl = document.querySelector('.xstage');
const aim = $('dive-aim'), go = $('dive-go'), ring = $('aim-ring'), box = $('dive'), cv = $('dive-cv'), g = cv.getContext('2d');
const skyImg = document.querySelector('#map .sky'), cover = $('cover');

const DET = 'D1';            // the detector every other patch link on Explore opens (the six cover a spot about equally)
const AIM_W = 66;            // the aim's width in px; its shape is the photo's (1146 x 902)
const IN_MS = 1900, OUT_MS = 1400;
const PUSH = Math.log(2.2);  // how much further "zoom" a scroll must ask for at the deepest level: about 4 wheel notches
const PINCH = Math.log(1.6); // and a pinch: fingers 1.6x further apart
const GAP = 180;             // ms without wheel events that ends one scroll
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = x => { x = clamp01(x); return x * x * x * (x * (6 * x - 15) + 10); };
const mid = () => [view.A.w / 2, (view.A.t + view.A.b) / 2];
const here = () => (view.A && view.W ? view.skyAt(...mid()) : null);   // [ra, dec] at the middle of the view
const round4 = v => +v.toFixed(4);   // the address carries four decimals: the dive uses the same numbers

// ---------- the map view, kept in this history entry ----------
let dive = null;   // the dive prepared, in flight or open (see prepare)
let saveQ = 0;
function save() {
  const c = here();
  if (!c || (dive && dive.phase !== 'ready') || history.state?.dive) return;
  history.replaceState({ ...history.state, view: { ra: c[0], dec: c[1], zoom: view.W / view.A.min, day: +$('time').value } }, '');
}
// put the map where a saved view had it: called by the phone and desktop files once they have measured the map area
export function restore() {
  const v = history.state?.view;
  if (!v || !view.A) return false;
  const w = Math.min(view.MAXW, Math.max(view.A.min, v.zoom * view.A.min)), [u, vv] = fwd(v.ra, v.dec), [mx, my] = mid();
  view.set(w, mx - u * w, my - vv * w / 2);
  return true;
}

// ---------- the sharp sky as the map shows it now ----------
// The deep layer (explore-deep.js) has the sharpest SPHEREx tiles for this view on its canvas already. One copy of that
// canvas, taken as the dive starts, is the sky inside the flying frame: nothing is loaded and nothing is built here, so
// resting at the deepest zoom costs nothing. With no deep layer (no WebGL, or its tiles not in yet) the frame flies over
// the map's plain sky picture.
function snapshot() {
  const st = deep.state(), c = document.querySelector('#map canvas.hips');
  if (!st.shown || st.lost || st.dead || !c?.width) return null;
  deep.redraw();   // a WebGL canvas can only be copied in the task that drew it
  const o = new OffscreenCanvas(c.width, c.height);
  o.getContext('2d').drawImage(c, 0, 0);
  return o;
}
// A frame as the time-lapse builds it (timelapse.html preview(): the same stretch and colour), on its whole 12 arcmin
// grid with a soft edge, so it can fade in at the middle of the tiles while the dive is still zooming.
function frameCanvas(px) {
  const G = Math.round(Math.sqrt(px.length)), v = Array.from(px).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const lo = v[Math.floor(.05 * v.length)], hi = v[Math.floor(.997 * (v.length - 1))], A = Math.asinh(10), img = new ImageData(G, G);
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {   // the worker's rows run south to north
    const x = px[(G - 1 - r) * G + c], k = Number.isFinite(x) ? Math.min(1, Math.asinh(Math.max(0, (x - lo) / (hi - lo)) * 10) / A) : 0;
    const edge = Math.max(Math.abs(c + .5 - G / 2), Math.abs(r + .5 - G / 2)) / (G / 2);
    img.data.set([255 * k, 247 * k, 235 * k, 255 * (1 - smooth((edge - .62) / .38))], 4 * (r * G + c));
  }
  const c = new OffscreenCanvas(G, G);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// ---------- the aim: where a dive would go, and how close a scroll is to starting one ----------
let push = 0, pushT = 0;
function setPush(p) {
  push = clamp01(p);
  ring.style.strokeDashoffset = 1 - push;
  if (dive && dive.phase !== 'ready') return;   // in flight the map's size is the flight's
  if (push && !calm.matches) {   // the map leans in a little
    const [x, y] = mid();
    wrapEl.style.transformOrigin = `${x - view.X}px ${y - view.Y}px`;
    wrapEl.style.scale = 1 + .05 * push;   // `scale`, not `transform`: that one holds the map's straightening (explore-view.js)
  } else wrapEl.style.scale = '';
}
function pushBy(d) {
  clearTimeout(pushT);
  setPush(push + d);
  target();   // a dive is likely: the time-lapse of this spot starts building
  if (push >= 1) start(); else pushT = setTimeout(() => setPush(0), 600);
}
function aimAt() {
  const c = here();
  if (dive?.phase === 'ready' && dive.ra != null && (!c || round4(c[0]) !== dive.ra || round4(c[1]) !== dive.dec)) drop();   // the view moved: that spot is off
  if (dive && dive.phase !== 'ready') return;
  const on = !!c && view.atMax();
  if (aim.hidden === on) { aim.hidden = !on; if (!on) { clearTimeout(pushT); setPush(0); } }
  if (!on) { if (dive) drop(); return; }   // away from the deepest zoom a loaded page is let go
  const [x, y] = mid();
  aim.style.left = x + 'px'; aim.style.top = y + 'px';
}
view.onView(() => { aimAt(); clearTimeout(saveQ); saveQ = setTimeout(save, 300); });
addEventListener('resize', () => setTimeout(aimAt));   // after the map files have re-measured

// the wheel: only a scroll that starts at the deepest zoom adds up (capture, so this runs before the map zooms)
// A scroll ends when a timer set at its last wheel event runs out, not by comparing event times: when the page is busy
// Chrome holds wheel events back and delivers them before any timer, so a stall in the middle of one scroll cannot
// pass for a pause.
let resting = true, restT = 0, wheelOk = false;
stageEl.addEventListener('wheel', e => {
  if (!view.A || e.target.closest('.tl') || (dive && dive.phase !== 'ready')) return;
  if (resting) wheelOk = view.atMax() && !!here();
  resting = false; clearTimeout(restT); restT = setTimeout(() => { resting = true; }, GAP);
  const dy = Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1)));
  if (dy >= 0 || !wheelOk || !view.atMax()) { if (dy > 0) wheelOk = false; if (push) { clearTimeout(pushT); setPush(0); } return; }
  pushBy(-dy * (e.ctrlKey ? .01 : .002) / PUSH);
}, { capture: true, passive: true });

// a pinch: only one that starts at the deepest zoom, by how far the fingers spread from where they began
const fingers = new Map();
let pinch = null;
const spread = () => { const [a, b] = [...fingers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
stageEl.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch' || e.target.closest('.tl')) return;
  fingers.set(e.pointerId, [e.clientX, e.clientY]);
  pinch = fingers.size === 2 && view.A && view.atMax() && here() && !(dive && dive.phase !== 'ready') ? { d0: spread() } : null;
}, true);
addEventListener('pointermove', e => {
  if (!fingers.has(e.pointerId)) return;
  fingers.set(e.pointerId, [e.clientX, e.clientY]);
  if (!pinch || fingers.size !== 2) return;
  if (!view.atMax()) { pinch = null; return setPush(0); }
  const p = Math.log(spread() / pinch.d0) / PINCH;
  setPush(p);
  if (p > .15) target();
  if (p >= 1) { pinch = null; start(); }
});
const lift = e => { if (!fingers.delete(e.pointerId)) return; if (pinch) { pinch = null; setPush(0); } };
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// the button: the time-lapse starts loading as soon as the pointer or the keyboard reaches it
let hoverQ = 0;   // a pointer that only passes over it loads nothing
go.addEventListener('pointerenter', () => { hoverQ = setTimeout(target, 150); });
go.addEventListener('pointerleave', () => clearTimeout(hoverQ));
go.addEventListener('pointerdown', () => target());
let byKey = false;   // started from the keyboard: focus comes back to the button afterwards
go.addEventListener('click', e => { byKey = e.detail === 0; setPush(1); start(); });

// ---------- a dive ----------
// phase: 'ready' (the time-lapse page is loaded in its hidden frame, the map is still in use), 'in' (flying in),
// 'open' (the time-lapse has the screen), 'out' (flying back). t runs from 0 (the map) to 1 (the time-lapse).
// Nothing loads while the view only rests at the deepest zoom: starting the time-lapse page takes the main thread for
// 70 ms or more (several times that on a phone), which would be a dropped frame for anyone just looking around. The page
// loads at the first sign of a dive (target(): the first scroll step past the limit, a pinch, a hover or press on the
// button), and gets the spot as soon as its script has started.
function prepare() {
  if (dive) return dive;
  const f = document.createElement('iframe');
  let ok; const ready = new Promise(r => { ok = r; });
  f.className = 'dive-frame'; f.title = 'Time-lapse of this spot'; f.tabIndex = -1;
  // a new frame for each dive: its first page load adds no history entry, so back always belongs to the map
  f.src = 'timelapse.html?embed=1';
  document.body.append(f);
  dive = { ra: null, dec: null, f, ready, ok, phase: 'ready', t: 0, raf: 0, snap: null, shot: null, fov: 6 / 60 };
  return dive;
}
function target(spot = here()) {
  const d = prepare();
  if (!spot || d.ra != null) return d;
  const ra = d.ra = round4(spot[0]), dec = d.dec = round4(spot[1]), day = +$('time').value;
  d.ready.then(() => { if (dive === d) d.f.contentWindow.postMessage({ type: 'dive-go', ra, dec, det: DET, day }, location.origin); });
  return d;
}
function drop() { dive.f.remove(); dive = null; }
const lapseUrl = d => `timelapse.html?ra=${d.ra.toFixed(4)}&dec=${d.dec.toFixed(4)}&det=${DET}`;
// the photo's place on screen, read from the time-lapse's own layout (its frame covers the window)
function photoRect(d) {
  try { const r = d.f.contentDocument.getElementById('patch').getBoundingClientRect(); return r.width > 1 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; }
  catch { return null; }
}
// map pixels per degree of sky at a spot, as a 2 x 2 matrix [xx, xy, yx, yy]: sky x is to the right on a north-up
// photo (west), sky y is down (south). Mollweide tilts and squeezes the sky away from the map's middle; the dive
// starts with the map's own tilt and turns north up on the way in, so every layer stays in register.
function mapScale(ra, dec) {
  const h = .05, W = view.W, c = Math.max(.02, Math.cos(dec * RAD)), p = (r, d) => { const [u, v] = fwd(r, d); return [u * W, v * W / 2]; };
  const o = p(ra, dec), s = dec - h < -90 ? -1 : 1, n = p(ra, dec - s * h);
  let w = p(ra - h / c, dec), ws = 1;
  if (Math.abs(w[0] - o[0]) > W / 4) { w = p(ra + h / c, dec); ws = -1; }   // across the map's edge: measure the other way
  return [ws * (w[0] - o[0]) / h, s * (n[0] - o[0]) / h, ws * (w[1] - o[1]) / h, s * (n[1] - o[1]) / h];
}

async function start(pushEntry = true, spot = here()) {
  const d = target(spot);
  if (d.ra == null || d.phase !== 'ready') return;
  d.phase = 'in';
  clearTimeout(pushT); clearTimeout(saveQ);
  // the map lets go of any finger or button still held, so it cannot move underneath
  for (const id of [...fingers.keys(), 1]) dispatchEvent(new PointerEvent('pointercancel', { pointerId: id }));
  fingers.clear(); pinch = null;
  view.cancel(); view.hooks.stop();
  if (pushEntry) {
    const c = here();
    const keep = { ...history.state, view: { ra: c[0], dec: c[1], zoom: view.W / view.A.min, day: +$('time').value } };
    history.replaceState(keep, '');
    history.pushState({ dive: { ra: d.ra, dec: d.dec } }, '', lapseUrl(d));
  }
  document.body.classList.add('diving', 'flying');
  // J0: the map's own layout around the spot. M0: what the screen shows, the layout through the engine's straightening
  d.c = view.toScreen(d.ra, d.dec); d.J0 = mapScale(d.ra, d.dec);
  { const m = view.M, j = d.J0; d.M0 = [m[0] * j[0] + m[1] * j[2], m[0] * j[1] + m[1] * j[3], m[2] * j[0] + m[3] * j[2], m[2] * j[1] + m[3] * j[3]]; }
  d.s0 = Math.sqrt(Math.abs(d.M0[0] * d.M0[3] - d.M0[1] * d.M0[2]));
  d.o = `${d.c[0] - view.X}px ${d.c[1] - view.Y}px`;
  d.tint = getComputedStyle(skyImg).filter;
  d.snap = snapshot(); d.vw = innerWidth; d.vh = innerHeight;
  const loaded = await Promise.race([d.ready.then(() => true), new Promise(r => setTimeout(r, 5000))]);
  if (dive !== d || d.phase !== 'in') return;   // backed out while it loaded
  const r = photoRect(d);
  if (!loaded || !r) return location.reload();   // the page in the frame did not start: the address is the time-lapse's, so this opens the page itself
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.round(r.w * dpr); cv.height = Math.round(r.h * dpr);
  fly(1);
}
// in flight the time-lapse keeps its own photo hidden (patch.css): the flying frame is the photo until it lands
const flying = (d, on) => { try { d.f.contentDocument.documentElement.classList.toggle('flying', on); } catch { /* not loaded */ } };
function fly(to) {
  const d = dive;
  cancelAnimationFrame(d.raf);
  flying(d, true);
  d.phase = to ? 'in' : 'out';
  document.body.classList.add('flying');
  box.hidden = false;
  const from = d.t, ms = calm.matches ? 0 : (to ? IN_MS : OUT_MS) * Math.abs(to - from), t0 = performance.now();
  const step = now => {
    const k = ms ? Math.min(1, (now - t0) / ms) : 1;
    d.t = from + (to - from) * k;
    paint(d);
    if (k < 1) d.raf = requestAnimationFrame(step); else (to ? landed : surfaced)(d);
  };
  d.raf = requestAnimationFrame(step);
}
// one picture of the flight at d.t
function paint(d) {
  const e = smooth(d.t), r1 = d.r1 = photoRect(d) ?? d.r1, [cx, cy] = d.c;
  const s = d.s0 ** (1 - e) * (r1.w / d.fov) ** e;   // px per degree of sky inside the frame: the zoom is even on a log scale
  // the frame is in place by 60% of the flight; the sky inside it keeps zooming all the way
  const f = smooth(d.t / .6), w = AIM_W ** (1 - f) * r1.w ** f, h = w * r1.h / r1.w;
  const x = cx + (r1.x + r1.w / 2 - cx) * f - w / 2, y = cy + (r1.y + r1.h / 2 - cy) * f - h / 2;
  box.style.width = w + 'px'; box.style.height = h + 'px'; box.style.transform = `translate(${x}px, ${y}px)`;
  // outside the frame: the map grows a little and goes dark, and the time-lapse page comes up around the frame
  wrapEl.style.transformOrigin = d.o;
  wrapEl.style.scale = Math.min(s / d.s0, 6);
  wrapEl.style.opacity = 1 - smooth((d.t - .2) / .3);
  d.f.style.opacity = Math.max(.001, smooth((d.t - .28) / .37));

  // inside it: the sky, in degrees from the spot, through M (north swings up as a goes to 1)
  const a = smooth((e - .05) / .45), M = d.M0.map((m, i) => s * ((1 - a) * m / d.s0 + (i === 0 || i === 3 ? a : 0)));
  const k = cv.width / w, ox = cv.width / 2, oy = cv.height / 2;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.filter = 'none'; g.fillStyle = '#04060c'; g.fillRect(0, 0, cv.width, cv.height);
  // the sky layers get the sky picture's colour filter (d.tint, styles.css), so the frame starts as a piece of the map; the photo is drawn plain
  // the photo fades in as it grows to cover the frame
  const shot = d.shot, shotOn = shot ? smooth((shot.deg * s / w - .8) / .8) : 0;
  // the map picture (and its veil of sky not photographed yet) underneath, then the deep layer's sharp tiles over it
  const mapOn = shotOn > .995 ? 0 : 1;
  if (mapOn) {
    const det = d.J0[0] * d.J0[3] - d.J0[1] * d.J0[2], I = [d.J0[3] / det, -d.J0[1] / det, -d.J0[2] / det, d.J0[0] / det];
    const T = [M[0] * I[0] + M[1] * I[2], M[0] * I[1] + M[1] * I[3], M[2] * I[0] + M[3] * I[2], M[2] * I[1] + M[3] * I[3]];   // map px -> frame px
    g.setTransform(T[0] * k, T[2] * k, T[1] * k, T[3] * k, ox, oy);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const [u, v] = fwd(d.ra, d.dec), half = Math.hypot(w, h) * d.s0 / s;   // map px shown around the spot, with room to turn
    for (const [img, alpha] of [[skyImg, mapOn], [cover, mapOn * (+getComputedStyle(cover).opacity || 0)]]) {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, q = view.W / iw;   // map px per image px
      if (!iw || alpha < .01) continue;
      const sx = Math.max(0, u * iw - half / q - 1), sy = Math.max(0, v * ih - half / q - 1), sw = Math.min(iw, u * iw + half / q + 1) - sx, sh = Math.min(ih, v * ih + half / q + 1) - sy;
      g.globalAlpha = alpha; g.filter = img === skyImg ? d.tint : 'none';
      g.drawImage(img, sx, sy, sw, sh, (sx - u * iw) * q, (sy - v * ih) * q, sw * q, sh * q);
    }
  }
  if (mapOn && d.snap) {   // the copy is the window as it was: window px from the spot -> frame px
    const det = d.M0[0] * d.M0[3] - d.M0[1] * d.M0[2], I = [d.M0[3] / det, -d.M0[1] / det, -d.M0[2] / det, d.M0[0] / det];
    const T = [M[0] * I[0] + M[1] * I[2], M[0] * I[1] + M[1] * I[3], M[2] * I[0] + M[3] * I[2], M[2] * I[1] + M[3] * I[3]];
    g.setTransform(T[0] * k, T[2] * k, T[1] * k, T[3] * k, ox, oy);
    g.globalAlpha = 1; g.imageSmoothingEnabled = true; g.filter = d.tint;
    g.drawImage(d.snap, -cx, -cy, d.vw, d.vh);
  }
  g.setTransform(M[0] * k, M[2] * k, M[1] * k, M[3] * k, ox, oy);
  g.filter = 'none';
  if (shotOn > .01) { g.globalAlpha = shotOn; g.imageSmoothingEnabled = false; g.drawImage(shot.cv, -shot.deg / 2, -shot.degH / 2, shot.deg, shot.degH); }
}
const others = () => [...document.body.children].filter(el => el !== dive?.f && el !== box && el.tagName !== 'SCRIPT');
let title = document.title;
function landed(d) {
  d.phase = 'open';
  flying(d, false);
  d.f.dataset.open = '1';   // the time-lapse counts a patch as looked at only once it is on screen
  try { d.f.contentWindow.__dive.hold(cv); } catch { /* its script is still loading: its own loading line shows */ }
  box.hidden = true;
  d.f.style.opacity = 1; d.f.classList.add('on'); d.f.tabIndex = 0;
  document.body.classList.remove('flying');
  for (const el of others()) el.inert = true;
  title = document.title; document.title = 'Patch viewer · Trailblazer';
  d.f.focus({ preventScroll: true });
}
// back on the map: from the photo as the time-lapse shows it now
function close() {
  const d = dive;
  if (!d || d.phase === 'out') return;
  if (d.phase === 'ready') return drop();
  try {
    const w = d.f.contentWindow, p = w.document.getElementById('patch'), st = w.__lapse.state;
    if (st.m && d.phase === 'open') {
      const c = new OffscreenCanvas(p.width, p.height);
      c.getContext('2d').drawImage(p, 0, 0);
      d.fov = st.fov / 60; d.shot = { cv: c, deg: d.fov, degH: d.fov * p.height / p.width };
    }
  } catch { /* not built yet: fly back over the sky tiles */ }
  for (const el of others()) el.inert = false;
  d.f.classList.remove('on'); d.f.tabIndex = -1;
  document.title = title;
  if (!d.r1) return surfaced(d);   // it never took off
  fly(0);
}
function surfaced(d) {
  cancelAnimationFrame(d.raf);
  box.hidden = true;
  wrapEl.style.scale = ''; wrapEl.style.opacity = '';
  document.body.classList.remove('diving', 'flying');
  d.f.remove(); dive = null;
  dispatchEvent(new Event('dive-closed'));   // explore.js: the heat map may have a new patch looked at
  setPush(0); aim.hidden = true; aimAt();
  if (!aim.hidden && byKey) go.focus({ preventScroll: true });
  byKey = false;
}

// the time-lapse, from inside its frame
addEventListener('message', e => {
  if (e.origin !== location.origin || !dive || e.source !== dive.f.contentWindow) return;
  const m = e.data, d = dive;
  if (m.type === 'dive-ready') d.ok();
  else if (m.type === 'dive-frame' && !d.shot) { const c = frameCanvas(m.px); if (c) d.shot = { cv: c, deg: 12 / 60, degH: 12 / 60 }; }
  else if (m.type === 'dive-url' && d.phase !== 'ready' && history.state?.dive) history.replaceState(history.state, '', 'timelapse.html' + m.search);
  else if (m.type === 'dive-out' && d.phase === 'open') history.back();
});
// back closes it; forward opens it again at the same spot
addEventListener('popstate', e => {
  const to = e.state?.dive;
  if (!to) return close();
  if (dive?.phase === 'out') { dive.phase = 'in'; return fly(1); }
  if ((dive && dive.phase !== 'ready') || !view.A) return;
  const [u, v] = fwd(to.ra, to.dec), [mx, my] = mid();
  view.set(view.MAXW, mx - u * view.MAXW, my - v * view.MAXW / 2);
  if (dive) drop();
  start(false, [to.ra, to.dec]);
});
// in flight nothing else on the page takes keys; Escape turns back
addEventListener('keydown', e => {
  if (!dive || dive.phase === 'ready') return;
  e.stopPropagation();
  if (e.key === 'Escape' && dive.phase === 'in' && history.state?.dive) history.back();
}, true);

// for the line-up check in tests/zoom_into_ui.py: the copied sky, north up, `deg` degrees across on n pixels (through the
// same matrix paint() uses), and the first frame as the flying frame draws it
window.__diveSky = (deg, n) => {
  const d = dive;
  if (!d?.snap) return null;
  const c = new OffscreenCanvas(n, n), x = c.getContext('2d'), k = n / deg, det = d.M0[0] * d.M0[3] - d.M0[1] * d.M0[2];
  x.setTransform(d.M0[3] / det * k, -d.M0[2] / det * k, -d.M0[1] / det * k, d.M0[0] / det * k, n / 2, n / 2);
  x.drawImage(d.snap, -d.c[0], -d.c[1], d.vw, d.vh);
  return c;
};
window.__diveShot = () => dive?.shot?.cv ?? null;
window.__diveState = () => (dive && dive.ra != null ? { phase: dive.phase, t: dive.t, ra: dive.ra, dec: dive.dec, sky: !!dive.snap, shot: !!dive.shot } : null);   // for tests/zoom_into_ui.py
aimAt();
