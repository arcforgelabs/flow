# Design system

Flow's screens use one theme engine: the one Arc Forge Labs'
[Field](https://github.com/arcforgelabs/field/blob/main/DESIGN.md) uses, so a
design system looks the same in both apps.

## Appearance

Appearance is three choices, per browser, on the Appearance page
(`/appearance`):

- **Mode**: Light, Dark or Auto (follow the device, the default). The top bar
  and the sign-in screen have a quick light or dark switch.
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
server). A person's own choice on the Appearance page wins in their browser.

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
- **Top bar**: the Flow mark, the views the person may open (People for
  owners, Account, Appearance), the light or dark switch and Clerk's account
  button.
- **People** (owners): page header with one primary action, Invite someone
  (a dialog: email and role). A table of people with initials, the role as a
  select, access as a status pill (Active, Invited, Waiting for approval,
  Turned off) and the row's actions (Approve, Turn off or Turn on, Remove
  behind a confirm dialog). Results show as toasts. Without a verified owner
  sign-in the page says so and the list stays closed.
- **Account**: Clerk's profile, with the person's Flow role above it.
- **Appearance**: mode, design system cards (each drawn in its own family)
  and accent swatches.
- **Messages**: one-card pages (sign-in not set up, an error, no access yet,
  the end of connecting Xero) use `messagePage` in `server/ui/page.js`.

## Adding a family

Add it to `FAMILIES` in `server/theme/themes.js` with every token in both
modes (copy Harbour), list its faces in `server/theme/font-families.js`, add
any new fontsource package to `package.json`, and run `npm test`. To take a
newer OpenClaw, check it out and run
`node scripts/port-openclaw-themes.mjs <checkout> <commit>`.
