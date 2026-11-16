// Explore's Investigate layer: the detector's worth-reporting candidates (candidates-data.js) as markers at their first
// detection, placed like every marker (percent of .map-wrap from skymap.js fwd). Desktop: a click opens a small card
// with "Investigate"; phones: the peek sheet (explore-phone.js reads data-what and data-open). A Layers toggle hides them.
import { fwd } from './skymap.js';
import { onView } from './explore-view.js';
import { load, VERDICT, lapseUrl, photos, motion } from './candidates-data.js';
const $ = id => document.getElementById(id);
const phone = matchMedia('(max-width: 640px)');
const place = (el, ra, dec) => { const [u, v] = fwd(ra, dec); el.style.left = u * 100 + '%'; el.style.top = v * 100 + '%'; return u; };

const got = await load();
const list = got?.data.candidates.filter(c => c.verdict === 'worth_reporting') ?? [];
if (list.length) {
  const marks = $('marks');
  // the toggle, after Known objects
  $('ly-known').closest('label').insertAdjacentHTML('afterend', `<label class="layer" style="--c:var(--comet)"><input class="cbx" type="checkbox" id="ly-cand" checked><span>Investigate${got.sample ? ' (sample)' : ''}</span></label>`);
  const card = Object.assign(document.createElement('div'), { className: 'mapcard', id: 'card-cand', hidden: true });
  card.innerHTML = '<button class="x" type="button" aria-label="Close">&times;</button><h3 data-f="id"></h3><span class="tag" data-f="what"></span><p class="mono" data-f="facts"></p><a class="btn small" data-f="go">Investigate <svg class="ic"><use href="icons.svg#arrow"/></svg></a>';
  let hid = [];   // the cards this one covered: closing it shows them again
  card.querySelector('.x').addEventListener('click', () => { card.hidden = true; hid.forEach(o => { o.hidden = false; }); hid = []; });
  marks.append(card);
  const name = c => (got.sample ? `Sample ${c.id}` : c.id);   // a sample marker says so on the map and in its card
  const what = c => `${VERDICT[c.verdict]} · score ${c.score.toFixed(2)}${got.sample ? ' · sample' : ''}`;
  for (const c of list) {
    const d = c.detections[0], a = document.createElement('a');
    a.className = 'mk cand'; a.href = lapseUrl(c); a.dataset.cand = c.id;
    a.dataset.what = `${VERDICT[c.verdict]} · ${c.score.toFixed(2)}${got.sample ? ' · sample' : ''}`;   // the phone's peek line, short enough for one row
    a.dataset.rate = motion(c).split(' · ')[0]; a.dataset.open = 'Investigate'; a.dataset.photos = photos(c); a.dataset.motion = motion(c);
    a.setAttribute('aria-label', `${name(c)}, moving dot to investigate`);
    a.innerHTML = '<i></i>'; a.append(Object.assign(document.createElement('b'), { textContent: name(c) }));
    if (place(a, d.ra, d.dec) > 0.88) a.classList.add('left');
    a.cand = c;
    marks.append(a);
  }
  // desktop: the card first (capture, before explore.js's own marker clicks); phones keep the peek sheet
  marks.addEventListener('click', e => {
    const a = e.target.closest('.mk.cand');
    if (!a || phone.matches || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    const c = a.cand, d = c.detections[0], q = f => card.querySelector(`[data-f=${f}]`);
    q('id').textContent = name(c); q('what').textContent = what(c); q('facts').textContent = `${photos(c)} · ${motion(c)}`; q('go').href = a.href;
    card.classList.toggle('left', place(card, d.ra, d.dec) > 0.75);
    if (card.hidden) hid = ['card-comet', 'card-patch'].map($).filter(o => o && !o.hidden);
    hid.forEach(o => { o.hidden = true; });   // one card open at a time
    card.hidden = false;
  }, true);
  // desktop: a candidate's name goes only where it covers no other name (deep fields, comets, the unexplored patch),
  // checked after every pan and zoom; phones have explore-phone.js's declutter, which covers these too
  const declutter = () => {
    if (phone.matches) return;
    const rect = el => el.getBoundingClientRect(), hit = (r, o) => r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom;
    for (const m of marks.querySelectorAll('.mk[data-moved]')) { m.classList.remove(m.dataset.moved); delete m.dataset.moved; }
    marks.querySelectorAll('.mk.cand').forEach(a => a.classList.remove('nm-off'));
    // a diamond on another marker's name: that name moves to the left of its own dot (deep fields, the patch), else hides
    const dots = [...marks.querySelectorAll('.mk.cand i')].map(rect);
    for (const m of marks.querySelectorAll('.mk:not(.cand)')) {
      const b = m.querySelector('b');
      if (!b || !rect(b).width || !dots.some(d => hit(d, rect(b)))) continue;
      const side = m.matches('.deep, .patch') && !m.classList.contains('left') ? 'left' : 'nm-off';
      m.classList.add(side); m.dataset.moved = side;
      if (side === 'left' && (dots.some(d => hit(d, rect(b))) || rect(b).left < 0)) { m.classList.remove('left'); m.classList.add('nm-off'); m.dataset.moved = 'nm-off'; }
    }
    const others = [...marks.querySelectorAll('.mk:not(.cand) b')].map(rect).filter(r => r.width), placed = [];
    for (const a of marks.querySelectorAll('.mk.cand')) {
      const r = rect(a.querySelector('b'));
      if ([...others, ...placed].some(o => hit(r, o))) a.classList.add('nm-off'); else placed.push(r);
    }
  };
  onView(() => requestAnimationFrame(declutter));
  addEventListener('resize', declutter);
  setTimeout(declutter, 600); setTimeout(declutter, 2000);   // after the map has scaled in and the comets are placed
}
