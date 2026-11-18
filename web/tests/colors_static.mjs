// E5, static part: the Colors page code holds no verdicts and no numbers copied from a result (the mockup's `seen: true`,
// its "30 stars", C-0176's 680 K, 2.75 mJy, 1.043 and the like). Every one of them must come from the result.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../colors.js', import.meta.url), 'utf8');
const banned = [/\bseen:\s*(true|false)/, /\b30 stars\b/, /C-0176/, /J053604/, /\b(680|690|660|650|710|720|700|630)\s*K\b/, /\b2\.75\b/, /\b1\.043\b/, /\b2\.37\b/, /\b3\.02\b/, /\b2\.71\b/, /\+10[0-9]%/, /\b(1\.96|1\.39|1\.11)\b/, /\b(verdict|v)\s*:\s*'(seen|not seen|inconclusive)'/];
let bad = 0;
for (const re of banned) { const m = src.match(re); if (m) { console.log(`FAIL web/colors.js holds ${JSON.stringify(m[0])}`); bad++; } }
console.log(bad ? `E5 static: ${bad} found` : 'E5 static: PASS, no verdict literals or copied numbers in web/colors.js');
process.exit(bad ? 1 : 0);
