# History read on open

Target: local Flow, synthetic Clerk sessions and synthetic Seazona responses.

1. History › Jobs opens the saved history jobs. Opening a held job displays its saved lines immediately while the check runs.
2. A copy checked more than two hours ago causes one read. Fresh and concurrent opens share the saved success or the in-flight claim across workers.
3. Queued person reads take the next admission before queued sweep reads, through the same PostgreSQL governor and call guard. An admitted read continues.
4. A successful check displays Updated with its completion time. Unchanged content advances the check time, not the content time.
5. Failed, empty and stopped reads preserve the saved lines and previous successful time. A missing order is marked explicitly and stays held.
6. Signed-out or wrong-organisation requests cannot read an order. Five inspection calls per person per rolling minute is shared across workers.
7. Changed history stays held. A pipeline pass creates no draft. Opening a linked issued invoice refreshes its job facts and preserves the issued document.
8. The real UI works at 1280×800 and 375×667. Screenshots use synthetic records only.

Outside this slice: invoice-change trigger, history fallback/list signatures, full lifecycle/pinning/activity and full-year backfill.

Validation here is source-aware integration/browser proof. It is not a source-blind independent validator verdict.
