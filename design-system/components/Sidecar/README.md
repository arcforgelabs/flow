# Sidecar

The right-hand panel, as in ClickUp: tabs with an icon and one word, and ×; closed, it takes no room.

- `sidecar(h, { label, overlay, escape, tabs, onChange, phone })` gives `{ element, open, show, close, tab, setTabs }`.
- A tab is `{ id, label, icon, render }`. A job's panel keeps it as its right column (Activity, Fix); `overlay` lays it over a page (Custom fields).
- `phone: 'page'` opens it as a full page on a phone. `recordBar` is the top bar (back, title, previous and next, menu). The main action sits at the foot. Custom fields does not pass the flag.
- Capture uses `show(node)` for its result beside the desktop list; smaller screens keep the Capture dialog.
- Use it for any detail beside a list. Never build a second side panel.

Code: `sidecar`, `recordBar` in `server/ui/sidecar.js`.
