---
name: explainer
description: "Explain with a visual page in the Arc Forge look: diagrams first, every part opens a definition."
---

# Explainer

An explainer is a page that explains a system, a plan or a comparison with visuals first. Samuel reads explainers instead of long text. Use this skill when someone asks to explain something, for more detail, how something works, to compare, to map or to plan, and before you draw any diagram or chart.

Samuel's own words win over this skill. The repo's `DESIGN.md` wins for brand values.

## Files

All paths are relative to this skill folder.

| Path | What it is |
| --- | --- |
| `references/pattern.md` | The page rules. Read it first, every time. |
| `references/charts.md` | Every rated chart kind, its tier and its note. Pick a chart from it. |
| `kit/tokens.css` | Colours, fonts, radii, light and dark, and the diagram colour key. |
| `kit/explainer.css` | The `.ex-` styles. Tokens only. |
| `kit/charts.js` | Data-driven SVG renderers: `connection`, `container`, `capacity`, `heatmap`, `sankey`. |
| `kit/explainer.js` | The runtime: pop-ups, Facts lists, tick rail. |
| `examples/starter.html` | Copy this to start a page. |
| `examples/explainer-kit.html` | A full page that uses every renderer. |
| `scripts/bundle` | Inlines the kit into one self-contained HTML file. |
| `scripts/check` | Headless check: page errors, every part opens, Facts lists work, no sideways scroll. |

## Make a page

1. Read `references/pattern.md`. Pick the chart kinds from `references/charts.md`: great or good only. The default is a connection diagram.
2. Copy `examples/starter.html` next to the other examples (or copy `kit/` next to your page and fix the four paths).
3. Write one `.ex-section` per subject. Each opens with an ExplainerHead whose first sentence defines the subject.
4. Put every part in `window.EX` as `{"t": title, "l": layer, "d": definition, "x": [facts]}`. The definition says what the part IS. Facts never repeat it.
5. Draw each chart with `ExCharts.<kind>(element, data)`. Load `kit/charts.js` and call the renderers before `kit/explainer.js`.
6. End a section with `<details class="ex-facts" data-def="…">` when a reader will want to scan the facts.
7. Run `scripts/check <page.html>`. Fix every failure. Set `CHROMIUM_PATH` to use a browser that is already installed.
8. Look at the screenshots (`--shots <dir>`) in light and dark, at 390px and 1280px. Read the page as Samuel would: no open text longer than one sentence, every fact has a part, red on one or two things only.

## Deliver the page

The source page is the same everywhere. Only the delivery changes.

| Harness | Delivery |
| --- | --- |
| Claude (claude.ai, Claude Code with the Artifact tool) | `scripts/bundle page.html out.html`, then publish `out.html` with the Artifact tool. Reply with one line and the link. |
| Any agent on a workstation (Codex, Grok, Claude Code) | Serve the skill folder: `python3 -m http.server 8765`, then open `http://localhost:8765/examples/<page>.html`. Or send the bundled file. |
| A product docs site | Copy `kit/` into the site's assets and link the files. Keep one copy of the kit per site. |

## Words

- Visuals first. Add words only where they help.
- One fact per sentence. ASD-STE100 simple English. Australian spelling.
- No preamble, no "This diagram shows…", no slogans.
- No project chatter, internal ids or customer data on a page. Each page stands alone.

## Inline widgets

A small idea (one idea, five to nine parts) can be an inline widget instead of a page, where the harness has one. Use neutral boxes, one red element, a transparent ground and the frame's own theme classes. A widget cannot open pop-ups, so make a page when the parts need definitions.

## Keep in step

- `references/pattern.md` copies `project/explainers.md` from the Arc Forge Design System artifact (https://claude.ai/artifact/8pZbZfefPhvV5kAHUSquEJ). `kit/explainer.css` and `kit/explainer.js` copy its `project/explainer/` files. When Samuel teaches a new rule, change both places.
- `references/charts.md` copies the Chart Lab ratings. When a rating changes, change the table.
- The diagram colour key belongs to `arcforgelabs/themes` (`docs/diagram-colour-key.md`). Copy its values; do not change them here.
- A new renderer in `kit/charts.js` must pass `scripts/check` in `examples/explainer-kit.html`. Add a section for it there.
