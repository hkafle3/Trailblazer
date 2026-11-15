// spherexRows() (the fast reader for IRSA search answers) must give the same values as the full CSV parser
// for any CSV, and be much cheaper on a real one. Run: node worker/check_csv.mjs (also part of npm test).
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const parseCsv = new Function(src.match(/function parseCsv[\s\S]*?\n}\n/)[0] + 'return parseCsv;')();
const spherexRows = new Function('parseCsv', src.match(/const SPX_COLS[\s\S]*?\nfunction spherexRows[\s\S]*?\n}\n/)[0] + 'return spherexRows;')(parseCsv);
const pick = r => ['obs_id', 't_min', 'access_url', 'energy_bandpassname', 'dataproduct_subtype'].map(k => r[k]);

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
  duplicateHeader: 'obs_id,t_min,access_url,energy_bandpassname,dataproduct_subtype,obs_id\na,60000,u,SPHEREx-D1,science,b\n',
  bareCarriageReturn: 'obs_id,t_min,access_url,energy_bandpassname,dataproduct_subtype\na,60000,u,SPHEREx-D1,science\rb,60001,v,SPHEREx-D1,science\r\n',
  oneFieldLine: 'obs_id,t_min,access_url,energy_bandpassname,dataproduct_subtype\nstray\n',
  pipesInValues: 'obs_id,t_min,access_url,energy_bandpassname,dataproduct_subtype,obs_id,t_min\na|b,c,u,SPHEREx-D1,science,a,b|c\n',
  irsaLayout: real,
};
let fail = 0;
for (const [name, text] of Object.entries(cases)) {
  const ok = isDeepStrictEqual(parseCsv(text).map(pick), spherexRows(text).map(pick));
  console.log(`${ok ? 'PASS' : 'FAIL'} spherexRows matches parseCsv: ${name}`); fail += !ok;
}
const time = f => { for (let i = 0; i < 3; i++) f(real); const t = performance.now(); for (let i = 0; i < 5; i++) f(real); return (performance.now() - t) / 5; };
const fast = time(spherexRows), full = time(parseCsv);
const quick = fast * 4 < full;   // the point of the fast path; it takes the full parser's place only when safe
console.log(`${quick ? 'PASS' : 'FAIL'} spherexRows is fast on IRSA's layout: ${fast.toFixed(1)} ms vs ${full.toFixed(1)} ms`); fail += !quick;
// IRSA's Gaia answer (IPAC table): columns found by name in any order, stars without a proper motion dropped
const ipacStars = new Function(src.match(/function ipacStars[\s\S]*?\n}\n/)[0] + 'return ipacStars;')();
const ipac = ['\\fixlen = T', '|  dec|   ra|  pmdec|   pmra| phot_g_mean_mag| dist|', '| double| double| double| double| double| double|',
  '  4.73942  269.44850  10362.394  -801.551  8.193974  99.9', '  4.76743  269.44674  null  null  20.89  1.99', ''].join('\n');
const got = ipacStars(ipac), okIpac = isDeepStrictEqual(got, [{ ra: 269.4485, dec: 4.73942, pmra: -801.551, pmdec: 10362.394, g: 8.193974 }]);
console.log(`${okIpac ? 'PASS' : 'FAIL'} IRSA Gaia table: columns by name, no-motion stars dropped`); fail += !okIpac;
let threw = false; try { ipacStars('<html>IRSA error</html>'); } catch { threw = true; }
console.log(`${threw ? 'PASS' : 'FAIL'} IRSA Gaia table: an error page is refused, not read as no stars`); fail += !threw;
// ESA's fallback answer: the same stars from plain CSV, and an error page refused
const esaStars = new Function(src.match(/function esaStars[\s\S]*?\n}\n/)[0] + 'return esaStars;')();
const okEsa = isDeepStrictEqual(esaStars('ra,dec,pmra,pmdec,g\r\n269.4485,4.73942,-801.551,10362.394,8.193974\r\n'), [{ ra: 269.4485, dec: 4.73942, pmra: -801.551, pmdec: 10362.394, g: 8.193974 }]);
let esaThrew = false; try { esaStars('<html>ESA error</html>'); } catch { esaThrew = true; }
console.log(`${okEsa && esaThrew ? 'PASS' : 'FAIL'} ESA Gaia CSV: stars read, an error page refused`); fail += !(okEsa && esaThrew);
// SkyBoT rows: every row must read, the V <= 21 cut uses the exact magnitude, comets always kept
const sexagesimal = new Function(src.match(/function sexagesimal[\s\S]*?\n}\n/)[0] + 'return sexagesimal;')();
const skybotRows = new Function('sexagesimal', src.match(/function skybotRows[\s\S]*?\n}\n/)[0] + 'return skybotRows;')(sexagesimal);
const row = (Name, ra, dec, mag, Class = 'MB>Middle') => ({ Name, 'RA (hms)': ra, 'DEC (dms)': dec, 'VMag (mag)': mag, Class, 'Err (arcsec)': 1 });
const swan = row('C/2025 R2', '05 09 14.4693', '+27 21 19.971', 20.3, 'Comet');
const sky = skybotRows([swan, row('bright', '05 09 10', '+27 22 0', 18.8), row('just faint', '05 09 11', '+27 22 1', 21.04)]);
const okSky = sky && sky.comets[0]?.name === 'C/2025 R2' && Math.abs(sky.comets[0].ra - 77.31029) < 1e-4 && sky.asteroids.map(a => a.name).join() === 'bright';
const noClass = { ...row('z', '05 09 10', '+27 22 0', 18) }; delete noClass.Class;
const bad = [[swan, row('x', 'garbage 12', '+27 22 0', 18)], [null], [swan, row('y', '25 00 00', '+27 22 0', 18)],
  [row('m', '05 99 10', '+27 22 0', 18)], [row('g', '05 09 10', '+27 22 0', 'unreadable')], [noClass], [row('b', '05 09 10', '+27 22 0', 18, '  ')]].every(r => skybotRows(r) === null);
const noMag = skybotRows([row('C/1', '05 09 10', '+27 22 0', null, 'Comet')]);
const okNoMag = noMag && noMag.comets[0].mag === null;
console.log(`${okSky && bad && okNoMag ? 'PASS' : 'FAIL'} SkyBoT rows: comet kept (with or without a magnitude), V 21.04 cut, an unreadable, impossible or unclassed row makes the answer unavailable`); fail += !(okSky && bad && okNoMag);
process.exit(fail ? 1 : 0);
