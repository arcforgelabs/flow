# Flow Design System

The [Flow Design System](https://claude.ai/artifact/WgrY4jEMYrBxGauqcXswxr) is
a claude.ai Design System artifact: Flow's tokens, faces, rules and one live
card per shared component. Agents read it before they build a screen, and a
person reviews a component there by commenting on its card. The repository is
the source: the artifact's files are generated from it, never edited by hand.

```text
server/theme/themes.js ─┐
server/ui/flow.css ─────┤
server/ui/kit.js, ──────┼─► npm run design-system ─► .artifacts/design-system/project/
  view-bar.js, …        │     (scripts/design-system/build.mjs)        │
design-system/ ─────────┘                                              ▼
  README.md, components/<Card>/                         Flow Design System artifact
                                                         (published after a merge)
```

## What is generated

| File in the artifact | From |
| --- | --- |
| `tokens.json` | Every `--t-*` colour of Harbour and Meridian, light and dark (four themes), radii, the shadow, type styles, the font files |
| `fonts/*.woff2` | The fontsource packages Flow serves (latin, variable weight) |
| `components/bundle.js` | The real shared modules (`server/ui/kit.js`, `view-bar.js`, `bulk-bar.js`, `tip.js`, `custom-fields.js`, `job-change.js`) bundled by esbuild as `window.FlowDesignSystem` (`scripts/design-system/entry.js`) |
| `components/bundle.css` | `server/ui/flow.css`, every family's `--t-*` tokens as `[data-theme="<family>-<mode>"]`, and the Lucide icons the app names, inlined |
| `components/<Card>/` | `design-system/components/<Card>/`: `preview.html` (line 1 the `@dsCard` marker) and `README.md` (first sentence the summary, a `Code:` line naming the code) |
| `components/Themes/` | Generated: every family, light and dark |
| `README.md`, `assets/` | `design-system/README.md`, `design-system/assets/` |

`project/design-system.json` (the index) is not generated: it is written at
publish, and keeps what a person changed on the page. The logo is an upload
in the artifact's asset store (Logos group).

## The rule for a pull request

A pull request that adds or changes a shared component changes its card in
`design-system/components/` too. `test/design-system.test.js` fails when an
export of a shared module (`kit.js`, `view-bar.js`, `bulk-bar.js`, `tip.js`,
`job-change.js`) has no card naming it, when a card has no README or marker,
or when the build writes something the artifact cannot read.

A card calls `window.FlowDesignSystem.<name>`, so it shows what the app draws.
A card for CSS only (Button, Pager, Tabs) uses the real classes; it says
"static card" in its README.

## Publishing

CI cannot write to claude.ai, so an agent publishes after a merge that
changed `design-system/`, `server/ui/flow.css`, `server/theme/` or a shared
module:

1. `npm run design-system`.
2. Read the artifact's `project/design-system.json`.
3. Publish `.artifacts/design-system/project/` to the artifact URL above with
   the Artifact tool (`root` = `.artifacts/design-system`, every changed
   file), and the index last, with `lastChange`
   `{ by, at, via: "GitHub · arcforgelabs/flow@<sha>", note }`.

A file a person changed on the page is kept unless the repository changed it
too; tell them which.

## Review

A comment on a card, sent to Claude, wakes the session that watches the
artifact. That session fixes the component in the repository (and its card),
opens a pull request, and republishes after the merge.

## Locally

`npm run design-system [out-dir]` writes the files (default
`.artifacts/design-system`, ignored by git). Each card is a small HTML file:
open it with `components/bundle.css` and `components/bundle.js` loaded to see
it as the artifact does.
