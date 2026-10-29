import { openDatabase } from "../../../server/db/index.js";
import { createSeazonaClient } from "../../../server/integrations/seazona/client.js";
import { resolveSeazonaSettings } from "../../../server/integrations/seazona/settings.js";
import { runSeazonaSync } from "../../../server/integrations/seazona/lanes.js";
import { createDraftInvoice } from "../../../server/core/invoices.js";
import { fakeClock } from "../../../test/support/seazona.js";
export const env = {
  SEAZONA_MODE: "replay",
  SEAZONA_REPLAY_FILE: new URL(
    "../../../test/fixtures/seazona/billing.json",
    import.meta.url,
  ).pathname,
  SEAZONA_INVOICE_LOOKBACK_DAYS: "0",
  FLOW_BACKGROUND_JOBS: "off",
};
export default async function seed(flow) {
  const h = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL });
  try {
    const settings = resolveSeazonaSettings(env),
      clock = fakeClock("2026-10-01T12:00:00Z");
    const invoices = [
      {
        id: "synthetic-current",
        invoiceNumber: "7001",
        clientId: "synthetic-clinic",
        status: "Shipped",
        lastModified: "2026-10-01T12:00:00Z",
        subtotal: 100,
        tax: 10,
        total: 110,
      },
      {
        id: "synthetic-older",
        invoiceNumber: "7000",
        clientId: "synthetic-clinic",
        status: "Shipped",
        lastModified: "2026-09-30T10:00:00Z",
        subtotal: 100,
        tax: 10,
        total: 110,
      },
    ];
    const replay = async (input) => {
      const u = new URL(input),
        path = u.pathname.split("/v1/")[1] ?? u.pathname.replace(/^\//, "");
      let body = [];
      if (path === "invoices/")
        body = invoices.filter(
          (i) =>
            Date.parse(i.lastModified) >=
            Date.parse(u.searchParams.get("lastModified")),
        );
      else if (path.startsWith("invoices/"))
        body = invoices.find((i) => i.id === path.slice(9)) ?? {};
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    };
    const client = createSeazonaClient({
      settings,
      db: h.db,
      fetchImpl: replay,
      now: clock.now,
      sleepFn: clock.sleep,
      random: () => 0,
    });
    const first = await runSeazonaSync(h.db, client, {
      settings,
      now: clock.now,
      only: ["invoices", "clients"],
      force: true,
    });
    if (!first.ok) throw new Error("Synthetic initial read failed");
    const copied = (
      await h.pool.query("select invoice_number from seazona_invoices")
    ).rows;
    if (copied.length !== 1 || String(copied[0].invoice_number) !== "7001")
      throw new Error("Initial read must copy the recent invoice only");
    clock.set("2026-10-29T12:00:00Z");
    const result = await runSeazonaSync(h.db, client, {
      settings,
      now: clock.now,
      only: ["sweep"],
      force: true,
    });
    if (!result.ok || result.results.sweep.found.missing)
      throw new Error("Synthetic sweep must have no misses");
    const c = (
        await h.pool.query(
          "select id from contacts where name='Bayview Clinic'",
        )
      ).rows[0],
      p = (await h.pool.query("select id from price_items limit 1")).rows[0];
    await createDraftInvoice(h.db, flow.organisationId, {
      contactId: c.id,
      reference: "Synthetic older invoice",
      lines: [{ priceItemId: p.id }],
    });
    console.log(
      "Synthetic sweep: no misses; older source predates first read.",
    );
  } finally {
    await h.close();
  }
}
