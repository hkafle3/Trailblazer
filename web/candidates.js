// The Candidates page: the detector's moving dots as cards, filtered by verdict, with how the detector was checked.
// Everything from the file is set with textContent.
import { load, VERDICT, lapseUrl, photos, motion, voter } from './candidates-data.js';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const FILTERS = [['worth_reporting', 'Worth reporting'], ['known', 'Known'], ['glitch', 'Glitch'], ['star', 'Star'], ['all', 'All']];

function check(v, data) {
  const box = $('c-check'), n = (a, b) => (b ? `${a} of ${b}` : `${a}`);
  box.append(el('h2', null, 'How the detector was checked'));
  const dl = el('dl');
  for (const [k, val] of [['Known asteroids found', n(v.known_recovered, v.known_expected)], ['Planted fake movers found', `${v.planted_found}%`],
    ['False alarms', `${v.false_per_sqdeg} per square degree`]]) { const d = el('div'); d.append(el('dt', null, k), el('dd', null, val)); dl.append(d); }
  box.append(dl, el('p', 'by', `Detector ${data.detector_version}, run ${new Date(data.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`));
  box.hidden = false;
}

function card(c) {
  const a = el('article', `cd v-${c.verdict}`), link = el('a', 'cd-open');
  a.dataset.id = c.id; a.dataset.verdict = c.verdict;
  link.href = lapseUrl(c); link.setAttribute('aria-label', `${c.id}, ${VERDICT[c.verdict]}: open the time-lapse`);
  const ph = el('span', 'ph'), img = el('img');
  img.src = c.strip; img.alt = ''; img.loading = 'lazy';
  ph.append(img, el('span', 'badge', VERDICT[c.verdict]));
  const t = el('span', 't');
  t.append(el('b', null, c.id), el('span', 'score', `score ${c.score.toFixed(2)}`));
  link.append(ph, t, el('span', 's', c.known_name ? `${c.known_name} · ${photos(c)}` : photos(c)), el('span', 's', motion(c)));
  const vote = el('div');
  a.append(link, vote);
  voter(c, vote);
  return a;
}

const got = await load();
if (!got) $('c-empty').hidden = false;
else {
  const { data, sample } = got, cards = data.candidates.map(card);
  $('c-sample').hidden = !sample;
  if (data.validation) check(data.validation, data);
  $('c-grid').append(...cards);
  const bar = $('c-filters'); bar.hidden = false;
  const show = f => {
    let n = 0;
    for (const c of cards) { const on = f === 'all' || c.dataset.verdict === f; c.hidden = !on; n += on; }
    bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === f));
    $('c-none').hidden = n > 0;
  };
  for (const [f, label] of FILTERS) {
    const b = el('button', null, label), k = f === 'all' ? cards.length : cards.filter(c => c.dataset.verdict === f).length;
    b.type = 'button'; b.dataset.f = f; b.append(el('span', 'n', String(k)));
    b.addEventListener('click', () => show(f));
    bar.append(b);
  }
  show('worth_reporting');
}
