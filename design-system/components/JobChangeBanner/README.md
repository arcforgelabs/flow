# JobChangeBanner

"The job changed" on a draft invoice: what the work system has now, beside what the draft has.

- `jobChangeBanner(ui, change, { money, onAccept, onRecheck })`.
- Accept change shows only while the draft is not sent. A conflict is an alert: a person fixes it at the source.

Code: `jobChangeBanner` in `server/ui/job-change.js`.
