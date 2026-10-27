# Phone tests

People use Flow on a phone every day. The phone suite opens the real app in a
browser at phone, tablet and desk sizes and checks each screen. It runs on
every pull request that changes the screens (`.github/workflows/mobile.yml`).
The plan it serves is issue #278: one phone layout per view type, each in its
shared component.

```text
test/mobile/server.js ──► fresh PostgreSQL, synthetic lab, jobs, invoices,
                          one owner per project, fake sign-in
test/mobile/phone.spec.js ─► 19 screens × 5 sizes × 2 engines × 3 themes
        │
        ├─ checks against test/mobile/budget.json
        └─ screenshots against test/mobile/__screenshots__/
```

## What it checks

| Check | Rule | Where |
| --- | --- | --- |
| Page overflow | The page is never wider than the screen. A table or board window may scroll inside itself | Every size |
| Touch targets | Every control on screen is 44px or more both ways (a label around a control counts) | Phone and tablet |
| Cut text | Text cut with "…" has its full text on hover or press (`title`, `aria-label` or a tip) | Every size |
| Toolbar | The list toolbar sits in the same place on every list page | Every size |
| Rows | A list shows 7 rows or more on a 375×667 screen | Small phone |
| Sideways | Nothing scrolls sideways on a phone unless its card names it (`scrollX` in `mobile.json`: tabs, the toolbar row, the list and board window). A table inside a card uses CardRows. No budget | Phone |
| Split notice | A notice's title sits on the same line as its text. No budget | Every size |
| Accessibility | axe, WCAG 2.2 A and AA | Phone |
| Screenshot | The screen matches its saved image (0.2% of pixels may differ) | Meridian light at every size; the other themes at the phone size |

Each design-system card has phone rules in `mobile.json`
(`docs/DESIGN_SYSTEM.md`). The suite reads them. On every screen a card
lists, that component is on the page and shows the layout, touch size and
row height the card names for this width (`server/ui/mobile.js` marks the
element). A list at 375×667 has to show the row count its card asks for
(the Columns card asks for 7). Page overflow and touch targets stay on
the budget below.

The sizes are 375×667, 393×852, 412×915, 768×1024 and 1280×800; the engines
WebKit (iPhone Safari) and Chromium; the themes Meridian light, Meridian dark
and Harbour light (`test/mobile/themes.js`). The screens are in
`test/mobile/screens.js`.

## The budget

Flow does not meet every rule yet. `test/mobile/budget.json` holds what each
screen has today, per project (`<size>-<engine>-<theme>/<screen>`): pixels of
overflow, small controls, cut texts, axe findings per rule, and the lists
where the toolbar moves. A screen may not get worse than its budget. A
pull request that fixes a screen lowers its budget in the same pull request.
A budget never goes up to let a change through; an empty entry means the
screen meets every rule.

## Widths

Flow has three widths: phone up to 639px, tablet 640–1023px, desk from
1024px. A media query uses only `max-width: 639px`, `min-width: 640px`,
`max-width: 1023px` or `min-width: 1024px`. `test/breakpoints.test.js`
fails on any other width, except the older ones it lists with the issue that
removes each.

## Run it

```sh
# A throwaway database: the suite drops Flow's schema and remakes its public schema.
FLOW_TEST_DATABASE_URL=postgres://flow:flow@localhost:5432/flow_mobile npm run test:mobile
# Without WebKit installed, Chromium only:
MOBILE_ENGINES=chromium npm run test:mobile
# One project:
npm run test:mobile -- --project phone-chromium-meridian-light
```

Screenshots made on a laptop do not match the saved ones (fonts render
differently). Compare them only in CI.

## Saved images and the budget

The saved images and the budget are made in CI, in the same Playwright image
the suite runs in:

1. Push the pull request.
2. Add the label `mobile-baseline` to the pull request, or run **Mobile
   Baseline** (Actions) on its branch. `budget: lower` lowers numbers after a
   fix; `budget: start` writes the budget from the run (the first time, or
   after adding screens). The label starts the budget when it is empty and
   lowers it otherwise.
3. It commits `test/mobile/__screenshots__/` and `test/mobile/budget.json`
   to the branch. Check the changed images in the pull request.
4. It then starts **Mobile** on the new commit (a commit made by a
   workflow starts no workflow on its own).
