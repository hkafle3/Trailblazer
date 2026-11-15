// The Explore map's pan and zoom engine, shared by phones (explore-phone.js) and desktops (explore-desktop.js).
//
// How it works: the view is three numbers in window pixels. W is the oval's width (its height is W / 2), X and Y are
// its top-left corner. set() writes them to .map-wrap's width, left and top. The sky, canvases, SVG and markers are all
// placed in percent of .map-wrap, so every layer follows and dots and names keep their pixel size.
//
// API
//   measure(area)          the space the map may use, re-measured by the caller when the window or the page changes:
//                          { w, t, b }  window width, top and bottom edges of the map area, in window pixels
//                          min          the smallest W (the whole sky)
//                          inset()      optional: pixels covered at the bottom right now (the phone's comet sheet)
//   set(w, x, y)           jump to a view; it is clamped so the oval stays in view (see limits below)
//   zoomAt(f, px, py)      zoom by factor f keeping window point (px, py) still
//   glide(w, x, y, ms)     animate to a view (no animation with reduced motion); cancel() stops a glide
//   glideZoom(f, px, py)   glide version of zoomAt
//   flyTo(ra, dec, w, ms)  glide so sky position (ra, dec), in degrees, sits in the middle of the area at width w
//   skyAt(px, py)          [ra, dec] under a window point, or null off the oval;  toScreen(ra, dec) the reverse
//   onView(fn)             fn({ W, X, Y, zoom }) after every change (zoom is W / min, 1 = whole sky)
//   W, X, Y, A, MAXW       live read-only values; atMin(), atMax()
//   hooks.stop()           set by explore.js: stops the coverage replay. Call it on any pan or zoom.
import { fwd, inv } from './skymap.js';

export const MAXW = 3200;   // ponytail: data/sky.jpg is 2000 px wide and turns soft past this; deeper zoom could load the HiPS tiles sky.js uses
export const hooks = { stop() {} };
const stage = document.querySelector('.xstage'), wrap = document.querySelector('.map-wrap');
export let W = 0, X = 0, Y = 0, A = null;
let anim = 0, ox = 0, oy = 0;
const listeners = [];

export function measure(area) {
  A = area;
  const s = stage.getBoundingClientRect();   // .map-wrap is placed inside .xstage, which sits at 0, 0 on phones only
  ox = s.left; oy = s.top;
}
export const atMin = () => W <= A.min + 0.5;
export const atMax = () => W >= MAXW - 0.5;
export const onView = fn => listeners.push(fn);

// keep the sky oval in view: an oval smaller than the area stays inside it and a bigger one covers it, give or take
// 15% of the area. The margin keeps the rule continuous, so zooming around a point never jumps where the oval
// grows past the area. Whatever covers the bottom (the phone's comet sheet) raises the bottom edge.
export function set(w, x, y) {
  W = Math.min(MAXW, Math.max(A.min, w));
  const H = W / 2, bot = A.b - (A.inset?.() ?? 0), mx = A.w * .15, my = (bot - A.t) * .15;
  X = Math.min(Math.max(0, A.w - W) + mx, Math.max(Math.min(0, A.w - W) - mx, x));
  Y = Math.min(Math.max(A.t, bot - H) + my, Math.max(Math.min(A.t, bot - H) - my, y));
  wrap.style.width = W + 'px'; wrap.style.left = X - ox + 'px'; wrap.style.top = Y - oy + 'px';
  wrap.classList.toggle('deep-zoom', W > 1700);   // the ecliptic's label is drawn in the sky, so it grows with the zoom: hidden when close in
  const v = { W, X, Y, zoom: W / A.min };
  for (const fn of listeners) fn(v);
}
const scaled = (f, px, py) => { const w = Math.min(MAXW, Math.max(A.min, W * f)), g = w / W; return [w, px - (px - X) * g, py - (py - Y) * g]; };
export const zoomAt = (f, px, py) => set(...scaled(f, px, py));
export const cancel = () => cancelAnimationFrame(anim);
export function glide(w, x, y, ms = 300) {
  cancel();
  const [w0, x0, y0] = [W, X, Y], t0 = performance.now(), ease = t => 1 - (1 - t) ** 3;
  const step = now => { const t = Math.min(1, (now - t0) / ms), e = ease(t); set(w0 + (w - w0) * e, x0 + (x - x0) * e, y0 + (y - y0) * e); if (t < 1) anim = requestAnimationFrame(step); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) set(w, x, y); else anim = requestAnimationFrame(step);
}
export const glideZoom = (f, px, py, ms = 250) => glide(...scaled(f, px, py), ms);
export function flyTo(ra, dec, w = W, ms = 400) {
  w = Math.min(MAXW, Math.max(A.min, w));   // centre at the width set() will allow, or a clamped width puts the spot off centre
  const [u, v] = fwd(ra, dec);
  glide(w, A.w / 2 - u * w, (A.t + A.b) / 2 - v * w / 2, ms);
}
export const skyAt = (px, py) => inv((px - X) / W, (py - Y) / (W / 2));
export const toScreen = (ra, dec) => { const [u, v] = fwd(ra, dec); return [X + u * W, Y + v * W / 2]; };
