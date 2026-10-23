# Toast

A short result after an action, at the foot of the page.

- `toast(text, tone, { stay })`; tone `info`, `success`, `warn` or `danger`.
- Without `stay`, it clears after four seconds. With `stay: true`, it stays until the person closes it (a danger a failed press must not pass unseen, and a deleted invoice).
- Past tense, one line: "3 invoices sent.", "Saved."

Code: `toast` in `server/ui/kit.js`.
