import { openDatabase } from "../../../server/db/index.js";
import { observeJob, setReady } from "../../../server/core/ledger.js";
import { createPriceItem } from "../../../server/core/directory.js";
import { createDraftInvoice } from "../../../server/core/invoices.js";
export default async function seed(flow) {
  const h = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL });
  try {
    const c = (
      await h.pool.query("select id from contacts where name='Bayview Clinic'")
    ).rows[0];
    const p = await createPriceItem(h.db, flow.organisationId, {
      code: "SYNTHETIC-GAP",
      name: "Synthetic gap crown",
      unitAmountCents: 41700,
    });
    const job = await observeJob(h.db, flow.organisationId, {
      sourceSystem: "worksystem",
      sourceJobRef: "SYNTHETIC-GAP",
      caseRef: "SYNTHETIC-GAP",
      sourceStatus: "Shipped",
      shippedOn: "2026-10-29",
      jobDate: "2026-09-30",
      contactId: c.id,
      lines: [{ itemCode: p.code }],
      actor: "synthetic-recorder",
    });
    await setReady(h.db, flow.organisationId, job.id, {
      actor: "synthetic-recorder",
    });
    await createDraftInvoice(h.db, flow.organisationId, {
      contactId: c.id,
      reference: "SYNTHETIC-GAP",
      lines: [{ priceItemId: p.id }],
    });
  } finally {
    await h.close();
  }
}
