# Pager

The bar over one record opened from a list: "← Back", "n of N", previous and next.

- Back opens the list as it was (tab, search, scroll). After Send or Save the next record opens.
- Today the markup is built in three pages (Invoices, Reconcile, Price list › Reconcile). Issue #220 makes one helper; until then copy none of them and reuse the classes.

Code: `.fx-pager` in `server/ui/flow.css` (static card: markup only, until #220).
