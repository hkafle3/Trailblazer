// spherexRows() (the fast reader for IRSA search answers) must give the same values as the full CSV parser
// for any CSV, and be much cheaper on a real one. Run: node worker/check_csv.mjs (also part of npm test).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const parseCsv = new Function(src.match(/function parseCsv[\s\S]*?\n}\n/)[0] + 'return parseCsv;')();
const spherexRows = new Function('parseCsv', src.match(/const SPX_COLS[\s\S]*?\nfunction spherexRows[\s\S]*?\n}\n/)[0] + 'return spherexRows;')(parseCsv);
const pick = r => ['obs_id', 't_min', 'access_url', 'energy_bandpassname', 'dataproduct_subtype'].map(k => r[k]).join('|');

const H = 'dataproduct_subtype,proposal_title,energy_bandpassname,obs_id,access_url,t_min,cloud_access';
const H2 = 'obs_id,t_min,access_url,energy_bandpassname,dataproduct_subtype,extra';
// IRSA's real layout: our columns first, then cloud_access as unbalanced-looking JSON spread over several fields
const real = 'dataproduct_subtype,energy_bandpassname,obs_id,access_url,t_min,cloud_access\n' +
  Array.from({ length: 4000 }, (_, i) => `science,SPHEREx-D1,o${i},https://irsa.ipac.caltech.edu/ibe/data/spherex/x${i}.fits,${60000 + i},` +
    '{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"x.fits", "region": "us-east-1"}},,1,' + 'level2_2025W18_1B_0034,'.repeat(30)).join('\n') + '\n';   // ~900 characters a row, like IRSA's
const cases = {
  plain: `${H}\nscience,x,SPHEREx-D1,o1,u1,1,{"a": 1}\n`,
  quotedEarly: `${H}\nscience,"a, b",SPHEREx-D1,o1,u1,1,z\n`,
  multilineEarly: `${H}\nscience,"line1\nline2",SPHEREx-D1,o1,u1,1,z\nscience,x,SPHEREx-D1,o2,u2,2,z\n`,
  lateQuote: `${H}\nscience,x,SPHEREx-D1,o1,u1,1,"{""k"": 1}"\n`,
  crlf: `${H}\r\nscience,x,SPHEREx-D1,o1,u1,1,z\r\n`,
  trailingMultiline: `${H2}\nreal,60000,real.fits,SPHEREx-D1,science,"start\nfake,60001,fake.fits,SPHEREx-D1,science,tail"\n`,
  trailingMultilineCrlf: `${H2}\r\nreal,60000,real.fits,SPHEREx-D1,science,"start\r\nfake,60001,fake.fits,SPHEREx-D1,science,tail"\r\n`,
  quotedHeader: `"note,extra",${H2}\nx,y,real,60000,real.fits,SPHEREx-D1,science,z\n`,
  irsaLayout: real,
};
let fail = 0;
for (const [name, text] of Object.entries(cases)) {
  const ok = JSON.stringify(parseCsv(text).map(pick)) === JSON.stringify(spherexRows(text).map(pick));
  console.log(`${ok ? 'PASS' : 'FAIL'} spherexRows matches parseCsv: ${name}`); fail += !ok;
}
const time = f => { for (let i = 0; i < 3; i++) f(real); const t = performance.now(); for (let i = 0; i < 5; i++) f(real); return (performance.now() - t) / 5; };
const fast = time(spherexRows), full = time(parseCsv);
const quick = fast * 4 < full;   // the point of the fast path; it takes the full parser's place only when safe
console.log(`${quick ? 'PASS' : 'FAIL'} spherexRows is fast on IRSA's layout: ${fast.toFixed(1)} ms vs ${full.toFixed(1)} ms`); fail += !quick;
process.exit(fail ? 1 : 0);
