# Price list

The price list is the lab's own list of codes, names, prices and tax codes
(`price_items`). Flow keeps it, and it works with no integration connected.
Xero items and Seazona products link to it when those integrations are on.
Flow never changes a price in another system.

Code: `server/core/price-list.js`. Screens: Settings, Price list
(`server/ui/price-list.js`) and Price list › Reconcile
(`server/ui/price-reconcile.js`, likely codes in `server/ui/price-match.js`).
API: `server/api/invoicing.js`.

## The screens

- **Price list** shows Flow's own codes only: code, name, price and tax, with
  Active and Archived tabs and a search. It looks the same with no
  integration on. A row opens the code's dialog.
- **Reconcile** shows only while an integration with a price list is on. Its
  button on the Price list counts the records that need a person: each
  record with no code, and each code that differs from a linked record.
- Reconcile has the two views of Xero › Import › Review:
  - **One at a time**: the record beside its likely Flow code, one fact per
    row, ✓ or ≠ between them. The invoice pager steps through them. Link,
    Other match, Find another code, Add as new code, Skip. A code that
    differs: Edit code, Remove link (record gone), Mark resolved.
  - **List**: every record with its likely code. Ticked rows are linked,
    added as new codes or marked resolved from the bulk bar.
- A likely code agrees by name (words, or a short word that starts a long
  one), then price, then tax. A **sure** match agrees on all three, with no
  other code as close. "Link N sure" links every sure one in one call.
- Check prices sits on the Reconcile screen.

## The parts

| Part | What it is |
| --- | --- |
| Price item | One code on the list: code, name, price before tax, tax code (GST or GST free), and an optional invoice text and account code. |
| System list | A connected system's own list, read from Flow's copy through the port's `listPriceItems`. Xero: its items. Seazona: its products. |
| Link | One row in `price_item_links`. It joins one record of a system list to one price item. |
| Price check | Compares each live price item with its linked records. |
| Alert | One review item (`kind` `price_check`) for a price item that differs. |

## Links

- Flow links a record by itself when its code is the code of a price item
  (`matched_by` `code`).
- A person links the rest on the Reconcile screen (`matched_by` `person`).
  "Add as new code" adds the record to the list, then links it.
- An accounting system (Xero) has one record for each price item at most.
  A work system (Seazona) can link many products to one price item.
- Line mapping uses a work system link first: a Seazona line whose product
  code is linked takes that price item (`docs/LINE_MAPPING.md`, step
  `linked`).

## The price check

The check runs at the start of each pipeline run, and when a person presses
"Check prices". It reads only Flow's copies, so it makes no calls to Xero or
Seazona. Xero's copy changes on each Xero sync; Seazona's on its daily
products read.

| Finding | Means |
| --- | --- |
| `price` | The linked record has another sales price. |
| `tax` | The linked record has another tax code. Xero `OUTPUT` reads as GST; Seazona taxable no reads as GST free. |
| `missing` | The linked record is no longer in the system's list. |
| `not_linked` | An accounting system has no record for this code. A send with it stops for a person. |

Each finding is an alert only. A person fixes the price in Flow, Xero or
Seazona, or presses "Mark resolved". Mark resolved checks the one code again,
then accepts what is still different. The same finding does not open again; a
new difference does. When the prices agree again, Flow closes the alert.

## The line price

"Line price from" (the line mapping routine's `linePrice`) chooses the price
on each mapped invoice line:

- **Work system amount** (default): the amount Seazona gave, as the earlier
  app did.
- **Price list**: the price item's price.

## Later

- Customer prices: a price for one customer.
- Writing a price change to Xero items, through the outbox, off by default.

## API

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/invoicing/price-list` | everyone | The list, the links, each system's records with no link, and what differs. |
| `POST /api/invoicing/price-list/check` | owner, admin | Runs the check now. |
| `POST /api/invoicing/price-items` | owner, admin | Adds a code. |
| `PUT /api/invoicing/price-items/:id` | owner, admin | Changes a code. |
| `POST /api/invoicing/price-items/:id/archive` | owner, admin | `{ archived }`: archives a code, or brings it back. |
| `POST /api/invoicing/price-items/:id/links` | owner, admin | `{ system, externalId }`: links a record. |
| `POST /api/invoicing/price-items/:id/resolve` | owner, admin | Mark resolved. |
| `POST /api/invoicing/price-links` | owner, admin | `{ links: [{ priceItemId, system, externalId }] }`: up to 500 links in one call, then one remap. |
| `DELETE /api/invoicing/price-links/:id` | owner, admin | Removes a link. |
