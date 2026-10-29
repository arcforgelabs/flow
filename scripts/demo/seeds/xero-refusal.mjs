import { setup, api, env as common } from "./xero-common.mjs";
import { createDraftInvoice } from "../../../server/core/invoices.js";
import { createXeroAdapter } from "../../../server/integrations/xero/index.js";
import { openDatabase } from "../../../server/db/index.js";
import { createSendWorker, markReady } from "../../../server/core/sending.js";
export const env = {
  ...common,
  XERO_REPLAY_FIXTURES: new URL("./xero-refusal-fixtures.json", import.meta.url)
    .pathname,
};
export default async function seed(flow) {
  await setup(flow, async (h) => {
    const c = (
      await h.pool.query("select id from contacts where name='Bayview Clinic'")
    ).rows[0];
    const p = (
      await h.pool.query("select id from price_items where code='CR-ZR'")
    ).rows[0];
    const person = (await h.pool.query("select id from people limit 1"))
      .rows[0];
    for (const ref of ["Synthetic send accepted", "Synthetic send refused"]) {
      const i = await createDraftInvoice(h.db, flow.organisationId, {
        contactId: c.id,
        reference: ref,
        lines: [{ priceItemId: p.id }],
      });
      await markReady(h.db, flow.organisationId, [i.id], {
        personId: person.id,
      });
    }
  });
  await api(flow, "/api/xero/sync", {});
  await api(flow, "/api/xero/mirror", {
    resources: ["invoices", "credit_notes", "payments"],
  });
  const h = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL });
  const adapter = createXeroAdapter();
  const log = { info() {}, warn() {}, error() {} };
  await adapter.start({ db: h.db, env, log });
  const worker = createSendWorker({
    db: h.db,
    integrations: { with: () => [adapter] },
    log,
    everyMs: 300,
  });
  await worker.start();
  return async () => {
    await worker.stop();
    await adapter.stop();
    await h.close();
  };
}
