# Dialog

A confirm step before an action that is hard to undo.

- `await dialog({ title, body, confirm, tone })` gives the form's data, or null on Cancel.
- The title is the question ("Send 3 invoices?"). `confirm` is the action's one word.
- `tone: 'danger'` for a delete or a disconnect. A danger dialog opens with Cancel focused, so Enter alone does not confirm it.

Code: `dialog` in `server/ui/kit.js`.
