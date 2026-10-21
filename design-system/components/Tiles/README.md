# Tiles

Cards that open a page, in titled sections of two columns, like Claude's Customize page.

- `tileSection(title, cards, { href, more })`: the title at the left, "Show all" at the right when `href` is given.
- `tileCard({ row: true, href, mark, title, blurb, meta, status })`: a Lucide icon (or a logo node) at the left, the name, two lines at most, a dim meta line, and the status pill or an arrow at the right.
- Without `row`, the large card of Integrations: mark, name, status, two lines and the action button.
- The lines say something real (a rule's test, a setting's value). Leave `blurb` out when the name says enough.

Code: `tileCard`, `tileSection` in `server/ui/kit.js`; `.fx-tile`, `.fx-tiles`, `.fx-int-card` in `server/ui/flow.css`.
