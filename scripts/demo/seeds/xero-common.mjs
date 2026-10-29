import { openDatabase } from "../../../server/db/index.js";
import { saveConnection } from "../../../server/integrations/xero/connections.js";
import { TOKEN_KEY, TENANT } from "../../../test/support/xero.js";
import { fileURLToPath } from "node:url";
export const env = {
  XERO_MODE: "replay",
  XERO_TOKEN_KEY: TOKEN_KEY,
  FLOW_PUBLIC_ORIGIN: "https://flow.example.test",
  XERO_REPLAY_FIXTURES: fileURLToPath(
    new URL("./xero-fixtures.json", import.meta.url),
  ),
};
export async function setup(flow, fn) {
  const handle = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL });
  try {
    await saveConnection(handle.db, {
      organisationId: flow.organisationId,
      mode: "replay",
      tenantId: TENANT,
      tenantName: "Example Lab (Demo)",
      scope: null,
      refreshToken: "synthetic-refresh",
      connectedBy: null,
      key: Buffer.from(TOKEN_KEY, "hex"),
    });
    await fn(handle);
  } finally {
    await handle.close();
  }
}
export async function api(flow, path, body) {
  const res = await fetch(flow.url + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${Object.values(flow.tokens)[0]}`,
      "Content-Type": "application/json",
    },
    body: body
      ? JSON.stringify({ organisationId: flow.organisationId, ...body })
      : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Synthetic setup ${res.status}: ${data.code}`);
  return data;
}
