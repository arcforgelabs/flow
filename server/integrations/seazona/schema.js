import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// The Seazona adapter's own tables. They are not part of the core schema
// (server/db/schema.js): the adapter creates them only when it is enabled
// (issue #13). One installation talks to one Seazona account, so these tables
// are installation-wide, like `people`.

const at = (name) => timestamp(name, { withTimezone: true });

// One row per API client: when the next request may go, and any cooldown a
// 429 asked for. Every process that shares the database shares this row.
// Issue #101: the circuit breaker (open until, and how many times in a row it
// opened) and a stop that waits for a person (`halted_reason`, for example
// `auth` after a 401).
export const seazonaApiGovernor = pgTable('seazona_api_governor', {
  clientKey: text('client_key').primaryKey(),
  nextEligibleAt: at('next_eligible_at').notNull().default(sql`'epoch'`),
  cooldownUntil: at('cooldown_until').notNull().default(sql`'epoch'`),
  circuitOpenUntil: at('circuit_open_until').notNull().default(sql`'epoch'`),
  circuitOpens: integer('circuit_opens').notNull().default(0),
  haltedReason: text('halted_reason'),
  haltedAt: at('halted_at'),
  // The call guard's stopped resources (../call-guard.js). Seazona's guard
  // halts on any 401 or 403, so this stays empty; the shared guard needs it.
  stoppedResources: jsonb('stopped_resources').notNull().default({}),
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
  resource: text('resource'),
  requestPath: text('request_path'),
  statusCode: integer('status_code'),
  failureKind: text('failure_kind'),
  durationMs: integer('duration_ms'),
  isRetry: boolean('is_retry').notNull().default(false),
}, (t) => [
  index('seazona_api_requests_window').on(t.clientKey, t.admittedAt),
]);

// The mirror. Each row is what Seazona said at the last successful read,
// reduced to what billing needs: no clinical notes, no files, and no patient
// field unless SEAZONA_KEEP_PATIENT_REFERENCE is on. Money is integer cents,
// as Seazona reported it. `list_signature` is a hash of the list fields, so an
// unchanged list row costs no detail read; `record_hash` tells a change apart.
const cents = (name) => bigint(name, { mode: 'number' });
const mirrored = () => ({
  listSignature: text('list_signature'),
  recordHash: text('record_hash').notNull(),
  firstSeenAt: at('first_seen_at').notNull(),
  lastSyncedAt: at('last_synced_at').notNull(),
  lastChangedAt: at('last_changed_at').notNull(),
});

export const seazonaOrders = pgTable('seazona_orders', {
  id: text('id').primaryKey(),
  invoiceNumber: text('invoice_number'),
  clientId: text('client_id'),
  company: text('company'),
  doctorName: text('doctor_name'),
  status: text('status'),
  orderedText: text('ordered_text'),
  dueText: text('due_text'),
  lastModifiedText: text('last_modified_text'),
  department: text('department'),
  lines: jsonb('lines').notNull().default([]),
  subtotalCents: cents('subtotal_cents'),
  patientReference: text('patient_reference'),
  // Issue #12: Seazona answered 404. The row and its history stay; the order
  // reads as "Deleted in Seazona" and is out of billing. A later successful
  // read clears it.
  deletedInSourceAt: at('deleted_in_source_at'),
  ...mirrored(),
}, (t) => [
  index('seazona_orders_invoice_number').on(t.invoiceNumber),
  index('seazona_orders_changed').on(t.lastChangedAt),
]);

export const seazonaInvoices = pgTable('seazona_invoices', {
  invoiceNumber: text('invoice_number').primaryKey(),
  seazonaId: text('seazona_id'),
  clientId: text('client_id'),
  accountNumber: text('account_number'),
  company: text('company'),
  doctorName: text('doctor_name'),
  status: text('status'),
  invoiceDateText: text('invoice_date_text'),
  dueText: text('due_text'),
  lastModifiedText: text('last_modified_text'),
  lines: jsonb('lines').notNull().default([]),
  subtotalCents: cents('subtotal_cents'),
  taxCents: cents('tax_cents'),
  totalCents: cents('total_cents'),
  discountCents: cents('discount_cents'),
  patientReference: text('patient_reference'),
  ...mirrored(),
}, (t) => [
  index('seazona_invoices_changed').on(t.lastChangedAt),
]);

export const seazonaClients = pgTable('seazona_clients', {
  id: text('id').primaryKey(),
  accountNumber: text('account_number'),
  company: text('company'),
  fullName: text('full_name'),
  email: text('email'),
  phone: text('phone'),
  address: jsonb('address'),
  taxRate: text('tax_rate'),
  active: boolean('active'),
  doctors: jsonb('doctors').notNull().default([]),
  lastModifiedText: text('last_modified_text'),
  ...mirrored(),
});

// Products and users: long-lived reference lists, read in full once a day.
export const seazonaReference = pgTable('seazona_reference', {
  resource: text('resource').notNull(),
  id: text('id').notNull(),
  name: text('name'),
  code: text('code'),
  kind: text('kind'),
  priceCents: cents('price_cents'),
  taxable: boolean('taxable'),
  recordHash: text('record_hash').notNull(),
  lastSyncedAt: at('last_synced_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.resource, t.id] }),
]);

// One row per sync lane: its cursor, when it runs next, and its last failure.
export const seazonaLaneState = pgTable('seazona_lane_state', {
  lane: text('lane').primaryKey(),
  status: text('status').notNull().default('idle'),
  cursorTime: at('cursor_time'),
  cursor: jsonb('cursor').notNull().default({}),
  lastSuccessAt: at('last_success_at'),
  lastAttemptAt: at('last_attempt_at'),
  nextRunAt: at('next_run_at'),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  // The order ids and statuses behind the last failure (issue #12). Never
  // patient data.
  failureDetails: jsonb('failure_details'),
  heldReason: text('held_reason'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

// Issue #12: each failed order read, per order. A failed order moves to the
// back of the rotation; after a few failures in a row it is quarantined for a
// bounded time, then gets one more read. A successful read or a 404 clears it.
export const seazonaOrderReadFailures = pgTable('seazona_order_read_failures', {
  orderId: text('order_id').primaryKey(),
  failureCount: integer('failure_count').notNull(),
  lastAttemptAt: at('last_attempt_at').notNull(),
  lastHttpStatus: integer('last_http_status'),
  lastFailureKind: text('last_failure_kind'),
  lastError: text('last_error'),
  quarantinedUntil: at('quarantined_until'),
});

// Issue #101: each failed detail read of an invoice or a client, per record.
// Orders keep their own table (issue #12). After a few failures in a row the
// record is quarantined: the lane skips it and its cursor moves on.
export const seazonaRecordReadFailures = pgTable('seazona_record_read_failures', {
  resource: text('resource').notNull(),
  recordKey: text('record_key').notNull(),
  failureCount: integer('failure_count').notNull(),
  lastAttemptAt: at('last_attempt_at').notNull(),
  lastHttpStatus: integer('last_http_status'),
  lastFailureKind: text('last_failure_kind'),
  quarantinedUntil: at('quarantined_until'),
}, (t) => [
  primaryKey({ columns: [t.resource, t.recordKey] }),
]);
