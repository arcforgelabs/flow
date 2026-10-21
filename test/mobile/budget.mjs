import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes budget.json from the last run's measures (results/measure): what
// each screen has today, so the suite stops anything getting worse
// (docs/MOBILE_TESTS.md). Run it only to start the budget or to lower it
// after a fix: `npm run test:mobile:budget`. A budget never goes up to let a
// change through.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'results', 'measure');
const out = join(here, 'budget.json');
const lower = process.argv.includes('--lower');
const previous = lower ? JSON.parse(readFileSync(out, 'utf8')) : {};
const budget = lower ? { ...previous } : {};

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const [project, screen] = file.replace(/\.json$/, '').split('__');
  const m = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const key = `${project}/${screen}`;
  let entry;
  if (screen === 'toolbar') {
    entry = m.moved.length ? { moved: m.moved } : null;
  } else {
    entry = {};
    for (const k of ['overflow', 'small', 'cut']) if (m[k]) entry[k] = m[k];
    if (m.axe && Object.keys(m.axe).length) entry.axe = m.axe;
    if (!Object.keys(entry).length) entry = null;
  }
  // With --lower, a screen with no budget meets every rule and stays so.
  if (lower) entry = previous[key] ? lowerOnly(previous[key], entry ?? {}) : null;
  if (entry && Object.keys(entry).length) budget[key] = entry;
  else delete budget[key];
}

writeFileSync(out, `${JSON.stringify(Object.fromEntries(Object.entries(budget).sort()), null, 1)}\n`);
console.log(`budget.json: ${Object.keys(budget).length} screens over the rules`);

// With --lower, a number only goes down.
function lowerOnly(before, now) {
  const out = {};
  for (const k of ['overflow', 'small', 'cut']) {
    const v = Math.min(before[k] ?? 0, now[k] ?? 0);
    if (v) out[k] = v;
  }
  const axe = {};
  for (const [rule, n] of Object.entries(before.axe ?? {})) {
    const v = Math.min(n, now.axe?.[rule] ?? 0);
    if (v) axe[rule] = v;
  }
  if (Object.keys(axe).length) out.axe = axe;
  if (before.moved) {
    const moved = before.moved.filter((id) => now.moved?.includes(id));
    if (moved.length) out.moved = moved;
  }
  return out;
}
