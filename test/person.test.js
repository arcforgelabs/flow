import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipLabel, initialsOf, LABEL_MAX, personLabel } from '../server/ui/person.js';

test('a person is named by their full name, else their whole email', () => {
  assert.equal(personLabel({ name: 'Jane Citizen', email: 'jane@example.test' }), 'Jane Citizen');
  assert.equal(personLabel({ name: '  ', email: 'jane@example.test' }), 'jane@example.test');
  assert.equal(personLabel({ name: null, email: 'jane@example.test' }), 'jane@example.test');
  assert.equal(personLabel(null), '');
});

test('a badge takes two letters from the name, or from the email before @', () => {
  assert.equal(initialsOf({ name: 'Jane Citizen', email: 'jane@example.test' }), 'JC');
  assert.equal(initialsOf({ email: 'jane.citizen@example.test' }), 'JC');
  assert.equal(initialsOf({ email: 'admin@example.test' }), 'A');
  assert.equal(initialsOf('admin@example.test'), 'A');
  assert.equal(initialsOf({}), '?');
});

test('a long label ends in "…" at the limit; a short one is kept', () => {
  assert.equal(clipLabel('Jane Citizen'), 'Jane Citizen');
  const long = 'a.very.long.address.for.someone@laboratory.example.test';
  const clipped = clipLabel(long);
  assert.equal(clipped.length, LABEL_MAX);
  assert.ok(clipped.endsWith('…'));
  assert.ok(long.startsWith(clipped.slice(0, -1)));
});
