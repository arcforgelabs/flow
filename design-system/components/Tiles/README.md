# Tiles

Cards that open a page, in titled sections, like Claude's Customize categories.

- `tileSection(title, cards, { href, more })`: the title at the left, "Show all" at the right when `href` is given.
- `tileCard({ row: true, href, mark, title, meta, status })`: one line: a Lucide icon (or a logo node) at the left, the name, and a short dim value or the status pill at the right. Cards keep about 300px wide; as many columns as fit (one on a phone). The detail is on the page it opens, as a list.
- Without `row`, the large card of Integrations: mark, name, status, two lines and the action button.
- No arrow and no explainer on a one-line card. On the large card, leave `blurb` out when the name says enough.
- On a phone, every card is one 56px row, as a list row: the mark, the name, the status (or the dim value) and ›. The large card drops its blurb and button; they stay on the page it opens. A tablet and a desk keep the cards.

Code: `tileCard`, `tileSection` in `server/ui/kit.js`; `.fx-tile`, `.fx-tiles`, `.fx-int-card` in `server/ui/flow.css`.
