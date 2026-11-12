## Unreleased

### Changes

- A job stuck on a void Flow invoice, or on an accounting invoice voided or deleted there, can be freed; it goes on hold until a person releases it. Holds and reviews can be released with a reason, from the API and the assistant skill.
- Seazona jobs get a shipped day: the day Flow first sees the job reach Shipped; each status move is kept. (#442)
- The AI assistant key reads the open review queue (`GET /api/invoicing/review`) and works the Seazona history import; `flow.sh health` reads Flow's health. The Flow skill says how to use them to close billing gaps.
