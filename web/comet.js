// Comet page: one comet from /api/comets/:id (D1). Real comets carry measured photos and a SPHEREx spectrum
// in `detail` (bake/comet_3iatlas.py); example comets have only their discussion.
const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id') || '3I/ATLAS';
const MJD_UNIX = 40587;
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
  document.querySelector('.verdict .tally').hidden = !n;
  document.querySelector('.verdict .tally-key').hidden = !n;
  for (const k of ['comet', 'asteroid', 'glitch', 'unsure']) {
    document.querySelector(`.verdict .t-${k}`).style.setProperty('--n', t[k]);
    document.querySelector(`[data-t=${k}]`).textContent = t[k];
  }
  const list = $('t-list');
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
  d.photos.forEach((p, i) => {
    const f = el('figure', i === d.photos.length - 1 ? 'now' : '');
    const plate = el('div', 'plate');
    const img = el('img'); img.src = `data/comets/3i-atlas/${p.file}`; img.alt = `3I/ATLAS on ${date(p.mjd, { day: 'numeric', month: 'short' })}`;
    const ring = el('span', i === d.photos.length - 1 ? 'ring' : 'ring earlier'); ring.style.left = '50%'; ring.style.top = '50%';
    plate.append(img, ring);
    f.title = `${p.lam.toFixed(2)} µm`;
    f.append(plate, date(p.mjd, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''));
    box.append(f);
  });
  $('c-photos-panel').hidden = false;
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
  months.forEach(([month, pts], k) => {
    const cls = k === 0 ? 'curve' : 'rock';
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
    const s = el('span'); s.append(el('i'), new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
    legend.append(s);
  });
  // label each gas over the tallest measurement near its band (published SPHEREx detections: Lisse et al. 2025)
  for (const [l, name, w] of [[4.26, 'Carbon dioxide', .06], [2.7, 'Water', .08]]) {
    const near = all.filter(p => Math.abs(p.lam - l) <= w);
    if (!near.length) continue;
    const y = sy(Math.max(...near.map(p => p.flux)));
    add('text', { class: 'lab', x: sx(l), y: Math.max(Y0 - 12, y - 24), 'text-anchor': 'middle' }, name);
    add('text', { x: sx(l), y: Math.max(Y0 + 2, y - 10), 'text-anchor': 'middle' }, `${l} µm`);
  }
  $('c-spec-note').textContent = `${all.length} SPHEREx measurements`;
  $('c-spec-panel').hidden = false;
}

fetch(`/api/comets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(c => {
  document.title = `${c.id} · Comet Catcher`;
  $('c-id').textContent = c.id;
  const n = c.tags.comet + c.tags.asteroid + c.tags.glitch + c.tags.unsure;
  if (c.kind === 'comet' && n) { $('c-verdict').textContent = c.tags.comet / n >= .6 ? 'Likely comet' : 'Undecided'; $('c-verdict').hidden = false; }
  $('c-cat').querySelector('span').textContent = c.kind === 'known' ? (c.real ? 'Known comet · real SPHEREx data' : 'Known object') : 'Not in any catalog';
  if (c.kind === 'comet') { const p = $('c-patch'); p.href = `timelapse.html?ra=${c.ra}&dec=${c.dec}&det=D1&diff=1`; p.hidden = false; }
  if (c.detail?.photos) { photos(c.detail); measures(c.detail); spectrum(c.detail); } else $('c-empty').hidden = false;
  talk(c);
}).catch(err => { $('c-id').textContent = 'Comet not found'; console.warn(err); });
