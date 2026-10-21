# Flow Design System

Flow is job management and invoicing for labs that make work to order, first
dental labs. This system is how Flow's screens look and the parts they are
built from. It is generated from the code in
[arcforgelabs/flow](https://github.com/arcforgelabs/flow)
(`npm run design-system`): when this page and the code disagree, the code wins.

## Before you build anything

1. Look here first. Each card is a shared component, drawn by the real code.
2. A card fits: use it as is.
3. A card almost fits: give the component an option (a flag) in its file. Keep one copy.
4. Nothing fits and two pages need it: make a shared component, and add its
   card in `design-system/components/` in the same pull request.
5. Never copy one page's code into another page.

## Words

- Labels are one word where possible: "Jobs", "Invoices", "Send", "Reconcile".
- A page header is the title only. No line of text under it, no marketing subtitles.
- One fact per sentence. Say what to do, not what went wrong inside.
- Say "Custom field", never "Field". Say "Ready to invoice", never "Ready to bill".
- Results are past tense: "3 invoices sent.", "Saved."

## Layout

- White space over filler. A page opens on work, not on words about the page.
- Lists share one toolbar: Group, Sort, Filter at the left; the search icon and
  Board/List at the right (Filter, FindBox cards).
- Ticked rows get the bulk bar at the foot (BulkBar). One record opened from a
  list gets the pager on top (Pager).
- Settings are rows: a short name, one line under it, the control at the right
  (SettingRow). Longer help is a ? link, never inline.
- Patterns follow ClickUp's (bulk bar, Group / Sort / Filter rows, column-head
  sort), in Flow's own look.

## Colour and type

- Screens use the `--t-*` tokens only, never literal colours, radii or strokes.
- Harbour (teal, mint, cream; Nunito Sans and Playfair Display; soft corners)
  is the default. Meridian (navy, champagne, stone; Plus Jakarta Sans; square
  corners) is the second own family. Eleven more are ported from OpenClaw
  (Themes card). A person picks a family, a mode and an accent.
- `--t-text` and `--t-dim` read at 4.5:1 on their surfaces; `--t-accent` at
  4.5:1 on `--t-bg`. CI checks every family and mode
  (`server/theme/contrast-audit.js`).
- `--t-brand` is the accent as chosen, for fills and the focus ring;
  `--t-accent` is the same colour shifted to read as text.
- Codes, references and amounts are in the data face (JetBrains Mono).

## Icons

Lucide, in the text colour (Icon card). An icon-only control always has a
name, shown as a tip on hover and focus (Tip card).

## Themes on a card

Every card starts in Harbour Light. `data-theme="<family>-<mode>"` on an
element shows any family inside it, for example `meridian-dark`.
