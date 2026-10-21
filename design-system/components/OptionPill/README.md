# OptionPill

A custom field's option as a coloured pill, and the colour picker that sets it.

- `optionPill(h, name, color)`; the colours are `OPTION_COLORS` (server/core/custom-fields.js).
- `colorPicker(h, { colors, value, sample, label, onpick })` opens the palette, each colour drawn as its pill.
- Say "Custom field", never "Field".

Code: `optionPill`, `colorPicker` in `server/ui/custom-fields.js`.
