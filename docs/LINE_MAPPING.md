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
A line keeps the work system's amount and explicit tax flag.
A saved tax choice or price item supplies tax only when the source gave none. The routine's setting
`linePrice` changes that: `work` (the default) keeps the work system's amount,
`list` takes the price list's price. Price list settings, "Invoice line price"
sets it. `lineTax` does the same for GST: `list` (the default) takes the price
item's tax and keeps a different work
flag on the line as `workTaxCode` ("Invoice line GST"). The price item wins:
the job does not wait, the work system's GST and total are not compared (only
its prices before GST), and the work flag alone decides "the job changed"; `work` keeps the work system's flag. A line that no step
answers keeps no price item, so the ledger holds the job ("a line does not
map to a price item").

A change to a mapping row, or to the routine, or a release that changes what\na stored line holds (`MAPPING_SHAPE`, `server/core/pipeline.js`), reads every job again from
Flow's own copy of the work system: the live jobs and the held jobs of a
history import. It makes no calls to the work system.

## Placeholder lines

Some labs add a line in the work system only to open a job, before the real
work is known (for example "Models" at $0.00). The routine's setting
`placeholders` lists them: `[{ "label": "Models", "unitAmountCents": 0 }]`
(`null` for any price). It is the lab's own setting, not Flow's code.

- A placeholder line leaves the job when the job has other lines. It does not
  reach the invoice and holds nothing.
- A job with only placeholder lines keeps them (`mappedBy` `placeholder`), so
  the job is still seen. The lab's rules hold it (for example "No amount")
  until the work system has the real lines.
- Flow does not write to the work system, so the line stays there.

Set it on Price codes (a $0.00 row offers "Placeholder: leave it off the
invoice"), or `PUT /api/invoicing/automations/map_lines` with
`{ "config": { "placeholders": [...] } }`.

## Price codes (Settings, Rules)

Each group of lines that found no price item shows as one row: the work
system's text, its product code, the price on the job (and the list price when
it differs), and the lines and jobs it holds back. One label that waits at two
prices is two rows. An owner or admin picks the price item:

- A row with a product code links that product to the price item (the price
  list's link, `docs/PRICE_LIST.md`). Every line of the product then maps, at
  every price: a price set by hand on one job no longer stops it.
- A row with no product (a free-text line, for example a discount) saves a
  `saved` row for that label at that price. The price can be below zero.

Each row has "Copy prompt": the facts and the steps for a connected agent. An
error stays on the page in red, with its own "Copy prompt".

A waiting line keeps the work system's code as `workCode`. A Seazona invoice
line has no product code of its own; it takes the code of the order's line for
the same product (`server/integrations/seazona/ledger.js`, `ledgerLinesFor`).

API (`server/api/invoicing.js`): `GET /line-labels` (`labels`: every label; `waiting`: the rows above), `GET /line-mappings`,
`POST /line-mappings`, `PUT /line-mappings/:id`, `DELETE /line-mappings/:id`.

## From the earlier app

While `FLOW_IMPORT_EARLIER_SCHEMA` is set, each start reads the earlier app's
saved choices (`xero_item_match_rules`) in a read-only transaction. Each one
becomes a `saved` row, unless the lab has one already
(`server/import/at-start.js`, `importEarlierMappingsAtStart`).
