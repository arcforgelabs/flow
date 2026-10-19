import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Every table except `organisations` and the installation-wide tables (people,
// integration settings) carries `organisation_id`. Child rows
// point at their parent through (organisation_id, id), so the database itself
// refuses a row that joins two organisations. Money is integer cents.

const id = () => uuid('id').primaryKey().defaultRandom();
const organisationId = () => uuid('organisation_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const TAX_CODES = ['GST', 'GST_FREE'];
export const CONTACT_KINDS = ['customer', 'supplier'];
export const INVOICE_STATUSES = ['draft', 'issued', 'void'];

export const organisations = pgTable('organisations', {
  id: id(),
  name: text('name').notNull(),
  invoicePrefix: text('invoice_prefix').notNull().default('INV-'),
  nextInvoiceNumber: integer('next_invoice_number').notNull().default(1),
  createdAt: createdAt(),
}, (t) => [
  check('organisations_next_invoice_number_positive', sql`${t.nextInvoiceNumber} > 0`),
]);

export const contacts = pgTable('contacts', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  createdAt: createdAt(),
}, (t) => [
  unique('contacts_org_id').on(t.organisationId, t.id),
  unique('contacts_org_kind_name').on(t.organisationId, t.kind, t.name),
  check('contacts_kind_valid', sql`${t.kind} in ('customer', 'supplier')`),
]);

export const priceItems = pgTable('price_items', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  unitAmountCents: integer('unit_amount_cents').notNull(),
  taxCode: text('tax_code').notNull().default('GST'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  unique('price_items_org_id').on(t.organisationId, t.id),
  unique('price_items_org_code').on(t.organisationId, t.code),
  check('price_items_tax_code_valid', sql`${t.taxCode} in ('GST', 'GST_FREE')`),
]);

export const invoices = pgTable('invoices', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  contactId: uuid('contact_id').notNull(),
  // Assigned when the invoice is first issued; kept by every later version.
  number: text('number'),
  status: text('status').notNull().default('draft'),
  // The last version a customer was sent; 0 while the invoice was never issued.
  issuedVersion: integer('issued_version').notNull().default(0),
  reference: text('reference'),
  currency: text('currency').notNull().default('AUD'),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  subtotalCents: integer('subtotal_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  // Sending to the accounting system (server/core/sending.js): queued by a
  // person, then sent or failed. `sendError` is { code, message } while failed.
  sendState: text('send_state'),
  sendError: jsonb('send_error'),
  sendRequestedBy: uuid('send_requested_by').references(() => people.id, { onDelete: 'set null' }),
  sendUpdatedAt: timestamp('send_updated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('invoices_org_id').on(t.organisationId, t.id),
  unique('invoices_org_number').on(t.organisationId, t.number),
  foreignKey({
    name: 'invoices_contact_same_org',
    columns: [t.organisationId, t.contactId],
    foreignColumns: [contacts.organisationId, contacts.id],
  }),
  check('invoices_status_valid', sql`${t.status} in ('draft', 'issued', 'void')`),
  check('invoices_issued_has_number', sql`${t.status} = 'draft' or ${t.number} is not null`),
  check('invoices_send_state_valid', sql`${t.sendState} is null or ${t.sendState} in ('queued', 'sent', 'failed')`),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  organisationId: organisationId(),
  invoiceId: uuid('invoice_id').notNull(),
  position: integer('position').notNull(),
  priceItemId: uuid('price_item_id'),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unitAmountCents: integer('unit_amount_cents').notNull(),
  taxCode: text('tax_code').notNull(),
  lineAmountCents: integer('line_amount_cents').notNull(),
  taxCents: integer('tax_cents').notNull(),
}, (t) => [
  unique('invoice_lines_invoice_position').on(t.invoiceId, t.position),
  foreignKey({
    name: 'invoice_lines_invoice_same_org',
    columns: [t.organisationId, t.invoiceId],
    foreignColumns: [invoices.organisationId, invoices.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'invoice_lines_price_item_same_org',
    columns: [t.organisationId, t.priceItemId],
    foreignColumns: [priceItems.organisationId, priceItems.id],
  }),
  check('invoice_lines_quantity_positive', sql`${t.quantity} > 0`),
  check('invoice_lines_tax_code_valid', sql`${t.taxCode} in ('GST', 'GST_FREE')`),
]);

// What the customer was sent, exactly. Rows are append-only: a trigger in
// the migrations refuses UPDATE and DELETE.
export const invoiceVersions = pgTable('invoice_versions', {
  id: id(),
  organisationId: organisationId(),
  invoiceId: uuid('invoice_id').notNull(),
  version: integer('version').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  issuedBy: text('issued_by').notNull(),
  document: jsonb('document').notNull(),
}, (t) => [
  unique('invoice_versions_invoice_version').on(t.invoiceId, t.version),
  foreignKey({
    name: 'invoice_versions_invoice_same_org',
    columns: [t.organisationId, t.invoiceId],
    foreignColumns: [invoices.organisationId, invoices.id],
  }),
  check('invoice_versions_version_positive', sql`${t.version} > 0`),
]);

export const PERSON_ROLES = ['owner', 'admin', 'staff'];
export const PERSON_STATUSES = ['active', 'pending', 'disabled'];

// Who may sign in to this installation, and with which role. Clerk proves who
// someone is; this table decides what they may do. One installation serves one
// lab, so people are installation-wide and carry no organisation_id. Emails
// are stored lower-case. `clerk_user_id` is set on the person's first verified
// sign-in; until then the row is an invitation. `appearance` is the person's
// own design system, light or dark and accent (server/auth/people.js,
// normaliseAppearance); null until they first choose.
export const people = pgTable('people', {
  id: id(),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').notNull(),
  status: text('status').notNull().default('active'),
  clerkUserId: text('clerk_user_id'),
  invitedBy: uuid('invited_by').references(() => people.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }),
  appearance: jsonb('appearance'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('people_email').on(t.email),
  unique('people_clerk_user_id').on(t.clerkUserId),
  check('people_email_lower', sql`${t.email} = lower(${t.email})`),
  check('people_role_valid', sql`${t.role} in ('owner', 'admin', 'staff')`),
  check('people_status_valid', sql`${t.status} in ('active', 'pending', 'disabled')`),
]);

// Billing obligations (issue 3). One billable job in a work system gives one
// obligation. The obligation keeps the evidence for its state: what the work
// system reported, what the accounting system reported, each payment, and each
// status write-back to the work system. Flow is not the source of truth for
// accounting; the ledger is its audit and workflow memory over what the
// integrations report.

export const ACCOUNTING_STATES = [
  'unknown', 'not_found', 'drafted', 'authorised', 'part_paid', 'paid',
  'voided', 'deleted', 'ambiguous', 'conflict',
];
export const HOLD_STATES = ['none', 'held', 'review'];
export const WRITEBACK_STATES = ['pending', 'sent', 'failed', 'not_supported'];

const inList = (column, values) => sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

export const billingObligations = pgTable('billing_obligations', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  // The job's identity in the work system, for example `seazona` and its job id.
  sourceSystem: text('source_system').notNull(),
  sourceJobRef: text('source_job_ref').notNull(),
  // The work system's own invoice identity for the job, when it has one.
  sourceInvoiceRef: text('source_invoice_ref'),
  // A case number only. Never patient data.
  caseRef: text('case_ref'),
  contactId: uuid('contact_id'),
  practitioner: text('practitioner'),
  shippedOn: date('shipped_on'),
  // The day of the work, for matching it to an accounting invoice: the work
  // system's invoice date, else its due date, else its order date.
  jobDate: date('job_date'),
  // The work system's status for the job, as it reported it (for example
  // "Shipped"). The draft rules read it.
  sourceStatus: text('source_status'),
  // Flow's own stage: the job is ready to invoice, since when and by whom (a
  // person, or an automation such as one that reads the work system status).
  readyAt: timestamp('ready_at', { withTimezone: true }),
  readyBy: text('ready_by'),
  // The lines as the work system reported them, normalised.
  lines: jsonb('lines').notNull().default(sql`'[]'::jsonb`),
  lineFingerprint: text('line_fingerprint').notNull(),
  subtotalCents: integer('subtotal_cents').notNull(),
  taxCents: integer('tax_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  // Every line maps to a price item.
  mappingComplete: boolean('mapping_complete').notNull(),
  sourceSeenAt: timestamp('source_seen_at', { withTimezone: true }).notNull(),
  holdState: text('hold_state').notNull().default('none'),
  holdReason: text('hold_reason'),
  // The Flow invoice made for this job.
  invoiceId: uuid('invoice_id'),
  // What the accounting system reported, how it matched, and when Flow checked.
  accountingState: text('accounting_state').notNull().default('unknown'),
  accountingRef: text('accounting_ref'),
  accountingUrl: text('accounting_url'),
  accountingMatchedBy: text('accounting_matched_by'),
  accountingCheckedAt: timestamp('accounting_checked_at', { withTimezone: true }),
  paidCents: integer('paid_cents').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('billing_obligations_org_id').on(t.organisationId, t.id),
  unique('billing_obligations_source_job').on(t.organisationId, t.sourceSystem, t.sourceJobRef),
  unique('billing_obligations_invoice').on(t.organisationId, t.invoiceId),
  foreignKey({
    name: 'billing_obligations_contact_same_org',
    columns: [t.organisationId, t.contactId],
    foreignColumns: [contacts.organisationId, contacts.id],
  }),
  foreignKey({
    name: 'billing_obligations_invoice_same_org',
    columns: [t.organisationId, t.invoiceId],
    foreignColumns: [invoices.organisationId, invoices.id],
  }),
  check('billing_obligations_hold_state_valid', inList('hold_state', HOLD_STATES)),
  check('billing_obligations_accounting_state_valid', inList('accounting_state', ACCOUNTING_STATES)),
  check('billing_obligations_paid_not_negative', sql`${t.paidCents} >= 0`),
]);

// Why each obligation is in its state. Append-only: a trigger in the
// migrations refuses UPDATE and DELETE.
export const obligationEvents = pgTable('obligation_events', {
  id: id(),
  organisationId: organisationId(),
  obligationId: uuid('obligation_id').notNull(),
  kind: text('kind').notNull(),
  actor: text('actor').notNull(),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({
    name: 'obligation_events_obligation_same_org',
    columns: [t.organisationId, t.obligationId],
    foreignColumns: [billingObligations.organisationId, billingObligations.id],
  }),
]);

// Each payment the accounting system reported against the job's invoice.
export const obligationPayments = pgTable('obligation_payments', {
  id: id(),
  organisationId: organisationId(),
  obligationId: uuid('obligation_id').notNull(),
  paymentRef: text('payment_ref').notNull(),
  paidOn: date('paid_on').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reference: text('reference'),
  reconciled: boolean('reconciled').notNull(),
  accountingUrl: text('accounting_url'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('obligation_payments_ref').on(t.organisationId, t.obligationId, t.paymentRef),
  foreignKey({
    name: 'obligation_payments_obligation_same_org',
    columns: [t.organisationId, t.obligationId],
    foreignColumns: [billingObligations.organisationId, billingObligations.id],
  }),
  check('obligation_payments_amount_positive', sql`${t.amountCents} > 0`),
]);

// Status sent back to the work system (for example "paid"), with the evidence
// sent. A failed write-back stays here and is tried again; it never changes the
// accounting record.
export const obligationWritebacks = pgTable('obligation_writebacks', {
  id: id(),
  organisationId: organisationId(),
  obligationId: uuid('obligation_id').notNull(),
  targetSystem: text('target_system').notNull(),
  status: text('status').notNull(),
  state: text('state').notNull().default('pending'),
  evidence: jsonb('evidence').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('obligation_writebacks_status').on(t.organisationId, t.obligationId, t.status),
  foreignKey({
    name: 'obligation_writebacks_obligation_same_org',
    columns: [t.organisationId, t.obligationId],
    foreignColumns: [billingObligations.organisationId, billingObligations.id],
  }),
  check('obligation_writebacks_state_valid', inList('state', WRITEBACK_STATES)),
]);

// The data spine (docs/DATA_SPINE.md, issue 56): the tables every integration
// shares. Each row changes state; the spine never deletes one.

// Identity map (issue 57). Which external record is each Flow record. At most
// one active link per external record and per Flow record, in each system. A
// link that is not exact stays `proposed` until a person confirms it.
export const LINK_ENTITIES = ['contact', 'price_item', 'obligation', 'invoice', 'payment', 'credit_note'];
// `exact_name`: the same name, after spacing and case are evened out, held by
// exactly one record on each side.
export const LINK_MATCHES = ['created_by_flow', 'exact_id', 'exact_name', 'imported', 'name', 'person'];
export const LINK_STATES = ['active', 'proposed', 'superseded'];

export const externalLinks = pgTable('external_links', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  entity: text('entity').notNull(),
  flowId: uuid('flow_id').notNull(),
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  matchedBy: text('matched_by').notNull(),
  state: text('state').notNull(),
  confirmedBy: uuid('confirmed_by').references(() => people.id, { onDelete: 'set null' }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('external_links_org_id').on(t.organisationId, t.id),
  uniqueIndex('external_links_active_external')
    .on(t.organisationId, t.system, t.entity, t.externalId).where(sql`state = 'active'`),
  uniqueIndex('external_links_active_flow')
    .on(t.organisationId, t.system, t.entity, t.flowId).where(sql`state = 'active'`),
  index('external_links_flow').on(t.organisationId, t.entity, t.flowId),
  check('external_links_entity_valid', inList('entity', LINK_ENTITIES)),
  check('external_links_matched_by_valid', inList('matched_by', LINK_MATCHES)),
  check('external_links_state_valid', inList('state', LINK_STATES)),
  check('external_links_name_needs_person', sql`${t.matchedBy} <> 'name' or ${t.state} <> 'active' or ${t.confirmedAt} is not null`),
]);

// Links between a work system's job and an accounting record, carried over
// from an earlier installation (server/import/at-start.js). They wait here
// until the job becomes an obligation; then they are evidence for its link.
// `person` means a person made the link there; `imported` means the earlier
// app matched it by itself.
export const PRIOR_LINK_MATCHES = ['person', 'imported'];

export const priorLinks = pgTable('prior_links', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  sourceSystem: text('source_system').notNull(),
  sourceJobRef: text('source_job_ref').notNull(),
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  externalNumber: text('external_number'),
  matchedBy: text('matched_by').notNull(),
  matchedAt: timestamp('matched_at', { withTimezone: true }),
  origin: text('origin').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('prior_links_job').on(t.organisationId, t.sourceSystem, t.sourceJobRef, t.system),
  index('prior_links_external').on(t.organisationId, t.system, t.externalId),
  check('prior_links_matched_by_valid', inList('matched_by', PRIOR_LINK_MATCHES)),
]);

// Background job queue (issue 6). Workers claim with FOR UPDATE SKIP LOCKED and
// hold a lease; a lease that runs out makes the job claimable again. One queued
// or running job per (organisation, kind, dedupe key).
export const BACKGROUND_JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead'];

export const backgroundJobs = pgTable('background_jobs', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull().default(''),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  state: text('state').notNull().default('queued'),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(8),
  lockedBy: text('locked_by'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  result: jsonb('result'),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('background_jobs_one_open')
    .on(t.organisationId, t.kind, t.dedupeKey).where(sql`state in ('queued', 'running')`),
  index('background_jobs_due').on(t.state, t.runAfter),
  check('background_jobs_state_valid', inList('state', BACKGROUND_JOB_STATES)),
  check('background_jobs_attempts_valid', sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
]);

// Outbox. Every write to another system is a row here before the call
// leaves, written in the same transaction as the Flow change it reports. The
// idempotency key is unique, so a retry never makes a second record.
export const OUTBOX_STATES = ['pending', 'sending', 'ambiguous', 'sent', 'failed', 'cancelled'];

export const outbox = pgTable('outbox', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  system: text('system').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  flowId: uuid('flow_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  request: jsonb('request').notNull(),
  state: text('state').notNull().default('pending'),
  externalId: text('external_id'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdBy: text('created_by').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('outbox_org_id').on(t.organisationId, t.id),
  unique('outbox_idempotency_key').on(t.idempotencyKey),
  index('outbox_pending').on(t.system, t.state, t.createdAt),
  check('outbox_state_valid', inList('state', OUTBOX_STATES)),
  check('outbox_sent_has_id', sql`${t.state} <> 'sent' or ${t.externalId} is not null`),
]);

// Review queue (issue 59). One list of everything a person must decide. One
// open item per (organisation, kind, entity, Flow id); a repeat finding
// updates its evidence.
export const REVIEW_STATES = ['open', 'resolved', 'dismissed'];

export const reviewItems = pgTable('review_items', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  kind: text('kind').notNull(),
  entity: text('entity').notNull(),
  flowId: uuid('flow_id').notNull(),
  systems: text('systems').array().notNull().default(sql`'{}'::text[]`),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  moneyAtRiskCents: bigint('money_at_risk_cents', { mode: 'number' }).notNull().default(0),
  state: text('state').notNull().default('open'),
  seenCount: integer('seen_count').notNull().default(1),
  resolution: text('resolution'),
  note: text('note'),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('review_items_org_id').on(t.organisationId, t.id),
  uniqueIndex('review_items_one_open')
    .on(t.organisationId, t.kind, t.entity, t.flowId).where(sql`state = 'open'`),
  index('review_items_queue').on(t.organisationId, t.state, t.moneyAtRiskCents),
  check('review_items_state_valid', inList('state', REVIEW_STATES)),
  check('review_items_money_not_negative', sql`${t.moneyAtRiskCents} >= 0`),
  check('review_items_closed_has_resolution', sql`${t.state} = 'open' or (${t.resolution} is not null and ${t.resolvedBy} is not null and ${t.resolvedAt} is not null)`),
]);

// Integration settings an owner enters in Settings (server/integrations/setup.js).
// One row per adapter for the installation. `config` holds plain settings by
// their environment name; `secrets` holds credentials sealed with Flow's
// secrets key (server/core/secrets.js), never in clear. A host's own
// environment setting wins over a value here.
export const integrationSettings = pgTable('integration_settings', {
  adapterId: text('adapter_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
  secrets: jsonb('secrets').notNull().default(sql`'{}'::jsonb`),
  updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Who changed which integration setting, and when. Names only, never a value.
export const INTEGRATION_SETTING_EVENTS = ['turned_on', 'turned_off', 'setting_changed', 'secret_set', 'secret_removed'];

export const integrationSettingEvents = pgTable('integration_setting_events', {
  id: id(),
  adapterId: text('adapter_id').notNull(),
  kind: text('kind').notNull(),
  settings: text('settings').array().notNull().default(sql`'{}'::text[]`),
  actor: uuid('actor').references(() => people.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [
  index('integration_setting_events_adapter').on(t.adapterId, t.createdAt),
  check('integration_setting_events_kind_valid', inList('kind', INTEGRATION_SETTING_EVENTS)),
]);

// The pipeline (server/core/pipeline.js, issue 58). Where each step that reads
// another system's records stands, by name, so a restart goes on from there.
export const pipelineCursors = pgTable('pipeline_cursors', {
  organisationId: organisationId().references(() => organisations.id),
  name: text('name').notNull(),
  cursor: text('cursor'),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ name: 'pipeline_cursors_pk', columns: [t.organisationId, t.name] }),
]);

// The matcher's suggestions: accounting invoices that could bill a job, with
// the signals that agreed. Only exact evidence links a job by itself; a
// suggestion waits for a person. A newer run marks the ones it no longer
// makes `stale`.
export const LINK_SUGGESTION_STATES = ['open', 'accepted', 'rejected', 'stale'];

export const linkSuggestions = pgTable('link_suggestions', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  obligationId: uuid('obligation_id').notNull(),
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  externalNumber: text('external_number'),
  score: integer('score').notNull(),
  rank: integer('rank').notNull(),
  signals: jsonb('signals').notNull().default(sql`'[]'::jsonb`),
  state: text('state').notNull().default('open'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('link_suggestions_pair').on(t.organisationId, t.obligationId, t.system, t.externalId),
  index('link_suggestions_open').on(t.organisationId, t.state, t.obligationId),
  foreignKey({
    name: 'link_suggestions_obligation_same_org',
    columns: [t.organisationId, t.obligationId],
    foreignColumns: [billingObligations.organisationId, billingObligations.id],
  }),
  check('link_suggestions_state_valid', inList('state', LINK_SUGGESTION_STATES)),
]);

// A person's "not this one": the matcher never suggests the pair again.
export const linkRejections = pgTable('link_rejections', {
  organisationId: organisationId().references(() => organisations.id),
  obligationId: uuid('obligation_id').notNull(),
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  actor: text('actor').notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ name: 'link_rejections_pk', columns: [t.organisationId, t.obligationId, t.system, t.externalId] }),
  foreignKey({
    name: 'link_rejections_obligation_same_org',
    columns: [t.organisationId, t.obligationId],
    foreignColumns: [billingObligations.organisationId, billingObligations.id],
  }),
]);

// Invoicing rules (server/core/invoicing-rules.js). One row for each
// organisation: the checks a job passes before Flow drafts its invoice, and
// how a checked draft goes to the accounting system. No row means the
// defaults. When Flow drafts is an automation (`automations`).
export const SEND_MODES = ['accounting_draft', 'approve_and_email'];

export const invoicingSettings = pgTable('invoicing_settings', {
  organisationId: uuid('organisation_id').primaryKey().references(() => organisations.id),
  // accounting_draft: a person checks the draft in Flow, Flow sends it as an
  // accounting draft, and a person approves and sends it there.
  // approve_and_email: a person approves the draft in Flow, Flow sends it
  // approved, and the accounting system emails it to the customer.
  sendMode: text('send_mode').notNull().default('accounting_draft'),
  // A job whose date is more than this many days ago waits for a person.
  staleDays: integer('stale_days').notNull().default(90),
  // The days from the invoice date to its due date.
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  // A job needs a practitioner, its own or its customer's default one.
  requirePractitioner: boolean('require_practitioner').notNull().default(false),
  // The price item code of a rush charge, and its share of the other lines.
  rushItemCode: text('rush_item_code'),
  rushPercent: integer('rush_percent').notNull().default(20),
  // The fixed checks above became invoice rules (invoice_rules). True once
  // this organisation's starter rules were made from them.
  rulesSeeded: boolean('rules_seeded').notNull().default(false),
  updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
}, (t) => [
  check('invoicing_settings_send_mode_valid', inList('send_mode', SEND_MODES)),
  check('invoicing_settings_stale_days_valid', sql`${t.staleDays} between 1 and 3650`),
  check('invoicing_settings_terms_valid', sql`${t.paymentTermsDays} between 0 and 365`),
  check('invoicing_settings_rush_valid', sql`${t.rushPercent} between 0 and 100`),
]);

// One customer's own invoicing settings. A null value takes the
// organisation's setting.
export const customerBillingSettings = pgTable('customer_billing_settings', {
  organisationId: organisationId().references(() => organisations.id),
  contactId: uuid('contact_id').notNull(),
  // A customer that is not billable never gets an invoice from a rule, and
  // `autoDraft` false keeps the draft automation off for this customer.
  billable: boolean('billable').notNull().default(true),
  defaultPractitioner: text('default_practitioner'),
  autoDraft: boolean('auto_draft'),
  sendMode: text('send_mode'),
  paymentTermsDays: integer('payment_terms_days'),
  updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ name: 'customer_billing_settings_pk', columns: [t.organisationId, t.contactId] }),
  foreignKey({
    name: 'customer_billing_settings_contact_same_org',
    columns: [t.organisationId, t.contactId],
    foreignColumns: [contacts.organisationId, contacts.id],
  }),
  check('customer_billing_settings_send_mode_valid', sql`${t.sendMode} is null or ${t.sendMode} in ('accounting_draft', 'approve_and_email')`),
  check('customer_billing_settings_terms_valid', sql`${t.paymentTermsDays} is null or ${t.paymentTermsDays} between 0 and 365`),
]);

// Invoice rules (server/core/invoice-rules.js, docs/INVOICE_RULES.md): a lab's
// own checks on a job before Flow drafts its invoice. Each rule is When, If and
// Then: `conditions` is a list of { field, test, value, item? } that must all
// match, and `action` is { kind: 'wait' | 'skip' }. `starter_key` marks a rule
// Flow made from the earlier fixed settings, once per organisation.
export const invoiceRules = pgTable('invoice_rules', {
  id: id(),
  organisationId: organisationId().references(() => organisations.id),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  trigger: text('trigger').notNull().default('job_ready'),
  conditions: jsonb('conditions').notNull().default(sql`'[]'::jsonb`),
  action: jsonb('action').notNull(),
  starterKey: text('starter_key'),
  updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('invoice_rules_starter_key').on(t.organisationId, t.starterKey),
  check('invoice_rules_trigger_valid', sql`${t.trigger} in ('job_ready')`),
  check('invoice_rules_name_valid', sql`length(${t.name}) between 1 and 120`),
]);

// Automations (server/core/automations.js): Flow's routines, each on or off,
// with its own settings. The routines are defined in code; a row holds an
// organisation's choice. No row means the routine's default.
export const automations = pgTable('automations', {
  organisationId: organisationId().references(() => organisations.id),
  key: text('key').notNull(),
  enabled: boolean('enabled').notNull(),
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
  updatedBy: uuid('updated_by').references(() => people.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ name: 'automations_pk', columns: [t.organisationId, t.key] }),
]);
