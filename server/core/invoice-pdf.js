import { and, asc, eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { contacts, invoiceLines, invoiceVersions, organisations, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { getInvoice } from './invoices.js';

// An invoice as a PDF, drawn from Flow's own data: it needs no accounting
// system and makes no calls to one. A draft is drawn from its lines as they
// are now, with a DRAFT mark. An issued or void invoice is drawn from the
// version Flow stored when it was issued, so the PDF shows what was sent.

// The document for one invoice: the stored version for an issued or void
// invoice (or the version asked for), else the draft's lines now.
export async function invoicePdfDocument(db, organisationId, invoiceId, { version = null } = {}) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  const [organisation] = await db.select({ name: organisations.name }).from(organisations)
    .where(eq(organisations.id, organisationId));
  if (version !== null || (invoice.issuedVersion > 0 && invoice.status !== 'draft')) {
    const wanted = version ?? invoice.issuedVersion;
    const [row] = await db.select().from(invoiceVersions)
      .where(and(eq(invoiceVersions.organisationId, organisationId), eq(invoiceVersions.invoiceId, invoiceId), eq(invoiceVersions.version, wanted)));
    if (!row) throw notFound('invoice version');
    const latest = wanted === invoice.issuedVersion;
    return {
      seller: organisation?.name ?? null,
      mark: invoice.status === 'void' && latest ? 'void' : latest ? null : 'superseded',
      document: row.document,
    };
  }
  const [contact] = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
    .where(eq(contacts.id, invoice.contactId));
  const lines = await db.select({ line: invoiceLines, itemCode: priceItems.code }).from(invoiceLines)
    .leftJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
    .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
  return {
    seller: organisation?.name ?? null,
    mark: 'draft',
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

export function pdfFilename(document) {
  const name = String(document.number || 'draft-invoice').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${name}.pdf`;
}

const MARKS = { draft: 'DRAFT', void: 'VOID', superseded: 'SUPERSEDED' };

const C = { ink: '#18181b', body: '#3a3a42', muted: '#6b6b74', rule: '#d9d9df', mark: '#e4e4e9' };

function money(cents, currency) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency || 'AUD' }).format(cents / 100);
}

function showDate(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// A4 PDF bytes for a document from invoicePdfDocument().
export function renderInvoicePdf({ seller, mark, document: doc }) {
  if (!doc || !Array.isArray(doc.lines)) throw new FlowError('invalid', 'nothing to draw');
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: doc.number ? `Invoice ${doc.number}` : 'Draft invoice', Producer: 'Flow', Creator: 'Flow' },
    });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const bottom = pdf.page.height - pdf.page.margins.bottom;
    const currency = doc.currency || 'AUD';

    const drawMark = () => {
      if (!mark) return;
      pdf.save();
      pdf.rotate(-30, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
      pdf.font('Helvetica-Bold').fontSize(110).fillColor(C.mark)
        .text(MARKS[mark], 0, pdf.page.height / 2 - 60, { width: pdf.page.width, align: 'center', lineBreak: false });
      pdf.restore();
    };
    drawMark();

    // Header: the seller on the left, the title and number on the right.
    pdf.font('Helvetica-Bold').fontSize(14).fillColor(C.ink).text(seller ?? '', left, 48, { width: width / 2 });
    pdf.font('Helvetica-Bold').fontSize(22).fillColor(C.ink)
      .text(mark === 'draft' ? 'DRAFT INVOICE' : 'TAX INVOICE', left + width / 2, 44, { width: width / 2, align: 'right' });
    pdf.font('Helvetica').fontSize(10).fillColor(C.muted)
      .text(doc.number ?? 'Not numbered yet', left + width / 2, pdf.y + 2, { width: width / 2, align: 'right' });

    // Bill to, and the facts.
    const top = 120;
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('BILL TO', left, top);
    pdf.font('Helvetica').fontSize(11).fillColor(C.ink).text(doc.contact?.name ?? '—', left, top + 14, { width: width / 2 - 12 });
    if (doc.contact?.email) pdf.fontSize(9).fillColor(C.muted).text(doc.contact.email, { width: width / 2 - 12 });
    const facts = [
      ['Reference', pdfReference(doc) ?? '—'],
      ['Invoice date', showDate(doc.issueDate)],
      ['Due date', showDate(doc.dueDate)],
    ];
    let fy = top;
    const labelX = left + width / 2;
    for (const [label, value] of facts) {
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text(label.toUpperCase(), labelX, fy + 2, { width: 80 });
      pdf.font('Helvetica').fontSize(10).fillColor(C.ink).text(value, labelX + 84, fy, { width: width / 2 - 84 });
      fy = Math.max(pdf.y, fy + 14) + 4;
    }

    // Lines.
    const cols = [
      { key: 'description', label: 'Description', width: width - 290, align: 'left' },
      { key: 'quantity', label: 'Qty', width: 50, align: 'right' },
      { key: 'unit', label: 'Unit price', width: 80, align: 'right' },
      { key: 'tax', label: 'GST', width: 60, align: 'right' },
      { key: 'amount', label: 'Amount', width: 100, align: 'right' },
    ];
    const tableHead = (y) => {
      let x = left;
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(C.muted);
      for (const col of cols) {
        pdf.text(col.label.toUpperCase(), x, y, { width: col.width, align: col.align });
        x += col.width;
      }
      pdf.moveTo(left, y + 14).lineTo(left + width, y + 14).lineWidth(0.75).strokeColor(C.rule).stroke();
      return y + 22;
    };
    let y = tableHead(Math.max(pdf.y, fy) + 24);
    for (const line of doc.lines) {
      const cells = {
        description: line.itemCode ? `${line.itemCode}  ${line.description}` : line.description,
        quantity: String(line.quantity),
        unit: money(line.unitAmountCents, currency),
        tax: line.taxCode === 'GST' ? money(line.taxCents, currency) : 'GST free',
        amount: money(line.lineAmountCents, currency),
      };
      pdf.font('Helvetica').fontSize(10);
      const height = Math.max(14, pdf.heightOfString(cells.description, { width: cols[0].width - 8 }));
      if (y + height > bottom - 90) {
        pdf.addPage();
        drawMark();
        y = tableHead(pdf.page.margins.top);
      }
      let x = left;
      for (const col of cols) {
        pdf.font('Helvetica').fontSize(10).fillColor(col.key === 'description' ? C.ink : C.body)
          .text(cells[col.key], x, y, { width: col.key === 'description' ? col.width - 8 : col.width, align: col.align });
        x += col.width;
      }
      y += height + 8;
      pdf.moveTo(left, y - 4).lineTo(left + width, y - 4).lineWidth(0.5).strokeColor(C.rule).stroke();
    }

    // Totals.
    if (y > bottom - 80) {
      pdf.addPage();
      drawMark();
      y = pdf.page.margins.top;
    }
    y += 8;
    const totalsX = left + width - 240;
    const totals = [['Subtotal', doc.subtotalCents], ['GST', doc.taxCents], [`Total ${currency}`, doc.totalCents]];
    for (const [index, [label, cents]] of totals.entries()) {
      const grand = index === totals.length - 1;
      if (grand) {
        pdf.moveTo(totalsX, y - 2).lineTo(left + width, y - 2).lineWidth(0.75).strokeColor(C.ink).stroke();
        y += 4;
      }
      pdf.font(grand ? 'Helvetica-Bold' : 'Helvetica').fontSize(grand ? 12 : 10).fillColor(C.ink)
        .text(label, totalsX, y, { width: 140 })
        .text(money(cents, currency), totalsX + 140, y, { width: 100, align: 'right' });
      y += grand ? 20 : 16;
    }

    pdf.end();
  });
}
