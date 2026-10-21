// How Flow names a person, in one place: a person field's choices, its
// filter values and lanes, the Assignee badge, and the People page. The
// label is the person's full name; with no name, their whole email. No DOM,
// so the server builds the same label (server/core/custom-fields.js
// choosablePeople) and tests can read it (test/person.test.js).

// The longest label a native menu shows. A longer one ends in "…" and the
// full label is the option's hover name. Pages with their own lists clip
// with CSS (`text-overflow: ellipsis`) instead.
export const LABEL_MAX = 32;

// { name, email } → "Jane Citizen", or "jane@example.test" with no name.
export function personLabel(person) {
  return String(person?.name ?? '').trim() || String(person?.email ?? '').trim();
}

// A badge's letters: the first letters of the first two words of the label
// ("JC"), or of the email's part before @ ("jane.citizen@…" → "JC").
export function initialsOf(person) {
  const source = (typeof person === 'string' ? person : personLabel(person)).replace(/@.*/, '');
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// A label cut to `max` characters with "…" at the end, on one line.
export function clipLabel(text, max = LABEL_MAX) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
