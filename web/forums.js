// Forums: every comet with written comments is a thread (/api/threads). The search box finds threads and comments as you
// type: a thread matches when every word is in its name, an author or a comment. Filters narrow the list by sky region,
// by the date of the newest comment, and to known comets only. The search and filters are kept in the URL.
(() => {
  const $ = id => document.getElementById(id);
  const list = $('threads'), count = $('count'), q = $('q'), region = $('region'), date = $('date'), known = $('known');
  const DAY = 864e5, RAD = Math.PI / 180, SHOW = 3;   // comments shown per thread before "more"
  const VOTE = { comet: ['comet', 'var(--comet)'], asteroid: ['asteroid', 'var(--asteroid)'], glitch: ['glitch', 'var(--glitch)'], unsure: ['unsure', 'var(--unsure)'] };
  let threads = [];

  // ---- sky regions: north/south by Dec; near the ecliptic or the Milky Way by latitude within 15 degrees ----
  const eclLat = (ra, dec) => Math.asin(Math.sin(dec * RAD) * Math.cos(23.44 * RAD) - Math.cos(dec * RAD) * Math.sin(23.44 * RAD) * Math.sin(ra * RAD)) / RAD;
  const galLat = (ra, dec) => Math.asin(Math.sin(dec * RAD) * Math.sin(27.12825 * RAD) + Math.cos(dec * RAD) * Math.cos(27.12825 * RAD) * Math.cos((ra - 192.85948) * RAD)) / RAD;
  const REGION = {
    north: t => t.dec >= 0, south: t => t.dec < 0,
    ecliptic: t => Math.abs(eclLat(t.ra, t.dec)) < 15, galaxy: t => Math.abs(galLat(t.ra, t.dec)) < 15,
  };

  // ---- text: lower-case words; highlight builds text nodes and <mark>s, so comment text is never parsed as HTML ----
  const words = s => s.toLowerCase().split(/\s+/).filter(Boolean);
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function lit(el, text, ws) {
    if (!ws.length) { el.textContent = text; return el; }
    const re = new RegExp(`(${ws.map(reEsc).join('|')})`, 'gi');
    text.split(re).forEach((part, i) => el.append(i % 2 ? Object.assign(document.createElement('mark'), { textContent: part }) : part));
    return el;
  }
  const has = (text, w) => text.toLowerCase().includes(w);
  const when = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function card(t, ws) {
    const box = el('article', 'thread'), url = `comet.html?id=${encodeURIComponent(t.id)}`;
    box.setAttribute('aria-label', `Thread: ${t.id}`);
    // which comments to show: while searching, the ones that match (or the newest if only the name matched)
    const hits = ws.length ? t.comments.filter(c => ws.some(w => has(c.body, w) || has(c.author, w))) : [];
    const shown = (hits.length ? hits : t.comments).slice(-SHOW).reverse();   // newest first
    const head = el('div', 't-head');
    head.append(lit(el('h3'), t.id, ws));
    head.append(el('span', `t-chip ${t.kind}`, t.kind === 'known' ? 'Known comet' : 'Found by people'));
    if (!t.real) head.append(el('span', 't-chip example', 'example'));
    const open = el('a', 't-open'); open.href = url; open.setAttribute('aria-label', `Open the ${t.id} thread`);
    open.append(el('span', null, 'Open thread'));
    const go = el('span', 'go'); go.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>'; open.append(go);
    head.append(open);

    const meta = el('div', 't-meta');
    const n = t.comments.length;
    meta.append(el('span', null, `${n} comment${n === 1 ? '' : 's'}`), el('span', null, `Last ${when(t.last)}`),
      el('span', null, `RA ${t.ra.toFixed(1)}°  Dec ${t.dec >= 0 ? '+' : ''}${t.dec.toFixed(1)}°`));
    const votes = el('span', 't-votes');
    for (const [k, [label, c]] of Object.entries(VOTE)) if (t.tags[k]) { const v = el('span'); const i = el('i'); i.style.setProperty('--c', c); v.append(i, `${t.tags[k]} ${label}`); votes.append(v); }
    if (votes.childElementCount) meta.append(votes);
    const patch = el('a', null, 'See the patch');
    patch.href = `timelapse.html?ra=${t.ra.toFixed(4)}&dec=${t.dec.toFixed(4)}&det=D1&diff=1&found=${encodeURIComponent(t.id)}`;
    meta.append(patch);

    const ul = el('ul', 't-comments');
    for (const c of shown) {
      const li = el('li'), who = el('div', 't-who');
      who.append(lit(el('b'), c.author, ws), el('span', null, when(c.created_at)));
      if (c.tag) { const tg = el('span', 't-tag', `tagged ${c.tag}`); tg.style.setProperty('--c', VOTE[c.tag]?.[1] || ''); who.append(tg); }
      li.append(who, lit(el('p'), c.body, ws));
      ul.append(li);
    }
    box.append(head, meta, ul);
    const rest = (hits.length ? hits.length : n) - shown.length;
    if (rest > 0) { const more = el('a', 't-more', `${rest} more ${hits.length ? 'matching ' : ''}comment${rest === 1 ? '' : 's'}`); more.href = url; box.append(more); }
    return box;
  }

  function render() {
    const ws = words(q.value), days = +date.value, since = days ? Date.now() - days * DAY : 0, inRegion = REGION[region.value];
    const shown = threads.filter(t =>
      (!known.checked || t.kind === 'known') && (!since || t.last >= since) && (!inRegion || inRegion(t)) &&
      ws.every(w => has(t.id, w) || t.comments.some(c => has(c.body, w) || has(c.author, w))));
    list.replaceChildren(...shown.map(t => card(t, ws)));
    const filtered = ws.length || days || inRegion || known.checked;
    count.textContent = filtered ? `${shown.length} of ${threads.length} thread${threads.length === 1 ? '' : 's'}` : `${threads.length} thread${threads.length === 1 ? '' : 's'}, newest activity first`;
    if (!shown.length) {
      const empty = el('div', 'f-empty');
      empty.append(el('b', null, threads.length ? 'No threads match' : 'No threads yet'),
        el('span', null, threads.length ? 'Try fewer words, or loosen the filters.' : 'Comment on a comet and its thread starts here.'));
      list.append(empty);
    }
    // keep the search in the URL, so a search can be shared or reloaded
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (region.value) p.set('region', region.value);
    if (date.value) p.set('date', date.value);
    if (known.checked) p.set('known', '1');
    history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
  }

  // start from the URL
  const P = new URLSearchParams(location.search);
  q.value = P.get('q') || '';
  if (REGION[P.get('region')]) region.value = P.get('region');
  if ([...date.options].some(o => o.value === P.get('date'))) date.value = P.get('date');
  known.checked = P.get('known') === '1';
  let timer = 0;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 120); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); render(); } });
  for (const f of [region, date, known]) f.addEventListener('change', render);

  count.textContent = 'Loading threads...';
  fetch('/api/threads').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(d => { threads = d.threads; render(); })
    .catch(err => {
      console.warn('threads unavailable', err);
      count.textContent = '';
      const empty = el('div', 'f-empty');
      empty.append(el('b', null, 'Threads did not load'), el('span', null, 'The server is not answering. Reload the page to try again.'));
      list.replaceChildren(empty);
    });
})();
