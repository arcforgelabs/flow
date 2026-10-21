# FindBox

A list's own search: a round search icon that opens into a box while it has words.

- `findBox(h, { label, value, oninput })` gives `{ element, input }`. Escape clears it.
- It sits at the right of the toolbar. The sidebar search (Ctrl+K) finds anything in Flow.

Code: `findBox` in `server/ui/view-bar.js`.
