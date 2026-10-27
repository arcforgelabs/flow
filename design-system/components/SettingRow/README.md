# SettingRow

One setting, laid out the same on every settings screen: a short name, one line under it, the control at the right.

- `settingRow({ label, hint, control, wide, tone })`. Switches for on and off.
- No long help in the row: a ? link beside the section title (`sectionTitle(text, help)`).
- `tone: 'danger'` marks a row that needs a person.
- On a phone a box or a menu goes under its name, full width. A switch stays at the right.

Code: `settingRow`, `sectionTitle` in `server/ui/kit.js`; `.fx-setting` in `server/ui/flow.css`.
