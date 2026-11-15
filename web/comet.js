// Comet page: one comet from /api/comets/:id (D1). Real comets carry measured photos and a SPHEREx spectrum
// in `detail` (bake/comet_spectrum.py); example comets have only their discussion.
import { fwd, trackAt, trackPath, dayParam, dayDate, MJD0, RAD } from './skymap.js';
const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');   // no id: the list of known comets
const MJD_UNIX = 40587, day = dayParam();   // ?day=: the date on Explore's timeline when this page was opened from the map
const date = (mjd, opts) => new Date((mjd - MJD_UNIX) * 864e5).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

function ago(ms) {
  const m = (Date.now() - ms) / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 10080) return `${Math.round(m / 1440)} d`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function talk(c) {
  const t = c.tags, n = t.comet + t.asteroid + t.glitch + t.unsure;
  $('t-head').innerHTML = '';
  if (n) { $('t-head').append(`${t.comet} of ${n} `, el('span', null, 'say comet')); }
  else $('t-head').textContent = 'No tags yet';
  if (c.kind === 'comet' && n) { $('c-verdict').textContent = t.comet / n >= .6 ? 'Likely comet' : 'Undecided'; $('c-verdict').hidden = false; }
  document.querySelector('.verdict .tally').hidden = !n;
  document.querySelector('.verdict .tally-key').hidden = !n;
  for (const k of ['comet', 'asteroid', 'glitch', 'unsure']) {
    document.querySelector(`.verdict .t-${k}`).style.setProperty('--n', t[k]);
    document.querySelector(`[data-t=${k}]`).textContent = t[k];
  }
  const list = $('t-list');
  list.replaceChildren();
  for (const m of c.comments.filter(m => m.body)) list.append(comment(m));   // tags without text still count as votes
  if (!c.comments.some(m => m.body)) list.append(el('p', 'faint', 'Nobody has said anything yet.'));
  function comment(m) {
    const a = el('article', 'comment');
    a.append(el('span', 'av', m.author.slice(0, 2).toUpperCase()));
    const who = el('div', 'who');
    who.append(el('b', null, m.author), el('time', null, ago(m.created_at)));
    const before = earlierTag(m);
    if (m.tag && before && before !== m.tag) who.append(el('span', 'was', `was ${before === 'unsure' ? 'not sure' : before}`));
    if (m.tag) who.append(el('span', `tag ${m.tag}`, m.tag === 'unsure' ? 'not sure' : m.tag));
    a.append(who, el('p', null, m.body));
    return a;
  }
  function earlierTag(m) {
    const mine = c.comments.filter(x => x.author === m.author && x.tag && x.created_at < m.created_at);
    return mine.length ? mine[mine.length - 1].tag : null;
  }
}

function photos(d) {
  const box = $('c-photos');
  // the year too when the photos span more than one, so 27 Oct, 2 Jan and 9 Sep read in order
  const yr = new Set(d.photos.map(p => date(p.mjd, { year: 'numeric' }))).size > 1 ? { year: 'numeric' } : {};
  d.photos.forEach((p, i) => {
    const f = el('figure', i === d.photos.length - 1 ? 'now' : '');
    const plate = el('div', 'plate');
    const img = el('img'); img.src = `data/comets/${d.dir ?? '3i-atlas'}/${p.file}`; img.alt = `${d.name ?? 'The comet'} on ${date(p.mjd, { day: 'numeric', month: 'short' })}`;
    const ring = el('span', i === d.photos.length - 1 ? 'ring' : 'ring earlier'); ring.style.left = '50%'; ring.style.top = '50%';
    plate.append(img, ring);
    f.title = `${p.lam.toFixed(2)} µm`;
    f.append(plate, date(p.mjd, { day: 'numeric', month: 'short', ...yr, hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''));
    box.append(f);
  });
  $('c-photos-panel').hidden = false;
}

// A badge by the title only when the measurement is clear: "detected" or "quiet" (bake/comet_spectrum.py co2_verdict)
function co2Badge(state) {
  const text = { detected: 'CO2 glow detected', quiet: 'No gas glow' }[state];
  if (!text) return;
  const b = el('span', `chip co2 ${state}`, text);
  b.title = state === 'detected' ? 'SPHEREx sees extra light at 4.26 µm, where carbon dioxide gas glows'
    : 'The comet is clearly seen, with no extra light at 4.26 µm';
  $('c-cat').after(b);
}

function measures(d) {
  const m = $('c-measures');
  m.querySelector('[data-f=speed]').textContent = d.speed_arcsec_per_hour;
  m.querySelector('[data-f=dir]').textContent = d.direction[0].toUpperCase() + d.direction.slice(1);
  m.querySelector('[data-f=first]').textContent = date(d.first_mjd, { day: 'numeric', month: 'short', year: 'numeric' });
  m.querySelector('[data-f=n]').textContent = d.exposures;
  m.hidden = false;
}

// Measured points with their noise, plus a running median per month. Wavelength axis is linear, 0.75-5 um.
function spectrum(d) {
  const svg = $('spec'), NS = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };
  const months = Object.entries(d.spectrum).filter(([, pts]) => pts.length);
  const all = months.flatMap(([, p]) => p);
  // Compressed brightness axis (asinh, linear near zero): December's coma is ~20x brighter than August's,
  // and a straight axis would flatten August to a line. Noise around zero stays readable either way.
  const S = 5, h = f => Math.asinh(f / S), top = h(Math.max(...all.map(p => p.flux)) * 1.15), bottom = h(Math.min(0, ...all.map(p => p.flux)));
  // draw at about the screen's width so the 11-unit text stays readable on a phone (desktop keeps 900);
  // the panel must be visible first, or its width reads as 0
  $('c-spec-panel').hidden = false;
  const W = Math.round(Math.min(900, Math.max(380, svg.clientWidth * 1.15)));
  svg.setAttribute('viewBox', `0 0 ${W} 250`);
  const X0 = 52, X1 = W - 10, Y0 = 30, Y1 = 214;
  const sx = l => X0 + (l - .75) / 4.25 * (X1 - X0), sy = f => Y1 - (Math.min(top, Math.max(bottom, h(f))) - bottom) / (top - bottom) * (Y1 - Y0);
  add('rect', { class: 'band', x: sx(4.20), y: Y0, width: sx(4.32) - sx(4.20), height: Y1 - Y0 });
  for (const l of [1, 2, 3, 4, 5]) { add('line', { class: 'grid', x1: sx(l), x2: sx(l), y1: Y0, y2: Y1 }); add('text', { x: sx(l), y: Y1 + 20, 'text-anchor': 'middle' }, `${l} µm`); }
  for (const t of [0, 10, 100, 1000].filter(t => h(t) <= top)) {
    add('line', { class: 'grid', x1: X0, x2: X1, y1: sy(t), y2: sy(t) });
    add('text', { x: X0 - 8, y: sy(t) + 4, 'text-anchor': 'end' }, t ? `${t} mJy` : '0');
  }
  const legend = $('c-legend');
  // the month that carries the CO2 verdict is orange and solid; every other month is pale and dashed
  const key = (Object.entries(d.co2 ?? {}).find(([, v]) => v.state === d.co2_verdict && v.state !== 'unclear') ?? months[0])[0];
  months.forEach(([month, pts]) => {
    const hl = month === key, k = hl ? 0 : 1, cls = hl ? 'curve' : 'rock';
    for (const p of pts) {
      add('line', { class: `err m${k}`, x1: sx(p.lam), x2: sx(p.lam), y1: sy(p.flux - p.err), y2: sy(p.flux + p.err) });
      add('circle', { class: `m${k}`, cx: sx(p.lam), cy: sy(p.flux), r: 2.2 }).append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${p.lam.toFixed(3)} µm: ${p.flux.toFixed(1)} ± ${p.err.toFixed(1)} mJy` }));
    }
    const line = [];   // running median in 0.1 um steps
    for (let l = .75; l <= 5; l += .1) {
      const v = pts.filter(p => Math.abs(p.lam - l) <= .08).map(p => p.flux).sort((a, b) => a - b);
      if (v.length) line.push([sx(l), sy(v[v.length >> 1])]);
    }
    add('path', { class: cls, d: line.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('') });
    const s = el('span'), i = el('i');
    if (!hl) i.className = 'pale';
    s.append(i, new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
    legend.append(s);
  });
  // where each gas would glow, as guides along the top: a label here marks a wavelength, not a detection
  // (the CO2 badge by the title is the verdict; bake/comet_spectrum.py has the rule)
  for (const [l, name] of [[4.26, 'Carbon dioxide'], [2.7, 'Water']]) {
    add('text', { class: 'lab', x: sx(l), y: Y0 - 12, 'text-anchor': 'middle' }, name);
    add('text', { x: sx(l), y: Y0 + 2, 'text-anchor': 'middle' }, `${l} µm`);
  }
  // what the CO2 band measured, in a few words (the badge by the title gives the verdict; bake/comet_spectrum.py has the rule)
  const v = d.co2 && Object.values(d.co2), best = v && (v.find(x => x.state === d.co2_verdict) ?? v[0]);
  const co2 = !best ? '' : best.state === 'unclear' ? ' · CO2 band: not enough signal to tell'
    : ` · CO2 band ${best.excess >= 0 ? '+' : ''}${best.excess} ± ${best.sigma} mJy over nearby light`;
  $('c-spec-note').textContent = `${all.length} SPHEREx measurements${co2}`;
  co2Badge(d.co2_verdict);
  $('c-spec-panel').hidden = false;
}

// "Where it is": the comet on the all-sky picture, placed exactly as Explore places it (skymap.js). A comet with a
// JPL path shows the path, its place on `day` and that date; one without (example comets) keeps its fixed place.
// "Find on map" opens Explore on the same day with this comet picked out.
function where(c) {
  const at = trackAt(c.track, day), [ra, dec] = at ?? [c.ra, c.dec], [u, v] = fwd(ra, dec), dot = $('c-mini-dot');
  dot.style.left = u * 100 + '%'; dot.style.top = v * 100 + '%'; dot.hidden = false;
  $('c-where').textContent = `RA ${ra.toFixed(1)}\u00b0   Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}\u00b0`;
  if (at) {
    $('c-when').textContent = dayDate(day, { month: 'short', day: 'numeric', year: 'numeric' });
    $('c-mini-path').setAttribute('d', trackPath(c.track));
  }
  const find = $('c-find');
  find.href = `explore.html?day=${day}&focus=${encodeURIComponent(c.id)}`;
  find.hidden = false;
}

// A known comet from JPL's catalog: when SPHEREx photographed it (matched to the survey's photo outlines),
// each with a link that opens that patch on that date. Its spectrum is not measured yet.
function known(c) {
  const shots = c.detail.spherex, box = $('c-empty');
  box.querySelector(':scope > p')?.remove();   // the example-comet sentence is wrong here
  const first = box.querySelector('.actions');   // the new lines go above the button
  box.insertBefore(el('h2', null, shots.length ? `SPHEREx photographed it ${shots.length} times` : 'Not in a SPHEREx photo yet'), first);
  // one link per visit: photos less than 5 days after the previous one belong to the same visit
  const visits = [];
  shots.forEach((s, i) => { if (i === 0 || s.day - shots[i - 1].day >= 5) visits.push(s); });
  const list = el('div', 'visits');
  for (const v of visits) {   // each photo carries the comet's exact position at that moment (bake/known_comets.py)
    const a = el('a', 'chip', date(MJD0 + v.day, { day: 'numeric', month: 'short', year: 'numeric' }));
    a.href = `timelapse.html?ra=${v.ra.toFixed(4)}&dec=${v.dec.toFixed(4)}&det=D1`;
    a.title = `Open the patch where it was (RA ${v.ra.toFixed(2)}, Dec ${v.dec.toFixed(2)})`;
    list.append(a);
  }
  box.insertBefore(list, first); box.insertBefore(el('p', 'faint', 'Known comet from JPL. Its spectrum is not measured yet.'), first);
  if (c.detail.faint) box.insertBefore(el('p', 'faint', `Predicted too faint to see clearly in SPHEREx photos (brightest magnitude ${c.detail.mag_in_photo ?? 'unknown'} while photographed).`), first);
  box.hidden = false;
}

// The API's rule for names; a stored name that breaks it (e.g. "Zoë") falls back to the nickname field
const NAME = /^[A-Za-z0-9 _.-]{1,24}$/;
let nameRefused = false;   // set when the API refused the stored name
function userName() {
  let n = window.CH_USER?.name;
  if (!n) try { n = JSON.parse(localStorage.getItem('ch.user'))?.name; } catch {}
  n = typeof n === 'string' ? n.trim() : '';
  return !nameRefused && NAME.test(n) ? n : null;
}

function composer(c) {
  const form = document.querySelector('.composer'), text = form.querySelector('textarea'), nick = form.querySelector('.nick');
  const btn = form.querySelector('button'), note = $('c-note'), hint = note.textContent;
  let submitting = false;
  const sync = () => {
    nick.hidden = !!userName();
    for (const x of form.querySelectorAll('input')) x.disabled = submitting;
    text.readOnly = submitting;
    btn.disabled = submitting || !text.value.trim() || (!nick.hidden && !nick.value.trim());
  };
  const say = (msg, err) => { note.textContent = msg; note.classList.toggle('err', !!err); };
  text.addEventListener('input', sync); nick.addEventListener('input', sync);
  window.addEventListener('ch:user', () => { nameRefused = false; sync(); });
  sync();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    const token = window.turnstile?.getResponse() || form.querySelector('[name=cf-turnstile-response]')?.value;
    if (!token) return say('One moment, checking you are human…', true);
    const sent = text.value, tag = form.querySelector('[name=tag]:checked')?.value;
    const stored = userName(), author = stored || nick.value.trim();
    submitting = true; sync();
    try {
      const r = await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comet_id: c.id, body: sent, author, turnstile: token, ...(tag ? { tag } : {}) }) });
      const out = await r.json().catch(() => ({}));
      if (r.status === 400 && out.field === 'author' && stored) nameRefused = true;   // show the nickname field instead
      if (!r.ok) throw new Error(out.error || `Could not post (${r.status})`);
      c.comments.push(out.comment); c.tags = out.tags;
      talk(c);
      if (text.value === sent) { text.value = ''; form.querySelectorAll('[name=tag]').forEach(x => { x.checked = false; }); }
      say(hint);
    } catch (err) {
      say(err.message, true);
    } finally {
      window.turnstile?.reset();   // a token works once
      submitting = false; sync();
    }
  });
}

// The Comets tab: every known comet SPHEREx photographed, on one of three shelves. Measured comets get a photo card with
// their CO2 result, the ones that could still be measured get a small sky map (placed by skymap.js, as Explore and the
// comet page place them on `day`), and the faint ones fold away. Search and the filter row change every shelf.
const RESULT = { detected: ['CO2 glow', 'co2'], quiet: ['No gas glow', 'flat'], unclear: ['No clear signal', 'flat'] };
const shelf = c => (c.co2 ? 'm' : c.faint ? 'f' : 'o');
// regions as on Forums (forums.js): north/south by Dec, near the ecliptic within 15 degrees of it; here at the comet's place on `day`
const eclLat = (ra, dec) => Math.asin(Math.sin(dec * RAD) * Math.cos(23.44 * RAD) - Math.cos(dec * RAD) * Math.sin(23.44 * RAD) * Math.sin(ra * RAD)) / RAD;
const REGION = { north: ([, dec]) => dec >= 0, south: ([, dec]) => dec < 0, ecliptic: ([ra, dec]) => Math.abs(eclLat(ra, dec)) < 15 };
const byPhotos = (a, b) => (b.photos ?? 0) - (a.photos ?? 0);
const SORT = {   // "Result": a CO2 glow first; then, and on the other shelves, the most photographed first
  '': (a, b) => (b.co2 === 'detected') - (a.co2 === 'detected') || byPhotos(a, b),
  photos: byPhotos,
  name: (a, b) => a.id.localeCompare(b.id),
};
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>';
const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const photosText = c => `${c.photos ?? 0} photos`;

function card(c, href) {   // Ming's outlined arrow button (patch viewer .pv-state), with the comet's photo
  const a = el('a', `card s-${RESULT[c.co2][1]}`), ph = el('span', 'ph'), img = el('img'), v = el('span', 'v'), go = el('span', 'go');
  a.href = href; a.dataset.id = c.id; a.dataset.co2 = c.co2;
  img.src = c.thumb; img.alt = ''; ph.append(img);
  v.append(el('i', `g g-${RESULT[c.co2][1]}`), RESULT[c.co2][0]);
  go.innerHTML = ARROW;
  a.append(ph, el('b', null, c.id), v, el('span', 'n', photosText(c)), go);
  return a;
}

function tile(c, href, at) {   // the comet page's mini map (.skymini) in small: the path, and the comet on `day`
  const a = el('a', 'tile box'), sky = el('span', 'skymini'), svg = svgEl('svg', { viewBox: '0 0 2000 1000', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  a.href = href; a.dataset.id = c.id;
  svg.append(svgEl('path', { d: trackPath(c.track) }));
  const [u, v] = fwd(at[0], at[1]), dot = el('i');
  dot.style.left = u * 100 + '%'; dot.style.top = v * 100 + '%';
  a.dataset.u = u; a.dataset.v = v;
  sky.append(svg, dot);
  a.append(sky, el('b', null, c.id), el('span', 'n', photosText(c)));
  a.title = c.id;
  return a;
}

function list() {
  document.querySelector('.comet-head').hidden = document.querySelector('.comet-grid').hidden = true;
  document.querySelector('main').classList.add('comets');
  $('c-list').hidden = false;
  document.title = 'Comets · Trailblazer';
  fetch('/api/comets').then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(({ comets }) => {
    const known = comets.filter(c => c.kind === 'known' && c.real).map(c => ({ ...c, at: trackAt(c.track, day) ?? [c.ra, c.dec] }));
    const href = c => `comet.html?id=${encodeURIComponent(c.id)}&day=${day}`;
    const render = () => {
      const q = $('l-q').value.trim().toLowerCase(), region = REGION[$('l-region').value], sort = SORT[$('l-sort').value];
      const shown = known.filter(c => (!q || c.id.toLowerCase().includes(q)) && (!region || region(c.at))).sort(sort);
      const on = k => shown.filter(c => shelf(c) === k);
      const fill = (k, items) => {
        const s = $(`s-${k}`);
        s.querySelector('.n').textContent = items.length;
        s.hidden = !items.length;
        return s;
      };
      fill('m', on('m')).querySelector('.cards').replaceChildren(...on('m').map(c => card(c, href(c))));
      fill('o', on('o')).querySelector('.tiles').replaceChildren(...on('o').map(c => tile(c, href(c), c.at)));
      const f = fill('f', on('f'));
      f.querySelector('.specks').replaceChildren(...on('f').map(() => el('i')));
      f.querySelector('.faintlist').replaceChildren(...on('f').map(c => {
        const a = el('a', null, c.id); a.href = href(c); a.dataset.id = c.id;
        a.insertAdjacentHTML('beforeend', ARROW.replace('<svg', '<svg class="ic"'));
        return a;
      }));
      $('l-none').hidden = shown.length > 0;
    };
    for (const k of ['l-q', 'l-region', 'l-sort']) $(k).addEventListener('input', render);
    render();
  }).catch(err => { $('l-none').textContent = 'Comets are unavailable right now.'; $('l-none').hidden = false; console.warn(err); });
}

if (!id) list();
else fetch(`/api/comets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(c => {
  document.title = `${c.id} · Trailblazer`;
  $('c-id').textContent = c.id;
  $('c-cat').querySelector('span').textContent = c.kind === 'known' ? (c.detail?.photos ? 'Known comet · measured by SPHEREx' : c.real ? 'Known comet · JPL catalog' : 'Known object') : 'Not in any catalog';
  if (c.kind === 'comet') { const p = $('c-patch'); p.href = `timelapse.html?ra=${c.ra}&dec=${c.dec}&det=D1&diff=1`; p.hidden = false; }
  where(c);
  if (c.detail?.photos) { photos(c.detail); measures(c.detail); spectrum(c.detail); }
  else if (c.detail?.spherex) known(c);
  else $('c-empty').hidden = false;
  talk(c);
  composer(c);
}).catch(err => {   // a 404 is a wrong name; anything else is the network or the database
  console.warn(err);
  $('c-id').textContent = err === 404 ? 'Comet not found' : 'Could not load this comet';
  $('c-cat').hidden = true;
  document.querySelector('.comet-grid').hidden = true;   // no empty tallies or comment form for a comet that is not there
  const p = el('p', 'faint'), a = el('a', null, 'See all comets');
  a.href = 'comet.html';
  p.append(err === 404 ? 'There is no comet by that name. ' : 'Try again in a moment. ', a);
  document.querySelector('.comet-head').after(p);
});
