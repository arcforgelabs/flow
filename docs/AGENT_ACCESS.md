# Agent access

## Status

This source slice implements four approved read operations from #9.
The door stays off by default. It needs an explicit Flow grant.
It makes no financial changes and calls no integration.
This security change must wait for Samuel's acceptance before merge.
Live Clerk and OpenClaw consent needs a separate private pilot.

The server uses official MCP SDK 1.32.1 and Clerk's MCP helpers.
It keeps `@clerk/backend` at 3.25.0. It pins `@clerk/express` at 2.1.6
and `@clerk/mcp-tools` at 0.9.0. The Express package accepts this backend.
No custom plugin, connector key or OAuth server is required.

## AI assistant key

This is the quick door for one AI assistant (an OpenClaw Gateway) that runs
Flow for the lab. It is separate from the MCP door below and is off by default.

1. In Flow, an owner opens **People** and invites the assistant as its own
   person, for example `assistant@<lab domain>`, with the role **admin**. The
   person never signs in. Activity shows this person.
2. On the assistant's machine, the `flow` skill (`skills/flow/`) runs
   `flow.sh setup https://<this Flow>`. It saves that address, makes a random
   key, keeps it in a file with mode 600, and prints only the key's SHA-256.
   The script has no default address: the key goes only to the saved one.
3. The host sets two settings and restarts Flow:
   `FLOW_AGENT_KEY_SHA256=<that digest>` and `FLOW_AGENT_EMAIL=<that person>`.
   Flow holds only the digest. The key never leaves the assistant's machine.

A request with `Authorization: Bearer <key>` then acts as that person, inside
the person's role, on `/api/me`, `/api/invoicing/…`, `/api/xero/…`,
`/api/seazona/api/…` and `/api/agent-skill/flow/…` only. Every other route
refuses the key. With **admin** it
can read invoices and jobs, change invoice rules, void, delete drafts, send
ready invoices and reconcile: link jobs and invoices, match Flow against
Flow's copy of Xero and refresh that copy. It can also compare and fix the price list: Flow codes,
links to Xero items and Seazona products, and the price codes that hold job
lines (`docs/PRICE_LIST.md`). Owner
actions (People, Integrations, updates) always refuse the key: an agent request
is never a verified owner sign-in. Turning the person off in People stops the
key on the next request, and a send it queued fails as `requester_disabled`
instead of reaching the accounting system. Removing either setting turns the
door off. Each call
logs one line with the route and the person, never the key.

`GET /api/agent-skill/flow/SKILL.md` and `GET /api/agent-skill/flow/flow.sh`
serve the `flow` skill from the release this Flow runs (any signed-in person or
the key; no other file). `flow.sh update` fetches both from the saved Flow
address, checks them, and only then replaces the installed copy. So the skill
never runs ahead of, or behind, the Flow it calls. Install from GitHub only the
first time.

`GET /api/seazona/api/<resource>[/<id>]` lets an owner, an admin or the
assistant read Seazona through Flow's own Seazona connection and rate governor
(`docs/SEAZONA.md`), so the assistant needs no Seazona credentials. It answers
what Seazona gives. With "Hide patient details" on (Seazona settings), Flow
first drops every field whose name says patient, note, comment, instruction,
file, image, prescription, shade, clinical, medical or birth, at any depth.

## Authentication and grants

Set `FLOW_MCP=on`, `FLOW_AUTH=clerk` and a fixed HTTPS `FLOW_PUBLIC_ORIGIN`.
The resource and token audience are that origin plus `/mcp`.
Flow does not derive them from request headers or model arguments.
Clerk must verify an `oauth_token` for this resource.
Flow also checks verified expiry, subject and client.
A browser session never opens the MCP door.

Each request needs a linked, active Flow person and an unrevoked read grant.
The grant binds the person and client to one resource and organisation.
The lookup never invites a person, links an account or fills a name.
Disablement and revocation apply on the next request.
Access never exceeds the person's current role.

OAuth consent alone does not create a Flow grant.
The minimal management API uses normal Flow browser authentication:

- `GET /api/agent-grants` lists the caller's first 100 grants.
- `POST /api/agent-grants` lets a verified owner create their own read grant
  or explicitly reauthorize their revoked grant for the same organisation.
  Supply only `clientId`, `appName` and `organisationId`. Reauthorization
  preserves the grant UUID and audit history, updates the app name, and clears
  revocation and breaker state. It never moves the grant to another organisation.
- `POST /api/agent-grants/<id>/revoke` revokes the caller's grant.
  A verified owner can revoke another person's grant.
- `POST /api/agent-grants/<id>/resume` clears a breaker pause.
  It does not undo revocation. The same ownership rules apply.

The caller cannot choose the grant's person, resource, role or access level.
An active or paused duplicate person/client/resource returns a conflict.
Only explicit verified-owner provisioning can reauthorize a revoked binding;
ordinary requests and pause-resume cannot. Reusing a revoked binding with a
different organisation also returns a conflict.
Do not put a browser token in an agent or support message.
The Connected apps and client-ID discovery UI are not built.
An ordinary person cannot connect end to end without approved grant provisioning.

## Four read tools

Inputs are strict objects. The model cannot select a person, organisation,
instance, origin, upstream URL or SQL statement.

- `flow_connection` takes `{}`. It returns this resource, the own grant,
  organisation, read access and available toolsets.
- `flow_invoice_diagnosis` takes `{ invoiceId }`, an exact Flow invoice UUID.
  It returns stored status, totals, a bounded refusal code and fixed reason codes.
  It includes the linked job and source-total review when present.
  It does not make a full readiness decision or repeat a source check.
- `flow_job_read` takes `{ jobId }`, an exact Flow billing-obligation UUID.
  It returns stored hold, mapping and accounting state, totals and observation times.
  This is not a source-system job ID.
- `flow_health_read` takes `{}`. It returns database reachability, the bounded
  due-job count and the latest source observation for this organisation.

Answers contain `ok`, `observedAt`, `truncated` and `data` or a fixed `code`.
Missing and out-of-organisation records both return `record_unavailable`.
They do not reveal whether another record exists.

A source-total review returns only source and reconstructed totals, unknown-tax
line positions and its observation time. It returns no raw evidence or reasons.
A difference is evidence for review. It does not prove that the source is wrong.
Do not allocate unknown tax. Stored evidence can be stale.
Links use the configured origin: `/invoices/<id>` and `/reconcile/<obligationId>`.
No permanent job-panel URL is claimed.

Patient names, references, contact names, notes, line text, raw source payloads,
upstream URLs and free-text refusal messages are not projected.
No tool changes a financial record or queues a source read.

These approved names replace the research names for this slice. There are no
aliases. `flow_status`, `flow_invoice_get` and `flow_job_get` are not registered.
The broader #291 inventory remains open: search, lists, alerts, prices,
custom fields and activity. That issue is not complete.

## Host gates

One shared gate owns each request. All tools use one registration path, strict
schemas, a PostgreSQL READ ONLY transaction and bounded output.
Grant and audit writes run outside the domain transaction.
Defaults follow #290, Stripe's four limiters, OpenClaw MCP relay limits and
Flow's integration call-guard policy:

- Address rate: 120 requests a minute before body parsing and verification.
- Grant rate: 60 a minute and 3,000 per day, using `express-rate-limit`.
  Both emit draft-8 `RateLimit` and `RateLimit-Policy` headers.
  Rate refusal also emits `Retry-After`.
- Concurrency: two calls per grant. Three agent leases cover verification, SQL
  acquisition, tool work and audit. The normal ten-connection pool keeps seven
  connections for people and workers. A smaller pool keeps at least one spare.
- Worker protection: more than 100 due jobs refuses agents with 503.
- Deadline: 15 seconds. Expiry aborts verification and destroys a held SQL client.
  A late identity cannot proceed. Only the MCP acquisition wait times out
  after one second; ordinary shared-pool callers keep their existing behavior.
  PostgreSQL pool acquisition cannot be cancelled per caller. A pending wait
  therefore keeps its agent lease until it settles; its late connection is
  discarded without running SQL. At most three such waits can exist, and a
  saturated pool keeps agents refused until it recovers.
- SQL: five-second statement timeout and one-second transaction lock timeout.
- Projection: 100 rows, 512 KiB per answer and 16,000 characters per text.
  Exact-ID tools have no list cursor. A capped embedded list marks truncation.
- Body: 100 KiB. Batches are refused. Unknown tools return 404.

Clerk backend 3.25.0 has no per-request abort option. Its verifier runs in a
bounded worker thread. Cancellation terminates the worker and its sockets.
At most three workers exist. Worker output is discarded, not logged.
Flow does not patch global fetch or upgrade Clerk to obtain cancellation.

The durable breaker pauses a grant after 20 attributed refused or failed calls
in one UTC day. A person must resume it. A restart does not resume it.
One transition logs an error; repeated refusals use warnings.
Unauthenticated attempts and pre-admission fleet refusals have no verified grant
and no attributed audit row. Address and fleet admission still bound them.

Audits hold person, grant, fixed tool, status, count and duration only.
They hold no token, patient, arguments, payload or database error.
Person and grant UUIDs are historical snapshots without foreign keys. Removing
a person or grant neither deletes nor rewrites their audits; retention still applies.
A verified-grant timeout receives a 408 audit through a replacement connection.
Cleanup removes at most 100 audit rows older than 35 days per minute of activity.
It runs inside the agent lease. A database outage can prevent an audit write.
Flow emits a fixed warning and drops an acquired connection. An audit acquisition
that outlives its one-second wait retains the lease until the pool settles, then
discards the late connection; it does not create unbounded replacement work.

All gate settings have finite bounds. No setting disables a gate.
See Self-hosting for names and bounds. One Flow process serves one installation.
Multiple processes need shared limiter ownership before activation.
No sync or import tool is exposed. Such work must later queue a job.

## Stock OpenClaw

Use the exact URL `https://flow.example.com/mcp`, not the site root.

```json5
{ mcp: { servers: { flow: {
  url: "https://flow.example.com/mcp",
  transport: "streamable-http", auth: "oauth",
  oauth: { identity: "per-requester" },
  connectionTimeoutMs: 5000, requestTimeoutMs: 20000,
  toolFilter: { include: ["flow_connection", "flow_invoice_diagnosis", "flow_job_read", "flow_health_read"] },
} } } }
```

Stable OpenClaw supports per-requester OAuth. Configure its public callback
origin under `gateway.publicOrigin`. Each requester uses native sign-in.
The CLI's shared OAuth login is offline-only on current OpenClaw.
It is not the per-requester flow. Native Accounts manages shared credentials.
Sign-in links are bearer links. Start the first pilot in a private direct chat.
Do not post links in shared support rooms. Per-requester storage alone does
not establish shared-room safety.

## Remaining delivery work

Complete independent source review and the required suite on the accepted head.
Prove Clerk resource registration and stock OpenClaw with a private consent round trip.
No live setup changed here. The Connected apps UI, ordinary-person grant path
and broader #291 inventory remain open. No skill or financial tool was added.
