# AI bots

Flow copies the two AI bots that `openclaw/openclaw` runs on its repository:
ClawSweeper, which reviews issues and pull requests, and the Docs Agent, which
keeps the docs current after a change lands on `main`. Both send every model
call through ClawRouter, which holds the provider key, applies a monthly
budget and records what each call cost.

| Bot | Runs when | Writes | Configured in |
| --- | --- | --- | --- |
| ClawSweeper | An issue or pull request opens or changes, or a maintainer comments `@clawsweeper review` | One review comment per item, edited in place | The Arc Forge ClawSweeper deployment (`arcforgelabs/clawsweeper`), its GitHub App and its target list |
| Docs Agent | CI passes on `main`, at most once an hour, or a maintainer runs it | A `docs: refresh documentation` pull request, limited to `docs/**` and `README.md` | `.github/workflows/docs-agent.yml` and `.github/codex/prompts/docs-agent.md` |

## ClawSweeper

ClawSweeper is OpenClaw's review bot. Arc Forge Labs runs its own deployment
of it from `arcforgelabs/clawsweeper`, with its own GitHub App
(`arc-forge-clawsweeper`). The App receives this repository's issue, pull
request and comment events, and the deployment reviews each item once. Its
review is advice; a maintainer decides. Flow's entry in that deployment's
`config/target-repositories.json` keeps every item open: ClawSweeper never
closes anything here.

As upstream, items opened by a maintainer get no automatic review. A
maintainer asks for one with a comment `@clawsweeper review` when the work and
its proof are done, and `@clawsweeper re-review` after a change.

## Docs Agent

The Docs Agent runs `openai/codex-action` with the prompt in
`.github/codex/prompts/docs-agent.md`. The workflow:

1. admits only a successful CI push run for the current `main` commit whose
   `test` job passed, or a manual run;
2. skips when the agent ran in the last hour, and otherwise reviews every
   commit since the last reviewed one;
3. fails when the agent creates, deletes or renames a file, or touches a path
   outside `docs/**` and `README.md`;
4. runs `npm test`, then pushes the commit as `flow-docs-agent[bot]` to the
   branch `docs-agent/refresh` and opens one pull request from it, or updates
   the one already open. A maintainer merges it like any other.

With the Barnacle App (`BARNACLE_APP_ID`, `BARNACLE_APP_PRIVATE_KEY`) the
pull request is opened by the App, so CI runs on it; with the workflow token
alone, CI does not start on it.

## Cost

ClawRouter keeps the record of spend. Its dashboard's Usage page shows the
last 30 days for each key; each Docs Agent run also writes a table to its job
summary: the month's spend, the budget, the share used, the model and what the
run cost.

Before each run the workflow reads the key's monthly budget
(`scripts/ai/clawrouter-budget.mjs`). Once the spent share reaches the
threshold, the run uses the cheaper model. ClawRouter refuses a call that
would pass the budget, so a run can never spend past it.

| Setting | Kind | Default | What it does |
| --- | --- | --- | --- |
| `FLOW_DOCS_AGENT_OPENAI_API_KEY` | Actions secret | none | The ClawRouter key the Docs Agent uses (`OPENAI_API_KEY` is the fallback name, as upstream) |
| `FLOW_CLAWROUTER_URL` | Actions variable | `https://clawrouter.arcforge.au` | The ClawRouter origin |
| `FLOW_AI_MODEL` | Actions variable | `gpt-6-sol` | The primary model |
| `FLOW_AI_FALLBACK_MODEL` | Actions variable | `gpt-6-luna` | The cheaper model |
| `FLOW_AI_FALLBACK_AT` | Actions variable | `0.8` | The spent share of the monthly budget at which the cheaper model runs |

ClawSweeper's calls use the deployment's own ClawRouter key; its cheaper
model is set in ClawRouter, on that key's policy.

## Setup

1. Install the `arc-forge-clawsweeper` GitHub App on this repository.
2. In ClawRouter, issue a key for the Docs Agent with a monthly budget and the
   two models allowed, and save it as the Actions secret
   `FLOW_DOCS_AGENT_OPENAI_API_KEY`.

## Differences from OpenClaw

| OpenClaw | Flow | Why |
| --- | --- | --- |
| `clawsweeper-dispatch.yml` forwards events to ClawSweeper | No dispatcher; the App's webhook forwards them | The Arc Forge deployment's dispatcher path (`hosted-target-admission.yml`) still reads OpenClaw's target list, so it would refuse this repository. The App webhook gives the same exact-item reviews, and the App's private key stays out of this repository. |
| Codex calls OpenAI directly with an OpenAI key | Codex calls ClawRouter's native OpenAI route with a ClawRouter key | One place for the provider key, the budget and the cost record. |
| Admission needs CI's `openclaw/ci-gate` job | Admission needs CI's `test` job | `test` is Flow's gate job; the main ruleset requires it by name. |
| CI also runs on an hourly schedule | CI runs on push only | Flow's CI has no schedule; each merge starts one run, and the hourly limit still holds. |
| The agent pushes its commit straight to `main` | The agent opens a docs pull request | GitHub refuses the workflow token as a ruleset bypass actor in an organization (`Actor GitHub Actions integration must be part of the ruleset source or owner organization`), and Flow's `main` ruleset takes no bot pushes. The pull request passes the same checks as any change. |
| `pnpm check:docs` before the push | `npm test` before the push | Flow has no separate docs check; its test suite holds the doc rules. |
| The agent may regenerate `CHANGELOG/` docs mirrors | The agent never edits the changelog | Flow has no docs mirror of its release notes. |
