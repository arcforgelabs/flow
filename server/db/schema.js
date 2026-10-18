import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Every table except `organisations` carries `organisation_id`. Child rows
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
// sign-in; until then the row is an invitation.
export const people = pgTable('people', {
  id: id(),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').notNull(),
  status: text('status').notNull().default('active'),
  clerkUserId: text('clerk_user_id'),
  invitedBy: uuid('invited_by').references(() => people.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }),
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
