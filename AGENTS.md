# AGENTS.md

Read `VISION.md` before starting work. `README.md` indexes all other
documentation; check it first.

## UI: reuse first

Before you build a UI element, read the
[Flow Design System](https://claude.ai/artifact/WgrY4jEMYrBxGauqcXswxr)
(its `project/README.md`, then the cards) and "Shared components" in
`docs/DESIGN.md`.

- Use the shared component. If it does not do what you need, give it a new
  option (a flag) and keep one copy.
- Do not copy one page's code into another page.
- When two pages need the same pattern, make it a shared component. Add its
  row to the table and its card in `design-system/components/` in the same
  pull request (`docs/DESIGN_SYSTEM.md`). After the merge, publish the design
  system (`npm run design-system`, then the Artifact tool).
- Labels are one word where possible ("Jobs", "Invoices", "Send").
- An icon-only control has a name (`aria-label` or `title`), shown on hover.
- A page header is the title only: no line of text under it.
- Prefer white space to filler text. Say "Custom field", never "Field".
- Colours, corners and strokes come from the `--t-*` tokens, never literal
  values.
- People use Flow on a phone. Use only the three widths (639/640, 1023/1024px)
  and check the phone suite (`docs/MOBILE_TESTS.md`); a fix lowers its budget.
