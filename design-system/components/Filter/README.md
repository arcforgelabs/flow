# Filter

The Filter chip over every list (Jobs, Invoices, Reconcile, Price list), as ClickUp's: groups of rows of field, operator and value, joined by And / Or inside a group and between groups.

- `viewBar(h).filterMenu({ fields, kindOf, choicesOf, view, change })`; the rules live in `job-view.js` (`filterJobs`).
- Fields have one-word names (Type, Client, Date, Total) and an icon each; the field list has a search box.
- Each kind has ClickUp's operators (`OPERATORS`); a date's value is a range (`DATE_VALUES`).
- The view is `{ match, groups: [{ match, filters }] }`; `cleanFilterView` checks a saved one.
- Group and Sort are shared chips too: `viewBar(h).groupMenu({ options, view, change, clearable })` and `viewBar(h).sortMenu({ options, view, change, dirWords, nameOf })`. Columns is a chip from the same `viewBar(h).menu`.
- A new list page uses these chips. It never builds its own Group, Sort or Filter.
- The panel is placed again after its rows draw, with the same left-edge rule, so a wider row stays on screen (field, operator, value and delete).

Code: `viewBar` in `server/ui/view-bar.js`; `filterJobs`, `OPERATORS` in `server/ui/job-view.js`.
