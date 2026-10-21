# Flow

Flow is job management, invoicing, bill approval and a financial dashboard for labs that make
work to order, first for dental labs. Seazona (the lab's case system) is a
bundled integration, and Xero is an optional one. See `VISION.md`.

Flow is maintained by Arc Forge Labs at
[arcforgelabs/flow](https://github.com/arcforgelabs/flow).

Licence: MIT (`LICENSE`).

## Status

This repository is the new home of Flow, with a new history. Code moves here
from an earlier private codebase one module at a time (`CONTRIBUTING.md`,
"Porting from the earlier codebase"). Today it holds the repository's rules,
CI, the release track (npm, container image and GitHub Release, on a beta and
a stable channel), the integration port, a health check, Clerk sign-in with
roles kept in Flow, a People page for owners, the design systems Arc Forge
Labs' Field uses, and the first part of the core: the PostgreSQL data model
for organisations, contacts, the price list and invoices. It is not ready to
run a lab.

## Documentation

| Document | What it is for |
| --- | --- |
| `VISION.md` | What Flow is for, the core and its integrations, and what it will not do |
| `AGENTS.md` | Agent entry point (`CLAUDE.md` links to it) |
| `CONTRIBUTING.md` | How to file issues and pull requests, porting rules, the changelog, merging |
| `CHANGELOG.md` | What changed in each release: an index of one file per release in `CHANGELOG/` |
| `SECURITY.md` | How to report a security problem, the trust model, and the rules held hard |
| `LICENSE` | MIT licence |
| `docs/docs.json` | The docs site navigation. `docs/` is published at https://arcforgelabs.github.io/docs/flow/ by arcforgelabs/docs |
| `docs/index.md` | The docs site home page |
| `docs/releases/` | One release notes page per version (`<version>.md`), shown on the docs site |
| `docs/DESIGN.md` | The design systems (theme families), how pages and Clerk's components take them, and the screens |
| `docs/DESIGN_SYSTEM.md` | The Flow Design System artifact: how `npm run design-system` builds it from the code, the card per shared component, publishing and review |
| `docs/DATA_MODEL.md` | The PostgreSQL records, the rules the database holds, and how to change the schema |
| `docs/DATA_SPINE.md` | The design of the tables and jobs every integration shares: mirror, identity map, job queue, outbox, review queue |
| `docs/JOB_INVOICE_LINKS.md` | The pipeline: how each job links to its customer and to the accounting invoice that bills it |
| `docs/INVOICING_RULES.md` | The invoicing rules that draft a job's invoice, and the two ways an invoice goes to Xero |
| `docs/INVOICE_RULES.md` | Invoice rules a lab builds (When, If, Then) that make a ready job wait or never draft |
| `docs/INVOICE_SENDING.md` | The invoice tabs (Pending, Ready, Draft, Approved, Sent, Void), a changed job, and Send all ready to the accounting system |
| `docs/RECONCILE.md` | The daily reconcile: counts and totals per day across the work system's copy, the ledger and the accounting copy |
| `docs/ALERTS.md` | Quiet alerts: the slim line on a page when something there needs a person, and how a person dismisses it |
| `docs/AUTOMATIONS.md` | Automations: Flow routines that mark jobs ready to invoice and draft them, each on or off |
| `docs/LINE_MAPPING.md` | Line mapping: how each work system line finds its price item, and Price codes in Settings |
| `docs/CUSTOM_FIELDS.md` | Custom fields: the lab's own fields for its jobs, kept in Flow only, and how a board move checks for conflicts |
| `docs/JOB_BOARD_MOVES.md` | Moving jobs on the Jobs board: custom field moves stay in Flow; Seazona stage moves become a hand-off |
| `docs/PRICE_LIST.md` | The price list: Flow's own codes and prices, their links to Xero items and Seazona products, and the price check |
| `docs/AI_BOTS.md` | The AI bots: ClawSweeper reviews and the Docs Agent, their ClawRouter budget and cost, and setup |
| `docs/LOW_RISK_MERGE.md` | The low-risk merge lane: which pull requests merge themselves when green, with ClawSweeper's risk labels |
| `docs/RELEASING.md` | Versions and channels, the release workflows, how to cut and roll back a release, and the one-time setup |
| `docs/SELF_HOSTING.md` | Running a Flow release with Docker, Node or Replit, the update notice, and Clerk sign-in |
| `docs/REPLIT.md` | A Replit workspace of this repository that follows a release channel (`FLOW_DEPLOY_REF`) |
| `docs/INTEGRATIONS.md` | How an integration adapter is built, turned on and off, and owns its tables |
| `docs/XERO.md` | The Xero adapter: modes, settings, rate limits, connecting Xero and draft invoices |
| `docs/XERO_IMPORT.md` | Xero › Import: each Xero invoice in Flow's copy linked to its Flow invoice, or made into one |
| `docs/SEAZONA.md` | The Seazona adapter: modes, settings, the rate governor, replay files and its tables |
| `docs/SENTRY.md` | The Sentry adapter: errors and problem reports to the installation's own Sentry project |
| `server/integrations/port.js` | The integration port every adapter implements |

## Getting started

Requirements: Node 24, npm and PostgreSQL 16 or later.

```bash
npm ci
FLOW_TEST_DATABASE_URL=postgres://… npm test   # a throwaway database
DATABASE_URL=postgres://… npm start             # http://localhost:19300/health
```
