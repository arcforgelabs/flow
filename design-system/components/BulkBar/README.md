# BulkBar

The bar at the foot of the page while rows are ticked: "N selected ×", the actions, then More.

- `bulkBar(ui, { label })` gives `{ element, draw(state) }`; `state = { count, onClear, groups, more }`.
- An action is `{ icon, label, title, run, primary, iconOnly }`: a Lucide icon and one word.
- Every action works, or says plainly that it is not available yet.

Code: `bulkBar` in `server/ui/bulk-bar.js`.
