# Sidecar

The right-hand panel, as in ClickUp: tabs with an icon and one word, and ×; closed, it takes no room.

- `sidecar(h, { label, overlay, escape, tabs, onChange })` gives `{ element, open, show, close, tab, setTabs }`.
- A tab is `{ id, label, icon, render }`. A job's panel keeps it as its right column (Activity, Review); `overlay` lays it over a page (Custom fields).
- Use it for any detail beside a list. Never build a second side panel.

Code: `sidecar` in `server/ui/sidecar.js`.
