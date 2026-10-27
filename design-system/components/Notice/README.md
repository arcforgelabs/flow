# Notice

A note on the page that stays until the cause is gone.

- `notice(text, tone, title, { short })`; tone `info`, `warn`, `danger` or `success`.
- `short`: one line a phone shows in place of the title and text
  ("Client not in Xero"). Use it when the note sits in a row with buttons.
- One fact per sentence. Say what to do, not what went wrong inside.
- A short result after a click is a Toast, not a Notice.

Code: `notice` in `server/ui/kit.js`.
