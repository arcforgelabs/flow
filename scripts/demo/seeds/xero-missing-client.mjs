import { setup, api } from "./xero-common.mjs";
import { createDraftInvoice } from "../../../server/core/invoices.js";
export { env } from "./xero-common.mjs";
export default async function seed(flow) {
  await setup(flow, async (h) => {
    const c = (
      await h.pool.query("select id from contacts where name='Harbour Smiles'")
    ).rows[0];
    const p = (await h.pool.query("select id from price_items limit 1"))
      .rows[0];
    await createDraftInvoice(h.db, flow.organisationId, {
      contactId: c.id,
      reference: "Synthetic missing client",
      lines: [{ priceItemId: p.id }],
    });
  });
  await api(flow, "/api/xero/sync", {});
}
