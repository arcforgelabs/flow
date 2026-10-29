# First slice review

The defect is that an API-backfilled history order can remain stale indefinitely when a person opens it. The invariant is that inspection can update its saved facts while its history hold and issued invoice stay intact. The smallest complete fix connects a held job's open to the existing order reader with durable coalescing and priority admission, then displays its confirmed result through SyncStatus.

## Simplification

Reviewed the complete diff against c225ef8. Reused readWorkItem/readOrder, the PostgreSQL governor/call guard, the history-to-ledger mapper, observeJob and SyncStatus. No new service, general scheduler, second reader or billing action pipeline was introduced. History inspection deliberately avoids adding history-only orders to the live billing feed. The new queue table owns waiting admissions; the history row owns the check time, content time and expiring inspection claim. Both are necessary for the requested cross-worker behavior.

Extracted the existing history item and board ledger item mapping for their actual production callers. Both details use one status/request lifecycle. The existing local client Promise tail remains only for ungoverned replay; governed calls reach the shared admission queue.

## Test audit

- Route owner: stale/open/fresh/unchanged behavior and pipeline hold preserve the exact failure absent on the base. No other existing suite exercised this open route.
- Two worker instances and independent connection pools protect coalescing and the person cap. The replay transport supplies source responses, not claims, admission order or persistence.
- Failed, empty and stopped responses protect the saved copy and truthful timestamp. A real 404 protects the deleted-but-held outcome.
- History/live overlap protects identity, the existing history hold and the issued invoice snapshot.
- Browser proof protects real UI wiring, the History › Jobs entry, both viewports, and opening the linked invoice without mutating its issued lines.
- Governor owner: a background worker wakes first, but cannot take the person's slot. Expired admission rows protect crash recovery. The base sends the sweep first and fails this check.
- Updated the existing pre-schema-move fixture to exclude the new migration/table from its historical installation. Existing migration guards, repeat migration and schema move tests remain intact.

There are no test-only production exports or configuration flags. No test was weakened or removed. The browser proof is source-aware, not an independent source-blind review.

## Boundaries

No remote branch, pull request, issue comment or public description was changed. No merge, deployment, backfill, secret or permission change occurred. All data is synthetic. This first slice targets held history with a source order identifier, chiefly the API backfill; CSV identity reconciliation remains the existing import workflow.

Later #386 work remains separate: invoice-change trigger, history list signatures and fallback within 10 calls/run and 100/day, cold/fresh/hot lifecycle, pinning/persisted activity and full-year backfill.
