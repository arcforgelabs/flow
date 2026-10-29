import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { skipWithoutDatabase } from './support/db.js';

test('the recorder holds the payment result for the requested reading time', {
  skip: skipWithoutDatabase, timeout: 120_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-walkthrough-hold-'));
  try {
    const shots = JSON.parse(await readFile(new URL('../scripts/demo/shots/xero-paid.json', import.meta.url)));
    shots.steps[2].hold = 4500;
    const input = join(dir, 'shots.json');
    const output = join(dir, 'take');
    await writeFile(input, JSON.stringify(shots));
    await promisify(execFile)(process.execPath, ['scripts/demo/walkthrough.mjs', input, output], { timeout: 110_000 });
    const take = JSON.parse(await readFile(output + '.json'));
    const result = take.steps[2];
    assert.ok(result.end - result.start >= 4.5, 'the paid result must stay visible for at least 4.5 seconds');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
