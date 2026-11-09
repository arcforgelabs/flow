# JobChangeBanner

The shared comparison for a changed job or a source amount problem on a draft invoice.

- `jobChangeBanner(ui, change, { money, onAccept, onRecheck })`.
- `jobChangeReview` wires Accept change and the source recheck.
- The invoice page and the job Review sidecar use this component.
- Accept change shows only when the existing guards permit it.

## Source invoice amounts

`change.sourceReview` compares source invoice amounts with reconstructed Flow job lines.
The Difference column shows Flow minus source.
Unknown tax stays unknown.
A separate disclosure shows the saved Flow invoice amounts.

The source link opens the job, not an invented invoice URL.
A home-page link says where to find the source record.
A missing link gives a manual instruction.
Recheck reads the source and preserves the saved invoice.
A source problem never offers Accept change.
Other holds and invoice problems remain visible.

On a phone, this variant uses CardRows for the amount rows.
The full instructions and action names remain visible.
The variant does not use the short Notice label.

Code: `jobChangeBanner`, `jobChangeReview` in `server/ui/job-change.js`.
