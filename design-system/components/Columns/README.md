# Columns

The table under every list (Jobs, Invoices, Reconcile, Price list), as ClickUp's: drag a head's right edge to resize the column, drag a head to move it, click or right-click a head for its menu.

- `columnTable(h, { order, widths, change, hidden, extra })` once per page; `table({ columns, rows, lead })` per draw.
- A column is `{ id, label, kind, cell(row) }`. Its kind sets its start width and its minimum (`COLUMN_WIDTH`, `COLUMN_MIN` in `job-view.js`).
- The edge grip: drag, arrow keys (16px a step), or double-click to reset. The width never goes under the kind's minimum.
- Drag a head: a line shows where it lands. A click without a drag opens the menu: Move to start, Move to end, Hide, Reset width; the page adds its own items (Sort, Edit custom field).
- + at the end lists the hidden columns. A `fixed` column (Jobs' Client) keeps its place.
- Shared cells: `dateCell` (short date, the whole date on hover), `personCell` (initials) and `fieldColumn` (a custom field as a column). Jobs and Invoices both use `fieldColumn`, so a custom field looks the same on both. On Invoices the value is the invoice's job's value.
- A list can start with some columns only (`shown` in `normaliseListView`): the rest wait in +. Invoices starts with its usual columns; Due, Case, Practitioner, Shipped and every custom field wait in +.
- The view keeps `columns` (order) and `widths`, with the person's account (`viewSaver(ui, page)`, PUT /api/me/views/:page).
- Columns never stretch. As HubSpot's, the head and every row still reach the window's right edge: the end column (+ at its right) takes the space after the last column (`endWidth` in `job-view.js`, kept up to date as the window changes size). Past the window width the table scrolls sideways. On a phone the rows stack and the widths do not apply.

Code: `columnTable`, `rowCells`, `viewSaver`, `onRightButton`, `dateCell`, `shortDate`, `personCell`, `fieldText`, `fieldColumn` in `server/ui/columns.js`; `widthOf`, `tableWidth`, `endWidth`, `moveColumn`, `normaliseListView` in `server/ui/job-view.js`.
