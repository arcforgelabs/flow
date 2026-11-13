import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Copy error names the Flow call that failed only when it can tell which
// call that was (server/ui/kit.js, recentFailure).
const uiRoot = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), uiRoot).href : specifier, context),
});
const { noteFailure, recentFailure } = await import('../server/ui/kit.js');

test('Copy error names a failed call only when one call matches the words on the screen', () => {
  const t = 1_000_000;
  noteFailure({ path: '/api/invoicing/invoices/a', status: 409, code: 'conflict', message: 'Already sent.' }, t);
  assert.equal(recentFailure(t + 10, 'Already sent.').path, '/api/invoicing/invoices/a', 'one matching call is named');
  assert.equal(recentFailure(t + 10, 'Name is required.'), null, 'an error no call made names no call');
  assert.equal(recentFailure(t + 20_000, 'Already sent.'), null, 'an old failure is not this error');

  // Two reads fail at once with the same words: either could be on screen.
  const u = t + 60_000;
  noteFailure({ path: '/api/invoicing/invoices/b', status: 401, code: 'signed_out', message: 'Sign in to Flow.' }, u);
  noteFailure({ path: '/api/invoicing/jobs/c/reconcile', status: 401, code: 'signed_out', message: 'Sign in to Flow.' }, u + 5);
  assert.equal(recentFailure(u + 10, 'Sign in to Flow.'), null, 'two different calls with the same words: no call, not a wrong one');

  // The same call failing twice is still that call.
  const v = u + 60_000;
  noteFailure({ method: 'post', path: '/api/invoicing/invoices/d/send', status: 502, code: 'xero', message: 'Xero did not answer.' }, v);
  noteFailure({ method: 'POST', path: '/api/invoicing/invoices/d/send', status: 502, code: 'xero', message: 'Xero did not answer.' }, v + 5);
  assert.equal(recentFailure(v + 10, 'Xero did not answer.').path, '/api/invoicing/invoices/d/send');
});
