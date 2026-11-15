// Explore on desktops (wider than 640px): pan and zoom the way map apps do, on the engine in explore-view.js.
// A press that moves less than 5 px is a click (a pin on the sky, or a marker's page, as before); one that moves further
// is a drag that pans, and its release clicks nothing. The wheel and trackpad zoom around the pointer, a double click
// zooms in 2x, and the +, - and whole-sky buttons (bottom right) or the + - 0 and arrow keys do the same.
// The whole sky is the oval where the page's CSS puts it; nothing here writes to the page until the first pan or zoom.
import { W, X, Y, A, hooks, measure, set, zoomAt, glide, glideZoom, cancel, onView, atMin, atMax } from './explore-view.js';
import { restore } from './explore-dive.js';   // back from a time-lapse, or a reload: the map where it was

const phone = matchMedia('(max-width: 640px)');
const $ = id => document.getElementById(id);
const stage = document.querySelector('.xstage'), wrap = document.querySelector('.map-wrap'), map = $('map');
const desk = () => !phone.matches;

// the whole sky, and the map area: under the header, above the timeline. Measured from layout (offsetLeft and so on),
// so the map's scale-in animation does not throw it off.
let on = false;
function area() {
  const s = stage.getBoundingClientRect();
  return { w: innerWidth, t: document.querySelector('.topbar').getBoundingClientRect().bottom, b: $('tl').getBoundingClientRect().top,
    min: wrap.offsetWidth, x0: s.left + wrap.offsetLeft, y0: s.top + wrap.offsetTop };
}
function begin() {   // before the first pan or zoom: start from the oval the CSS placed
  if (!on) { for (const p of ['width', 'left', 'top']) wrap.style[p] = ''; measure(area()); set(A.min, A.x0, A.y0); on = true; }
  cancel(); hooks.stop();
}
const whole = (ms = 300) => glide(A.min, A.x0, A.y0, ms);
const mid = () => [A.w / 2, (A.t + A.b) / 2];

onView(() => {
  if (!desk()) return;
  document.body.classList.toggle('zoomed', !atMin());
  $('zoom-out').disabled = $('zoom-whole').disabled = atMin();
  $('zoom-in').disabled = atMax();
});
function controls(min = true) { $('zoom-out').disabled = $('zoom-whole').disabled = min; $('zoom-in').disabled = false; }
phone.addEventListener('change', () => {   // the phone file takes .map-wrap over, or hands it back as the CSS oval
  cancel(); drop(); on = false;
  document.body.classList.remove('zoomed'); controls();
});
addEventListener('resize', () => {   // keep the zoom and the middle of the view
  if (!desk() || !on) return;
  cancel();
  const z = W / A.min, [mx, my] = mid(), u = (mx - X) / W, v = (my - Y) / W;
  for (const p of ['width', 'left', 'top']) wrap.style[p] = '';
  measure(area());
  const w = A.min * z, [nx, ny] = mid();
  set(w, nx - u * w, ny - v * w);
});

// ---- click or drag: the pointer is captured only once a press becomes a drag, so clicks keep their targets ----
let press = null, swallowUntil = 0;
function drop() {   // end a press without a click
  if (press?.drag) { stage.releasePointerCapture?.(press.id); document.body.classList.remove('grabbing'); }
  press = null;
}
stage.addEventListener('pointerdown', e => {
  if (!desk() || e.button || e.target.closest('.tl, .pincard')) return;
  press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, drag: false };
  if (e.target.closest('#map')) map.focus({ preventScroll: true });   // so the keys work after a click on the sky
});
addEventListener('pointermove', e => {
  if (!press || e.pointerId !== press.id) return;
  if (!desk()) return drop();
  if (!press.drag) {
    if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) < 5) return;
    press.drag = true; begin();
    stage.setPointerCapture(e.pointerId); document.body.classList.add('grabbing');
  }
  set(W, X + e.clientX - press.lx, Y + e.clientY - press.ly);
  press.lx = e.clientX; press.ly = e.clientY;
});
addEventListener('pointerup', e => {
  if (!press || e.pointerId !== press.id) return;
  if (press.drag) {
    swallowUntil = performance.now() + 300;   // the click this release makes, if any
    if (atMin()) whole(200);   // the whole sky springs back to its place
  }
  drop();
});
addEventListener('pointerdown', () => { swallowUntil = 0; }, true);   // a new press is a new click
addEventListener('pointercancel', e => { if (press && e.pointerId === press.id) drop(); });
addEventListener('click', e => { if (performance.now() < swallowUntil) { swallowUntil = 0; e.preventDefault(); e.stopPropagation(); } }, true);   // a drag's release is not a click
// links and the sky picture would start the browser's own drag-and-drop
stage.addEventListener('dragstart', e => { if (desk()) e.preventDefault(); });

// ---- wheel and trackpad: zoom around the pointer. Lines and pages are turned into pixels; a trackpad pinch arrives as
// a wheel with ctrlKey and small deltas, so it zooms faster per pixel. The page itself never scrolls on desktop. ----
stage.addEventListener('wheel', e => {
  if (!desk() || e.target.closest('.tl')) return;
  e.preventDefault(); begin();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  zoomAt(Math.exp(-Math.max(-300, Math.min(300, dy)) * (e.ctrlKey ? .01 : .002)), e.clientX, e.clientY);
}, { passive: false });

// a double click zooms in 2x there. Its first click dropped a pin; explore.js puts the pin back as it was.
stage.addEventListener('dblclick', e => {
  if (!desk() || !e.target.closest('#map')) return;
  begin(); glideZoom(2, e.clientX, e.clientY);
});

// ---- buttons and keys ----
const step = f => { begin(); glideZoom(f, ...mid()); };
$('zoom-in').addEventListener('click', () => step(1.5));
$('zoom-out').addEventListener('click', () => step(1 / 1.5));
$('zoom-whole').addEventListener('click', () => { begin(); whole(); });
addEventListener('keydown', e => {
  const a = document.activeElement;
  if (!desk() || e.metaKey || e.ctrlKey || e.altKey || (a !== document.body && a !== map)) return;
  const k = e.key, d = e.shiftKey ? 300 : 100;
  if (k === '+' || k === '=') step(1.5);
  else if (k === '-' || k === '_') step(1 / 1.5);
  else if (k === '0') { begin(); whole(); }
  else if (k.startsWith('Arrow')) {
    begin();
    const [dx, dy] = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[k];
    glide(W, X + dx, Y + dy, 150);
  } else return;
  e.preventDefault();
});

// a zoomed view kept in this history entry (explore-dive.js) is put back as the page opens
if (desk() && history.state?.view?.zoom > 1.001) {
  begin(); restore();
  // the timeline is still rising into place (its top edge is the map area's bottom): once it has, measure and place again
  const was = [W, X, Y];
  $('tl').addEventListener('animationend', () => { if (on && desk() && W === was[0] && X === was[1] && Y === was[2]) { measure(area()); restore(); } }, { once: true });
}
