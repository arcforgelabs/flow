# ListHead

The top of every list page. It is in the same place on every list, and in Board and in List.

- `listHead(title, { controls, views, start, end, actions, line, sticky, controlsAt })` gives `{ nodes, views, bar }`. Append `nodes` to the page.
- Row 1: the title only (`pageHeader`).
- Row 2: the toolbar. `start` is at the left (tabs). `end` is at the right (search, Board/List). `actions` come last (New invoice).
- `controls` (Group, Sort, Filter) and `views` (the saved view tabs, SavedViews) sit together in the toolbar. They are at the end of `start`. With `controlsAt: 'end'` they are at the start of `end` (Invoices).
- On a phone, the controls and views are one row that scrolls sideways.
- The toolbar is 40px high on every list, so the rows start at one place.
- Every control in it (chips, view tabs, search, Board/List, the page's button) is one height: `--fx-control-h` (32px).
- Under a tab line, the controls keep 8px clear of the line. Only the tabs sit on it.
- `line`: a rule under tabs. `sticky`: the toolbar stays at the top while rows scroll.
- Every page uses the whole width with a slim edge (`--fx-gutter`, 24px), so the title starts at one place on every page.

Code: `listHead` in `server/ui/kit.js`; `.fx-listhead`, `.fx-views` in `server/ui/flow.css`.
