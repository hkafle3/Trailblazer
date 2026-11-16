// A white or thick top rule on a box with rounded top corners curls down at both ends: Ed calls that a hard AI tell.
// This reads every stylesheet, <style> block and style="" attribute under web/ and fails when one selector gets both a
// visible top border (2px or more, or white) and a rounded top-left or top-right corner. A fully outlined box (border on
// every side, like a button) is fine: only a top rule is checked.
// Run: node web/tests/straight_rules.mjs [web dir]
// ponytail: declarations are grouped by exact selector text; two different selectors that land on one element are not
// matched (that needs a browser).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [];   // [where, css]
for (const f of readdirSync(dir).filter(f => /\.(css|html)$/.test(f))) {
  const text = readFileSync(join(dir, f), 'utf8');
  if (f.endsWith('.css')) sources.push([f, text]);
  if (f.endsWith('.html')) {
    for (const [, css] of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) sources.push([f, css]);
    for (const [, css] of text.matchAll(/\sstyle="([^"]*)"/g)) sources.push([`${f} style=""`, `inline { ${css} }`]);
  }
}

const white = v => /#fff\b|#ffffff\b|\bwhite\b|rgba?\(\s*255\s*,\s*255\s*,\s*255/i.test(v);
const off = v => /^\s*(none|0(px)?)\b/i.test(v) || /\bnone\b/i.test(v);
const thick = v => { const m = v.match(/(^|\s)(\d*\.?\d+)px/); return !!m && +m[2] >= 2; };
const shown = v => !off(v) && (thick(v) || white(v));
const round = v => !/^\s*0(px|%)?\s*$/.test(v);
function corners(v) {   // border-radius shorthand -> [top-left, top-right]
  const p = []; let depth = 0, cur = '';   // split on spaces outside brackets: calc(20 * var(--e)) is one value
  for (const ch of v.split('/')[0].trim() + ' ') {
    if (ch === ' ' && !depth) { if (cur) p.push(cur); cur = ''; continue; }
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; cur += ch;
  }
  return [p[0], p[1] ?? p[0]];
}

const sel = new Map();   // selector -> { top, sides, tl, tr, where }
for (const [where, css] of sources) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectors, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const s of selectors.split(/,(?![^()]*\))/).map(x => x.trim()).filter(Boolean)) {   // commas inside :is() stay in their selector
      const r = sel.get(s) ?? { top: false, sides: false, tl: '0', tr: '0', where };
      for (const d of body.split(';')) {
        const i = d.indexOf(':'); if (i < 0) continue;
        const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
        if (k === 'border') { r.top = r.sides = shown(v); }
        else if (k === 'border-top') r.top = shown(v);
        else if (k === 'border-top-width') r.top = !off(v) && (thick(v) || r.top);
        else if (k === 'border-top-color' && white(v)) r.top = true;
        else if (k === 'border-left' || k === 'border-right') { if (off(v)) r.sides = false; }
        else if (k === 'border-radius') [r.tl, r.tr] = corners(v);
        else if (k === 'border-top-left-radius') r.tl = v;
        else if (k === 'border-top-right-radius') r.tr = v;
        else continue;
        r.where = where;
      }
      sel.set(s, r);
    }
  }
}

const bad = [...sel].filter(([, r]) => r.top && !r.sides && (round(r.tl) || round(r.tr)));
for (const [s, r] of bad) console.log(`FAIL ${r.where}: "${s}" has a top rule and rounded top corners (${r.tl} ${r.tr}); square them so the line runs straight`);
if (bad.length) process.exit(1);
console.log(`PASS straight top rules: ${sel.size} selectors checked, no top rule curls at its ends`);
