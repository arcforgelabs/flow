import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { build } from '../scripts/report/collect.mjs';
import { email, site } from '../scripts/report/render.mjs';

// The customer report is made from public GitHub records only, by the
// customer-report workflow. These tests feed it a small week of synthetic
// records and check what a customer would see in the email and the page.

const config = parse(readFileSync(new URL('../scripts/report/report.yml', import.meta.url), 'utf8'));
const NOW = '2026-10-28T01:00:00Z'; // Wednesday 28 October, Sydney
const label = (...names) => names.map((name) => ({ name }));
const impact = (text) => `## What Problem This Solves\n\nx\n\n## User Impact\n\n<!-- note -->\n- **${text}** More words.\n\n## Evidence\n\nran it`;

const data = {
  repoUrl: 'https://github.com/arcforgelabs/flow/',
  releases: [
    { published_at: '2026-10-21T02:00:00Z', body: '### Highlights\n\n- Xero contacts both ways, with a switch. (#10)\n- Internal database tidy. (#11)\n\n### Changes\n' },
    { published_at: '2026-10-27T02:00:00Z', body: '### Highlights\n\n- Send keeps going. (#12) Thanks @a.\n' },
    { published_at: '2026-10-10T02:00:00Z', body: '### Highlights\n\n- Too old for this report. (#9)\n' }
  ],
  pulls: {
    10: { number: 10, title: 'feat: Xero contacts both ways', labels: label('report: major'), body: impact('Change a client once.') },
    11: { number: 11, labels: label('report: hide'), body: impact('Nobody sees this.') },
    12: { number: 12, title: 'fix: send keeps going', labels: label('report: support'), body: impact('One bad job no longer stops the batch.') }
  },
  merged: [
    { number: 12, title: 'fix: send keeps going', created_at: '2026-10-26T23:00:00Z', merged_at: '2026-10-27T01:00:00Z', labels: label('report: support'), body: `Closes #40\n\n${impact('One bad job no longer stops the batch.')}` }
  ],
  roadmap: [{ number: 50, title: '[Feature]: RFC: photo capture', labels: label('report: major'), body: '' }],
  openPulls: [{ number: 60, draft: true, body: 'Related: #50' }],
  opened: { 40: '2026-10-26T21:00:00Z' },
  evidence: {}
};

test('the report covers last Monday to Sunday and this week, from labelled records only', () => {
  const r = build(config, data, NOW);
  assert.equal(r.period.label, '19 – 28 October 2026');
  assert.deepEqual(r.items.map((i) => i.id), ['pr10', 'pr12', 'i50']);
  const [contacts, send, photo] = r.items;
  assert.equal(contacts.title, 'Xero contacts both ways');
  assert.equal(contacts.why, 'Change a client once.');
  assert.deepEqual([contacts.kind, send.kind, photo.kind], ['new', 'fix', 'new']);
  assert.ok(contacts.major && contacts.day === 'wed');
  assert.ok(send.support && send.day === 'wtd');
  assert.deepEqual([photo.title, photo.next, photo.status], ['Photo capture', true, 'In progress · Build, 25% to Ready']);
  assert.deepEqual(r.ahead.planned, { label: 'Planned releases', note: '1 major' });
  assert.deepEqual(r.stats.map((s) => [s.label, s.value, s.note]), [
    ['Updates', '1', '+1 this week'], ['Security', '0', '+0 this week'], ['Support', '0', 'resolved, +1 this week']
  ]);
  // Request to fix: issue #40 opened 2026-10-26T21:00Z, its fix merged 2026-10-27T01:00Z.
  assert.deepEqual(r.ongoing.map((o) => o.result), ['All clear', 'Watching', '1 resolved']);
  const e = build(config, { ...data, errors: { caught: 3, resolved: 2 } }, NOW).ongoing[1];
  assert.deepEqual([e.result, e.does], ['3 caught', '2 of 3 resolved.']);
  assert.equal(r.ongoing[2].does, 'Request to fix: 4 hours on average.');
  assert.equal(r.highlights[0], 'pr10');
});

test('the email is safe to send: no script, inline styles, absolute links and merge fields', () => {
  const r = build(config, data, NOW);
  const html = email(r, { siteUrl: 'https://reports.example/flow' });
  assert.doesNotMatch(html, /<script|class="/);
  assert.match(html, /src="https:\/\/reports\.example\/timeline\.png"/);
  assert.match(html, /Hi \{\{first_name\}\},/);
  assert.match(html, /\{\{unsubscribe_url\}\}/);
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) assert.match(href, /^(https:\/\/|\{\{)/);
  assert.match(html, /href="https:\/\/reports\.example\/flow#pr10"/);

  const preview = email(r, { siteUrl: 'https://reports.example/flow', inline: false, merge: { first_name: 'Sam' } });
  assert.doesNotMatch(preview, / style="/);
  assert.match(preview, /Hi Sam,/);
});

test('the web page carries the report data and the icons it names', () => {
  const r = build(config, data, NOW);
  const html = site(r, 'https://reports.example/flow');
  const json = JSON.parse(html.match(/var R = (\{.*\});\n/)[1]);
  assert.ok(!/<\/script/i.test(html.match(/var R = (\{.*\});\n/)[1]), 'no closing tag inside the data');
  assert.equal(json.links.site, 'https://reports.example/flow');
  for (const i of json.items) assert.ok(json.icons[i.icon], `icon ${i.icon}`);
});

 test('roadmap stages require an exact issue reference', () => {
  const r = build(config, { ...data, openPulls: [{ number: 60, draft: true, body: 'Related: #500' }] }, NOW);
  assert.equal(r.ahead.progress[0].stage, 'Plan');
});

test('the collector CLI writes the requested file and period', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const out = await mkdtemp(join(tmpdir(), 'flow-report-'));
  try {
    await promisify(execFile)(process.execPath, ['--import', './test/fixtures/report/github.mjs', 'scripts/report/collect.mjs', '--now', NOW, '--out', join(out, 'report.json')], {
      env: { ...process.env, GITHUB_REPOSITORY: 'example/synthetic', GITHUB_TOKEN: 'synthetic', SENTRY_AUTH_TOKEN: '' },
    });
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(report.period.label, '19 – 28 October 2026');
    assert.equal(report.items[0].title, 'Synthetic update');
  } finally { await rm(out, { recursive: true, force: true }); }
});
