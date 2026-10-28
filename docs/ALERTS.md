# Quiet alerts

Issue #117. An alert says that something on one page needs a person.

## Rules

- Nothing shows when nothing needs a person.
- An alert shows only on the page where a person can act on it.
- An alert is one slim line under the page header. It shows the worst alert. "+N more" counts the others.
- × hides one alert for one person. It does not fix or close anything.
- A hidden alert comes back only when something new joins it. Example: a new invoice with a problem.
- An alert goes away for every person when its cause is fixed.
- Flow sends no email, sound or push for an alert. There is no feed of past alerts.
- A conflict between systems is an alert only. The alert has no button that writes to a system.

## Pages and sources

| Page | Alert | Source | Who sees it |
| --- | --- | --- | --- |
| Invoices | Invoices with a problem (a check stopped a draft, or the accounting system refused an issued invoice). The action opens the Pending tab. | `invoiceViews` (`server/core/sending.js`) | Everyone |
| Price list | Codes that differ from a connected system | Open `price_check` review items (`server/core/review.js`) | Everyone |
| Integrations | A stop that only a person can clear: the system refused Flow | Each integration's `alerts` capability | Owners and admins |

A paused circuit or a spent daily budget ends by itself, so it makes no alert.

Other open `review_items` kinds (`link.*`, `write.failed`, `job.dead`, reconcile, job changes) are not quiet alerts yet: they have no page where a person can act, so the rule above keeps them out. When that screen exists (#59), those kinds join this table.

An integration's own page (for example /integrations/xero) shows the same line, for that integration only (`scope`). Its status says "Calls stopped" while a danger alert is open, even after a person dismissed the line. The Xero page also turns the organisation row red and makes "Connect again" its main button. Connect again starts the calls again.

## How it works

```
review_items (open) ─┐
invoice views ───────┼─► alert sources ─► alertsFor(person, page) ─► GET /api/alerts?page=…
integration alerts ──┘                         ▲
                                               │ members ⊆ dismissed members → hidden
                                     alert_dismissals ◄── POST /api/alerts/dismiss { key }
```

- Flow works out alerts each time a page asks (`server/core/alerts.js`). It stores no copy of an alert.
- Each alert has a `key` that starts with its page, and `members`: the things it is about. Members stay on the server.
- `alert_dismissals` keeps one row per organisation, person and key, with the members at the time of the dismiss. The server works out the members again for a dismiss, so a browser cannot set them.
- `GET /api/alerts?page=integrations&scope=xero` answers only that integration's alerts, and `danger`: true while a danger alert is open, hidden or not.
- The strip loads with its page and again when the browser tab comes back into view (`server/ui/alerts.js`).

## An integration's alerts

An integration adds alerts with the optional `alerts({ organisationId })` capability (`server/integrations/port.js`). It reads Flow's own data only and makes no call to the outside system. It answers a list of `{ id, tone, title, members }`. `tone` is `danger` or `warn`.

An integration with a call guard can use `guardAlerts(name, status, { fix })` (`server/integrations/call-guard.js`). It turns the guard's `status()` into alerts for a halt and for stopped resources.
