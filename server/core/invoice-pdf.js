import { and, asc, eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { contacts, invoiceLines, invoiceVersions, organisations, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { getInvoice } from './invoices.js';

// An invoice as a PDF, drawn from Flow's own data: it makes no calls to an
// accounting system. A draft is drawn from its lines as they are now. An
// issued or void invoice is drawn from the version Flow stored when it was
// issued, so the PDF shows what was sent. Every page carries an EXAMPLE mark:
// the customer's copy is the one the accounting system sends.
//
// Nothing on the PDF is made up. Once the accounting system holds the
// version, its number, reference and dates come from Flow's copy of that
// system (the adapter's documentFacts, no calls). A value nobody knows yet is
// drawn as a grey note that says so, never as a sample value.

// The document for one invoice: the stored version for an issued or void
// invoice (or the version asked for), else the draft's lines now.
// `accounting` is the accounting adapter, or null.
export async function invoicePdfDocument(db, organisationId, invoiceId, { version = null, accounting = null } = {}) {
  const source = await flowDocument(db, organisationId, invoiceId, { version });
  const ask = accounting?.capabilities?.documentFacts;
  const facts = ask ? await ask({ organisationId, invoiceId, version: source.document.version ?? null }) : null;
  return { ...source, facts };
}

async function flowDocument(db, organisationId, invoiceId, { version }) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  const [organisation] = await db.select({ name: organisations.name }).from(organisations)
    .where(eq(organisations.id, organisationId));
  if (version !== null || (invoice.issuedVersion > 0 && invoice.status !== 'draft')) {
    const wanted = version ?? invoice.issuedVersion;
    const [row] = await db.select().from(invoiceVersions)
      .where(and(eq(invoiceVersions.organisationId, organisationId), eq(invoiceVersions.invoiceId, invoiceId), eq(invoiceVersions.version, wanted)));
    if (!row) throw notFound('invoice version');
    return { seller: organisation?.name ?? null, document: row.document };
  }
  const [contact] = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
    .where(eq(contacts.id, invoice.contactId));
  const lines = await db.select({ line: invoiceLines, itemCode: priceItems.code }).from(invoiceLines)
    .leftJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
    .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
  return {
    seller: organisation?.name ?? null,
    document: {
      number: invoice.number,
      version: null,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      reference: invoice.reference,
      currency: invoice.currency,
      contact: contact ?? null,
      lines: lines.map(({ line, itemCode }) => ({
        position: line.position,
        itemCode: itemCode ?? null,
        description: line.description,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        taxCode: line.taxCode,
        lineAmountCents: line.lineAmountCents,
        taxCents: line.taxCents,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
    },
  };
}

// The reference the accounting system gets: the invoice's own reference, else
// its number (the same rule as server/integrations/xero/drafts.js).
export function pdfReference(document) {
  return document.reference || document.number || null;
}

function addDays(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// The number, reference and dates the PDF shows. Each is { value } when it is
// known, or { missing } with a short note on why it is not.
export function pdfFields({ document: doc, facts = null }) {
  const known = (value) => ({ value });
  const missing = (note) => ({ missing: note });
  if (facts?.sent) {
    const fromCopy = (value) => (value ? known(value) : missing(`Not in Flow's copy of ${facts.system}`));
    return {
      number: fromCopy(facts.number),
      reference: fromCopy(facts.reference),
      issueDate: fromCopy(facts.issueDate),
      dueDate: fromCopy(facts.dueDate),
    };
  }
  const notIssued = missing('Set when issued');
  const issueDate = doc.issueDate ? known(doc.issueDate) : notIssued;
  let dueDate = doc.dueDate ? known(doc.dueDate) : notIssued;
  // The accounting system sets the due date from the invoice date when Flow
  // sends none (Xero: XERO_DEFAULT_DUE_DAYS).
  if (!doc.dueDate && doc.issueDate && facts?.defaultDueDays) dueDate = known(addDays(doc.issueDate, facts.defaultDueDays));
  const reference = pdfReference(doc);
  return {
    number: facts?.numberedBy === 'xero'
      ? missing(`${facts.system} sets it when sent`)
      : doc.number ? known(doc.number) : notIssued,
    reference: reference ? known(reference) : notIssued,
    issueDate,
    dueDate,
  };
}

export function pdfFilename(fields) {
  const name = String(fields.number.value || 'invoice').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${name}.pdf`;
}

const C = { ink: '#000000', body: '#333333', muted: '#666666', rule: '#bbbbbb', mark: '#e6e6e6' };

function money(cents) {
  return new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function showDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// A4 PDF bytes for a document from invoicePdfDocument(). The layout follows
// the accounting system's standard invoice (Xero's standard branding theme),
// so the customer's copy looks much the same: title and customer on the
// left, dates and numbers in the middle, the seller on the right, then the
// lines, the totals and the due date. The payment advice slip is left out.
export function renderInvoicePdf({ seller, document: doc, facts = null }) {
  if (!doc || !Array.isArray(doc.lines)) throw new FlowError('invalid', 'nothing to draw');
  const fields = pdfFields({ document: doc, facts });
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 56, right: 56 },
      info: { Title: fields.number.value ? `Invoice ${fields.number.value}` : 'Invoice', Producer: 'Flow', Creator: 'Flow' },
    });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const bottom = pdf.page.height - pdf.page.margins.bottom;
    const currency = doc.currency || 'AUD';
    const regular = 'Helvetica';
    const bold = 'Helvetica-Bold';
    const italic = 'Helvetica-Oblique';

    const drawMark = () => {
      pdf.save();
      pdf.rotate(-30, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
      pdf.font(bold).fontSize(96).fillColor(C.mark)
        .text('EXAMPLE', 0, pdf.page.height / 2 - 60, { width: pdf.page.width, align: 'center', lineBreak: false });
      pdf.restore();
    };
    drawMark();

    // Title, top left.
    pdf.font(regular).fontSize(26).fillColor(C.ink).text('TAX INVOICE', left, 56);

    // Three columns: customer, invoice facts, seller.
    const top = 110;
    const colW = width / 3;
    pdf.font(regular).fontSize(9).fillColor(C.ink).text(doc.contact?.name ?? '', left, top, { width: colW - 12 });
    if (doc.contact?.email) pdf.fillColor(C.body).text(doc.contact.email, { width: colW - 12 });
    const customerEnd = pdf.y;

    // A value nobody knows yet is a grey italic note, never a sample value.
    const field = (f, show = (v) => v) => (f.value ? { text: show(f.value), font: regular, color: C.body } : { text: f.missing, font: italic, color: C.muted });
    const rows = [
      ['Invoice Date', field(fields.issueDate, showDate)],
      ['Invoice Number', field(fields.number)],
      ['Reference', field(fields.reference)],
    ];
    let fy = top;
    for (const [label, shown] of rows) {
      pdf.font(bold).fontSize(9).fillColor(C.ink).text(label, left + colW, fy, { width: colW - 12 });
      pdf.font(shown.font).fillColor(shown.color).text(shown.text, left + colW, pdf.y, { width: colW - 12 });
      fy = pdf.y + 8;
    }
    pdf.font(regular).fontSize(9).fillColor(C.ink).text(seller ?? '', left + colW * 2, top, { width: colW });

    // Lines.
    const cols = [
      { key: 'description', label: 'Description', width: width - 300, align: 'left' },
      { key: 'quantity', label: 'Quantity', width: 60, align: 'right' },
      { key: 'unit', label: 'Unit Price', width: 80, align: 'right' },
      { key: 'tax', label: 'GST', width: 70, align: 'right' },
      { key: 'amount', label: `Amount ${currency}`, width: 90, align: 'right' },
    ];
    const gap = 10;
    const tableHead = (y) => {
      let x = left;
      pdf.font(bold).fontSize(9).fillColor(C.ink);
      for (const col of cols) {
        pdf.text(col.label, x, y, { width: col.width, align: col.align });
        x += col.width;
      }
      pdf.moveTo(left, y + 14).lineTo(left + width, y + 14).lineWidth(0.75).strokeColor(C.ink).stroke();
      return y + 22;
    };
    let y = tableHead(Math.max(customerEnd, fy, pdf.y) + 36);
    for (const line of doc.lines) {
      const cells = {
        description: line.description,
        quantity: Number(line.quantity).toFixed(2),
        unit: money(line.unitAmountCents),
        tax: line.taxCode === 'GST' ? '10%' : 'GST Free',
        amount: money(line.lineAmountCents),
      };
      pdf.font(regular).fontSize(9);
      const height = Math.max(12, pdf.heightOfString(cells.description, { width: cols[0].width - gap }));
      if (y + height > bottom - 110) {
        pdf.addPage();
        drawMark();
        y = tableHead(pdf.page.margins.top);
      }
      let x = left;
      for (const col of cols) {
        pdf.font(regular).fontSize(9).fillColor(C.ink)
          .text(cells[col.key], x, y, { width: col.key === 'description' ? col.width - gap : col.width, align: col.align });
        x += col.width;
      }
      y += height + 6;
      pdf.moveTo(left, y - 2).lineTo(left + width, y - 2).lineWidth(0.5).strokeColor(C.rule).stroke();
      y += 4;
    }

    // Totals, right aligned under the Amount column.
    if (y > bottom - 110) {
      pdf.addPage();
      drawMark();
      y = pdf.page.margins.top;
    }
    y += 4;
    const totalsX = left + width - 240;
    const totals = [['Subtotal', doc.subtotalCents], ['TOTAL GST 10%', doc.taxCents], [`TOTAL ${currency}`, doc.totalCents]];
    for (const [index, [label, cents]] of totals.entries()) {
      const grand = index === totals.length - 1;
      if (grand) {
        pdf.moveTo(totalsX, y - 3).lineTo(left + width, y - 3).lineWidth(0.75).strokeColor(C.ink).stroke();
        y += 3;
      }
      pdf.font(grand ? bold : regular).fontSize(9).fillColor(C.ink)
        .text(label, totalsX, y, { width: 150, align: 'right' })
        .text(money(cents), totalsX + 150, y, { width: 90, align: 'right' });
      y += 16;
    }

    // Due date.
    y += 24;
    pdf.font(bold).fontSize(11).fillColor(C.ink).text('Due Date: ', left, y, { continued: true });
    if (fields.dueDate.value) pdf.text(showDate(fields.dueDate.value));
    else pdf.font(italic).fillColor(C.muted).text(fields.dueDate.missing);

    pdf.end();
  });
}
