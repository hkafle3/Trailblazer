// Explore's Investigate layer: the detector's worth-reporting candidates (candidates-data.js) as markers at their first
// detection, placed like every marker (percent of .map-wrap from skymap.js fwd). Desktop: a click opens a small card
// with "Investigate"; phones: the peek sheet (explore-phone.js reads data-what and data-open). A Layers toggle hides them.
import { fwd } from './skymap.js';
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
  const card = Object.assign(document.createElement('div'), { className: 'mapcard glass', id: 'card-cand', hidden: true });
  card.innerHTML = '<button class="x" type="button" aria-label="Close">&times;</button><h3 data-f="id"></h3><span class="tag" data-f="what"></span><p class="mono" data-f="facts"></p><a class="btn small" data-f="go">Investigate <svg class="ic"><use href="icons.svg#arrow"/></svg></a>';
  card.querySelector('.x').addEventListener('click', () => { card.hidden = true; });
  marks.append(card);
  const what = c => `${VERDICT[c.verdict]} · score ${c.score.toFixed(2)}${got.sample ? ' · sample' : ''}`;
  for (const c of list) {
    const d = c.detections[0], a = document.createElement('a');
    a.className = 'mk cand'; a.href = lapseUrl(c); a.dataset.cand = c.id;
    a.dataset.what = what(c); a.dataset.open = 'Investigate';
    a.setAttribute('aria-label', `${c.id}, moving dot to investigate`);
    a.innerHTML = '<i></i>'; a.append(Object.assign(document.createElement('b'), { textContent: c.id }));
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
    q('id').textContent = c.id; q('what').textContent = what(c); q('facts').textContent = `${photos(c)} · ${motion(c)}`; q('go').href = a.href;
    card.classList.toggle('left', place(card, d.ra, d.dec) > 0.75);
    card.hidden = false;
  }, true);
}
