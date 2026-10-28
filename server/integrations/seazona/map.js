import { createHash } from 'node:crypto';

// Seazona API records, reduced to what billing needs. Each mapper takes the
// list row and the detail read and returns the mirror row. Notes, files,
// settings and other clinical detail are dropped. The patient field is kept
// only as a reference, and only when the installation asks for it
// (SEAZONA_KEEP_PATIENT_REFERENCE; VISION.md, "Why does Flow keep as little
// patient data as it can?").

export const DELETED_STATUS = 'Deleted in Seazona';

// Statuses after which Seazona does not change an order again. "Complete" is
// not one of them: a lab often moves a complete order to Shipped days or
// months later, and the list API has no lastModified cursor for orders, so a
// complete order stays in the active-order rotation until it ships.
const FINAL_STATUS = /(shipped|delivered|cancelled|canceled|void|closed|archived|deleted)/i;

export function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function textOrNull(value) {
  return text(value) || null;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Seazona reports dollars as decimals; Flow keeps integer cents.
export function toCents(value) {
  const amount = number(value);
  return amount === null ? null : Math.round(amount * 100);
}

export function stableSerialize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashOf(value) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export function isFinalStatus(status) {
  return FINAL_STATUS.test(text(status));
}

export function isCompleteStatus(status) {
  return /\bcomplete(?:d)?\b/i.test(text(status));
}

export function isShippedStatus(status) {
  return /\b(shipped|delivered)\b/i.test(text(status));
}

// What a person sees for an order: its Seazona status, or "Deleted in
// Seazona" once Seazona answered 404 for it.
export function orderStatusLabel(row) {
  return row?.deletedInSourceAt ? DELETED_STATUS : text(row?.status);
}

// The practice an order is for: its client's company, else the order's own
// company, else the client's name. Never the patient.
export function orderClientName(order, client = null) {
  return (client?.company || order?.company || client?.fullName || '').trim() || null;
}

// Seazona dates come as ISO text or as day/month/year (Australian order),
// with an optional time. Returns the calendar date (yyyy-mm-dd) or null.
export function parseSeazonaDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString().slice(0, 10);
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

function mapLine(item = {}, { discount = false } = {}) {
  const amountCents = toCents(item.price ?? item.amount);
  const line = {
    itemId: textOrNull(item.id),
    kind: discount ? 'discount' : (text(item.type) || 'product'),
    description: text(item.name || item.description),
    code: textOrNull(item.code),
    amountCents: discount && amountCents !== null ? -Math.abs(amountCents) : amountCents,
  };
  if (typeof item.taxable === 'boolean') line.taxable = item.taxable;
  if (item.tooth !== undefined && item.tooth !== null && text(item.tooth)) line.tooth = text(item.tooth);
  return line;
}

const sumCents = (lines) => lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0);

// The list fields that tell an order changed. Equal signatures mean the
// detail read can be skipped. The patient field is left out, so not even a
// hash of it is stored.
export function orderListSignature(item = {}) {
  return hashOf({
    id: text(item.id),
    invoiceNumber: text(item.invoiceNumber),
    company: text(item.company),
    doctor: text(item.clientName),
    status: text(item.status),
    department: text(item.department),
    ordered: text(item.ordered),
    due: text(item.due),
  });
}

export function mapOrder(listItem = {}, detail = null, { keepPatientReference = false } = {}) {
  const merged = { ...listItem, ...(detail || {}) };
  const lines = Array.isArray(merged.products)
    ? merged.products.map((item) => mapLine(item)).filter((line) => line.description)
    : [];
  return {
    id: text(merged.id),
    invoiceNumber: textOrNull(merged.invoiceNumber),
    clientId: textOrNull(merged.clientId),
    company: textOrNull(merged.company),
    doctorName: textOrNull(merged.clientName),
    status: textOrNull(merged.status),
    orderedText: textOrNull(merged.ordered),
    dueText: textOrNull(merged.due),
    lastModifiedText: textOrNull(merged.lastModified),
    department: textOrNull(merged.department),
    lines,
    subtotalCents: lines.length ? sumCents(lines) : null,
    patientReference: keepPatientReference ? textOrNull(merged.patient) : null,
  };
}

export function invoiceListSignature(item = {}) {
  return hashOf({
    id: text(item.id),
    invoiceNumber: text(item.invoiceNumber),
    clientId: text(item.clientId),
    status: text(item.status),
    due: text(item.due),
    lastModified: text(item.lastModified),
    subtotal: number(item.subtotal ?? item.sales),
    tax: number(item.tax),
    total: number(item.total),
  });
}

export function mapInvoice(listItem = {}, detail = null, { keepPatientReference = false } = {}) {
  const merged = { ...listItem, ...(detail || {}) };
  const products = Array.isArray(merged.productServiceItems) ? merged.productServiceItems.map((item) => mapLine(item)) : [];
  const discounts = Array.isArray(merged.discountItems) ? merged.discountItems.map((item) => mapLine(item, { discount: true })) : [];
  const lines = [...products, ...discounts].filter((line) => line.description);
  return {
    invoiceNumber: text(merged.invoiceNumber),
    seazonaId: textOrNull(merged.id),
    clientId: textOrNull(merged.clientId),
    accountNumber: textOrNull(merged.accountNumber),
    company: textOrNull(merged.company),
    doctorName: textOrNull(merged.fullName),
    status: textOrNull(merged.status),
    invoiceDateText: textOrNull(merged.invoiceDate || merged.created),
    dueText: textOrNull(merged.due),
    lastModifiedText: textOrNull(merged.lastModified),
    lines,
    subtotalCents: toCents(merged.subtotal ?? merged.sales),
    taxCents: toCents(merged.tax),
    totalCents: toCents(merged.total),
    discountCents: toCents(merged.discounts),
    patientReference: keepPatientReference ? textOrNull(merged.patient) : null,
  };
}

export function clientListSignature(item = {}) {
  return hashOf({
    id: text(item.id),
    accountNumber: text(item.accountNumber),
    company: text(item.company),
    fullName: text(item.fullName),
    email: text(item.email || item.emailAddresses),
    phone: text(item.phone1 || item.phone),
    lastModified: text(item.lastModified),
    discontinued: Boolean(item.discontinued),
  });
}

export function mapClient(listItem = {}, detail = null) {
  const merged = { ...listItem, ...(detail || {}) };
  const address = {};
  for (const field of ['address1', 'address2', 'city', 'region', 'postalCode', 'countryCode']) {
    if (text(merged[field])) address[field] = text(merged[field]);
  }
  return {
    id: text(merged.id),
    accountNumber: textOrNull(merged.accountNumber),
    company: textOrNull(merged.company),
    fullName: textOrNull(merged.fullName),
    email: textOrNull(merged.email || merged.emailAddresses),
    phone: textOrNull(merged.phone1 || merged.phone),
    address: Object.keys(address).length ? address : null,
    taxRate: number(merged.taxRate) === null ? null : String(number(merged.taxRate)),
    active: merged.discontinued === undefined ? null : !merged.discontinued,
    // Who at the practice the work is for: an id and a name, nothing more.
    doctors: Array.isArray(merged.doctors)
      ? merged.doctors.map((doctor) => ({ id: text(doctor?.id), fullName: text(doctor?.fullName) })).filter((doctor) => doctor.id)
      : [],
    lastModifiedText: textOrNull(merged.lastModified),
  };
}

export function mapReference(resource, item = {}) {
  const name = text(item.name || item.fullName || [item.firstName, item.lastName].map(text).filter(Boolean).join(' '));
  return {
    resource,
    id: text(item.id),
    name: name || null,
    code: resource === 'products' ? textOrNull(item.code) : null,
    kind: resource === 'products' ? textOrNull(item.type) : null,
    priceCents: resource === 'products' ? toCents(item.price ?? item.amount) : null,
    taxable: resource === 'products' && typeof item.taxable === 'boolean' ? item.taxable : null,
  };
}
