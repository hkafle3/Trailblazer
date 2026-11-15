// Explore: the all-sky map. One Mollweide projection places everything so markers, the coverage replay
// and the heat map line up with data/sky.jpg (RA increases to the left, RA 0 in the middle).
// Data: data/coverage.{png,json} (built by bake/sky_assets.py), /api/comets and /api/explored (worker/).
import { POLES, timelapseHref } from './skypos.js';
const R2 = Math.SQRT2, RAD = Math.PI / 180;
const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;

// map longitude (degrees, -180..180, positive right) and Dec -> [u, v] in 0..1 across the map
function fwdLon(lon, dec) {
  const lat = dec * RAD;
  let t = lat;
  for (let i = 0; i < 10 && Math.abs(dec) < 89.9; i++) t -= (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * t));
  const x = (2 * R2 / Math.PI) * lon * RAD * Math.cos(t), y = R2 * Math.sin(t);
  return [(x + 2 * R2) / (4 * R2), (R2 - y) / (2 * R2)];
}
const fwd = (ra, dec) => fwdLon(wrap(-ra), dec);
// [u, v] -> [ra, dec], or null outside the oval
function inv(u, v) {
  const x = (u * 2 - 1) * 2 * R2, y = (1 - v * 2) * R2;
  if ((x / (2 * R2)) ** 2 + (y / R2) ** 2 > 1) return null;
  const th = Math.asin(y / R2), lon = Math.PI * x / (2 * R2 * Math.cos(th));
  return [((-lon / RAD) % 360 + 360) % 360, Math.asin((2 * th + Math.sin(2 * th)) / Math.PI) / RAD];
}
for (const [ra, dec] of [[0, 0], [77, 30.4], [266, -29], [181, 60], [179, -75]]) {   // projection round trip
  const [r2, d2] = inv(...fwd(ra, dec));
  console.assert(Math.abs(wrap(r2 - ra)) < 1e-3 && Math.abs(d2 - dec) < 1e-3, 'projection round trip failed', ra, dec);
}

const $ = id => document.getElementById(id);
const place = (el, ra, dec) => { const [u, v] = fwd(ra, dec); el.style.left = u * 100 + '%'; el.style.top = v * 100 + '%'; return u; };
const patchUrl = (ra, dec) => timelapseHref(ra, dec, { diff: true });

// Ecliptic poles: the high-cadence deep fields. Markers sit on the map; the same links are in the side panel.
for (const p of POLES) {
  const a = document.createElement('a');
  a.className = 'mk pole';
  a.href = patchUrl(p.ra, p.dec);
  a.title = p.name;
  a.innerHTML = `<i></i><b>${p.short}</b>`;
  if (place(a, p.ra, p.dec) > 0.88) a.classList.add('left');
  $('marks').append(a);
  const btn = $(`go-${p.id}`);
  if (btn) btn.href = a.href;
}
const getJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// ---- grid and ecliptic ----
{
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1); };
  let d = '';
  for (let lon = -120; lon <= 120; lon += 60) for (let dec = -90; dec <= 90; dec += 3) d += (dec === -90 ? 'M' : 'L') + P(lon, dec);
  for (let dec = -60; dec <= 60; dec += 30) d += 'M' + P(-180, dec) + 'L' + P(180, dec);
  $('grat').setAttribute('d', d);
  const eps = 23.44 * RAD, pts = [];
  for (let l = 0; l < 360; l += 2) {
    const ra = Math.atan2(Math.cos(eps) * Math.sin(l * RAD), Math.cos(l * RAD)) / RAD;
    pts.push([wrap(-ra), Math.asin(Math.sin(eps) * Math.sin(l * RAD)) / RAD]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  $('ecl').setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + P(p[0], p[1])).join(''));
}

// ---- click anywhere on the oval: open that patch in the time-lapse with the difference view on ----
$('map').addEventListener('click', e => {
  const b = e.currentTarget.getBoundingClientRect(), rd = inv((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height);
  if (rd) location.href = patchUrl(...rd);
});
$('map').addEventListener('mousemove', e => {
  const b = e.currentTarget.getBoundingClientRect();
  const rd = inv((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height);
  const tip = $('spot');
  if (!rd) { tip.hidden = true; return; }
  const info = lookupCell(rd[0], rd[1]);
  const wrap = e.currentTarget.parentElement.getBoundingClientRect();
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 220) + 'px';
  tip.style.top = (e.clientY - wrap.top + 16) + 'px';
  const n = !info || !info.n ? 'No photos yet' : info.n >= 255 ? '255+ photos' : `${info.n} photo${info.n === 1 ? '' : 's'}`;
  tip.innerHTML = `RA ${rd[0].toFixed(1)}&nbsp;&nbsp;Dec ${rd[1] >= 0 ? '+' : ''}${rd[1].toFixed(1)}<b>${n} · click opens the patch</b>`;
});
$('map').addEventListener('mouseleave', () => { $('spot').hidden = true; });
$('search').addEventListener('submit', e => {
  e.preventDefault();
  const [ra, dec] = $('q').value.trim().split(/[\s,]+/).map(Number);
  if (Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90) location.href = patchUrl(ra, dec);
  else $('q').setCustomValidity('Type RA and Dec in degrees, e.g. 269.45 4.69'), $('q').reportValidity(), $('q').setCustomValidity('');
});

// ---- markers from /api/comets: comets people found (orange) and known objects (blue) ----
getJson('/api/comets').then(({ comets }) => {
  const marks = $('marks'), card = $('card-comet');
  const votes = c => Object.values(c.tags || {}).reduce((a, b) => a + b, 0);
  const featured = comets.filter(c => c.kind === 'comet').sort((a, b) => votes(b) - votes(a))[0];
  for (const c of comets) {
    const a = document.createElement('a');
    a.className = `mk ${c.kind}`;
    a.dataset.day = c.day ?? 0;
    a.innerHTML = '<i></i>';
    if (c.kind === 'comet') {
      a.href = `comet.html?id=${encodeURIComponent(c.id)}`;
      a.style.setProperty('--tail', `${c.tail ?? -150}deg`);
      if (c.tags.comet / Math.max(1, votes(c)) < 0.6) a.classList.add('open');   // not settled yet: hollow marker
    } else a.title = c.real ? `${c.id} (known comet)` : 'Known object (example)';
    if (c === featured) a.classList.add('sel');
    else if (c.kind === 'comet' || c.real) { const b = document.createElement('b'); b.textContent = c.id; a.append(b); }
    if (place(a, c.ra, c.dec) > 0.88) a.classList.add('left');   // label on the left only near the map's right edge
    marks.prepend(a);
  }
  if (featured) {
    const n = votes(featured), t = featured.tags;
    card.href = `comet.html?id=${encodeURIComponent(featured.id)}`;
    card.dataset.day = featured.day;
    card.querySelector('[data-f=id]').textContent = featured.id;
    card.querySelector('[data-f=count]').textContent = `${t.comet} of ${n} tags`;
    card.querySelector('.t-comet').style.setProperty('--n', t.comet);
    card.querySelector('.t-asteroid').style.setProperty('--n', t.asteroid);
    card.querySelector('.t-unsure').style.setProperty('--n', t.unsure + t.glitch);
    place(card, featured.ra, featured.dec);
    card.hidden = false;
  }
  showByDay();
}).catch(err => console.warn('comets unavailable', err));

// ---- heat map from /api/explored: patch-sized cells people have checked (mint), the rest stay dark ----
getJson('/api/explored').then(({ total, cells, suggest }) => {
  const cv = $('heat'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const level = n => (n >= 20 ? 3 : n >= 5 ? 2 : 1);
  for (const c of cells) {
    const lon0 = wrap(-c.ra_max), lon1 = lon0 + (c.ra_max - c.ra_min);   // keeps a cell whole where RA wraps at 180
    g.beginPath();
    [[lon0, c.dec_max], [lon1, c.dec_max], [lon1, c.dec_min], [lon0, c.dec_min]].forEach(([l, d], k) => {
      const [u, v] = fwdLon(l, d); k ? g.lineTo(u * W, v * H) : g.moveTo(u * W, v * H);
    });
    g.closePath();
    g.fillStyle = `rgba(95,224,173,${[0, .26, .5, .82][level(c.checks)]})`; g.fill();
    g.strokeStyle = 'rgba(4,6,11,.75)'; g.lineWidth = 1.5; g.stroke();
  }
  const fmt = n => n.toLocaleString('en-US');
  document.querySelector('[data-n=seen]').textContent = fmt(cells.length);
  document.querySelector('[data-n=total]').textContent = fmt(total);
  $('people-meter').style.setProperty('--p', cells.length / total * 100 + '%');

  const url = patchUrl(suggest.ra, suggest.dec), pin = document.createElement('a');
  pin.className = 'mk patch'; pin.href = url; pin.innerHTML = '<i></i><b>unexplored</b>';
  place(pin, suggest.ra, suggest.dec);
  $('marks').append(pin);
  const card = $('card-patch');
  place(card, suggest.ra, suggest.dec);
  card.querySelector('[data-f=where]').textContent = `RA ${suggest.ra.toFixed(1)}  Dec ${suggest.dec >= 0 ? '+' : ''}${suggest.dec.toFixed(1)}`;
  card.querySelector('[data-f=open]').href = url;
  $('go-unexplored').href = url;
}).catch(err => console.warn('explored unavailable', err));

// ---- SPHEREx coverage replay ----
// coverage.png: R*256+G = day of first photo, B = how many D1 photos cover the cell (capped at 255), A = covered.
// The day and the count for every pixel of the oval are computed once, so the slider only compares numbers.
let showByDay = () => {};
let lookupCell = () => null;
(async () => {
  const meta = await getJson('data/coverage.json');
  const img = new Image(); img.src = 'data/coverage.png'; await img.decode();
  const src = Object.assign(document.createElement('canvas'), { width: 720, height: 360 }).getContext('2d', { willReadFrequently: true });
  src.drawImage(img, 0, 0);
  const px = src.getImageData(0, 0, 720, 360).data;

  const cv = $('cover'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const depth = $('depth'), dg = depth.getContext('2d');
  const OUT = 65535, NEVER = 65534, day = new Uint16Array(W * H), count = new Uint8Array(W * H);
  let inside = 0, maxCount = 1;
  const cellIndex = (ra, dec) => (Math.min(359, Math.floor((90 - dec) / meta.step)) * 720 + Math.min(719, Math.floor(((ra % 360) + 360) % 360 / meta.step))) * 4;
  lookupCell = (ra, dec) => {
    const k = cellIndex(ra, dec);
    if (!px[k + 3]) return { n: 0, day: null };
    return { n: px[k + 2], day: px[k] * 256 + px[k + 1] };
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const rd = inv((i + .5) / W, (j + .5) / H);
    let v = OUT, n = 0;
    if (rd) {
      const info = lookupCell(rd[0], rd[1]);
      v = info.day == null ? NEVER : info.day;
      n = info.n;
      if (n > maxCount) maxCount = n;
      inside++;
    }
    day[j * W + i] = v;
    count[j * W + i] = n;
  }

  const out = g.createImageData(W, H), o = out.data, slider = $('time');
  const dout = dg.createImageData(W, H), od = dout.data;
  const FRESH = 9;   // days a newly photographed strip stays lit up
  const photos = n => n >= 255 ? '255+ photos' : `${n} photo${n === 1 ? '' : 's'}`;
  showByDay = () => { for (const el of document.querySelectorAll('[data-day]')) el.style.visibility = +el.dataset.day <= +slider.value ? '' : 'hidden'; };
  function draw() {
    const d = +slider.value; let lit = 0;
    const logMax = Math.log1p(maxCount);
    for (let k = 0; k < day.length; k++) {
      const v = day[k], q = k * 4, n = count[k];
      if (v === OUT) { o[q + 3] = 0; od[q + 3] = 0; continue; }
      if (v <= d && n > 1) {
        const t = Math.log1p(n) / logMax;
        const shown = Math.max(0, (t - 0.42) / 0.58);   // a handful of photos stays clear; the poles, which were shot many times, light up
        od[q] = 170; od[q + 1] = 205; od[q + 2] = 255; od[q + 3] = Math.round(210 * shown);
      } else od[q + 3] = 0;
      if (v <= d) {
        lit++;
        const age = d - v, fresh = age < FRESH && d < meta.days;
        o[q] = 234; o[q + 1] = 241; o[q + 2] = 255; o[q + 3] = fresh ? 70 * (1 - age / FRESH) : 0;
      } else { o[q] = 3; o[q + 1] = 5; o[q + 2] = 10; o[q + 3] = 232; }
    }
    g.putImageData(out, 0, 0);
    dg.putImageData(dout, 0, 0);
    const pct = lit / inside * 100;   // Mollweide is equal-area, so counting pixels counts sky fairly
    const when = new Date((meta.mjd0 + d - 40587) * 864e5);
    $('t-date').textContent = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    $('t-pct').textContent = (pct > 99.5 ? Math.floor(pct) : Math.round(pct)) + '% first photographed';
    slider.style.setProperty('--p', d / meta.days * 100 + '%');
    $('photo-meter').style.setProperty('--p', pct + '%');
    $('photo-meter').querySelector('b').textContent = Math.floor(pct) + '%';
    showByDay();
  }
  const poleLine = POLES.map(p => {
    const info = lookupCell(p.ra, p.dec);
    const btn = $(`go-${p.id}`);
    if (btn) btn.title = `${p.name}. ${photos(info.n)} on detector D1. Each exposure near one wavelength opens as its own frame.`;
    return `${p.short} ${photos(info.n)}`;
  }).join(' · ');
  $('pole-note').textContent = `${poleLine}. Each one near the same wavelength is its own frame.`;
  slider.max = meta.days;
  slider.value = meta.days;
  slider.addEventListener('input', draw);
  draw();

  let timer = 0;
  const play = $('play');
  play.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = 0; play.classList.remove('on'); return; }
    if (+slider.value >= meta.days) slider.value = 0;
    play.classList.add('on');
    timer = setInterval(() => { slider.value = +slider.value + 2; draw(); if (+slider.value >= meta.days) play.click(); }, 40);
  });
  document.body.dataset.ready = '1';
})();
