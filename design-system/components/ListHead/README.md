# ListHead

The top of every list page. It is in the same place on every list, and in Board and in List.

- `listHead(title, { start, end, actions, line, sticky })` gives `{ nodes, views, bar }`. Append `nodes` to the page.
- Row 1: the title only (`pageHeader`).
- Row 2: `views`, a slot for saved view tabs. It stays hidden until a page fills it.
- Row 3: the toolbar. `start` is at the left (tabs, Group, Sort, Filter). `end` is at the right (search, Board/List). `actions` come last (New invoice).
- The toolbar is 40px high on every list, so the rows start at one place.
- `line`: a rule under tabs. `sticky`: the toolbar stays at the top while rows scroll.
- The page column is `--fx-column` wide. On the Jobs board only the lanes go past it, to the right.

Code: `listHead` in `server/ui/kit.js`; `.fx-listhead`, `.fx-views` in `server/ui/flow.css`.
