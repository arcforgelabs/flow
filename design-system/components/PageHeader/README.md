# PageHeader

The top of every page: the page's name and nothing under it.

- `pageHeader(title, { count, help, actions })`. No subtitle, no line of text under the title.
- `count`: a live number beside the name ("3 to check").
- `help`: a docs link as a small ? icon whose tip names it (`helpLink`).
- `actions`: at most one primary button, at the right.

Code: `pageHeader`, `helpLink` in `server/ui/kit.js`.
