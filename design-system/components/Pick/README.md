# Pick

A dialog that picks one row of a long list, with a search box over it.

- `await pickOne({ title, intro, label, find, load, item, empty, confirm, remote })` gives the picked row, or null on Cancel.
- `load(q)` answers the rows. It runs once on open. With `remote: true` it runs again as the person types (a server search); without it the rows filter in the page.
- `item(row)` draws a row: `{ value, title, meta, end }`. `end` is a short figure at the right, such as a total.
- The title names the action ("Link Harbour Dental to Xero"). `confirm` is its one word.
- Uses: New invoice from a job; Link a client to its Xero client.
- On a phone it is a sheet (Dialog), and each row is at least 44px.

Code: `pickOne` in `server/ui/kit.js`.
