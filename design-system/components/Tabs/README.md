# Tabs

Tabs with counts over a list: Pending, Ready, Draft, Approved, Sent, Non-chargeable, Void on Invoices.

- One word per tab, left to right in the order work moves. The strip scrolls when the labels do not fit, so the page stays the width of the screen.
- `data-tone="danger"` on a tab whose count needs a person.

Code: `.fx-tabs`, `.fx-tabs__count` in `server/ui/flow.css` (static card: markup only).
