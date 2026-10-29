import { setup, api } from "./xero-common.mjs";
export { env } from "./xero-common.mjs";
export default async function seed(flow) {
  await setup(flow, async () => {});
  await api(flow, "/api/xero/sync", {});
}
