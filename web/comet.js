// The comet pages, direction A ("answers first", comet-plan/fact-table.md):
// - comet.html?id=: one comet from GET /api/comets/:id. Every sentence comes from facts.js (rules R1-R9) and carries its
//   label; the Depth tab plays the comet's SPHEREx photos in 3D at JPL's positions (comet3d.js);
//   one card per SPHEREx visit, each opening the time-lapse on the visit's clearest picture.
// - comet.html: the Comets list from GET /api/comets, by what SPHEREx found.
// main[data-ready] is set once a page has drawn (the UI tests wait for it).
import * as F from './facts.js';
import { dayParam } from './skymap.js';
const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
const TODAY = Date.now();
const NS = 'http://www.w3.org/2000/svg';
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>';
const LABEL = { measured: ['lm', 'measured by SPHEREx'], predicted: ['lp', 'predicted by JPL'], needs: ['ln', 'needs data'] };

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function svg(tag, attrs = {}, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; }
const mark = label => { const [k, say] = LABEL[label] ?? []; if (!k) return null; const i = el('i', `lb ${k}`); i.title = say; i.setAttribute('aria-label', say); i.setAttribute('role', 'img'); return i; };
// text with **bold** numbers, as nodes
function rich(text) {
  const out = [];
  text.split(/\*\*(.+?)\*\*/).forEach((part, k) => { if (part) out.push(k % 2 ? el('b', null, part) : document.createTextNode(part)); });
  return out;
}
// sentences into a paragraph: a sentence labelled other than its block gets its own labelled span and mark
function sentences(p, list, blockLabel) {
  list.forEach((s, k) => {
    if (k) p.append(' ');
    if (s.label && s.label !== blockLabel) {
      const sp = el('span'); sp.dataset.label = s.label; sp.append(...rich(s.text)); const m = mark(s.label); if (m) sp.append(m); p.append(sp);
    } else p.append(...rich(s.text));
  });
  return p;
}
// the time-lapse on one picture, centred on the comet's place then, that spot ringed and named as this comet
const lapseHref = (cid, l) => `timelapse.html?ra=${l.ra.toFixed(4)}&dec=${l.dec.toFixed(4)}&det=${l.det}&t=${l.t.toFixed(4)}&comet=${encodeURIComponent(cid)}`;
const utcTime = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace('Sept', 'Sep').replace(',', '') + ' UTC';
const done = () => { document.querySelector('main').dataset.ready = '1'; };

// ---------------------------------------------------------------- one comet
function one(c) {
  const P = F.page(c, c.now, TODAY), x = P.x, d = x.d, f = x.f;
  document.title = `${c.id} · Trailblazer`;
  $('c-one').hidden = false;
  $('c-id').textContent = c.id;
  for (const part of P.decode) { const s = el('span'); s.append(el('b', null, part.code), ' ' + part.text); $('c-decode').append(s); }
  for (const s of P.lead) { const sp = el('span'); sp.dataset.label = s.label; sp.append(...rich(s.text)); const m = mark(s.label); if (m) sp.append(m); $('c-lead').append(sp, ' '); }
  for (const s of P.chips) { const ch = el('span', `cchip ${s.label === 'measured' ? 'lm' : 'lq'}`); ch.dataset.label = s.label; ch.append(mark(s.label), s.text); $('c-chips').append(ch); }
  $('c-find').href = `explore.html?day=${dayParam()}&focus=${encodeURIComponent(c.id)}`;
  hero(c, x);
  cards(P.cards);
  strip(c, P);
  advanced(c, x);
  discuss(c);
  $('tab-photo').addEventListener('click', () => tab(false));
  $('tab-depth').addEventListener('click', () => tab(true, c, x));
  done();
}

function tab(depth, c, x) {
  $('tab-photo').classList.toggle('on', !depth); $('tab-depth').classList.toggle('on', depth);
  $('tab-photo').setAttribute('aria-selected', !depth); $('tab-depth').setAttribute('aria-selected', depth);
  $('c-photo').hidden = depth; $('c-depth').hidden = !depth;
  if (depth && !depth3) depth3 = scene($('c-scene'), x).then(s => (window.__scene = s));   // tests: window.__scene
  depth3?.then(s => s?.show(depth ? 'depth' : 'photo'));
}

// The main picture: a measured comet's brightest baked photo; otherwise the clearest visit's picture (the highest SNR
// where SPHEREx detected it, or else the visit measured best). Its time-lapse link is that picture's.
function hero(c, x) {
  const d = x.d, vs = x.f?.inv?.visits ?? [];
  let img, when, lam, ring = 'cring', link = null, verdict = 'seen';
  if (d.photos?.length) {
    const p = d.photos.reduce((b2, q) => (q.flux > b2.flux ? q : b2));
    img = `data/comets/${d.dir}/${p.file}`; when = utcTime(F.mjdMs(p.mjd)); lam = p.lam;
    if (p.ra != null) link = { t: p.mjd, ra: p.ra, dec: p.dec, det: p.file.match(/_(D\d)\.png$/)?.[1] ?? 'D1' };
  } else {
    const withImg = vs.filter(v => v.img), seen = withImg.filter(v => v.verdict === 'seen');
    const v = seen.length ? seen.reduce((b2, q) => (q.snr > b2.snr ? q : b2)) : withImg.find(q => q.verdict === 'faint') ?? withImg[0];
    if (v) { img = v.img; when = utcTime(F.mjdMs(v.link.t)); lam = v.lam; link = v.link; verdict = v.verdict; if (v.verdict !== 'seen') ring = 'cring dash'; }
  }
  if (img) {
    $('c-hero').src = img; $('c-hero').alt = `${c.id} in a SPHEREx picture, ${when}`;
    $('c-ring').className = ring;
    $('c-when').textContent = when;
    $('c-lam').textContent = `Infrared${lam ? ` ${lam.toFixed(2)} µm` : ''}, brightness stretched per picture`;
    $('c-lam').append(mark('measured'));
    const NOTE = { faint: 'Not detected here', unseen: 'No detection in this picture', parent: 'Light near the parent’s position, maybe the parent’s', unmeasured: 'Could not be measured here' };
    if (verdict !== 'seen') $('c-lam').before(el('span', 'cnote', `${NOTE[verdict] ?? NOTE.unmeasured}: the ring marks where JPL puts it.`));
  } else { $('c-hero').remove(); $('c-ring').remove(); $('c-nopic').hidden = false; }
  if (link) { $('c-lapse').href = lapseHref(c.id, link); $('c-lapse').hidden = false; }
}

const ICON = {
  'Is it dangerous?': '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  'Can I see it?': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  'Where is it going?': '<circle cx="5" cy="18" r="1.6"/><path d="M6.5 16.5C10 13 9 8 13 6.5S19 6 19 6"/><path d="M16 4l3 2-2 3"/>',
  'How big, how far, how fast?': '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>',
  'Is it new? Where from?': '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  'What is it made of?': '<circle cx="7" cy="14" r="3"/><circle cx="17" cy="14" r="3"/><circle cx="12" cy="6" r="2.4"/><path d="M8.6 11.6l2.1-3.6M15.4 11.6l-2.1-3.6"/>',
};
function cards(list) {
  for (const k of list) {
    const a = el('article', 'ans card'); a.dataset.label = k.label;
    const q = el('p', 'q'); q.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k.q] ?? ''}</svg>`; q.append(k.q);
    a.append(q);
    if (k.a) a.append(el('p', 'a', k.a));
    else if (k.needs && !k.kv) { const n = el('p', 'a'); n.append(el('span', 'needs big', 'Needs data')); a.append(n); }
    if (k.kv) {
      const dl = el('dl', 'kv');
      for (const [dt, v] of k.kv) {
        const dd = el('dd');
        if (v.label === 'needs') dd.append(el('span', 'needs', 'needs data')); else dd.textContent = v.v;
        dl.append(el('dt', null, dt), dd);
      }
      a.append(dl);
    }
    if (k.d?.length) a.append(sentences(el('p', 'd'), k.d, k.label));
    if (k.chart) { const sp = el('div', 'spec'); sp.dataset.month = k.chart; a.append(sp); }
    const srcs = el('div', 'srcs');
    if (k.src) { const s = el('p', `src ${LABEL[k.label]?.[0] ?? 'lp'}`); s.append(el('i'), k.src); srcs.append(s); }
    else if (k.label === 'needs' || k.needs) { const s = el('p', 'src ln', 'needs data'); srcs.append(s); }
    if (k.water) srcs.append(el('p', 'src ln', k.water));
    a.append(srcs);
    $('c-answers').append(a);
  }
}

// What SPHEREx saw: one card per visit, then what comes next
function strip(c, P) {
  const vs = P.visits, inv = P.x.f?.inv, box = $('c-strip');
  const n = inv?.n ?? 0;
  $('c-saw').append(vs.length ? `${n.toLocaleString('en-US')} picture${n === 1 ? '' : 's'} on ${vs.length} visit${vs.length === 1 ? '' : 's'}` : 'No SPHEREx picture held it', mark('measured'));
  for (const v of vs) {
    const card = el('div', `v ${v.verdict}`); card.dataset.label = 'measured';
    const ph = el('div', 'cph');
    if (v.img) { const im = el('img'); im.src = v.img; im.alt = `${c.id}, ${v.when}`; ph.append(im); }
    else ph.append(el('span', 'nopic', 'no picture'));
    ph.append(el('span', v.verdict === 'seen' ? 'cring' : 'cring dash'));
    const when = el('p', 'when date', v.when); when.append(mark('measured'));
    const say = el('p', 'say', v.short); say.append(mark('measured'));
    card.title = [v.title, ...v.d.map(t => F.plain(t.text))].join(' ');   // the full sentences on hover (and in Advanced)
    const a = el('a', 'clink lapse'); a.href = lapseHref(c.id, v.link); a.innerHTML = `Time-lapse ${ARROW}`;
    a.title = `Open the time-lapse on this visit's clearest picture, centred on where JPL puts the comet`;
    const cap = el('p', 'pcap', `Infrared${v.lam ? ` ${v.lam.toFixed(2)} µm` : ''}, brightness stretched per picture`);
    card.append(ph, cap, when, say, a);
    box.append(card);
  }
  if (P.next.length) {
    const nx = el('div', 'v next'); nx.dataset.label = 'predicted';
    const bx = el('div', 'next-box');
    for (const e of P.next) { const r = el('div', e.now ? 'o' : ''); r.append(el('b', null, e.when), e.what); bx.append(r); }
    bx.append(mark('predicted'));
    nx.append(bx); box.append(nx);
  }
  // the CO2 bump in the made-of card
  const sp = document.querySelector('.spec');
  if (sp) bump(sp, P.x.d, sp.dataset.month);
}

// The comet's light by infrared colour in one month, median per 0.05 µm, against the light beside the CO2 colour
function bump(box, d, month) {
  const pts = (d.spectrum?.[month] ?? []).filter(p => p.lam >= 3.3 && p.lam <= 5);
  const m = d.co2?.[month];
  if (pts.length < 4 || !m) { box.remove(); return; }
  const bins = [];
  for (let l = 3.3; l <= 5; l += 0.05) { const v = pts.filter(p => Math.abs(p.lam - l) <= 0.03).map(p => p.flux).sort((a, b) => a - b); if (v.length) bins.push([l, v[v.length >> 1]]); }
  const W = 340, H = 132, L = 8, R = 8, Tp = 24, B = 26, lo = 3.3, hi = 5;
  const max = Math.max(m.band, ...bins.map(q => q[1])) * 1.12;
  const X = l => L + (l - lo) / (hi - lo) * (W - L - R), Y = f => H - B - Math.max(0, f) / max * (H - Tp - B);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `SPHEREx's measurements of the comet's light by infrared colour, ${F.monthYear(Date.parse(month + '-01'))}` }, box);
  svg('rect', { x: X(4.2), y: Tp - 6, width: X(4.32) - X(4.2), height: H - B - Tp + 6, class: 'band' }, s);
  svg('text', { x: X(4.26), y: Tp - 10, 'text-anchor': 'middle', class: 'o' }, s).textContent = 'carbon dioxide (4.26 µm)';
  svg('line', { x1: L, x2: W - R, y1: Y(m.cont), y2: Y(m.cont), class: 'cont' }, s);
  svg('text', { x: L + 2, y: Y(m.cont) - 6, class: 'dim' }, s).textContent = 'light beside it';
  svg('polyline', { points: bins.map(q => `${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join(' '), class: 'line' }, s);
  for (const l of [3.5, 4, 4.5, 5]) svg('text', { x: X(l), y: H - 8, 'text-anchor': 'middle', class: 'dim' }, s).textContent = `${l} µm`;
  const cap = el('p', 'spec-cap', `${F.monthYear(Date.parse(month + '-01T00:00:00Z'))}. A micrometre (µm) is a thousandth of a millimetre; these colours are infrared, invisible to the eye.`);
  box.append(cap);
}

// ---------------------------------------------------------------- Depth: the comet's SPHEREx photos in 3D
// Earth with SPHEREx and the comet travel along their JPL paths (detail.facts.path, web/data/planets.json) to each
// photo's time, and that photo's frustum lights up (comet3d.js, three.js loaded when Depth first opens). Positions are
// JPL's at each photo's time; the daily snapshot is not drawn here.
let planetsP = null, depth3 = null;
const planets = () => (planetsP ??= fetch('data/planets.json').then(r => (r.ok ? r.json() : Promise.reject(r.status))));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
async function scene(box, x) {
  const f = x.f, rows = f?.path?.rows ?? [], src = $('c-scene-src');
  src.textContent = f ? `Real positions from JPL Horizons (${f.path?.soln ?? f.orb.soln}), at each photo's time` : 'Path needs data';
  src.prepend(el('i'));
  const vs = F.visits(x).filter(v => v.link);
  if (!rows.length || !vs.length) return null;
  let pl, M;
  try { [pl, M] = await Promise.all([planets(), import('./comet3d.js')]); } catch (e) { console.warn(e); src.textContent = 'The 3D view could not load. Try again in a moment.'; return null; }
  const day = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  return M.comet3d({
    box, after: box, zoomBox: box.parentNode.querySelector('.dzoom'), name: x.id, path: rows, earth: pl.earth, fmt: F.dist,
    visits: vs.map(v => ({ jd: v.link.t + 2400000.5, xyz: f.inv.visits[v.k]?.xyz ?? null, img: v.img, lam: v.lam, span: v.when.replace(/–/g, ' to '), short: day(v.start) })),
  });
}

// ---------------------------------------------------------------- Advanced
function advanced(c, x) {
  const body = $('c-adv-body'), f = x.f, d = x.d;
  if (f) {
    const o = f.orb, sec = el('section', 'adv-sec'); sec.dataset.label = 'predicted';
    sec.append(el('h3', null, 'Orbit numbers'));
    const dl = el('dl', 'kv');
    const row = (k, v, def) => { const dd = el('dd', null, v); if (def) dd.append(el('span', 'def', ` ${def}`)); dl.append(el('dt', null, k), dd); };
    row('Eccentricity', o.e.toFixed(4), o.e >= 1 ? '1 or more: an open path' : 'under 1: a closed loop');
    row('Closest to the Sun', `${F.sig(o.q)} AU (${F.dist(o.q)})`, 'AU: Earth’s distance from the Sun');
    if (o.a != null) row('Average distance', `${F.sig(o.a)} AU`);
    if (o.per != null && o.per < 1e4) row('Period', `${F.sig(o.per)} years`);
    row('Tilt to the planets’ plane', `${F.sig(o.i)}°`);
    if (o.moid != null) row('Closest its path comes to Earth’s', `${F.sig(o.moid)} AU`, '(MOID)');
    row('JPL solution', `${o.soln}, dated ${o.soln_date?.slice(0, 11) ?? '?'}`);
    if (o.first_obs) row('Observed', `${F.day(F.dayMs(o.first_obs))} to ${F.day(F.dayMs(o.last_obs))}`);
    row('Elements at', F.day(F.dayMs(f.baked)));
    sec.append(dl);
    const s = el('p', 'src lp'); s.append(el('i'), 'JPL Horizons'); sec.append(s);
    body.append(sec);
  }
  if (x.now) {
    const n = x.now, sec = el('section', 'adv-sec'); sec.dataset.label = 'predicted';
    sec.append(el('h3', null, 'Where it is in the sky'));
    const dl = el('dl', 'kv');
    dl.append(el('dt', null, 'Right ascension'), el('dd', null, `${n.ra.toFixed(2)}°`), el('dt', null, 'Declination'), el('dd', null, `${n.dec >= 0 ? '+' : ''}${n.dec.toFixed(2)}°`));
    sec.append(el('p', 'def', 'Sky coordinates, like longitude and latitude on the sky. They change every day.'), dl);
    const s = el('p', 'src lp'); s.append(el('i'), `JPL prediction, as of ${F.day(F.dayMs(n.as_of))}`); sec.append(s);
    body.append(sec);
  }
  const vis = F.visits(x);
  if (vis.length) {   // each visit in full: what the card's short line stands for, with its distance and magnitude
    const sec = el('section', 'adv-sec visits'); sec.dataset.label = 'measured';
    sec.append(el('h3', null, 'Each visit'));
    for (const v of vis) { const p = el('p', 'vrow'); p.append(el('b', null, v.when), ' ', v.title, ' '); sentences(p, v.d, 'measured'); sec.append(p); }
    const s = el('p', 'src lm'); s.append(el('i'), 'Measured by SPHEREx; distances and magnitudes predicted by JPL'); sec.append(s);
    body.append(sec);
  }
  if (d.photos?.length) {
    const sec = el('section', 'adv-sec'); sec.dataset.label = 'measured';
    sec.append(el('h3', null, `Every measured photo (${d.photos.length})`));
    const g = el('div', 'pgrid');
    for (const p of [...d.photos].sort((a, b2) => a.mjd - b2.mjd)) {
      const fig = el('figure'), im = el('img'); im.src = `data/comets/${d.dir}/${p.file}`; im.alt = ''; im.loading = 'lazy';
      fig.append(im, el('figcaption', null, `${F.day(F.mjdMs(p.mjd))} · infrared ${p.lam.toFixed(2)} µm`)); g.append(fig);
    }
    const s = el('p', 'src lm'); s.append(el('i'), 'Measured by SPHEREx (TrailBlazer’s photometry); brightness stretched per picture');
    sec.append(g, s); body.append(sec);
  }
  if (!body.children.length) body.append(el('p', 'def', 'Nothing more for this comet yet.'));
  $('c-adv-say').textContent = d.photos?.length ? 'Each visit, orbit numbers, sky position and every measured photo' : 'Each visit, orbit numbers and sky position';
}

// ---------------------------------------------------------------- Discuss (folded; no tag vote on a known comet)
function ago(ms) {
  const m = (Date.now() - ms) / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 10080) return `${Math.round(m / 1440)} d`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const NAME = /^[A-Za-z0-9 _.-]{1,24}$/;   // the API's rule for names
let nameRefused = false;
function userName() {
  let n = window.CH_USER?.name;
  if (!n) try { n = JSON.parse(localStorage.getItem('ch.user'))?.name; } catch {}
  n = typeof n === 'string' ? n.trim() : '';
  return !nameRefused && NAME.test(n) ? n : null;
}
function discuss(c) {
  const list = $('t-list');
  const show = () => {
    list.replaceChildren();
    const said = c.comments.filter(m => m.body);
    for (const m of said) { const box = el('article', 'post'), who = el('p', 'who'); who.append(el('b', null, m.author), ` · ${ago(m.created_at)}`); box.append(who, el('p', 'body', m.body)); list.append(box); }
    if (!said.length) list.append(el('p', 'def', 'Nobody has said anything yet. Be the first.'));
  };
  show();
  const det = $('c-discuss');
  det.addEventListener('toggle', () => {   // Turnstile only when someone opens Discuss
    if (det.open && !document.querySelector('script[src*="turnstile"]')) {
      const sc = document.createElement('script'); sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; sc.async = true; document.head.append(sc);
    }
  });
  const form = $('c-compose'), text = form.querySelector('textarea'), nick = form.querySelector('.nick'), btn = form.querySelector('button'), note = $('c-note');
  let busy = false;
  const sync = () => { nick.hidden = !!userName(); text.readOnly = busy; btn.disabled = busy || !text.value.trim() || (!nick.hidden && !nick.value.trim()); };
  const say = (msg, err) => { note.textContent = msg; note.classList.toggle('err', !!err); };
  text.addEventListener('input', sync); nick.addEventListener('input', sync);
  window.addEventListener('ch:user', () => { nameRefused = false; sync(); });
  sync();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    const token = window.turnstile?.getResponse() || form.querySelector('[name=cf-turnstile-response]')?.value;
    if (!token) return say('One moment, checking you are human…', true);
    const sent = text.value, stored = userName(), author = stored || nick.value.trim();
    busy = true; sync();
    try {
      const r = await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comet_id: c.id, body: sent, author, turnstile: token }) });
      const out = await r.json().catch(() => ({}));
      if (r.status === 400 && out.field === 'author' && stored) nameRefused = true;
      if (!r.ok) throw new Error(out.error || `Could not post (${r.status})`);
      c.comments.push(out.comment); show();
      if (text.value === sent) text.value = '';
      say('');
    } catch (err) { say(err.message, true); }
    finally { window.turnstile?.reset(); busy = false; sync(); }
  });
}

// ---------------------------------------------------------------- the list
function row(c, lazy) {
  const a = el('a', 'crow'); a.href = `comet.html?id=${encodeURIComponent(c.id)}`; a.dataset.id = c.id;
  const th = el('span', 'th');
  if (c.thumb) { const im = el('img'); im.src = c.thumb; im.alt = ''; if (lazy) im.loading = 'lazy'; th.append(im); } else th.append(el('span', 'nophoto'));
  const t = el('span', 'tx'), name = el('b', null, c.id); name.dataset.label = 'name';
  const sub = el('small');
  if (c.first != null) {
    const a1 = F.mjdMs(c.first), b1 = F.mjdMs(c.last), m = ms => new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('Sept', 'Sep');
    sub.dataset.label = 'measured'; sub.append(`In pictures ${m(a1) === m(b1) ? m(a1) : `${m(a1)} – ${m(b1)}`}`, mark('measured'));
  }
  t.append(name, sub);
  const go = el('span', 'cgo'); go.innerHTML = ARROW;
  a.append(th, t, go);
  return a;
}
function list() {
  document.title = 'Comets · Trailblazer';
  $('l-all').hidden = false;
  fetch('/api/comets').then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(({ comets }) => {
    const known = comets.filter(c => c.kind === 'known' && c.real);
    const firsts = known.map(c => c.first).filter(v => v != null), lasts = known.map(c => c.last).filter(v => v != null);
    const my = ms => F.monthYear(ms);
    $('l-intro').append(`${known.length} known comets in NASA SPHEREx pictures${firsts.length ? `, ${my(F.mjdMs(Math.min(...firsts)))} to ${my(F.mjdMs(Math.max(...lasts)))}` : ''}.`, mark('measured'));
    // start here: an interstellar comet, and comets passing the Sun now that SPHEREx detected
    const passing = c => [c.peri_prev, c.peri_next].some(jd => jd != null && Math.abs(F.jdMs(jd) - TODAY) <= F.W * 864e5);
    const feat = known.filter(c => /^\d+I\//.test(c.id) || (passing(c) && (c.co2 === 'detected' || c.seen > 0)))
      .sort((a, b2) => /I\//.test(b2.id) - /I\//.test(a.id) || (b2.co2 === 'detected') - (a.co2 === 'detected')).slice(0, 2).sort((a, b2) => /I\//.test(a.id) - /I\//.test(b2.id));
    for (const c of feat) {
      const a = el('a', 'fc'); a.href = `comet.html?id=${encodeURIComponent(c.id)}`;
      const ph = el('div', 'cph'); if (c.thumb) { const im = el('img'); im.src = c.thumb; im.alt = ''; ph.append(im); } ph.append(el('span', 'cring'));
      const tx = el('div'), interstellar = /^\d+I\//.test(c.id);
      tx.append(el('p', 'kicker', interstellar ? 'From outside the Solar System' : 'Passing the Sun now'));
      const h = el('h3', null, c.id); h.dataset.label = 'name'; tx.append(h);
      const dsc = el('p', 'd');
      if (interstellar) { const s = el('span', null, `${F.decode(c.id)[0].text[0].toUpperCase()}${F.decode(c.id)[0].text.slice(1)}.`); s.dataset.label = 'name'; dsc.append(s, ' '); }
      else { const jd = [c.peri_next, c.peri_prev].find(j => j != null && Math.abs(F.jdMs(j) - TODAY) <= F.W * 864e5); const s = el('span', null, `Closest to the Sun on ${F.day(F.jdMs(jd))}.`); s.dataset.label = 'predicted'; s.append(mark('predicted')); dsc.append(s, ' '); }
      const sx = el('span', null, c.co2 === 'detected' ? 'SPHEREx detected carbon dioxide around it.' : `SPHEREx detected it on ${c.seen} of ${c.visits} visits.`); sx.dataset.label = 'measured'; sx.append(mark('measured'));
      dsc.append(sx);
      tx.append(dsc, Object.assign(el('span', 'clink'), { innerHTML: `Open ${ARROW}` }));
      a.append(ph, tx); $('l-feat').append(a);
    }
    const order = c => -(c.seen ?? 0) - (c.co2 === 'detected' ? 100 : 0);
    const groups = F.GROUPS.map(g => {
      const cs = known.filter(c => F.group(c) === g.key).sort((a, b2) => order(a) - order(b2) || a.id.localeCompare(b2.id));
      if (!cs.length) return null;
      const folded = g.key === 'faint' || g.key === 'partial' || g.key === 'unchecked';
      const sec = el(folded ? 'details' : 'section', `grp card ${g.key}`);
      const head = el(folded ? 'summary' : 'div', 'grp-h'), ht = el('div');
      ht.append(el('h2', null, g.name), el('p', null, g.say));
      const n = el('span', 'cn', String(cs.length)); n.dataset.label = 'measured'; n.append(mark('measured'));
      if (folded) n.append(Object.assign(el('span', 'cmore'), { innerHTML: ' Show all <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' }));
      head.append(ht, n);
      const rows = el('div', 'crows'); rows.append(...cs.map(c => row(c, folded)));
      sec.append(head, rows);
      $('l-groups').append(sec);
      return { sec, folded, rows: [...rows.children] };
    }).filter(Boolean);
    const search = () => {
      const q = $('l-q').value.trim().toLowerCase();
      let shown = 0;
      for (const g of groups) {
        let k = 0;
        for (const r of g.rows) { const on = !q || r.dataset.id.toLowerCase().includes(q); r.hidden = !on; k += on; }
        g.sec.hidden = !k; shown += k;
        if (g.folded) g.sec.open = !!q && k > 0;
      }
      $('l-feat').hidden = !!q;
      $('l-none').hidden = shown > 0;
      $('l-status').textContent = shown ? `${shown} comet${shown === 1 ? '' : 's'}` : 'No comets match.';
    };
    $('l-q').addEventListener('input', search);
    done();
  }).catch(err => { console.warn(err); $('l-none').textContent = 'Comets are unavailable right now. Try again in a moment.'; $('l-none').hidden = false; done(); });
}

// ---------------------------------------------------------------- start
if (!id) list();
else fetch(`/api/comets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(c => {
  if (c.candidate) return location.replace(`candidate.html?id=${encodeURIComponent(c.id)}`);   // a dot reported from a time-lapse has its own page
  one(c);
}).catch(err => {   // 404: not in our data (the comet may well exist); anything else: the network or the database
  console.warn(err);
  const p = document.querySelector('.missing'), a = el('a', null, 'See all comets');
  a.href = 'comet.html';
  const h = el('h1', null, err === 404 ? id : 'Could not load this comet'); h.id = 'c-id';
  p.append(err === 404 ? `${id} is not in TrailBlazer's SPHEREx data. It may be a real comet that SPHEREx has not photographed, or a name we do not know. ` : 'Try again in a moment. ', a);
  p.before(h); p.hidden = false;
  document.title = `${err === 404 ? 'Not in our data' : 'Comet'} · Trailblazer`;
  done();
});
