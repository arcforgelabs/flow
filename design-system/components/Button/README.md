# Button

Every button in Flow is `button.fx-btn` with at most one modifier: `--primary`, `--ghost`, `--danger`, `--sm`, `--icon`.

- One primary per page or dialog: the next step.
- One word where it can be ("Send", "Save", "Invite"); an icon goes before the word.
- An icon-only button (`--icon`) has an `aria-label`; tip.js shows it on hover.
- A button that calls Xero or Seazona waits between presses: see HoldButton.

Code: `.fx-btn` in `server/ui/flow.css`.
