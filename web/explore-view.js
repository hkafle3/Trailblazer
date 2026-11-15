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
//   uvAt(px, py), win(u, v) the same two for map fractions (0..1 across and down the oval's box), which is how markers are placed
//   place(u, v, px, py, w) the view corner [x, y] that puts map fraction (u, v) at window point (px, py) at width w
//   move(f, x0, y0, x1, y1) the sky under (x0, y0) goes to (x1, y1), zoomed by f: a drag (f = 1) or a pinch
//   M, straight()          the straightening in force (see below), and whether there is any
//   onView(fn)             fn({ W, X, Y, zoom, M, C }) after every change (zoom is W / min, 1 = whole sky; C is M's pivot)
//   W, X, Y, A, MAXW       live read-only values; atMin(), atMax()
//   hooks.stop()           set by explore.js: stops the coverage replay. Call it on any pan or zoom.
import { fwd, fwdLon, inv, wrap as wrap180, RAD } from './skymap.js';

// the deepest zoom: one pixel of the screen per pixel of the sharpest SPHEREx sky tiles (HiPS order 5, 12.9 arcsec),
// which explore-deep.js draws over data/sky.jpg past about 2,500 px
export const MAXW = Math.round(90600 / devicePixelRatio);   // ponytail: read once; a window dragged to a screen with another pixel ratio keeps this limit until reload
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
const clampW = w => Math.min(MAXW, Math.max(A.min, w));

// ---- straightening ----
// The Mollweide map keeps areas but not shapes: away from its middle the sky is sheared, and near the poles squashed.
// Past 3,200 px the whole map is given one linear change M about the middle of the map area (the pivot C). It undoes the
// map's stretch at the sky under the pivot and turns north up there, and it fades in up to 12,800 px. At those zooms the
// window covers a few degrees, so one change is right across it.
//     window point = C + M (layout point - C),    layout point = (X + u W, Y + v W / 2) for map fraction (u, v)
// The sky under the pivot is where the layout puts it, so it never slides as M changes. Everything else that turns a
// window point into sky, or sky into a window point, goes through uvAt() and win().
// In CSS, .map-wrap carries M: the sky picture, coverage, heat map, grid and paths take it. Markers, cards and the pin
// carry its inverse (--un) about their own sky position, so they sit on the right spot at their own size and shape.
const ID = [1, 0, 0, 1];
export let M = ID;   // [a, b, c, d]: x' = a x + b y, y' = c x + d y
export const straight = () => M !== ID;
const pivot = () => (A ? [A.w / 2, (A.t + A.b) / 2] : [0, 0]);
const fade = w => { const t = Math.min(1, Math.max(0, Math.log2(w / 3200) / 2)); return t * t * (3 - 2 * t); };   // 0 up to 3,200 px, 1 from 12,800
function straighten(w, x, y) {
  const t = fade(w);
  if (!t) return ID;
  // the sky under the pivot, kept just inside the oval and 0.3 degrees off the poles, where the map's stretch has no end
  const [cx, cy] = pivot();
  let mx = (cx - x) / w * 2 - 1, my = 1 - (cy - y) / (w / 2) * 2;
  const r = Math.hypot(mx, my); if (r > .9995) { mx *= .9995 / r; my *= .9995 / r; }
  const [ra, d0] = inv((mx + 1) / 2, (1 - my) / 2), dec = Math.max(-89.7, Math.min(89.7, d0)), lon = wrap180(-ra);
  // J: how the map moves, in units of the map's own radius, for a step of sky to the right and a step down (south)
  const e = 1e-4, s = e * RAD / (4 * Math.SQRT2), p0 = fwdLon(lon, dec), pe = fwdLon(lon + e / Math.cos(dec * RAD), dec), pn = fwdLon(lon, dec + e);
  const a = (pe[0] - p0[0]) / s, c = (pe[1] - p0[1]) / 2 / s, b = -(pn[0] - p0[0]) / s, d = -(pn[1] - p0[1]) / 2 / s, det = a * d - b * c;
  const inv00 = d / det, inv01 = -b / det, inv10 = -c / det, inv11 = a / det;   // J's inverse: true shapes, north up
  // fade in as a turn times a stretch, each part way: a plain mix of the two matrices could pass through a flat one
  const th = Math.atan2(inv10 - inv01, inv00 + inv11), co = Math.cos(th), si = Math.sin(th);
  const p00 = 1 + t * (co * inv00 + si * inv10 - 1), p01 = t * (co * inv01 + si * inv11), p10 = t * (co * inv10 - si * inv00), p11 = 1 + t * (co * inv11 - si * inv01 - 1);
  const ct = Math.cos(t * th), st = Math.sin(t * th);
  return [ct * p00 - st * p10, ct * p01 - st * p11, st * p00 + ct * p10, st * p01 + ct * p11];
}
const lin = (m, x, y) => [m[0] * x + m[1] * y, m[2] * x + m[3] * y];
const unlin = (m, x, y) => { const det = m[0] * m[3] - m[1] * m[2]; return [(m[3] * x - m[1] * y) / det, (m[0] * y - m[2] * x) / det]; };
export function win(u, v) { const [cx, cy] = pivot(), [x, y] = lin(M, X + u * W - cx, Y + v * W / 2 - cy); return [cx + x, cy + y]; }
export function uvAt(px, py) { const [cx, cy] = pivot(), [x, y] = unlin(M, px - cx, py - cy); return [(cx + x - X) / W, (cy + y - Y) / (W / 2)]; }
// the straightening depends on where the view is, so the corner is found in a few rounds against the view it leads to
export function place(u, v, px, py, w = W) {
  const [cx, cy] = pivot();
  let x = px - u * w, y = py - v * w / 2;
  for (let i = 0; i < 4; i++) { const [lx, ly] = unlin(straighten(w, x, y), px - cx, py - cy); x = cx + lx - u * w; y = cy + ly - v * w / 2; }
  return [x, y];
}
function dress() {   // write M to the page
  if (M === ID) {
    if (wrap.classList.contains('straight')) { wrap.classList.remove('straight'); wrap.style.transform = wrap.style.transformOrigin = ''; wrap.style.removeProperty('--un'); wrap.style.removeProperty('--veil'); }
    return;
  }
  const [cx, cy] = pivot(), det = M[0] * M[3] - M[1] * M[2];
  wrap.classList.add('straight'); wrap.style.animation = 'none';   // the map's scale-in on load would hold its own transform
  wrap.style.transformOrigin = `${cx - X}px ${cy - Y}px`; wrap.style.transform = `matrix(${M[0]},${M[2]},${M[1]},${M[3]},0,0)`;
  wrap.style.setProperty('--un', `matrix(${M[3] / det},${-M[2] / det},${-M[1] / det},${M[0] / det},0,0)`);
  wrap.style.setProperty('--veil', 1 - fade(W));   // the coverage picture is half a degree a cell: a haze over the sharp sky this close in
}
// the switch between the phone and desktop layouts hands .map-wrap over: it starts unstraightened
matchMedia('(max-width: 640px)').addEventListener('change', () => { M = ID; dress(); });

// keep the sky oval in view: an oval smaller than the area stays inside it and a bigger one covers it, give or take
// 15% of the area. The margin keeps the rule continuous, so zooming around a point never jumps where the oval
// grows past the area. Whatever covers the bottom (the phone's comet sheet) raises the bottom edge.
// Straightened, the margin grows to half the area, so the oval's edge and the poles can come to the middle.
export function set(w, x, y) {
  W = clampW(w);
  const H = W / 2, bot = A.b - (A.inset?.() ?? 0), k = .15 + .35 * fade(W), mx = A.w * k, my = (bot - A.t) * k;
  X = Math.min(Math.max(0, A.w - W) + mx, Math.max(Math.min(0, A.w - W) - mx, x));
  Y = Math.min(Math.max(A.t, bot - H) + my, Math.max(Math.min(A.t, bot - H) - my, y));
  wrap.style.width = W + 'px'; wrap.style.left = X - ox + 'px'; wrap.style.top = Y - oy + 'px';
  wrap.classList.toggle('deep-zoom', W > 1700);   // the ecliptic's label is drawn in the sky, so it grows with the zoom: hidden when close in
  M = straighten(W, X, Y); dress();
  const v = { W, X, Y, zoom: W / A.min, M, C: pivot() };
  for (const fn of listeners) fn(v);
}
export function move(f, x0, y0, x1, y1) { const [u, v] = uvAt(x0, y0), w = clampW(W * f); set(w, ...place(u, v, x1, y1, w)); }
export const zoomAt = (f, px, py) => move(f, px, py, px, py);
export const cancel = () => cancelAnimationFrame(anim);
function run(ms, frame) {   // frame(0..1, eased) once per screen frame; at once with reduced motion
  cancel();
  const t0 = performance.now(), ease = t => 1 - (1 - t) ** 3;
  const step = now => { const t = Math.min(1, (now - t0) / ms); frame(ease(t)); if (t < 1) anim = requestAnimationFrame(step); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) frame(1); else anim = requestAnimationFrame(step);
}
export function glide(w, x, y, ms = 300) {
  const [w0, x0, y0] = [W, X, Y];
  run(ms, e => set(w0 + (w - w0) * e, x0 + (x - x0) * e, y0 + (y - y0) * e));
}
// the sky under (px, py) stays there on every frame of the zoom, whatever the straightening does on the way
export function glideZoom(f, px, py, ms = 250) {
  const [u, v] = uvAt(px, py), w0 = W, w1 = clampW(W * f);
  run(ms, e => { const w = w0 + (w1 - w0) * e; set(w, ...place(u, v, px, py, w)); });
}
export function flyTo(ra, dec, w = W, ms = 400) {
  w = clampW(w);   // centre at the width set() will allow, or a clamped width puts the spot off centre
  const [u, v] = fwd(ra, dec);
  glide(w, A.w / 2 - u * w, (A.t + A.b) / 2 - v * w / 2, ms);   // the middle of the area is the pivot, where the layout needs no correction
}
export const skyAt = (px, py) => inv(...uvAt(px, py));
export const toScreen = (ra, dec) => win(...fwd(ra, dec));
