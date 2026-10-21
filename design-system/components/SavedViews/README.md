# SavedViews

The row of named view tabs over a list (Jobs, Invoices, Reconcile), as ClickUp's view tabs.

- `savedViews(ui, { page, current, apply })` gives `{ element, opening, draw }`. The page places `element` between its title and its toolbar, opens on `opening()` when it gives a view, and calls `draw()` after each change to its view.
- "+ View" saves the page's Group, Sort, Filter and Columns under a name.
- While the page differs from the chosen tab, the tab has a dot, and Save and Revert show at the right.
- Each tab's ⋯: Set as my default (a house icon marks it), Rename, Delete. A person's default opens when they first come to the page.
- The views follow the account: `PUT /api/me/saved-views/:page`; `list-views.js` checks them.

Code: `savedViews` in `server/ui/saved-views.js`; `normaliseSavedViews` in `server/ui/list-views.js`.
