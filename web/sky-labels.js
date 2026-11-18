// Place names on the Explore map, shown by zoom the way map apps do (approved mockup: design notes in
// comet-hunt-work/sky-labels-plan/plan.md). Data: data/labels.json (bake/sky_labels.py).
//   whole sky   the Milky Way (curved, in the map's SVG like the ecliptic's label), the Magellanic Clouds, Andromeda
//   5 to 45     the 88 constellations, big ones first (px per degree 5, 7.5, 10 by rank), and their IAU borders from 4.5
//   18 to 40    famous objects and the star-forming clouds
//   60          named stars (IAU WGSN), brightest first
//   any zoom    nothing placed in view: the constellation under the middle of the view, faint at the top of the map
// Names are anchored like markers (percent of .map-wrap, undoing the straightening with --un), so they sit on their real
// sky position. They take no pointer events: clicks, drags and double clicks reach the map as before, and hover is a hit
// test on the boxes below.
//
// One layout pass per frame (layout()), after any change that can move a name or what it must avoid: a pan or zoom, a
// resize, fonts arriving, markers, cards or the pin changing (a MutationObserver on #marks, which also catches the
// timeline's ticks and the marker declutters), the search list, the phone sheet, Layers or Examples opening.
// It reads every rectangle it needs in one batch, works out each name's box with arithmetic (its anchor from the view
// engine's win(), its side offset and its size measured once), then writes only the classes that changed.
// Most important first: giant, constellation, cloud, object, star (then by rank or magnitude). A point name tries right,
// then left; an area name tries middle, below, above, left, right, further below. A name is dropped when it comes within
// 4 px of anything already there, leaves the window, or crosses the top bar or the timeline.
// The two cards that hang off a marker (#card-comet, #card-cand) are placed in the same pass, before the names: where
// the card is now while it still fits, else the default side (left near the map's right edge), then the other side,
// then under the marker, so they never sit under the fixed controls (the Flat / 3D switch, the search box). A card that
// fits nowhere keeps its default side.
import { fwd, fwdLon, wrap, RAD } from './skymap.js';
import * as view from './explore-view.js';
import { constellationAt, constellationName } from './sky-place.js';

const $ = id => document.getElementById(id);
const wrapEl = document.querySelector('.map-wrap'), map = $('map'), marks = $('marks');
const data = await fetch('data/labels.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
const PAD = 4, EDGE = 4, BAR = 8;

// ---- borders and the Milky Way: paths in the map's 2000 x 1000 SVG, lifted where a piece crosses the map's seam ----
let mwText = null, borderEl = null;
if (data) {
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1); };
  let d = '';
  for (const piece of data.borders) {
    let prev = null;
    for (let i = 0; i < piece.length; i += 2) {
      const lon = wrap(-piece[i]);
      d += (prev === null || Math.abs(lon - prev) > 180 ? 'M' : 'L') + P(lon, piece[i + 1]);
      prev = lon;
    }
  }
  const svg = map.querySelector('.grat'), NS = 'http://www.w3.org/2000/svg', path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'cbound'); path.setAttribute('d', d); borderEl = path;
  svg.insertBefore(path, $('ecl'));
  // the galactic equator (b = 0) across Cassiopeia, where it runs flat, as the path the name follows
  const ngpRa = 192.85948 * RAD, ngpDec = 27.12825 * RAD, lNcp = 122.93192 * RAD, pts = [];
  for (let l = 150; l >= 96; l--) {
    const L = lNcp - l * RAD, dec = Math.asin(Math.cos(ngpDec) * Math.cos(L)), ra = ngpRa + Math.atan2(Math.sin(L), -Math.sin(ngpDec) * Math.cos(L));
    pts.push(P(wrap(-ra / RAD), dec / RAD));
  }
  const mw = document.createElementNS(NS, 'path');
  mw.id = 'mw'; mw.setAttribute('class', 'mw-path'); mw.setAttribute('d', 'M' + pts.join('L'));
  svg.append(mw);
  svg.insertAdjacentHTML('beforeend', '<text class="mw-text"><textPath href="#mw" startOffset="50%" text-anchor="middle">Milky Way</textPath></text>');
  mwText = svg.lastElementChild;
}

// ---- names ----
const KIND = { giant: 0, constellation: 1, cloud: 2, object: 3, star: 4 };
const CMIN = { 1: 5, 2: 7.5, 3: 10 }, CMAX = 45, STAR = 60;
const POINT = ['right', 'left'], AREA = ['mid', 'below', 'above', 'left', 'right', 'below2'];
const labels = data ? [
  ...data.constellations.map(c => ({ ...c, kind: 'constellation', min: CMIN[c.rank], max: CMAX })),
  ...data.objects.map(o => (o.kind === 'star' ? { ...o, min: STAR, max: null } : o)),
].sort((a, b) => KIND[a.kind] - KIND[b.kind] || (a.rank ?? a.mag ?? 0) - (b.rank ?? b.mag ?? 0)) : [];
const layer = Object.assign(document.createElement('div'), { className: 'skylabels' });
layer.setAttribute('aria-hidden', 'true');
marks.before(layer);
for (const l of labels) {
  const a = document.createElement('div');
  [l.u, l.v] = fwd(l.ra, l.dec);
  a.className = `lb k-${l.kind} off`; a.style.left = l.u * 100 + '%'; a.style.top = l.v * 100 + '%';
  if (l.kind === 'object') a.append(document.createElement('i'));
  a.append(Object.assign(document.createElement('span'), { textContent: l.name }));
  Object.assign(l, { el: a, span: a.lastChild, sides: l.kind === 'object' || l.kind === 'star' ? POINT : AREA, side: null, shown: false });
}
// the deep-zoom name: fixed at the top middle of the map, outside .map-wrap so the straightening never turns it
const pinned = Object.assign(document.createElement('div'), { className: 'lb k-constellation skypin off' });
pinned.setAttribute('aria-hidden', 'true');
pinned.append(document.createElement('span'));
document.body.append(pinned);

let sized = false;
// Only the names shown are in the page: hundreds more under .map-wrap would each be restyled on every frame of a pan or
// zoom (the straightening's --un changes on .map-wrap). They are put in once to be measured.
function measure() {   // each name's size, once (and again when the fonts arrive)
  const out = labels.filter(l => !l.el.isConnected);
  layer.classList.add('measuring'); layer.append(...out.map(l => l.el));
  for (const l of labels) { l.w = l.span.offsetWidth; l.h = l.span.offsetHeight; }
  for (const l of out) l.el.remove();
  layer.classList.remove('measuring');
  sized = labels.length > 0;
}
// a name's box in window px for a side, from its anchor (x, y): the offsets are sky-labels.css's
function box(l, side, x, y) {
  const { w, h } = l;
  switch (side) {
    case 'mid': return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
    case 'below': return [x - w / 2, y + 7, x + w / 2, y + 7 + h];
    case 'above': return [x - w / 2, y - 7 - h, x + w / 2, y - 7];
    case 'below2': return [x - w / 2, y + 21, x + w / 2, y + 21 + h];
    case 'right': return [x + 9, y - h / 2, x + 9 + w, y + h / 2];
    default: return [x - 9 - w, y - h / 2, x - 9, y + h / 2];   // left
  }
}
const hit = (r, o, pad = PAD) => r[0] - pad < o[2] && o[0] - pad < r[2] && r[1] - pad < o[3] && o[1] - pad < r[3];
const rect = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
const visible = e => !e.closest('[style*="visibility: hidden"]');   // markers not yet on the timeline's day (explore.js showByDay)
const rects = sel => [...document.querySelectorAll(sel)].filter(visible).map(rect).filter(r => r[2] > r[0] && r[3] > r[1]);   // display: none gives an empty box

// what names must keep clear of: the markers and their names, the pin, the controls over the map, the open panels
const MARKS = '#card-patch, #pin:not([hidden]) .pincard, #pin:not([hidden]) .pin-ring';   // and each marker near the view, below
const CONTROLS = '.xsearch, #xs-panel:not([hidden]), .viewsw, .zoomctl, .xbtns > *, .layers[open] > .layers-body, #csheet:not([hidden]), #dive-aim:not([hidden]) .aim-box, #dive-aim:not([hidden]) .aim-go, #maphint:not([hidden]), #zoomlvl:not([hidden]), #t-date, .tl-knob';
// the cards: [right, left] as [dx, dy] from the marker (styles.css, explore.css, candidates.css); under it is BELOW px down
const CARDS = [['card-comet', [28, -30], [-278, -30]], ['card-cand', [-12, 16], [-258, 16]]].map(([id, r, l]) => ({ id, right: r, left: l }));
const BELOW = 24;
// where a card under its marker can sit across: centred, then just clear of each control's side, nearest the centre
// first; always with the marker over the card (20 px in from either end) so the rule meets it
const belowAt = (x, w, fixed) => [-w / 2, ...fixed.flatMap(o => [o[2] + PAD + 1 - x, o[0] - PAD - 1 - w - x])]
  .filter(dx => dx <= -20 && dx >= 20 - w).sort((a, b) => Math.abs(a + w / 2) - Math.abs(b + w / 2));

let placed = [];   // [box, label] for the hover test
// The controls and the top bar and timeline edges do not move with the map: read again only when something other than a
// pan or zoom asked for this pass (a resize, a panel, a marker change), so a glide reads only the markers near the view.
let still = null, fresh = true;
function layout() {
  q = 0;
  if (document.body.dataset.view === '3d') return;
  if (!sized && labels.length && document.fonts.status === 'loaded') measure();
  // ---- read ----
  const vw = innerWidth, vh = innerHeight, k = wrapEl.offsetWidth / 360;
  if (fresh || !still) still = { top: document.querySelector('.topbar').getBoundingClientRect().bottom, bot: $('tl').getBoundingClientRect().top - BAR,
    fixed: rects(CONTROLS), topbar: rect(document.querySelector('.topbar')) };
  fresh = false;
  const { top, bot, fixed: fixed0, topbar } = still, fixed = [...fixed0];
  const str = view.straight(), mr = wrapEl.getBoundingClientRect();
  const at = (u, v) => (str ? view.win(u, v) : [mr.left + u * mr.width, mr.top + v * mr.height]);
  const taken = rects(MARKS);
  for (const m of marks.querySelectorAll('.mk:not([hidden])')) {   // markers near the view only: at a deep zoom most are far off
    const [x, y] = at(parseFloat(m.style.left) / 100, parseFloat(m.style.top) / 100);
    if (x < -300 || x > vw + 300 || y < top - 100 || y > bot + 100 || !visible(m)) continue;
    for (const e of m.children) if (e.tagName === 'I' || e.tagName === 'B') { const r = rect(e); if (r[2] > r[0] && r[3] > r[1]) taken.push(r); }
  }
  const cards = CARDS.map(c => ({ ...c, el: $(c.id) })).filter(c => c.el && !c.el.hidden && c.el.offsetWidth && visible(c.el))
    .map(c => ({ ...c, w: c.el.offsetWidth, h: c.el.offsetHeight, u: parseFloat(c.el.style.left) / 100, v: parseFloat(c.el.style.top) / 100 }));
  const mwBox = mwText && !wrapEl.classList.contains('deep-zoom') ? rect(mwText) : null;

  // ---- cards: off the controls, inside the window ----
  const cardWrites = [];
  for (const c of cards) {
    const [x, y] = at(c.u, c.v), def = c.u > 0.75 ? 'left' : 'right';
    const tries = [[def, c[def][0], c[def][1]], [def === 'left' ? 'right' : 'left', ...c[def === 'left' ? 'right' : 'left']],
      ...belowAt(x, c.w, fixed).map(dx => ['below', dx, BELOW])];
    const fits = ([, dx, dy]) => { const b = [x + dx, y + dy, x + dx + c.w, y + dy + c.h]; return b[0] >= 0 && b[2] <= vw && b[3] <= vh && ![...fixed, topbar].some(o => hit(b, o)); };
    // where it is now comes first while it still fits, so a pan or a timeline tick never makes it jump sides
    const cl = c.el.classList, now = cl.contains('below') ? ['below', parseFloat(c.el.style.getPropertyValue('--bx')), BELOW] : cl.contains('left') ? ['left', ...c.left] : ['right', ...c.right];
    const same = c.el.dataset.at === c.el.style.left + c.el.style.top;   // the same spot as last time (a pan or zoom, not a new comet or day)
    const pick = (same && Number.isFinite(now[1]) && fits(now) ? now : null) ?? tries.find(fits) ?? tries[0];
    cardWrites.push([c.el, pick, c.el.style.left + c.el.style.top]);
    taken.push([x + pick[1], y + pick[2], x + pick[1] + c.w, y + pick[2] + c.h]);
  }
  taken.push(...fixed);

  // ---- the Milky Way: hidden where it would cover a marker, a card or a control ----
  let mwOn = false;
  if (mwBox && mwBox[2] > mwBox[0]) { mwOn = !taken.some(o => hit(mwBox, o, 2)); if (mwOn) taken.push(mwBox); }

  // ---- names ----
  const out = [], inView = (b) => b[0] >= EDGE && b[2] <= vw - EDGE && b[1] >= top && b[3] <= bot;
  placed = [];
  for (const l of labels) {
    let side = null;
    if (sized && k >= l.min && (l.max == null || k < l.max)) {
      const [x, y] = at(l.u, l.v);
      if (x > -l.w - 20 && x < vw + l.w + 20 && y > top - 40 && y < bot + 40) {
        for (const s of l.sides) {
          const b = box(l, s, x, y);
          if (!inView(b) || taken.some(o => hit(b, o))) continue;
          taken.push(b); placed.push([b, l]); side = s;
          if (l.kind === 'object') taken.push([x - 3.5, y - 3.5, x + 3.5, y + 3.5]);   // its ring
          break;
        }
      }
    }
    out.push([l, side]);
  }
  // nothing placed (zoomed in, between the zooms where names show, or on empty sky): the constellation under the middle
  let pin = null;
  if (sized && !placed.length && view.A && !view.atMin()) {
    const cx = view.A.w / 2, sky = view.skyAt(cx, (view.A.t + view.A.b) / 2);
    if (sky) {
      const name = constellationName(constellationAt(...sky)), s = pinned.firstChild;
      if (s.textContent !== name) { s.textContent = name; pinned.classList.add('measuring'); pinned.dataset.w = s.offsetWidth; pinned.dataset.h = s.offsetHeight; pinned.classList.remove('measuring'); }
      const w = +pinned.dataset.w, h = +pinned.dataset.h;
      for (const y of [top + 14, top + 48, top + 82]) {
        const b = [cx - w / 2, y, cx + w / 2, y + h];
        if (!inView(b) || taken.some(o => hit(b, o))) continue;
        pin = [cx, y]; placed.push([b, null]); break;
      }
    }
  }

  // ---- write: only what changed ----
  const bound = Math.max(0, Math.min(1, (k - 4.5) / 4)).toFixed(2);   // borders fade in from 4.5 to 8.5 px per degree
  if (borderEl && borderEl.style.opacity !== bound) borderEl.style.opacity = bound;   // on the path itself: a property on .map-wrap would restyle everything in it
  for (const [el, [side, dx], spot] of cardWrites) {
    if (el.dataset.at !== spot) el.dataset.at = spot;
    el.classList.toggle('left', side === 'left'); el.classList.toggle('below', side === 'below');
    const bx = side === 'below' ? Math.round(dx) + 'px' : '';
    if (el.style.getPropertyValue('--bx') !== bx) el.style.setProperty('--bx', bx);
  }
  if (mwText) mwText.classList.toggle('mw-off', !mwOn);
  for (const [l, side] of out) {
    if (side === l.side) continue;
    l.side = side;
    l.el.classList.toggle('off', side === null);
    if (side) { l.el.dataset.side = side; if (!l.el.isConnected) layer.append(l.el); } else l.el.remove();
  }
  pinned.classList.toggle('off', !pin);
  if (pin && (pinned.style.left !== pin[0] + 'px' || pinned.style.top !== pin[1] + 'px')) { pinned.style.left = pin[0] + 'px'; pinned.style.top = pin[1] + 'px'; }
}

let q = 0;
const soon = () => { fresh = true; if (!q) q = requestAnimationFrame(layout); };
view.onView(() => { if (!q) q = requestAnimationFrame(layout); });   // a pan or zoom: the controls have not moved
addEventListener('resize', soon);
wrapEl.addEventListener('animationend', soon);   // the map's scale-in moves the whole sky without a view change
document.fonts.ready.then(() => { if (labels.length) measure(); soon(); });
const watch = { attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open', 'data-detent', 'data-view'] };
new MutationObserver(soon).observe(marks, { ...watch, subtree: true });
for (const e of [$('csheet'), $('dive-aim'), $('maphint'), $('zoomlvl'), $('t-date'), ...document.querySelectorAll('details.layers')]) if (e) new MutationObserver(soon).observe(e, watch);
new MutationObserver(soon).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-view'] });
const panel = $('xs-panel');   // search.js adds it; this module may run first
if (panel) new MutationObserver(soon).observe(panel, watch); else new MutationObserver((m, o) => { const p = $('xs-panel'); if (p) { o.disconnect(); new MutationObserver(soon).observe(p, watch); soon(); } }).observe(document.body, { childList: true });
marks.addEventListener('pointerover', soon); marks.addEventListener('pointerout', soon);   // a known comet's name shows on hover
document.addEventListener('change', soon);   // a Layers switch shows or hides markers with :has(), which changes no attribute
soon();

// ---- hover: a little brighter under the pointer ----
let hov = null;
const hover = l => { if (l === hov) return; hov?.el.classList.remove('hover'); hov = l; hov?.el.classList.add('hover'); };
map.addEventListener('pointermove', e => { const p = placed.find(([b, l]) => l && e.clientX >= b[0] - 2 && e.clientX <= b[2] + 2 && e.clientY >= b[1] - 2 && e.clientY <= b[3] + 2); hover(p?.[1] ?? null); });
map.addEventListener('pointerleave', () => hover(null));

window.skyLabels = { layout, labels, placed: () => placed.map(([, l]) => l?.name ?? pinned.textContent) };   // the tests read these
