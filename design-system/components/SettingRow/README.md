# SettingRow

One setting, laid out the same on every settings screen: a short name, one line under it, the control at the right.

- `settingRow({ label, hint, control, wide, tone })`. Switches for on and off.
- No long help in the row: a ? link beside the section title (`sectionTitle(text, help)`).
- `tone: 'danger'` marks a row that needs a person.
- On a phone a box, a menu or a choice goes under its name, full width. A switch or a button stays at the right.
- Every settings page uses this row (Automations, Rules, Price codes, Price list, Sending). Do not copy it.

Code: `settingRow`, `sectionTitle` in `server/ui/kit.js`; `.fx-setting` in `server/ui/flow.css`.
