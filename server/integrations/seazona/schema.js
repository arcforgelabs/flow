import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The Seazona adapter's own tables. They are not part of the core schema
// (server/db/schema.js): the adapter creates them only when it is enabled
// (issue #13). One installation talks to one Seazona account, so these tables
// are installation-wide, like `people`.

const at = (name) => timestamp(name, { withTimezone: true });

// One row per API client: when the next request may go, and any cooldown a
// 429 asked for. Every process that shares the database shares this row.
export const seazonaApiGovernor = pgTable('seazona_api_governor', {
  clientKey: text('client_key').primaryKey(),
  nextEligibleAt: at('next_eligible_at').notNull().default(sql`'epoch'`),
  cooldownUntil: at('cooldown_until').notNull().default(sql`'epoch'`),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

// One row per request sent. The rate limit counts these rows, and they are
// the telemetry an operator reads to answer the vendor. A row keeps the
// request path (for example /v1/orders/<order id>, so a failing record can be
// named), never the host, the query or a credential, and never a response.
export const seazonaApiRequests = pgTable('seazona_api_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clientKey: text('client_key').notNull(),
  workflow: text('workflow').notNull(),
  admittedAt: at('admitted_at').notNull(),
  requestPath: text('request_path'),
  statusCode: integer('status_code'),
  failureKind: text('failure_kind'),
  durationMs: integer('duration_ms'),
  isRetry: boolean('is_retry').notNull().default(false),
}, (t) => [
  index('seazona_api_requests_window').on(t.clientKey, t.admittedAt),
]);
