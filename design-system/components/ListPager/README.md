# ListPager

The pages of a long list, in the list window's foot bar, as HubSpot's: rows per page, "1–100 of 1,204", numbered pages between previous and next.

- `listPager(h, { label, sizes, change })` gives `{ element, draw({ offset, limit, total }) }`. `change({ offset, limit })` asks for a page.
- The server cuts the page (`offset`, `limit`) and counts every row the filter keeps, so a list works with any number of rows.
- A new size starts at page 1. One page hides the page numbers; the size stays.

Code: `listPager` in `server/ui/pager.js`. Invoices uses it.
