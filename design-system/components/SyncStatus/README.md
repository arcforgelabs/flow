# SyncStatus

A shared Layers row: pulse, real count, then a day rail and an approximate time remaining.

Code: `syncStatus` in `server/ui/sync-status.js`; styles in `server/ui/flow.css`.

`syncStatus()` returns `{ element, draw(state, button), dispose() }`. The caller owns polling and actions. State is `{ phase, startedAt, endedAt, count, unit, from, through, at, cause, nextRunAt }`; dates and totals come from the server. `endedAt` freezes a finished clock across reloads. ETA uses completed days in this run, not the cumulative count. Missing timing data stays blank.

Seazona History is the first caller. It polls every five seconds while visible and running or waiting. A stopped run keeps its total; Resume starts a new server clock. The approved first release has no steps toggle because the server does not yet provide persisted steps. Never manufacture a page-only log.

On phones the status and action wrap, with a thin rail below. Controls remain 44px. Reduced motion stops the dots and shimmer and uses the fixed word Reading. Decorative clocks and rotating words are excluded from live announcements. The integration phone fixture has Seazona disconnected; connected History is covered by `test/sync-status.test.js`.
