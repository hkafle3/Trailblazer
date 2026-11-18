// Explore's search box (Ed's pick: desktop A, phone A; search-mockups/notes.md).
// Desktop: Ming's .f-search at the top left, over Examples and Layers; suggestions open under it in his panel.
// Phone: a search button in the row above the timeline opens the box at the top of the screen, where the keyboard never
// covers it; a result closes the list and leaves the box there with what was found, and a clear button.
// What it finds, in order: our own list as you type (the comets on the map, the five Examples targets), RA and Dec as
// you type, then CDS Sesame (any star or galaxy name) on Enter when nothing local matched.
// A comet opens its card (desktop) or sheet (phone) where its JPL path has it on the timeline's day; a target, a star
// or coordinates drop the pin card with "Look closer". The address keeps the search: /explore?q=269.45+4.69.
// Keys: / or Cmd+K focuses the box, arrows move through the suggestions, Enter picks, Escape closes.
import { trackAt } from './skymap.js';
import { flyTo as viewFly, W, A, hooks as view } from './explore-view.js';
import { flyTo as deskFly } from './explore-desktop.js';
import { TARGETS, parse, matchLocal, matchPlaces, sep, sesameRaDec } from './search-core.js';

const phone = matchMedia('(max-width: 640px)');
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ARROW = svg('<path d="M4 12h16M14 6l6 6-6 6"/>');
const EXAMPLES = '<code>269.45 4.69</code> or <code>17h57m48s +04d41m36s</code>';
const day = () => +$('time').value;
const f2 = x => (Math.abs(x) + 1e-9).toFixed(2);   // halves round away from zero: 133.795 reads 133.80, as the challenge writes it
const radec = (ra, dec) => `RA ${f2(ra)}° Dec ${dec < 0 ? '-' : '+'}${f2(dec)}°`;

// ---- the markup: the box (outside the map, so drags and the wheel never reach it), its panel, the phone's dim and button ----
document.body.insertAdjacentHTML('beforeend', `
<form class="f-search xsearch" id="xsearch" role="search" novalidate>
  <svg class="f-search-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
  <button class="xs-back" id="xs-back" type="button" aria-label="Back to the map">${svg('<path d="M15 5l-7 7 7 7"/>')}</button>
  <input id="xs-q" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Comet, star, or RA Dec"
    role="combobox" aria-label="Search the sky: a comet, a star, or RA and Dec" aria-expanded="false" aria-controls="xs-list" aria-autocomplete="list">
  <button class="xs-clear" id="xs-clear" type="button" aria-label="Clear" hidden>${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
</form>
<div class="xs-panel" id="xs-panel" hidden><div id="xs-list" role="listbox" aria-label="Suggestions"></div><div class="xs-msg" id="xs-msg" aria-live="polite"></div></div>
<div class="xs-dim" id="xs-dim"></div>`);
const form = $('xsearch'), input = $('xs-q'), panel = $('xs-panel'), list = $('xs-list'), msg = $('xs-msg'), clear = $('xs-clear');
const opener = Object.assign(document.createElement('button'), { type: 'button', className: 'xs-open', id: 'xs-open', innerHTML: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>') });
opener.setAttribute('aria-label', 'Search');
$('whole').before(opener);

let hooks = { showPin() {}, feature() {} }, rows = [], active = -1, look = null;   // look: the Sesame state for the text in the box
const markers = () => [...document.querySelectorAll('#marks .mk')].filter(m => m.comet);
const where = c => (trackAt(c.track, day()) ?? [c.ra, c.dec]).slice(0, 2);   // trackAt adds the magnitude
// the sky's own names (data/labels.json, as sky-labels.js shows them): the 88 constellations by name or abbreviation, then
// famous objects and clouds, then named stars, brightest first. A pick flies to a zoom where that name shows on the map.
let places = [];
const placesIn = fetch('data/labels.json').then(r => (r.ok ? r.json() : null)).then(d => {
  if (!d) return;
  const seen = new Set(), CMIN = { 1: 5, 2: 7.5, 3: 10 };
  places = [...d.constellations.map(c => ({ ...c, kind: 'constellation', aka: [c.id], min: CMIN[c.rank], max: 45 })), ...d.objects.filter(o => o.kind !== 'star'), ...d.objects.filter(o => o.kind === 'star').map(o => ({ ...o, min: 60 }))]
    .filter(p => !seen.has(p.name) && seen.add(p.name));   // one row per name
  if (!panel.hidden) render();
}).catch(() => {});
const KIND_WORD = { constellation: 'constellation', star: 'star', cloud: 'cloud' };

// ---- the suggestions ----
// rows: what Enter or a click can pick. { kind: 'coord' | 'target' | 'comet' | 'sesame', ... }
function render() {
  const q = input.value.trim(), p = q ? parse(q) : null, m = matchLocal(q, markers().map(k => k.comet));
  rows = [];
  let html = '', note = '';
  const row = (r, icon, label, side = '', go = false) => {
    rows.push(r);
    return `<div class="xs-row" role="option" id="xs-o${rows.length - 1}" data-i="${rows.length - 1}" aria-selected="false">${icon}<span class="t">${label}</span>${side}${go ? `<span class="go" aria-hidden="true">${ARROW}</span>` : ''}</div>`;
  };
  const group = (name, body) => (body ? `<div role="group" aria-label="${name}"><h4 aria-hidden="true">${name}</h4>${body}</div>` : '');
  const bold = (s, a, b) => esc(s.slice(0, a)) + '<b>' + esc(s.slice(a, b)) + '</b>' + esc(s.slice(b));
  const cross = '<span class="k k-cross"><i></i></span>', ring = '<span class="k k-ring"></span>';
  const dot = c => `<span class="k k-dot" style="--c:var(--${c.kind === 'known' ? 'known' : 'comet'})"></span>`;
  const targetRow = (t, label, side) => row({ kind: 'target', t }, ring, label, side);
  const cometRow = (c, label, side) => row({ kind: 'comet', c }, dot(c), label, side);
  const hint = `<div class="xs-row quiet">${cross}<span class="t">Or type RA Dec, like 269.45 4.69</span></div>`;
  const pl = p?.ra != null ? [] : matchPlaces(q, places);
  const local = m.targets.length + m.comets.length + pl.length;

  if (look?.q === q && look.state !== 'done') note = look.state === 'looking' ? '<p>Looking in star catalogs…</p>'
    : look.state === 'none' ? `<p>Nothing called "${esc(q)}".</p><p class="help">We checked our comets, the five example targets and the SIMBAD star catalog. Try a name like <code>3I/ATLAS</code>, or RA and Dec like <code>269.45 4.69</code>.</p>`
    : `<p>The star catalog did not answer.</p><p class="help">Try again in a moment, or type RA and Dec like <code>269.45 4.69</code>.</p>`;
  else if (!q) {   // empty: the five targets, and how to type coordinates
    html = group('TARGETS', TARGETS.map(t => targetRow(t, esc(t.name))).join('')) + group('COORDINATES', hint);
  } else if (p?.ra != null) {   // coordinates first, then a target at that spot, then the nearest comet on the timeline's day
    html = group('COORDINATES', row({ kind: 'coord', ra: p.ra, dec: p.dec, q }, cross, radec(p.ra, p.dec), '', true));
    html += group('TARGETS', TARGETS.filter(t => sep(t.ra, t.dec, p.ra, p.dec) < 0.5).map(t => targetRow(t, esc(t.name), '<span class="s">at this spot</span>')).join(''));
    const near = markers().map(k => k.comet).map(c => [c, sep(...where(c), p.ra, p.dec)]).sort((a, b) => a[1] - b[1])[0];
    if (near) html += group('COMETS', cometRow(near[0], esc(near[0].id), `<span class="s">${near[1] < 1 ? near[1].toFixed(1) : Math.round(near[1])}° away</span>`));
  } else if (p && !local) {   // numbers, but not a place yet: say which number is wrong, or what is missing
    note = p.error ? `<p>${esc(p.error)}</p><p class="help">${esc(p.help)}<br>${EXAMPLES}</p>`
      : `<p>That reads as RA ${f2(p.half)}°. Add the Dec.</p><p class="help">Type RA, then Dec: <code>08h55m10.8s -07d14m42s</code> or <code>133.80 -7.25</code></p>`;
    // letters too: it may be a catalog name that reads like numbers ("1H 0323+342"), so the star catalogs stay one Enter away
    if (p.error && /[a-z]/i.test(q)) html = group('STAR CATALOGS', row({ kind: 'sesame', q }, ring, `Look up "${esc(q)}"`, '<span class="s">SIMBAD</span>', true));
  } else {   // a name: our targets and comets, the matched part in bold; else the star catalogs on Enter
    // the sky's names (rows are numbered as they are drawn, so each group is drawn in the order it shows)
    const sky = () => group('PLACES', pl.map(x => row({ kind: 'place', p: x.p }, ring, x.label === x.p.name ? bold(x.label, x.s, x.e) : esc(x.p.name),
      `<span class="s">${x.label === x.p.name ? KIND_WORD[x.p.kind] ?? '' : bold(x.label, x.s, x.e)}</span>`)).join(''));
    const exact = pl[0] && pl[0].rank < Math.min(m.targets[0]?.rank ?? 9, m.comets[0]?.rank ?? 9);   // "Ori" is Orion before any comet with ori in it
    html = exact ? sky() : '';
    html += group('TARGETS', m.targets.map(x => targetRow(x.t, x.label === x.t.name ? bold(x.label, x.s, x.e) : esc(x.t.name), x.label === x.t.name ? '' : `<span class="s">${bold(x.label, x.s, x.e)}</span>`)).join(''));
    html += group('COMETS', m.comets.map(x => cometRow(x.c, bold(x.c.id, x.s, x.e), x.c.co2 === 'detected' ? '<span class="s hot">CO2 glow</span>' : '')).join(''));
    if (!exact) html += sky();
    if (!local) html += group('STAR CATALOGS', row({ kind: 'sesame', q }, ring, `Look up "${esc(q)}"`, '<span class="s">SIMBAD</span>', true));
    html += group('COORDINATES', hint);
  }
  list.innerHTML = html; msg.innerHTML = note;
  msg.hidden = !note;
  setActive(rows.length ? 0 : -1);
  show(true);
}
function setActive(i) {
  active = i;
  for (const el of list.querySelectorAll('[data-i]')) { const on = +el.dataset.i === i; el.classList.toggle('on', on); el.setAttribute('aria-selected', on); }
  const el = $(`xs-o${i}`);
  if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
}
function show(on) {
  panel.hidden = !on;
  input.setAttribute('aria-expanded', on && rows.length > 0);
  clear.hidden = !input.value && !document.body.classList.contains('xs-found');
}

// ---- picking: fly there, then the comet's card or sheet, or the pin card ----
function fly(ra, dec) {
  if (!phone.matches) return deskFly(ra, dec, 4);
  if (A) viewFly(ra, dec, Math.max(W, A.min * 4), 600);
}
function pick(r) {
  if (!r) return;
  if (r.kind === 'sesame') return lookUp(r.q);
  let text = input.value.trim();
  const pin = (ra, dec, name, href) => {
    if (phone.matches && !$('csheet').hidden) $('csheet').querySelector('.sheet-x').click();   // a comet's sheet would cover the pin card
    fly(ra, dec); hooks.showPin(ra, dec, name, href);
  };
  if (r.kind === 'comet') {
    view.stop();   // the replay stops, so the comet stays where it was found (a place or a star keeps it playing)
    const mk = markers().find(k => k.comet === r.c);
    text = r.c.id;
    if (phone.matches) mk?.click();   // explore-phone.js opens its sheet and glides it into view
    else { hooks.feature(r.c, mk); fly(...where(r.c)); }
  } else if (r.kind === 'place') {   // fly to a zoom where its name shows
    const k = Math.min(Math.max(8, r.p.min * 1.15), (r.p.max ?? Infinity) * 0.9), w = k * 360;
    text = r.p.name;
    if (phone.matches && !$('csheet').hidden) $('csheet').querySelector('.sheet-x').click();
    if (!phone.matches) deskFly(r.p.ra, r.p.dec, 1);   // starts the desktop engine; its own flyTo never zooms out
    if (A) viewFly(r.p.ra, r.p.dec, w, 600);
    if (r.p.kind !== 'constellation') hooks.showPin(r.p.ra, r.p.dec, r.p.name);   // a star or an object: its pin card opens the time-lapse there
  } else if (r.kind === 'target') {
    text = r.t.name;
    pin(r.t.ra, r.t.dec, r.t.name, `timelapse.html?target=${r.t.key}`);
  } else pin(r.ra, r.dec, r.name);   // coordinates, or a star from Sesame
  input.value = text;
  const u = new URL(location.href); u.searchParams.set('q', text); history.replaceState(history.state, '', u);
  done();
}
function done() {   // a result: the list closes; on phones the box stays at the top with what was found
  look = null; rows = []; show(false);
  document.body.classList.remove('xs-typing');
  document.body.classList.toggle('xs-found', phone.matches);
  clear.hidden = false;
  input.blur();
}

// ---- CDS Sesame: SIMBAD, NED and VizieR names. CORS is open, so the page asks it directly; it redirects to a mirror.
// Misses take 4 to 5 s, so it runs only on Enter, shows that it is looking, and gives up after 6 s. Answers are kept
// for the session. A newer search, or editing the text, drops the request. ----
const cache = new Map();
let ctl = null;
const drop = () => { ctl?.abort(); ctl = null; look = null; };   // the text changed: forget the lookup for the old one
async function lookUp(q) {
  ctl?.abort();
  const key = q.toLowerCase();
  if (!cache.has(key)) {
    look = { q, state: 'looking' }; render();
    const c = ctl = new AbortController(), timer = setTimeout(() => c.abort(), 6000);
    let ans;
    try {
      const r = await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-oJ/SNV?${encodeURIComponent(q)}`, { signal: c.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cache.set(key, ans = sesameRaDec(await r.text()));   // only real answers are kept
    } catch {
      if (ctl !== c) return;   // replaced by a newer search, or the search was closed
      // 6 s and nothing reads as not found; a failed request says so. Neither is kept: Enter asks again.
      look = { q, state: c.signal.aborted ? 'none' : 'fail' }; ctl = null;
      return render();
    } finally { clearTimeout(timer); }
    if (ctl !== c || input.value.trim() !== q) return;
    ctl = null;
  }
  const hitRaDec = cache.get(key);
  if (!hitRaDec) { look = { q, state: 'none' }; return render(); }
  pick({ kind: 'coord', ...hitRaDec, name: q });
}

// ---- the box ----
input.addEventListener('input', () => { drop(); document.body.classList.remove('xs-found'); render(); });
input.addEventListener('focus', () => { if (phone.matches) document.body.classList.add('xs-on', 'xs-typing'); document.body.classList.remove('xs-found'); render(); });
form.addEventListener('submit', e => {   // Enter, or the phone keyboard's search key
  e.preventDefault();
  if (active >= 0) pick(rows[active]);
  else if (look && look.q === input.value.trim() && !ctl) lookUp(look.q);   // not found or failed: Enter asks again
});
input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (panel.hidden) return render();
    if (rows.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();   // a search field would clear itself; explore.js's Escape closes the pin, here it only closes the search
    if (phone.matches) back(); else if (!panel.hidden) { drop(); show(false); } else input.blur();
  }
});
list.addEventListener('pointerdown', e => e.preventDefault());   // keep the focus in the box
list.addEventListener('click', e => { const el = e.target.closest('[data-i]'); if (el) pick(rows[+el.dataset.i]); });
list.addEventListener('pointermove', e => { const el = e.target.closest('[data-i]'); if (el && +el.dataset.i !== active) setActive(+el.dataset.i); });
form.addEventListener('focusout', e => { if (!phone.matches && !form.contains(e.relatedTarget) && !panel.contains(e.relatedTarget)) show(false); });
clear.addEventListener('pointerdown', e => e.preventDefault());
clear.addEventListener('click', () => {
  drop(); input.value = '';
  const u = new URL(location.href); u.searchParams.delete('q'); history.replaceState(history.state, '', u);
  if (phone.matches && document.body.classList.contains('xs-found')) return back();
  input.focus(); render();
});

// phones: the button opens the box at the top (the focus must happen inside the tap, or iOS keeps the keyboard down)
function open() {
  if (phone.matches) document.body.classList.add('xs-on', 'xs-typing');
  input.focus(); input.select(); render();   // render: the box may already have the focus, with its list closed
}
function back() {   // the plain map, with the button
  drop(); input.value = ''; show(false);
  document.body.classList.remove('xs-on', 'xs-typing', 'xs-found');
  input.blur();
}
opener.addEventListener('click', open);
$('xs-back').addEventListener('click', back);
$('xs-dim').addEventListener('click', back);
phone.addEventListener('change', () => { document.body.classList.remove('xs-on', 'xs-typing', 'xs-found'); show(false); });
addEventListener('keydown', e => {
  const typing = document.activeElement?.matches('input, textarea, select, [contenteditable]');
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) { e.preventDefault(); open(); }
});

// explore.js: showPin(ra, dec, name, href), feature(comet, marker), and ready once the comets are on the map.
// ?q= in the address opens on that search's first result.
export function init(h) {
  hooks = h;
  const q = new URLSearchParams(location.search).get('q')?.trim();
  if (q) Promise.all([h.ready, placesIn]).then(() => {
    input.value = q;
    if (phone.matches) document.body.classList.add('xs-on');
    render(); show(false);
    if (rows[0]) pick(rows[0]); else show(true);   // numbers that are not a place: say why
  });
}
