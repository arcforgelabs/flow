import { sql } from 'drizzle-orm';
import {
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
