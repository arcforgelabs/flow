#!/usr/bin/env node
// Prints the WCAG AA contrast audit (server/theme/contrast-audit.js) for every
// design system and mode. Exits 1 when a pair fails. `--json` prints rows.
import { auditTokens } from '../server/theme/contrast-audit.js';
import { THEME_FAMILIES, tokensFor } from '../server/theme/themes.js';

const rows = THEME_FAMILIES.flatMap(({ id }) => ['light', 'dark'].flatMap((mode) =>
  auditTokens(tokensFor(id, mode)).map((r) => ({ family: id, mode, ...r }))));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.family.padEnd(12)} ${r.mode.padEnd(5)} ${r.id.padEnd(20)} ${String(r.ratio).padStart(5)}:1  (min ${r.min})`);
  }
}
const failed = rows.filter((r) => !r.pass).length;
console.error(`${rows.length - failed} of ${rows.length} pairs pass WCAG AA.`);
process.exitCode = failed ? 1 : 0;
