import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../skills/flow/flow.sh', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'flow-link-'));
const id = '3f6c2a1e-8b4d-4c2f-9a7e-1d2b3c4d5e6f';
const run = (args, env = { FLOW_URL: 'https://flow.example.com/' }) => spawnSync('bash', [script, 'link', ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, LC_ALL: 'C.UTF-8', ...env },
});

test('flow.sh link prints page addresses from Flow ids', () => {
  assert.equal(run(['invoice', id]).stdout, `https://flow.example.com/invoices/${id}\n`);
  assert.equal(run(['reconcile', id]).stdout, `https://flow.example.com/reconcile/${id}\n`);
  assert.equal(run(['contact', id]).stdout, `https://flow.example.com/contacts/${id}\n`);
  assert.equal(run(['job', 'café 37']).stdout, 'https://flow.example.com/jobs?q=caf%C3%A9%2037\n');
});

test('flow.sh link refuses numbers, empty ids and a missing Flow address', () => {
  for (const args of [['invoice', 'INV-0123'], ['job', 'null'], ['job', ''], ['page', id]]) {
    const out = run(args);
    assert.equal(out.status, 2, args.join(' '));
    assert.equal(out.stdout, '');
  }
  const noAddress = run(['invoice', id], {});
  assert.equal(noAddress.status, 2);
  assert.equal(noAddress.stdout, '');
});
