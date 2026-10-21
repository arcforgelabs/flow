# Line mapping

A work system names its lines in its own way. Seazona sends its own product
code and label (for example `2149` and "Full Denture Reline"). The
accounting system needs the lab's own item code. Line mapping finds the lab's
price item for each line before the job reaches the ledger
(`server/core/line-mapping.js`).

## The routine

The routine is the automation "Map lines to price items" (key `map_lines`,
`docs/AUTOMATIONS.md`). It runs inside the pipeline's read of the work system
(`server/core/pipeline.js`, `ingestWork`). It tries these steps in order. The
first step that answers wins.

| Step | Answers when |
| --- | --- |
| `same_code` | The line's own code is a price item code. |
| `account` | An account row matches the label. The line books to an account, with no price item (a surcharge). |
| `saved` | A person saved a price item for this label at this price. |
| `catalog_name` | Exactly one price item has this name. |
| `price_alias` | A row names a price item for this label at this price. |
| `catalog_name_price` | Exactly one price item has this name at this price. More than one stops the line. |
| `catalog_score` | One price item at this price has a clearly closer name than the others. |
| `alias` | A row names a price item for this label, or for the start of it. |

Before these steps, a line whose code is linked to a price item on the price
list (`docs/PRICE_LIST.md`) takes that price item (`linked`). A link is a
person's choice or an exact code, so it always goes first and is not a step
in the list.

The label is compared without sizes, arch ("upper", "lower 4") and "per set".
A line keeps the work system's amount and tax flag. The routine's setting
`linePrice` changes that: `work` (the default) keeps the work system's amount,
`list` takes the price list's price. Settings, Price list, "Line price from"
sets it. A line that no step
answers keeps no price item, so the ledger holds the job ("a line does not
map to a price item").

A change to a mapping row, or to the routine, reads every job again from
Flow's own copy of the work system. It makes no calls to the work system.

## Price codes (Settings, Rules)

Each label that found no price item shows as one row, with its price and the
number of lines it holds back. An owner or admin picks the price item. Flow
saves it as a `saved` row for that label at that price.

API (`server/api/invoicing.js`): `GET /line-labels`, `GET /line-mappings`,
`POST /line-mappings`, `PUT /line-mappings/:id`, `DELETE /line-mappings/:id`.

## From the earlier app

While `FLOW_IMPORT_EARLIER_SCHEMA` is set, each start reads the earlier app's
saved choices (`xero_item_match_rules`) in a read-only transaction. Each one
becomes a `saved` row, unless the lab has one already
(`server/import/at-start.js`, `importEarlierMappingsAtStart`).
