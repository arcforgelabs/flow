# Shared sync row proof

Real Flow app, fresh local PostgreSQL, synthetic fixtures and synthetic Seazona status responses only. No customer data, integration credentials or remote Seazona calls.

- [1280 × 800](history-1280.png), Meridian light.
- [375 × 667](history-375.png), Meridian light, reduced motion.

Reproduce the connected History flow:

```sh
FLOW_TEST_DATABASE_URL=postgres://flow:flow@localhost:5432/flow_test \
PLAYWRIGHT_BROWSERS_PATH=/workspace/browsers \
SYNC_SCREENSHOTS=docs/evidence/422 node --test test/sync-status.test.js
```

Use a throwaway database: the test resets its schema. Browser and screenshot paths are optional environment-specific paths.

The browser proof opens Integrations → Seazona in the actual app, maps a synthetic active run to the row, reloads, hides and restores the document, switches to 375px, enables reduced motion and completes the run. It checks the cumulative total, server-based clock, retained keyboard focus across polling, no hidden or ended polling, no overflow, 44px Stop target and disabled animation. The same regression against the old app fails: it shows `12 read` instead of the persisted total `412 jobs`.

The server test in `test/seazona-history.test.js` verifies that stopped and completed `endedAt` values persist through a fresh read. Existing tests exercise Stop, Resume, deduplication and waiting → failed transitions.

The named `pr-simplify`, `test-audit`, `behavior-validator` and `arcforge-proof` skills are not installed in this environment or repository. Manual equivalents were performed: diff simplification (retain one button across polling, no duplicate status renderer), behavioral test review (regression fails on the old UI), real-app proof above, and old-path search (no `fx-history__status` or `fx-history__bar` remain). This is not a claim that the unavailable skills ran.

The owner-only design artifact could not be opened. Implementation follows the full issue and approved decision at https://github.com/arcforgelabs/flow/issues/422#issuecomment-6486733031 plus the repository design-system source. As that decision permits, the steps dropdown is deferred until a persisted server step log exists. There is no page-only event history. Existing completed runs without an `endedAt` show no invented duration.
