# FieldError

A field that fails a check glows red, like a required field.

- `fieldError(field)` marks it; `fieldError(field, false)` clears it.
- Typing in the field clears the red. The next check marks it again if it still fails.
- Mark the field the check reads (a rule's field, a line's item), not the whole form.
- The notice above the form says what is wrong in one sentence. The red field shows where.

Code: `fieldError` in `server/ui/kit.js`, `.fx-input[aria-invalid="true"]` in `server/ui/flow.css`.
