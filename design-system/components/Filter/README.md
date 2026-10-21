# Filter

The Filter chip over every list (Jobs, Reconcile): rows of field, operator and value.

- `viewBar(h).filterMenu({ fields, kindOf, choicesOf, view, change })`; the rules live in `job-view.js` (`filterJobs`).
- Fields have one-word names (Type, Client, Date, Total) and icons on choices.
- Group, Sort and Columns are chips from the same `viewBar(h).menu`.
- A new list page uses this chip. It never builds its own filter.

Code: `viewBar` in `server/ui/view-bar.js`; `filterJobs`, `OPERATORS` in `server/ui/job-view.js`.
