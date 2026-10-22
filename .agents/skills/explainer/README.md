# explainer

Status: `prototype`

Visual explainer pages in the Arc Forge look, for any agent harness. Diagrams
first; every part opens a pop-up with its definition. It holds the page rules,
the chart catalogue from Chart Lab, a runtime kit, data-driven chart renderers,
a starter page, a full example, a bundler and a headless check.

## Quick use

```sh
# Check the example (light and dark, 390px and 1280px)
CHROMIUM_PATH=/path/to/chromium scripts/check examples/explainer-kit.html --shots /tmp/shots

# One self-contained file (for a Claude artifact or an email)
scripts/bundle examples/explainer-kit.html /tmp/explainer-kit.html

# View it on localhost
python3 -m http.server 8765   # then open http://localhost:8765/examples/explainer-kit.html
```

`scripts/check` needs Playwright (`npm i -g playwright`). `scripts/bundle` needs Node only.

## Install

Installed by `forge-tools skills sync --defaults` (listed in `install-defaults.json`).
Claude sessions on claude.ai also have the account skill `explainer`; after a change
here merges, update that account skill from `SKILL.md`.
ChatGPT has no skill folder: build `explainer-chatgpt.zip` with
`harnesses/chatgpt/package-chatgpt-skill` and upload it under Customize → Skills
(see `harnesses/chatgpt/README.md`).

## Sources

- Arc Forge Design System artifact: `project/explainers.md`, `project/explainer/*`
  (https://claude.ai/artifact/8pZbZfefPhvV5kAHUSquEJ).
- Chart Lab ratings (https://claude.ai/artifact/RESTxZpBbDo9x2mjgWy2f8). `references/chart-lab.html` is its page source, without the rating form, its storage code and the Next round list.
- Diagram colour key: `arcforgelabs/themes`, `docs/diagram-colour-key.md`.
- Tokens: OpenClaw Control UI Knot theme (MIT), as resolved by the design system.
