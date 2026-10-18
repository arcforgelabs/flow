# Seazona adapter

Seazona is the lab's case system. The Seazona adapter reads what billing
needs through the Seazona REST API: invoices, orders, clients, products and
users. It never writes to Seazona, and it never drives a browser. The code is
in `server/integrations/seazona/`. Core code never imports it
(`CONTRIBUTING.md`).

Status: the API client and the rate governor are in place. The sync lanes and
the connection to the integration port come next.

## Modes

The mode says which environment the adapter acts on (issue #10). It comes
from `SEAZONA_MODE` only. There is no default: with no mode the adapter does
nothing.

| Mode | Acts on | Background sync | Network |
| --- | --- | --- | --- |
| `live` | The installation's real Seazona account | Yes | Seazona API |
| `sandbox` | A Seazona test account | Never; runs only when asked | Seazona API |
| `replay` | A file of recorded, synthetic responses | Never | None |

Development and CI use `replay` or `sandbox`. Never give a development
workspace live credentials.

## Settings

| Setting | Meaning |
| --- | --- |
| `SEAZONA_MODE` | `live`, `sandbox` or `replay`. Required. |
| `SEAZONA_API_BASE_URL` | The API root of the account, `https://…`, with or without `/v1`. Required in `live` and `sandbox`. |
| `SEAZONA_API_CLIENT_ID`, `SEAZONA_API_CLIENT_SECRET` | The API client. Secrets: keep them in the platform's secret store. Required in `live` and `sandbox`. |
| `SEAZONA_REPLAY_FILE` | The replay file. Required in `replay`. |
| `SEAZONA_API_REQUESTS_PER_MINUTE` | Default and maximum 30. A value can only lower it. |
| `SEAZONA_API_MAX_RETRIES` | Retries after a 429 or 5xx answer. Default 2. |
| `SEAZONA_API_TIMEOUT_MS` | Time limit for one request. Default 30000. |
| `SEAZONA_API_MAX_WAIT_MS` | How long a request may wait for a free slot. Default 120000. |
| `SEAZONA_API_TELEMETRY_RETENTION_DAYS` | How long request telemetry is kept. Default 35, so last month's question from Seazona can be answered. Maximum 90. |

The code holds no Seazona host or account. Every address and credential is
configuration.

## Rate governor

Seazona publishes a limit of 60 requests a minute for each API client. Flow
stays at 30, and counts every process that shares the database as one client,
because Seazona does (`server/integrations/seazona/governor.js`):

- A request waits until fewer than 30 requests went out in the last minute,
  and at least 2 seconds have passed since the last one.
- A 429 answer with `Retry-After` holds every process for that long (at most
  60 seconds).
- A 429 or 5xx answer is retried at most `SEAZONA_API_MAX_RETRIES` times, with
  a growing wait. Each retry counts against the limit.
- A request that waits longer than `SEAZONA_API_MAX_WAIT_MS` gives up with
  `seazona_api_governor_timeout`.
- In `live` and `sandbox` the client refuses to start without the governor,
  so no code path can call Seazona ungoverned.

Each request leaves one row in `seazona_api_requests`: when it went, the
request path (for example `/v1/orders/<order id>`), the status or failure
kind, the time it took and whether it was a retry. The row never holds the
host, the query, a credential or a response. `governor.summarise({ from, to })`
gives the totals for a period and each failing path with its count, which
answers a question such as "why did this account make thousands of failed
reads last month?".

## Replay files

A replay file is JSON with a `responses` list. Each entry answers one
request:

```json
{
  "responses": [
    { "path": "invoices/", "query": { "lastModified": "*" }, "status": 200, "body": [] },
    { "path": "orders/ORD-1001", "status": 404 },
    { "path": "orders/ORD-1002", "sequence": [{ "status": 500 }, { "status": 200, "body": { "id": "ORD-1002" } }] },
    { "path": "orders/ORD-1003", "rawBody": "" },
    { "path": "orders/ORD-1004", "error": "timeout" }
  ]
}
```

- `path` is relative to the API root.
- `query` is optional. Each key it lists must match, and `"*"` matches any
  value.
- The first matching entry answers. A `sequence` answers in order, then
  repeats its last answer.
- A request that no entry matches fails with the kind `replay_miss`.

A replay file holds synthetic data only: no real lab, practice, dentist or
patient (`CONTRIBUTING.md`).

## Tables

The adapter owns its tables (issue #13). They are created only while the
adapter is turned on, from its own migrations in
`server/integrations/seazona/migrations/`, and are not part of the core
schema. One installation talks to one Seazona account, so they are
installation-wide.

| Table | What it holds |
| --- | --- |
| `seazona_api_governor` | For each API client: when the next request may go, and any 429 cooldown |
| `seazona_api_requests` | One row per request sent: the rate limit counts these, and they are the telemetry |

To change them, edit `server/integrations/seazona/schema.js` and run:

```bash
npx drizzle-kit generate --config server/integrations/seazona/drizzle.config.js
```
