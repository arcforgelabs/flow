# Pager

The bar over one record opened from a list: "← Back", "n of N", previous and next.

- `pager(h, { label, back })` gives `{ element, draw({ count, prev, next, prevLabel, nextLabel, steps }) }`.
- `back` is the Back click. `draw` fills the count and step buttons; `prev` / `next` are click handlers or `null` (disabled). Omit `draw`, or pass `steps: false`, for Back only.
- Back opens the list as it was (tab, search, scroll). After Send or Save the next record opens.

Code: `pager` in `server/ui/pager.js`. Invoices, Reconcile and Price list › Reconcile use it.
