# Flow

Flow is invoicing, bill entry and a financial dashboard for labs that make
work to order, first for dental labs. Seazona (the lab's case system) is a
bundled integration, and Xero is an optional one. See `VISION.md`.

Flow is maintained by Arc Forge Labs at
[arcforgelabs/flow](https://github.com/arcforgelabs/flow).

Licence: MIT (`LICENSE`).

## Status

This repository is the new home of Flow, with a new history. Code moves here
from an earlier private codebase one module at a time (`CONTRIBUTING.md`,
"Porting from the earlier codebase"). Today it holds the repository's rules,
CI, the integration port, a health check and the first part of the core: the
PostgreSQL data model for organisations, contacts, the price list and
invoices. It is not ready to run a lab.

## Documentation

| Document | What it is for |
| --- | --- |
| `VISION.md` | What Flow is for, the core and its integrations, and what it will not do |
| `AGENTS.md` | Agent entry point (`CLAUDE.md` links to it) |
| `CONTRIBUTING.md` | How to file issues and pull requests, porting rules, merging |
| `SECURITY.md` | How to report a security problem, the trust model, and the rules held hard |
| `LICENSE` | MIT licence |
| `docs/DATA_MODEL.md` | The PostgreSQL records, the rules the database holds, and how to change the schema |
| `docs/SELF_HOSTING.md` | Running a pinned Flow release, and the `deploy/replit/` template |
| `server/integrations/port.js` | The integration port every adapter implements |

## Getting started

Requirements: Node 24, npm and PostgreSQL 16 or later.

```bash
npm ci
FLOW_TEST_DATABASE_URL=postgres://… npm test   # a throwaway database
DATABASE_URL=postgres://… npm start             # http://localhost:19300/health
```
