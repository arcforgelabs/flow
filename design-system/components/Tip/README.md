# Tip

Every icon-only control names itself on hover and on keyboard focus.

- One listener serves the whole app (`startTips`). Give the control an `aria-label` (or `named(node, label)`), and it gets its tip.
- `data-tip` when the tip differs from the spoken name. A control with words shows no tip.

Code: `named`, `startTips` in `server/ui/tip.js`.
