import { hashOf, parseSeazonaDate, text } from '../map.js';

// Seazona's CSV export, read into Flow fields and grouped into jobs. Pure: no
// database and no network. docs/SEAZONA.md, "History import", lists the
// headers Flow knows.

// Flow field -> the headers Seazona's export may use for it. Headers compare
// without case, spaces or punctuation, so "Invoice #" and "invoice no" match.
// "Client Name" is left out on purpose: in Seazona it can mean the doctor or
// the practice, so a person maps it with `columns` when the file has it.
export const INVOICE_LINE_COLUMNS = Object.freeze({
  invoiceNumber: ['invoice', 'invoice #', 'invoice number', 'invoice no', 'inv #', 'inv no'],
  caseRef: ['case', 'case #', 'case number', 'case no', 'case id', 'order', 'order #', 'order number', 'order no', 'order id'],
  jobDate: ['invoice date', 'date', 'date invoiced', 'invoiced'],
  dueDate: ['due date', 'due'],
  shippedDate: ['ship date', 'shipped', 'shipped date', 'date shipped'],
  company: ['company name', 'company', 'practice', 'practice name', 'account name'],
  accountNumber: ['account #', 'account number', 'account no'],
  doctorName: ['doctor name', 'doctor', 'dentist', 'practitioner'],
  patient: ['patient', 'patient name'],
  status: ['status', 'case status'],
  item: ['item', 'product', 'description', 'item description', 'product name', 'service'],
  itemCode: ['item code', 'code', 'product code'],
  quantity: ['qty', 'quantity', 'units'],
  itemAmount: ['item amount', 'amount', 'line amount', 'line total', 'price'],
  itemTaxable: ['item taxable', 'taxable'],
  total: ['total', 'invoice total'],
  tooth: ['tooth', 'teeth', 'tooth #'],
});

// A file is read only when it has these, and at least one date.
const REQUIRED = ['company', 'item', 'itemAmount'];
const DATES = ['jobDate', 'dueDate', 'shippedDate'];

const squash = (header) => text(header).toLowerCase().replace(/[^a-z0-9#]/g, '').replace(/#/g, 'number');

// Answers { columns: field -> header, ignored: [header], missing: [field] }.
// `override` (field -> header) wins over the guess; a null value unmaps it.
export function detectColumns(headers, override = {}) {
  const byKey = new Map(headers.map((h) => [squash(h), h]));
  const columns = {};
  for (const [field, aliases] of Object.entries(INVOICE_LINE_COLUMNS)) {
    const found = aliases.map((alias) => byKey.get(squash(alias))).find(Boolean);
    if (found) columns[field] = found;
  }
  for (const [field, header] of Object.entries(override ?? {})) {
    if (!(field in INVOICE_LINE_COLUMNS)) throw Object.assign(new Error(`Unknown field ${field}`), { code: 'invalid' });
    if (header === null) delete columns[field];
    else if (headers.includes(header)) columns[field] = header;
    else throw Object.assign(new Error(`The file has no column "${header}"`), { code: 'invalid' });
  }
  const used = new Set(Object.values(columns));
  const missing = REQUIRED.filter((field) => !columns[field]);
  if (!DATES.some((field) => columns[field])) missing.push('date');
  return { columns, ignored: headers.filter((h) => h && !used.has(h)), missing };
}

// "$1,234.50", "1234.5", "(12.00)" and "-12" to integer cents.
export function moneyCents(value) {
  const raw = text(value);
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const digits = raw.replace(/[()$,\s-]/g, '').replace(/^[A-Z]{3}/i, '');
  if (!/^\d*(\.\d+)?$/.test(digits) || digits === '' || digits === '.') return undefined;
  const cents = Math.round(Number(digits) * 100);
  return negative ? -cents : cents;
}

function yesNo(value) {
  const raw = text(value).toLowerCase();
  if (['y', 'yes', 'true', '1', 'taxable', 'gst'].includes(raw)) return true;
  if (['n', 'no', 'false', '0', 'exempt', 'gst free', 'none'].includes(raw)) return false;
  return null;
}

// One CSV row to Flow fields and the problems that stop it. The patient field
// is read for grouping; the caller drops it unless the installation keeps a
// patient reference.
export function readRow(cells, headers, columns) {
  const cell = (field) => {
    const header = columns[field];
    if (!header) return '';
    return text(cells[headers.indexOf(header)]);
  };
  const problems = [];
  const fields = {
    invoiceNumber: cell('invoiceNumber') || null,
    caseRef: cell('caseRef') || null,
    company: cell('company') || null,
    accountNumber: cell('accountNumber') || null,
    doctorName: cell('doctorName') || null,
    patient: cell('patient') || null,
    status: cell('status') || null,
    item: cell('item') || null,
    itemCode: cell('itemCode') || null,
    tooth: cell('tooth') || null,
  };
  for (const field of DATES) {
    const raw = cell(field);
    fields[field] = raw ? parseSeazonaDate(raw) : null;
    if (raw && !fields[field]) problems.push(`bad_${field}`);
  }
  if (!DATES.some((field) => fields[field])) problems.push('missing_date');
  if (!fields.company) problems.push('missing_company');
  if (!fields.item) problems.push('missing_item');
  const amount = moneyCents(cell('itemAmount'));
  if (amount === undefined || amount === null) problems.push(amount === null ? 'missing_amount' : 'bad_amount');
  fields.itemAmountCents = typeof amount === 'number' ? amount : null;
  const total = moneyCents(cell('total'));
  if (total === undefined) problems.push('bad_total');
  fields.totalCents = typeof total === 'number' ? total : null;
  const quantity = cell('quantity');
  fields.quantity = quantity && Number.isFinite(Number(quantity)) ? Number(quantity) : null;
  fields.itemTaxable = columns.itemTaxable ? yesNo(cell('itemTaxable')) : null;
  return { fields, problems };
}

const sameText = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

// Where a row's job is found: its invoice number, else its case number, else
// the old app's grouping (date, practice, doctor and patient). The patient
// only separates jobs inside this file; it is never part of the stored key.
function groupOf(fields) {
  if (fields.invoiceNumber) return `inv:${fields.invoiceNumber}`;
  if (fields.caseRef) return `case:${fields.caseRef}`;
  const date = fields.jobDate ?? fields.dueDate ?? fields.shippedDate;
  return `grp:${[date, fields.company, fields.doctorName, fields.patient].map((v) => text(v).toLowerCase()).join('|')}`;
}

const withGst = (cents) => Math.round(cents * 1.1);

// Rows (each { rowNumber, fields, problems }) to jobs. Rows with problems
// join no job. Answers { jobs, rowKeys: Map(rowNumber -> jobKey) }. Each job
// carries its findings: { code, blocking }.
export function groupJobs(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.problems.length) continue;
    const group = groupOf(row.fields);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const jobs = [];
  const rowKeys = new Map();
  const taken = new Map();
  for (const [group, members] of groups) {
    const first = members[0].fields;
    const findings = [];
    for (const field of ['company', 'doctorName']) {
      if (members.some((m) => !sameText(m.fields[field], first[field]))) findings.push({ code: `mixed_${field}`, blocking: true });
    }
    const totals = [...new Set(members.map((m) => m.fields.totalCents).filter((t) => t !== null))];
    if (totals.length > 1) findings.push({ code: 'conflicting_totals', blocking: true });
    const lines = members.map((m) => ({
      description: m.fields.item,
      code: m.fields.itemCode,
      amountCents: m.fields.itemAmountCents,
      ...(m.fields.quantity !== null ? { quantity: m.fields.quantity } : {}),
      ...(m.fields.itemTaxable !== null ? { taxable: m.fields.itemTaxable } : {}),
      ...(m.fields.tooth ? { tooth: m.fields.tooth } : {}),
    }));
    const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
    const totalCents = totals.length === 1 ? totals[0] : null;
    if (totalCents !== null && totalCents !== subtotalCents && totalCents !== withGst(subtotalCents)) {
      const taxable = lines.filter((l) => l.taxable !== false).reduce((sum, l) => sum + l.amountCents, 0);
      if (totalCents !== subtotalCents + Math.round(taxable * 0.1)) findings.push({ code: 'total_differs_from_lines', blocking: false });
    }
    const pick = (field) => members.map((m) => m.fields[field]).find(Boolean) ?? null;
    const job = {
      invoiceNumber: pick('invoiceNumber'),
      caseRef: pick('caseRef'),
      company: first.company,
      accountNumber: pick('accountNumber'),
      doctorName: first.doctorName,
      status: pick('status'),
      jobDate: pick('jobDate'),
      dueDate: pick('dueDate'),
      shippedDate: pick('shippedDate'),
      lines,
      subtotalCents,
      totalCents,
      patientReference: pick('patient'),
    };
    // A job with no Seazona number is keyed by what it is, without the patient.
    let key = group;
    if (group.startsWith('grp:')) {
      const base = `grp:${hashOf({ ...job, patientReference: null }).slice(0, 24)}`;
      const n = (taken.get(base) ?? 0) + 1;
      taken.set(base, n);
      key = n === 1 ? base : `${base}#${n}`;
    }
    jobs.push({ jobKey: key, job, findings });
    for (const m of members) rowKeys.set(m.rowNumber, key);
  }
  return { jobs, rowKeys };
}
