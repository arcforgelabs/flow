# SettingRow

One setting, laid out the same on every settings screen: a short name and the control at the right. No line of text under the name.

- `settingRow({ label, hint, help, control, wide, tone })`. Switches for on and off.
- `help`: the explanation. A ? beside the name shows it on hover. A press shows it under the name (a phone has no hover). Give `help` only when the name is not clear alone.
- `hint`: a short status line only ("3 copied, 1 in Flow", "Checking…"). Never an explanation.
- A section's docs link is the ? beside the section title (`sectionTitle(text, help)`).
- `tone: 'danger'` marks a row that needs a person.
- On a phone a box, a menu or a choice goes under its name, full width. A switch or a button stays at the right.
- On a phone or tablet the switch, the name's ? and the title's ? have a 44px touch area. The switch looks the same.
- Every settings page uses this row (Integrations, Automations, Rules, Price codes, Price list, Sending). Do not copy it.

Code: `settingRow`, `sectionTitle` in `server/ui/kit.js`; `.fx-setting` in `server/ui/flow.css`.
