# CardRows

A table that is a list of small cards on a phone, and a table on a tablet and desk.

- `cardRows(table, { areas, columns })` once, on the `<table>`. It answers the table.
- `areas`: one string per card line, as CSS `grid-template-areas` (`'item item qty remove'`).
- `columns`: the card's column sizes, as `grid-template-columns`.
- A cell names its place with `data-area` and its column name with `data-label`. A phone shows the name above the value.
- `data-end` puts a cell at the right (an amount).
- Rows drawn later are placed too. Inputs and buttons are 44px high on a phone.
- Use it for a short table inside a card (invoice lines). A long list uses Columns.

Code: `cardRows` in `server/ui/kit.js`, `.fx-cardrows` in `server/ui/flow.css`.
