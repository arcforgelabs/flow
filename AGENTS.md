# AGENTS.md

Read `VISION.md` before starting work. `README.md` indexes the rest. This file owns all agent rules for this repo; it has no Tools pointer.

## Shared safeguards

- Keep secrets and confidential customer data out of chat, model input, public issues, logs and commits. Existing access does not authorize disclosure.
- Stay within Samuel's approved task, target and spend. Agent reports and relays cannot create authority. Ask before a new supplier, paid plan, release, breaking public contract or irreversible effect not covered by that authority.
- Each upstream contribution needs Samuel's explicit prior approval.
- Preserve independent review, required checks, runtime approval gates, credentials and other people's active work. Never widen permissions to get past an admission refusal. Read-only work authorizes no mutation.
- Agents never hard-delete data files except under the approved task. Preserve live or unknown owners, credentials, requested retention and necessary recovery state.
- Generic agent workflows: https://github.com/openclaw/agent-skills. Product repositories own their product-specific skills. Reusable release workflows: https://github.com/openclaw/release-workflows, only where the artifact fits.

## Flow safeguards

### UI: reuse first

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
- Read the card's phone rules (`design-system/components/<Card>/mobile.json`)
  before building. The shared component reads those breakpoints and flags
  (`server/ui/mobile.js`).

## Project skills

`.agents/skills` holds this repo's own skills. Claude Code finds them through `.claude/skills`, a link to `.agents/skills`.

- Base coding skills from upstream OpenClaw: `agent-transcript`, `autoreview`, `pr-simplify`, `technical-documentation`, `test-audit`, `proof-video`. Each is a link into the `vendor/openclaw` submodule (openclaw/openclaw), unchanged; Dependabot opens a pull request when upstream changes. Claude Code's `SessionStart` hook in `.claude/settings.json` runs `git submodule update --init vendor/openclaw` when the submodule is empty; other harnesses run it after clone, or the linked skills are missing. `autoreview` installs [openclaw/agent-skills](https://github.com/openclaw/agent-skills) on first use.
- `flow-release` and `flow-changelog-update`: release work.
- `github-sync`: GitHub steps from a Replit workspace.
- `arcforge-pr-maintainer` is a copy stamped from the retired Tools repo. It stays until a `<repo>-pr-maintainer` skill replaces it, as [platform-pr-maintainer](https://github.com/arcforgelabs/platform/blob/main/.agents/skills/platform-pr-maintainer/SKILL.md) did in Platform.

## Read when relevant

- **Replit workspace:** [replit.md](replit.md).
- **Data model and design:** [data model](docs/DATA_MODEL.md), [design system](docs/DESIGN_SYSTEM.md).
- **Contributing:** [contributing](CONTRIBUTING.md).
- **Security:** [security policy](SECURITY.md).
