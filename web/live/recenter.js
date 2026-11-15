// Click, drag and arrow-key re-centring for the time-lapse photo (timelapse.html). It knows nothing of the page's
// layout: the page says how many grid pixels one screen pixel is, draws the photo moved by `pan`, and builds the new
// centre. pan is in grid pixels, right and down, from the centre the frames on screen were built around.
//   scale()         -> [x, y] grid pixels per CSS pixel, or null while there is no photo
//   moved()         the photo moved: redraw it shifted by .pan (sky outside the loaded grid stays empty)
//   commit(pan)     make the spot `pan` from the built centre the new centre (build it, update the URL and the box)
// The page calls reset() when frames for a new centre land and when another search starts (it also ends a pending
// arrow-key move or a drag still held), and asks moving() before it swaps frames mid-gesture. One pointer at a time: a second finger is
// ignored until the first lifts.
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

export function recenterable(el, { scale, moved, commit, hint = 'Drag or click to re-center' }) {
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

  el.tabIndex = 0;   // Tab to the photo, then the arrow keys move it
  try { if (!localStorage.getItem('ch.recenter')) el.title = hint; } catch {}   // until the first re-centre
  const mine = e => grab && e.pointerId === grab.id;
  el.addEventListener('pointerdown', e => {
    const k = scale();
    if (!k || e.button || grab) return;
    glide = null;
    grab = { id: e.pointerId, x: e.clientX, y: e.clientY, pan, moved: 0, k };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!mine(e)) return;
    const dx = e.clientX - grab.x, dy = e.clientY - grab.y;
    grab.moved = Math.max(grab.moved, Math.hypot(dx, dy));
    if (grab.moved <= TAP) return;
    el.classList.add('drag');
    set([grab.pan[0] + dx * grab.k[0], grab.pan[1] + dy * grab.k[1]]);
  });
  el.addEventListener('pointerup', e => {
    if (!mine(e)) return;
    const g = grab, b = el.getBoundingClientRect(); grab = null; el.classList.remove('drag');
    el.blur();   // after a pointer the arrow keys step through visits again; Tab to the photo to move it with them
    if (g.moved > TAP) return done(pan);   // a drag: the centre moves by what was dragged
    const to = [g.pan[0] + (b.left + b.width / 2 - e.clientX) * g.k[0], g.pan[1] + (b.top + b.height / 2 - e.clientY) * g.k[1]];
    ease(to); done(to);   // a click or a tap: that spot becomes the centre
  });
  // a cancelled drag goes back to where it started: the photo at once, and that centre is asked for again when it
  // was itself a move still building (frames that landed meanwhile are in the page's cache)
  el.addEventListener('pointercancel', e => {
    if (!mine(e)) return;
    const p = grab.pan; grab = null; el.classList.remove('drag');
    set(p);
    if (p[0] || p[1]) done(p);
  });
  // arrow keys move the view an eighth of its width (Shift: one pixel); the new centre builds once the keys rest
  el.addEventListener('keydown', e => {
    const d = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key], k = scale();
    if (!d || !k) return;
    e.preventDefault(); e.stopPropagation();   // not the page scroll, not the page's visit stepping
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
