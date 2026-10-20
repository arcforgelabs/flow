import { eq } from 'drizzle-orm';
import { readOrder } from './lanes.js';
import { seazonaInvoices, seazonaOrders } from './schema.js';

// The patient name of one Seazona order, for the invoice Reference
// (server/core/references.js). Flow keeps it only when the installation keeps
// patient names (SEAZONA_KEEP_PATIENT_REFERENCE); off, this answers no name
// and never calls Seazona. An order read before the setting was on has no
// name yet: with `read`, Flow reads that order once more. An order that has
// no patient in Seazona is kept as '' so it is not read again.
export async function orderPatient({ db, client, settings, now }, orderId, { read = false } = {}) {
  if (!settings.sync.keepPatientReference) return { patient: null };
  const stored = async () => {
    const [order] = await db.select({ patient: seazonaOrders.patientReference, invoiceNumber: seazonaOrders.invoiceNumber })
      .from(seazonaOrders).where(eq(seazonaOrders.id, orderId));
    if (order?.patient != null || !order?.invoiceNumber) return order ?? null;
    const [invoice] = await db.select({ patient: seazonaInvoices.patientReference })
      .from(seazonaInvoices).where(eq(seazonaInvoices.invoiceNumber, order.invoiceNumber));
    return { ...order, patient: invoice?.patient || order.patient };
  };
  const known = await stored();
  if (!known) return { patient: null };
  if (known.patient != null) return { patient: known.patient || null };
  if (!read) return { patient: null };
  const result = await readOrder({ db, client, sync: settings.sync, at: new Date(Number(now())) }, orderId, { known: true });
  if (result.outcome !== 'read') return { patient: null, asked: true };
  const after = await stored();
  if (after?.patient == null) await db.update(seazonaOrders).set({ patientReference: '' }).where(eq(seazonaOrders.id, orderId));
  return { patient: after?.patient || null, asked: true };
}
