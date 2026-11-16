// The Candidates page: the detector's moving dots as cards, grouped by verdict as the Comets list groups its comets, with how the detector was checked.
// Everything from the file is set with textContent.
import { load, VERDICT, lapseUrl, photos, motion, voter } from './candidates-data.js';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// verdict, heading, and the Comets list's glyph for it (styles.css #c-list .g)
const GROUPS = [['worth_reporting', 'Worth reporting', 'g-co2'], ['known', 'Known', 'g-open'], ['glitch', 'Glitch', 'g-faint'], ['star', 'Star', 'g-flat']];

// the detector's own bars (bake/detector_eval.py RECOVER and CAP): each check says plainly whether it passed.
// Returns how many failed.
function check(v, data) {
  const box = $('c-check'), pct = x => `${Math.round(x * 100)}%`, known = v.known_expected ? v.known_recovered / v.known_expected : null;
  box.append(el('h2', null, 'How the detector was checked'));
  const dl = el('dl');
  let failed = 0;
  for (const [k, val, ok, bar] of [
    ['Known asteroids found', `${v.known_recovered} of ${v.known_expected}${known == null ? '' : ` (${pct(known)})`}`, known == null ? null : known >= 0.8, 'needs 80%'],
    ['Planted fake movers found', v.planted_found == null ? 'not tested' : pct(v.planted_found), v.planted_found == null ? null : v.planted_found >= 0.8, 'needs 80%'],
    ['False alarms', `${v.false_per_sqdeg} per square degree`, v.false_per_sqdeg == null ? null : v.false_per_sqdeg < 1, 'needs under 1']]) {
    const d = el('div'), dd = el('dd', null, val), verdict = el('span', `ok ${ok ? 'pass' : ok === false ? 'fail' : ''}`, ok ? 'Pass' : ok === false ? `Fail, ${bar}` : 'Not tested');
    d.dataset.pass = ok; failed += ok === false;
    d.append(el('dt', null, k), dd, verdict); dl.append(d);
  }
  box.append(dl, el('p', 'by', `Detector ${data.detector_version}, run ${new Date(data.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`));
  box.hidden = false;
  return failed;
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
  const failed = data.validation ? check(data.validation, data) : 0, fields = data.regions?.length ?? 0;
  if (!sample && failed) { $('c-test').textContent = `Test run on ${fields} field${fields === 1 ? '' : 's'}, detector still being tuned. ${failed} of its checks below ${failed === 1 ? 'fails' : 'fail'}, so treat these as early results.`; $('c-test').hidden = false; }
  for (const [v, label, glyph] of GROUPS) {
    const mine = cards.filter(c => c.dataset.verdict === v);
    if (!mine.length && v !== 'worth_reporting') continue;   // Worth reporting always shows, empty or not
    const sec = el('section', 'c-group'), h = el('h2', 'sec'), grid = el('div', 'c-grid');
    sec.dataset.v = v; h.id = `g-${v}`; sec.setAttribute('aria-labelledby', h.id);
    h.append(el('i', `g ${glyph}`), label, el('span', 'n', String(mine.length)));
    grid.append(...mine);
    sec.append(h, mine.length ? grid : el('p', 'c-none', 'None yet. The detector has not found a mover it cannot match to a known object.'));
    $('c-groups').append(sec);
  }
}
