import { setup, api } from "./xero-common.mjs";
import { createPriceItem } from "../../../server/core/directory.js";
import {
  createDraftInvoice,
  issueInvoice,
} from "../../../server/core/invoices.js";
import { observeJob, linkJobToInvoice } from "../../../server/core/ledger.js";
export { env } from "./xero-common.mjs";
export default async function seed(flow) {
  await setup(flow, async (h) => {
    const c = (
      await h.pool.query("select id from contacts where name='Bayview Clinic'")
    ).rows[0];
    const p = await createPriceItem(h.db, flow.organisationId, {
      code: "SYNTHETIC-PAID",
      name: "Synthetic paid crown",
      unitAmountCents: 25000,
      taxCode: "GST",
    });
    const draft = await createDraftInvoice(h.db, flow.organisationId, {
      contactId: c.id,
      reference: "Synthetic paid invoice",
      lines: [{ priceItemId: p.id }],
    });
    const invoice = await issueInvoice(h.db, flow.organisationId, draft.id, {
      issuedBy: "synthetic-recorder",
      issueDate: "2026-10-29",
    });
    const job = await observeJob(h.db, flow.organisationId, {
      sourceSystem: "worksystem",
      sourceJobRef: "SYNTHETIC-PAID",
      contactId: c.id,
      lines: [{ itemCode: p.code }],
    });
    await linkJobToInvoice(h.db, flow.organisationId, job.id, {
      invoiceId: invoice.id,
      actor: "synthetic-recorder",
    });
    await h.pool.query(
      "insert into xero_invoice_pushes(organisation_id,invoice_id,version,state,idempotency_key,request_body,body_hash,xero_invoice_id,xero_invoice_number,xero_status,verified) values($1,$2,1,'created','synthetic-paid','{}','synthetic','synthetic-paid','INV-SYNTHETIC','PAID',true)",
      [flow.organisationId, invoice.id],
    );
  });
  const payments = await api(flow, "/api/xero/payments/sync", {});
  if (payments.recorded.length !== 1 || payments.failed.length)
    throw new Error("Synthetic payment was not recorded");
  await api(flow, "/api/xero/mirror", { resources: ["invoices"] });
}
