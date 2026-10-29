# IconPicker

A button that shows an icon, and a panel that picks a new one: a search box over a grid of Lucide icons.

- `iconPicker({ value, fallback, label, onpick })` gives `{ element, value(), fallback(name) }`. Put `element` where the icon goes.
- `value` null shows `fallback` (the icon a thing has by default). "Default" goes back to it and gives `onpick(null)`.
- The grid shows `ICON_CHOICES` first. A search finds any Lucide icon by its name or its words.
- Each icon is named on hover and for a screen reader (Tip). The chosen icon is marked.
- On a desk and a tablet the panel opens under the button. On a phone it is a sheet at the foot, and each icon is 44px.
- Uses: the icon of a rule (Rules, Edit rule).

Code: `iconPicker`, `ICON_CHOICES` in `server/ui/kit.js`; `.fx-icons` in `server/ui/flow.css`.
