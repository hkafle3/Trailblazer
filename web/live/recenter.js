// Click, drag and arrow-key re-centring for the time-lapse photo (timelapse.html). It knows nothing of the page's
// layout: the page says how many grid pixels one screen pixel is, draws the photo moved by `pan`, and builds the new
// centre. pan is in grid pixels, right and down, from the centre the frames on screen were built around.
//   scale()         -> [x, y] grid pixels per CSS pixel, or null while there is no photo
//   moved()         the photo moved: redraw it shifted by .pan (sky outside the loaded grid stays empty)
//   commit(pan)     make the spot `pan` from the built centre the new centre (build it, update the URL and the box)
//   idle()          optional: a gesture ended without moving anything (a drag cancelled where it started)
//   zoom(k)         optional: the wheel, a trackpad pinch, two fingers or +/- ask for the field of view k times as wide
//   tap(to)         optional: a click or tap on the spot `to` (the pan that would centre it). Return true to take it:
//                   then nothing moves (the Spectrum card picks a star this way); drags and keys still re-centre.
// The page calls reset() when frames for a new centre land and when another search starts (it also ends a pending
// arrow-key move or a drag still held), and asks moving() before it swaps frames mid-gesture. A second finger turns a drag into a pinch: the drag is
// cancelled (as pointercancel does) and the two fingers zoom until both lift. A press drops a pending arrow-key move.
import { tanDeproject } from './fits.js';

export const TAP = 5;   // CSS px: a press that moves less than this is a click on that spot, not a drag

// the sky position `pan` grid pixels from centre (ra, dec): east is left, north is up, as on the photo
export function panToSky(ra, dec, pan, arcsecPerPixel) {
  const a = arcsecPerPixel / 3600;
  return tanDeproject({ CRVAL1: ra, CRVAL2: dec }, pan[0] * a, pan[1] * a);
}

// The Explore heat map's cell for a spot: worker/src/index.js cellAt(ra % 360, dec), the same arithmetic step for step
// so the floating point agrees at cell edges. 51 bands of Dec, each cut into about 3.5 degree steps of RA. The page posts
// a check only when a result it shows lands in a new cell, so nudging around one spot counts once (and stays under the
// Worker's 10 a minute limit). Returns "band,cell in band".
const BANDS = 51, DEC_STEP = 180 / BANDS, RAD = Math.PI / 180;
export function heatCell(ra, dec) {
  const i = Math.min(BANDS - 1, Math.floor((90 - dec) / DEC_STEP));
  const n = Math.max(1, Math.round(360 * Math.cos((90 - (i + .5) * DEC_STEP) * RAD) / 3.5));
  return `${i},${Math.min(n - 1, Math.floor(ra % 360 / 360 * n))}`;
}

export function recenterable(el, { scale, moved, commit, idle = () => {}, zoom = () => {}, tap = () => false, hint = 'Drag or click to re-center' }) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let pan = [0, 0], grab = null, glide = null, nudge = 0;
  const set = p => { pan = p; moved(); };
  const done = p => {
    el.removeAttribute('title'); try { localStorage.setItem('ch.recenter', '1'); } catch {}
    commit(p);
  };
  // a click eases the photo to the clicked spot (180 ms, none with reduced motion) while the new centre builds
  const ease = to => {
    const from = pan, t0 = performance.now(), ms = calm.matches ? 0 : 180, g = glide = {};
    const step = now => {
      if (glide !== g) return;   // the new frames landed, or another move began
      const k = ms ? Math.min(1, (now - t0) / ms) : 1, e = 1 - (1 - k) ** 3;
      set([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
      if (k < 1) requestAnimationFrame(step);
    };
    step(t0);
  };

  // a cancelled drag goes back to where it started: the photo at once, and that centre is asked for again when it
  // was itself a move still building (frames that landed meanwhile are in the page's cache)
  const cancel = () => {
    const p = grab.pan; grab = null; el.classList.remove('drag');
    set(p);
    if (p[0] || p[1]) done(p); else idle();
  };
  // two fingers zoom: the field narrows as they spread, about the photo's middle. Touch and pen only (a mouse is one).
  const fingers = new Map();
  let spread = 0;   // the fingers' distance at the last move, while two are down
  const apart = () => { const [a, b] = fingers.values(); return Math.hypot(a[0] - b[0], a[1] - b[1]); };

  el.tabIndex = 0;   // Tab to the photo, then the arrow keys move it
  try { if (!localStorage.getItem('ch.recenter')) el.title = hint; } catch {}   // until the first re-centre
  const mine = e => grab && e.pointerId === grab.id;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size === 2) { if (grab) cancel(); el.setPointerCapture(e.pointerId); spread = apart(); return; }
    if (fingers.size > 2 || spread) return;   // a third finger, or one still down after a pinch
    const k = scale();
    if (!k || e.button || grab) return;
    glide = null; clearTimeout(nudge); nudge = 0;   // the photo stays where the keys put it; the press decides from there
    grab = { id: e.pointerId, x: e.clientX, y: e.clientY, pan, moved: 0, k };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (spread && fingers.has(e.pointerId)) {
      fingers.set(e.pointerId, [e.clientX, e.clientY]);
      const d = apart(); if (d > 0) { zoom(spread / d); spread = d; }
      return;
    }
    if (!mine(e)) return;
    const dx = e.clientX - grab.x, dy = e.clientY - grab.y;
    grab.moved = Math.max(grab.moved, Math.hypot(dx, dy));
    if (grab.moved <= TAP) return;
    el.classList.add('drag');
    set([grab.pan[0] + dx * grab.k[0], grab.pan[1] + dy * grab.k[1]]);
  });
  const lift = e => { fingers.delete(e.pointerId); if (!fingers.size) spread = 0; };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
  el.addEventListener('pointerup', e => {
    if (!mine(e)) return;
    const g = grab, b = el.getBoundingClientRect(); grab = null; el.classList.remove('drag');
    el.blur();   // after a pointer the arrow keys step through visits again; Tab to the photo to move it with them
    if (g.moved > TAP) return done(pan);   // a drag: the centre moves by what was dragged
    const to = [g.pan[0] + (b.left + b.width / 2 - e.clientX) * g.k[0], g.pan[1] + (b.top + b.height / 2 - e.clientY) * g.k[1]];
    if (tap(to)) return;
    ease(to); done(to);   // a click or a tap: that spot becomes the centre
  });
  el.addEventListener('pointercancel', e => { if (mine(e)) cancel(); });
  // the wheel zooms, smoothly: pixels, lines or pages, a trackpad's small steps add up, and its pinch (ctrlKey) is
  // stronger per step. Not during a drag, whose grid pixels per screen pixel were fixed when it began.
  el.addEventListener('wheel', e => {
    e.preventDefault();   // over the photo only: the page does not scroll, the browser does not zoom
    if (grab || spread) return;
    const px = e.deltaY * [1, 33, el.clientHeight][e.deltaMode];   // pixels, lines (3 a notch: about Chrome's 100 px) or pages
    zoom(Math.exp(Math.max(-120, Math.min(120, px)) * (e.ctrlKey ? 0.01 : 0.002)));
  }, { passive: false });
  // Safari: a trackpad pinch is a gesture, not a ctrl wheel; on iPhone the fingers above zoom, so it is only stopped
  let pinchScale = 1;
  el.addEventListener('gesturestart', e => { e.preventDefault(); pinchScale = 1; });
  el.addEventListener('gesturechange', e => { e.preventDefault(); if (!fingers.size && e.scale > 0) { zoom(pinchScale / e.scale); pinchScale = e.scale; } });
  el.addEventListener('gestureend', e => e.preventDefault());
  // arrow keys move the view an eighth of its width (Shift: one pixel); the new centre builds once the keys rest.
  // + and - zoom (Ctrl or Cmd with them is the browser's own zoom, left alone).
  el.addEventListener('keydown', e => {
    const z = { '+': 0.8, '=': 0.8, '-': 1.25, '_': 1.25 }[e.key];
    if (z && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); if (!grab) zoom(z); return; }
    const d = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key], k = scale();
    if (!d || !k) return;
    e.preventDefault(); e.stopPropagation();   // not the page scroll, not the page's visit stepping
    if (grab) return;   // a pointer is held: it decides where the centre goes
    const by = e.shiftKey ? 1 : el.getBoundingClientRect().width * k[0] / 8;
    glide = null; set([pan[0] + d[0] * by, pan[1] + d[1] * by]);
    clearTimeout(nudge); nudge = setTimeout(() => { nudge = 0; done(pan); }, 350);
  });

  return {
    get pan() { return pan; },
    // ends everything in progress: the eased move, a pending arrow-key move and a drag still held (its release is ignored)
    reset() {
      glide = null; pan = [0, 0]; clearTimeout(nudge); nudge = 0;
      if (grab) { try { el.releasePointerCapture(grab.id); } catch {} grab = null; el.classList.remove('drag'); }
    },
    moving: () => !!(grab || nudge),
  };
}
