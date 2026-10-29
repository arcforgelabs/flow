# History freshness: first-slice handover

Development is on hold at Samuel’s request. Related: #386. No pull request, merge, deployment or backfill was started by this handover.

The public implementation is branch `feat/386-history-read-on-open`, commit `5109bccafce7f130010f171a2e09d5e58abceda6`.
It has the identical source tree as tested local commit `b3a0122c52fb4bf9cb524cc7ca0d8687e7bd8727`, based on `c225ef88c87728373c8159a0856ddc7380d41893`.
GitHub rejected the original push with GH007 because of its private author email. The local original and its branch remain intact. The public copy uses the same account’s no-reply address already present in this repository’s public history. No privacy setting was changed and no force push was used.

This handover branch contains the implementation plus review evidence. Review or resume the **implementation branch**, not this evidence branch. Do not merge the evidence branch as the feature.

## Completed slice

History › Jobs shows saved history immediately. A held job, or its linked invoice, checks the order when its last successful check is over two hours old. Concurrent opens share a persisted claim. Person reads get the next admission before queued sweep work, through the existing governor/call guard, with five inspection calls per person per rolling minute across workers. A failed/blocked read keeps the saved copy and previous successful time. Changed or deleted history stays held. Issued invoices remain unchanged.

Recent, active and invoice lane schedules are unchanged. Later slices remain deferred: invoice-change trigger, history signatures and fallback within 10 calls/run and 100/day, cold/fresh/hot lifecycle, pinning/persisted activity and full-year backfill.

## Proof and limits

- `npm test`: 944 passed, none failed or skipped; 174.857 seconds. Local Node 24.19, PostgreSQL 17, synthetic data and source responses only.
- Affected phone suite: 150 passed across WebKit and Chromium, five sizes and three themes; 2.6 minutes. Only Jobs board/list/panel, invoice and Seazona integration screens were selected. WebKit used a local test container with its normal dependencies.
- The copied base tests fail as intended: the open endpoint is absent, and a queued sweep takes the person’s slot. The implementation passes those tests.
- Gitleaks over the implementation patch and commit found no leaks. Migration guards, simplification and test audit passed. The new test suite is source-aware integration/browser proof, not an independent source-blind review.
- Screenshots below are the real Flow interface with synthetic records, at 1280×800 and 375×667. Logs and timings are in this directory.
- Not run: remote pull-request checks, every unchanged phone screen, packaging/release checks or any live Seazona/Xero call. Code has not been merged, deployed or used for a live backfill.

[Desktop checking](open-1280-checking.png) · [Desktop updated](open-1280-updated.png) · [Phone checking](open-375-checking.png) · [Phone updated](open-375-updated.png)

## Resume after Samuel gives the go

Use Node 24, a disposable local PostgreSQL database and Playwright Chromium/WebKit. Set `FLOW_TEST_DATABASE_URL` only to that test database: these tests drop and recreate its schemas. Never use a live installation.

```sh
git fetch origin feat/386-history-read-on-open
git worktree add --detach ../flow-386-review 5109bccafce7f130010f171a2e09d5e58abceda6
cd ../flow-386-review
npm ci
npx playwright install --with-deps chromium webkit
# Set FLOW_TEST_DATABASE_URL to the disposable local database first.
node --test --test-concurrency=1 test/history-open.test.js test/seazona-governor.test.js
npm test
npm run test:mobile -- --grep 'jobs-board|jobs-list|job-panel|integration-seazona|invoice$' --workers=2
```

Read `AGENTS.md`, `VISION.md`, `CONTRIBUTING.md`, `docs/SEAZONA.md` and issue #386 first. Use a new worktree; preserve the existing branches. The migration is additive and repeat-safe (`0008_history_read_on_open.sql`). The original source worktree and full review archive remain local at `/workspace/flow-386` and `/workspace/flow-386-evidence`; do not rely on that worker surviving. The selected evidence here is durable on GitHub.

## Small finish-line decisions

Samuel can authorize a pull request for the bounded first slice, run the required remote checks and review the new migration/priority admission. Merge and release/deployment remain separate approvals. Keep Related: #386, not Closes: #386. Do not resume the deferred design work or start the full-year backfill as part of the handover.

Source chat: https://chatgpt.com/c/01a1751a-899a-74f0-b038-ce51a940e030 . This link uses the source thread id supplied in the delegation; access was not verified in this worker. The final issue comment records the immutable evidence link.

Text logs retain their results; trailing whitespace was normalized for the repository check.

Prepared by Codex. This is a preservation/handover commit, not further feature development.
