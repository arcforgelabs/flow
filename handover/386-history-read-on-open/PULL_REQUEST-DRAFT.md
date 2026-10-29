feat: refresh held Seazona history when a person opens a job

Related: #386

## What Problem This Solves

Old Seazona orders imported into history can stay stale indefinitely. A person opening one needs to see the saved copy immediately and check that order without waiting for the rest of the history design.

## User Impact

History › Jobs opens the past jobs. Opening a held history job or its linked invoice checks Seazona when its last successful check is over two hours old. Flow shows Checking, then Updated with the successful check's completion time. Failed or blocked reads keep the saved copy and explain the problem. Changed or deleted history stays held, and issued invoices keep the lines the customer was sent.

## Why This Change Was Made

This first slice reuses readWorkItem/readOrder and the shared SyncStatus. Inspection updates history directly, through the existing reader, rather than creating live billing-feed records or invoking the money-action pipeline. A short PostgreSQL claim coalesces opens across workers without holding a connection during the network request. The governor now orders waiting admissions by priority and arrival, so a person takes the next free slot before queued sweep work. All admissions and retries still share the existing spacing, cooldown and call guard. A person can make five inspection calls per rolling minute across workers.

Last successful check and last content change are stored separately. Existing history starts unverified; new API imports record a check, while a file upload does not establish API freshness. A failed attempt waits one minute before another open retries. A dead inspection claim expires after fifteen minutes by default, or longer when configured waits/retries require it. A successful inspection is reapplied from its saved snapshot if a worker stopped between storing it and updating the ledger.

The recent, active and invoice lane schedules are unchanged. Later #386 slices remain separate: invoice-change trigger, history list signatures/fallback within 10 calls per run and 100 per day, cold/fresh/hot lifecycle, pinning/persisted activity and full-year backfill. This change starts no backfill.

## Evidence

Public implementation commit: `5109bccafce7f130010f171a2e09d5e58abceda6`.
Tested locally as `b3a0122c52fb4bf9cb524cc7ca0d8687e7bd8727`; the public copy has the identical source tree and changes only commit identity/date metadata to use the account’s existing GitHub no-reply address.
Base: `c225ef88c87728373c8159a0856ddc7380d41893`.

- `FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55486/flow386 PLAYWRIGHT_BROWSERS_PATH=/workspace/playwright-browsers npm test`: **944 passed, zero failed/skipped**, 174.857 seconds. Local Node 24.19 and PostgreSQL 17; all records and integration responses synthetic. Log: `npm-test-green.log`.
- Base reproduction on `c225ef8`, with the new tests copied into a detached checkout: `node --test --test-name-pattern='stale open|a person takes' --test-concurrency=1 test/history-open.test.js test/seazona-governor.test.js`: both fail for the intended reasons. The open endpoint answers 404; the queued sweep takes the person's slot. Log: `base-red.log`. Both pass with this commit.
- `node --test test/history-open.test.js`: **6 passed**, 5.526 seconds wall time. Real authenticated routes, two independent worker instances/connection pools, actual PostgreSQL migrations/persistence and actual adapter mapping. Covers stale/fresh/repeated/concurrent opens, changed and unchanged lines, signed-out/wrong-organisation requests, cross-worker person cap, failed/empty/stopped reads, explicit 404, history/live identity overlap, held pipeline behavior, immutable issued invoice and real browser wiring. The file includes database setup and a real browser at both viewports, rather than repeating its contract with fast mocks.
- `node --test test/seazona-governor.test.js`: **13 passed**, 1.901 seconds wall time. The background worker wakes first but still cannot take the person's next slot. Expired admission rows cannot block another worker. Existing shared-limit, retry, cooldown and guard tests pass.
- `node --test test/flow-schema.test.js`: the historical-installation fixture excludes the new table/migration from the old installation; schema move, fresh install and repeat migration checks pass. Wall time: 3.476 seconds (`flow-schema.time`).
- Affected phone suite: `node node_modules/@playwright/test/cli.js test -c test/mobile/playwright.config.js --grep 'jobs-board|jobs-list|job-panel|integration-seazona|invoice$' --workers=2`: **150 passed** in 2.6 minutes, across WebKit and Chromium, all five sizes and three themes. It used a separate disposable PostgreSQL database. WebKit ran in a local test container with its normal system dependencies; no host-validation bypass. Report: `mobile-report/index.html`, log: `mobile-green.log`.
- Real Flow screenshots, synthetic data: `open-1280-checking.png`, `open-1280-updated.png` (1280×800); `open-375-checking.png`, `open-375-updated.png` (375×667). The browser also opens the linked issued invoice, checks its job and verifies that its issued lines stay unchanged.
- `node scripts/db-guard-migrations.js --check`, `git diff --cached --check`, and Gitleaks 8.30.1 over the complete patch and new commit: pass; **no leaks**. Commit scan: `commit-secret-scan.log`.
- Simplification and test audit: reused existing owners, extracted one shared history mapper and one detail status lifecycle; no new general scheduler, service, second reader or test-only production seam. Delta against base: production +291/-81; tests +285/-2; docs +50/-2; generated migration metadata +1622. Detailed audit: `review-notes.md`.

Not run: remote pull-request checks, the full inventory of unchanged phone screens, packaging/release validation, live Seazona/Xero calls, deployments or a live backfill. This is source-aware integration/browser proof, not an independent source-blind validator verdict. The implementation and handover evidence branches are preserved on GitHub under the later handover instruction. Pull-request creation, remote checks and merge remain separate finish-line decisions. No merge, deployment or backfill occurred.
