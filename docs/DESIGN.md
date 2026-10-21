# Design system

Flow's screens use one theme engine: the one Arc Forge Labs'
[Field](https://github.com/arcforgelabs/field/blob/main/DESIGN.md) uses, so a
design system looks the same in both apps.

## Appearance

Appearance is three choices, per person, on the Appearance page
(`/appearance`). Each person's choice is saved with their account
(`people.appearance`, `PUT /api/me/appearance`) and applied when they sign
in, so people who share a browser, or move between devices, each see their
own. The browser keeps a copy (localStorage `flow_appearance`) so a page
paints in it before Flow knows who is signed in. An account with no choice
yet takes the browser's current one at its first sign-in.

- **Mode**: Light, Dark or Auto (follow the device, the default), on the
  Appearance page. The sign-in screen has a quick light or dark switch.
- **Design system**: a theme family, each with a light and a dark palette and
  its own faces, corners and label style.
  - **Harbour** (`harbour`, the default): Flow's own. One deep teal for ink,
    filled buttons and labels, a mint highlight, cream pages and white cards.
    Nunito Sans for reading, Playfair Display for page titles, soft corners,
    tracked uppercase labels. In dark mode the teal becomes the page and the
    mint the accent.
  - **Meridian** (`meridian`): a dental laboratory's look. Deep navy for ink,
    filled buttons and labels, a champagne highlight, warm stone pages and
    white cards. Plus Jakarta Sans for reading, Playfair Display at regular
    weight for page titles, square corners, widely tracked uppercase labels.
    In dark mode the navy becomes the page and the champagne the accent. An
    installation makes it the default with `FLOW_THEME=meridian`.
  - **Beacon, Tide, Claw, Knot, Dash**, then **Absolutely, Phosphor, CRT,
    Manuscript, Rosé, Miami**: ported from the
    [OpenClaw](https://github.com/openclaw/openclaw) Control UI themes (MIT
    licence, Copyright (c) 2026 OpenClaw Foundation) by
    `scripts/port-openclaw-themes.mjs`. The generated
    `server/theme/openclaw-palettes.js` keeps that attribution and the
    upstream commit.
- **Accent colour**: the family's own, one of upstream's presets (plus
  Harbour teal), or any custom colour.

An installation picks the design system every browser starts on with
`FLOW_THEME` (any family id; unset means `harbour`; an unknown id stops the
server). A person's own choice on the Appearance page wins wherever they sign in.

## How it works

```text
server/theme/themes.js ──► /assets/themes.css      every family × mode as
  (the --t-* tokens)       [data-theme][data-mode] rules
        │
        ├──► /assets/theme/*.js  the same modules in the browser
        │      (accent overrides, contrast helpers, font lists)
        │
server/ui/page.js ──► every page: themes.css, flow.css, and an inline script
                      that puts the stored family and mode on <html> before
                      first paint and loads that family's faces
server/ui/appearance.js ──► applies a change, saves it in localStorage
                            (flow_appearance), tells listeners
server/ui/clerk-appearance.js ──► Clerk's components, themed from the tokens
```

`server/theme/themes.js` is the one source of the `--t-*` tokens. Screens use
the tokens, never literal colours, radii or strokes (`server/ui/flow.css`), so
every family reaches every screen. The faces are the fontsource variable
builds, served from `node_modules` under `/assets/fonts/<package>/`
(`server/theme/font-families.js`); a page loads only the chosen family's
faces. The fonts are under the SIL Open Font Licence.

The rules every family keeps, checked in both modes by `test/theme.test.js`
and by the WCAG AA audit in `test/theme-contrast.test.js` (CI fails on any
miss; `npm run theme:contrast` prints every pair). The audit
(`server/theme/contrast-audit.js`) lists each text and control colour on each
surface Flow's components and Clerk's screens put it on, and lays translucent
tints over their surface first. A new pairing on screen gets a row there.

- `--t-text` and `--t-dim` read at 4.5:1 or better on their surfaces.
- `--t-accent` is text and reads at 4.5:1 on `--t-bg`. `--t-brand` is the
  colour as chosen, for fills, highlights and the focus ring. An accent
  override shifts `--t-accent` just enough to keep 4.5:1.
- `--t-control` is the edge of an input or an outlined button: the text
  colour faded toward `--t-paper` only as far as it still reads at 3:1
  (WCAG 1.4.11). `themes.js` derives it for every family.
- A ported family that misses AA on a surface Flow uses is nudged in
  `themes.js` just far enough: `--t-dim`, `--t-accent` and `--t-brand-ink`.

## Clerk

Clerk's own components do the account work: `SignIn` on the sign-in screen,
`UserButton` in the top bar (manage account, sign out) and `UserProfile` on
the Account page. `server/ui/clerk-appearance.js` builds their appearance from
the active tokens: colours, faces, corners, and the control edges in
`--t-control`. Clerk builds its border shades (dividers, hover edges, the
"Primary" badge) as fractions of `colorBorder`, so that is the opaque text
colour, and the badge text is `--t-dim`. Clerk draws an input's edge as a box-shadow ring on a
`[data-variant]` selector, so Flow's edge rules double the class (`&&`) to win.
A change of appearance remounts every Clerk component, so Clerk follows the
theme and mode at once. Clerk's words that name the app say "Flow", whatever
the Clerk instance is called.

## Screens

The page at `/sign-in`, `/people`, `/account` and `/appearance`
(`server/ui/app-page.js`, `server/ui/app.js`):

- **Sign-in**: a brand panel (the primary colour in light mode, a raised
  surface in dark) beside Clerk's sign-in card. On a phone the panel is a
  band above the card.
- **Sidebar**: the Flow mark and the views the person may open (People and
  Integrations for owners). Account is not in the list: "Manage account" in
  the account menu opens it. At its foot: the account chip (Clerk's photo or
  initial, then the name, or the email when there is no name, clipped to fit)
  that opens the account menu (Manage account, Report a problem when Sentry
  is on, Sign out; as wide as its rows, 220px to 280px, with a long name or
  email clipped), and Search (also Ctrl+K or ⌘K) for pages, invoices and
  jobs. While Sentry's report form is on, "Report a problem" sits at the
  foot of the menu, above the chip (an icon when folded). The menu button at the top folds the sidebar to its icons and back;
  the choice stays in the browser. On narrow screens the sidebar is a bar
  across the top (menu button, Flow mark, account photo, Search), and the menu
  button opens the pages as a panel below the bar.
- **Jobs**: the board (one lane per group, about a phone wide, filling the
  window to its bottom edge, each lane scrolling inside itself) or the list.
  The toolbar has Group, Sort and Filter at the left, and the search icon
  (it opens into a box, `findBox`) and Board/List at the right. Each opens a panel of rows, laid out as
  ClickUp's, in Flow's own look; each row has a bin that deletes it, and
  an active chip has an × that clears it ("Clear all filters").
  Group by is one row: status, invoice stage, client, practitioner or a
  groupable custom field, and Ascending or Descending (the group order).
  Its bin takes the groups away: one plain list (the board always has
  lanes: status lanes). Sort is rows applied in turn (due, requested,
  shipped, client, practitioner, total or any custom field, each in
  either direction), with "Add sort"; no sort keeps the lab system's
  order. Filters are rows of field, operator and value (status, invoice
  stage, client, practitioner, Assignee, due, requested, shipped, total,
  problem, or any custom field; operators such as is, is not, is set,
  is overdue, is before, contains, is more than), with "Add filter",
  "Clear all", and And / Or for all rows. A row still being filled in
  filters nothing. Each person's view is
  saved with their account (`people.views`, `PUT /api/me/views/jobs`,
  server/ui/job-view.js), so it follows them to every device.
  In the list, Columns chooses the columns (saved with the view; Client
  always shows): Case, Practitioner, Patient (only when the installation
  keeps patient names), Stage, Assignee, Requested, Due, Shipped, Total,
  and each custom field. One column holds one field: each date has its own
  column, short (Today, Tomorrow, Yesterday, else day/month; the full date
  on hover), and a late Due date shows in red. A person column shows each
  person's badge (initials; the name on hover). In the list, sorting
  starts on the column heads, as ClickUp's: a sort button shows on hover
  (and always while the column sorts, as a filled circle with the
  arrow). A click sorts one way, a second click the other way, a third
  click takes the sort off. A right-click on a sorting button opens
  "Sort by <column>" (changes the direction) and "Clear sort". The Sort
  chip shows in the list only while a sort is on. A click or right-click
  on a column's name opens its menu: sort by it (when it sorts), move it
  to the start or end, Edit custom field (owners and admins), Hide
  column. + at the end of the head lists the hidden columns; a click adds
  one back. The filter "Assignee is Me" keeps the jobs assigned to the
  person looking.
  The Stage column shows each status as its coloured label. A
  tick column is at the left; a group head ticks every job in its group,
  and a click on the head folds the group or opens it (folds stay in the
  browser). Ticked rows get the bulk bar at the foot, as on Invoices (Move,
  Custom field, Mark ready to invoice, Draft invoices, Copy case numbers, Export
  CSV; More adds each custom field and Selection). Custom field sets one:
  the custom field, then its value, in Flow only. Move says "Not yet available": a
  work system's stages cannot be moved from Flow in bulk yet. Every item
  in the bar is a working tool or says plainly that it is not available.
- **People** (owners): a title with one primary action, Invite (a dialog:
  email, and role with its one-line hint). One row per person: initials, the
  name (the email under it only when there is a name), the role as a select
  (its hint as a tooltip), a status pill only when access is not plain
  Active (Invited, Waiting for approval, Turned off), and a ⋯ menu (Email
  invite again, Turn off or Turn on, Remove behind a confirm dialog).
  Approve stays a visible button. No column headings and no role key under
  the table. Results show as toasts. Without a verified owner sign-in the
  page says so and the list stays closed.
- **Account**: Clerk's profile. Its own card heading is the only visible
  title.
- **Appearance**: mode, design system cards (each drawn in its own family)
  and accent swatches.
- **Messages**: one-card pages (sign-in not set up, an error, no access yet,
  the end of connecting Xero) use `messagePage` in `server/ui/page.js`.

## Shared components

Every page builds from these. Reuse one, or give it a new option; do not
copy its code into a page (`AGENTS.md`, "UI: reuse first"). A new shared
component gets a row here in the pull request that adds it.

| Component | Where | Use it for |
| --- | --- | --- |
| `ui()`: `h`, `flow`, `go`, `me` | `server/ui/app.js` | What every view module takes: build elements, call the API, open a page, the signed-in person |
| `pageHeader(title, { actions })` | `server/ui/app.js` (`ui().pageHeader`) | The page title and its actions |
| `notice`, `toast`, `dialog` | `server/ui/app.js` (`ui()`) | A note on the page, a short result, a confirm dialog |
| `holdButton(button, ms)` | `server/ui/app.js` (`ui()`) | A button that waits between presses (Xero, Seazona) and shows the time left |
| `settingRow({ label, hint, control })`, `.fx-setting` | `server/ui/app.js` | One setting row: short name, one hint line, the control at the right. Not in `ui()` yet: add it there before another module needs it |
| `rowMenu(label, items)` | `server/ui/app.js` | The ⋯ menu on a row |
| `viewBar(h)`: `menu`, `option`, `filterMenu` and the rows-panel parts | `server/ui/view-bar.js` | Group, Sort, Filter and Columns chips and their panels, on every list (Jobs, Reconcile) |
| `findBox(h, { label, oninput })` | `server/ui/view-bar.js` | A list's own search: an icon that opens into a box |
| `ICONS`, `svg`, `today` | `server/ui/view-bar.js` | The toolbar icons, an SVG string as a node, the local day |
| `filterJobs`, `sortJobs`, `groupJobs`, `OPERATORS` | `server/ui/job-view.js` | The rules behind Filter, Sort and Group (no DOM) |
| `bulkBar(ui, { label })` | `server/ui/bulk-bar.js` | The bar at the foot while rows are ticked: icon and one word per action, More |
| `.fx-pager` | `server/ui/flow.css` | "← Back", "n of N", previous and next over one record. Built three times today (Invoices, Reconcile, Price list › Reconcile); issue #220 makes one helper. Do not add a fourth copy |
| `.fx-tabs`, `.fx-tabs__count` | `server/ui/flow.css` | Tabs with counts (Invoices, Price list) |
| `alertStrip(ui, page)` | `server/ui/alerts.js` | The slim alert line on a page (`docs/ALERTS.md`) |
| `lucide(h, name, label)` | `server/ui/custom-fields.js` | A Lucide icon in the text colour; with `label` it is named |
| `colorPicker`, `optionPill` | `server/ui/custom-fields.js` | A colour choice; a dropdown option as a coloured pill |
| `jobChangeBanner(ui, change)` | `server/ui/job-change.js` | "The job changed" on a draft, with Accept change |
| `formatCents`, `xeroTag`, `linkIcon`, `accountingIcon` | `server/ui/invoicing.js` | Money, an accounting status tag, a link to the other system |
| `automationSection`, `rulesSection`, `sendModeSection`, `lineMappingSection` | `server/ui/automations.js`, `invoice-rules.js`, `invoicing-settings.js`, `line-mappings.js` | Settings sections a page mounts |

## Adding a family

Add it to `FAMILIES` in `server/theme/themes.js` with every token in both
modes (copy Harbour), list its faces in `server/theme/font-families.js`, add
any new fontsource package to `package.json`, and run `npm test`. To take a
newer OpenClaw, check it out and run
`node scripts/port-openclaw-themes.mjs <checkout> <commit>`.
