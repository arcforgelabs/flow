# Tiles

Cards that open a page, in titled sections, like Claude's Customize categories.

- `tileSection(title, cards, { href, more })`: the title at the left, "Show all" at the right when `href` is given.
- `tileCard({ row: true, href, mark, title, meta, status })`: one line: a Lucide icon (or a logo node) at the left, the name, and a short dim value or the status pill at the right. Three columns where they fit. The detail is on the page it opens, as a list.
- Without `row`, the large card of Integrations: mark, name, status, two lines and the action button.
- No arrow and no explainer on a one-line card. On the large card, leave `blurb` out when the name says enough.

Code: `tileCard`, `tileSection` in `server/ui/kit.js`; `.fx-tile`, `.fx-tiles`, `.fx-int-card` in `server/ui/flow.css`.
