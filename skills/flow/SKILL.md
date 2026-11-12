---
name: flow
description: Run the lab's Flow app and read Seazona through it - invoice tabs, send ready invoices, void or delete drafts, invoice rules, jobs, reconcile Seazona jobs with Flow and Xero, and Seazona orders, invoices and clients.
metadata: { "openclaw": { "requires": { "bins": ["curl", "openssl", "sha256sum"] } } }
---

# Flow

Flow is the lab's invoicing app. It takes jobs from Seazona (the lab's case
system) and sends invoices to Xero. Use `{baseDir}/flow.sh` for every call.
It holds the Flow key; never print the key file or put the key in a message.

Flow address: saved by `setup` next to the key (or `FLOW_URL`). There is no
default: the key goes only to this lab's own Flow.
Key file: `FLOW_AGENT_KEY_FILE` (default `~/.openclaw/credentials/flow-agent-key`).

## First time only

Run `{baseDir}/flow.sh setup https://<this lab's Flow>`. It saves the address,
makes the key once and prints only `FLOW_AGENT_KEY_SHA256=<64 hex>`. That digest is safe to share: give it to the
person who sets up Flow. Flow stores the digest, never the key. Run `setup`
again any time to see the same digest. To change the key, delete the key file,
run `setup`, and give the new digest to Flow.

Then check: `{baseDir}/flow.sh get me` must answer `HTTP 200`.

## Calls

Every answer ends with a line `HTTP <code>`. 401 or 403: the key is not set up
in Flow, or the Flow person is turned off. Stop and tell the person.

Read first. Before a change, read the record, say what you will change, and
for sends, voids and deletes get the person's yes in the chat.

| Do this | Command |
| --- | --- |
| Tabs and counts | `flow.sh get 'invoicing/invoices?status=ready&limit=50'` (status: pending, ready, draft, approved, sent, non_chargeable, void) |
| Search invoices | `flow.sh get 'invoicing/invoices?q=<text>'` |
| One invoice | `flow.sh get invoicing/invoices/<id>` |
| Mark ready | `flow.sh post invoicing/invoices/mark-ready '{"invoiceIds":["<id>"]}'` |
| Send all ready to Xero | `flow.sh post invoicing/invoices/send-ready '{}'` (or `'{"invoiceIds":["<id>"]}'`) |
| Void an invoice | `flow.sh post invoicing/invoices/<id>/void` |
| Delete a draft | `flow.sh delete invoicing/invoices/<id>` |
| Jobs | `flow.sh get 'invoicing/jobs?limit=50'`, one job `invoicing/jobs/<id>/activity` |
| Invoice rules | `flow.sh get invoicing/rules`; what a rule can use: `flow.sh get invoicing/rule-fields` |
| Add a rule | `flow.sh post invoicing/rules '{"name":"...","conditions":[{"field":"job_total","test":"at_most","value":0}],"action":{"kind":"wait"}}'` |
| Change or turn off a rule | `flow.sh put invoicing/rules/<id> '{"enabled":false}'` |
| Delete a rule | `flow.sh delete invoicing/rules/<id>` |
| Automations | `flow.sh get invoicing/automations` |
| Flow settings | `flow.sh get invoicing/settings` |

Rule actions: `wait` (hold the job) or `skip` (never invoice it). Take field,
test and value only from `rule-fields`.

Voids: the Void tab holds invoices voided in Flow **or voided or deleted in
Xero**. Before a clean-up, list the tab, group the rows (Flow void, Xero void,
deleted draft), show the person the groups, and act only on the group they
confirm.

Sending: Flow sends each invoice to Xero as a draft unless the "Approve and
email" setting is on (`invoicing/settings`). Say which one applies before a send.

## Seazona (read only)

Flow reads Seazona for you with its own Seazona connection, so you need no
Seazona password. Calls share Seazona's limit of 30 a minute with Flow's
sync: make few calls, and never loop over many records.

| Do this | Command |
| --- | --- |
| Orders on one day | `flow.sh get 'seazona/api/orders/?ordered=2026-11-11T00:00:00&page=1&pageSize=50'` |
| One order | `flow.sh get seazona/api/orders/<order id>` |
| Invoices changed since | `flow.sh get 'seazona/api/invoices/?lastModified=2026-11-01T00:00:00'` |
| Clients changed since | `flow.sh get 'seazona/api/clients/?lastModified=2026-11-01T00:00:00'` |
| Products, users | `flow.sh get seazona/api/products/`, `flow.sh get seazona/api/users/` |

Answers are `{ "ok": true, "data": ... }`, as Seazona gives them. If the owner
turned on "Hide patient details", patient, note, file and clinical fields are
left out. Do not copy patient names outside this chat. 429: wait a
minute and try once more.

## Reconcile: Seazona jobs, Flow invoices, Xero

When the person says "reconcile", "tidy up" or "why is this job not
invoiced", work in this order. Read first, show the person what you found in
short groups, then act on the group they confirm.

1. **Jobs against Flow invoices.** `flow.sh get invoicing/reconcile` lists
   jobs with no invoice and invoices with no job. For one row:
   `flow.sh get invoicing/jobs/<job id>/reconcile` or
   `flow.sh get invoicing/invoices/<id>/reconcile` (each lists the likely other
   side; `best: true` is the top guess).
   - Link a job to its invoice: `flow.sh post invoicing/jobs/<job id>/link '{"invoiceId":"<id>"}'`
   - Job needs no invoice: `flow.sh post invoicing/jobs/<job id>/no-invoice`
   - Make the invoice now: `flow.sh post invoicing/jobs/<job id>/draft`
   - Read the job again from Seazona: `flow.sh post invoicing/jobs/<job id>/recheck`
2. **Flow against Xero.** First get the lab id:
   `flow.sh get invoicing/context` (`organisations[0].id`, below `<org>`).
   - Refresh Flow's copy of Xero: `flow.sh post xero/mirror '{"organisationId":"<org>"}'`
   - Xero invoices against Flow's: `flow.sh get 'xero/import?organisationId=<org>&show=check'`
     (show: `check`, `linked`, `invoice_fits`, `job_fits`, `none`, `all`)
   - Match them all again: `flow.sh post xero/import/match '{"organisationId":"<org>"}'`
   - Link one Xero invoice to a Flow invoice: `flow.sh post xero/import/<xero invoice id>/link '{"organisationId":"<org>","invoiceId":"<id>"}'`
   - Make the Flow invoice for one Xero invoice: `flow.sh post xero/import/<xero invoice id>/make '{"organisationId":"<org>","jobId":"<job id or null>"}'`
   - Xero's state of some Flow invoices: `flow.sh post xero/invoices/status '{"organisationId":"<org>","invoiceIds":["<id>"]}'`
   - Re-check one invoice after a fix in Xero: `flow.sh post xero/invoices/<id>/recheck '{"organisationId":"<org>"}'`
   - Contacts: `flow.sh get 'xero/contacts/match?organisationId=<org>&contactId=<Flow contact id>'`; link to a Xero contact of another name: `flow.sh post xero/contacts/link '{"organisationId":"<org>","contactId":"<id>","xeroContactId":"<id>"}'`
3. **Fix the cause with a rule.** If many jobs fail the same way, read
   `invoicing/rule-fields`, propose one rule (`wait` or `skip`), and add it after
   the person says yes. Line names that map to the wrong product:
   `flow.sh get invoicing/line-mappings`, then change one with `put
   invoicing/line-mappings/<id>`. Prices: `flow.sh get invoicing/price-list`.
4. **Check Seazona itself** for one job with the Seazona read above (one order).

Links, "no invoice", rules and mappings are Flow records only: say what you
will change and do it after the person's yes. Mirror, match and recheck only
read Xero. Sending to Xero still goes through `invoicing/invoices/send-ready`.

## Xero

Xero has its own `xero` command on this Gateway, for anything Flow does not
cover. Flow's send and the reconcile steps above use Flow's own Xero
connection, not yours.

## Never

- Never print, paste or send the key file, a Xero token or a callback URL.
- Never send, void or delete without the person's yes in this chat.
- Never send a turned-off person's work again without asking: a send stopped as
  `requester_disabled` means a person turned the assistant off.
- Never change Flow people, Integrations or owner settings: Flow refuses them.
