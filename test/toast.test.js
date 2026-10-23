import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('toast stays until closed when stay is set, and a failed Send uses it', () => {
  const kit = read('server/ui/kit.js');
  assert.match(kit, /export function toast\(text, tone = 'info', \{ stay = false \} = \{\}\)/);
  assert.match(kit, /if \(stay\) \{[\s\S]*?fx-toast__close[\s\S]*?\} else \{[\s\S]*?setTimeout\(\(\) => item\.remove\(\), 4200\)/);

  const invoicing = read('server/ui/invoicing.js');
  const stays = [...invoicing.matchAll(/toast\(error\.message, 'danger', \{ stay: true \}\)/g)];
  assert.ok(stays.length >= 2, 'bulk post and one-invoice Send keep the danger toast');
  assert.match(invoicing, /toast\('Invoice deleted\.', 'success', \{ stay: true \}\)/);
  assert.match(invoicing, /toast\(error \? `\$\{done\} of \$\{rows\.length\} deleted\. \$\{error\.message\}` : `\$\{plural\(done, 'invoice', 'invoices'\)\} deleted\.`, error \? 'danger' : 'success', \{ stay: true \}\)/);
  assert.match(invoicing, /toast\(results\.join\(' '\), refused \? 'danger' : 'success', \{ stay: true \}\)/);
});
