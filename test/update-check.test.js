// server/update-check.js: what owners are told about newer Flow releases,
// with GitHub and npm replaced by a stand-in fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateChecker, UPDATE_CHECK_INTERVAL_MS, updateChannel, upgradeGuideUrl } from "../server/update-check.js";

const HOUR = 60 * 60 * 1000;

// GitHub's API as the release channel sees it: `latest` for stable, `list`
// for beta. Records every request with its options.
function github({ latest = "v2026.10.15", list = [], status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (status !== 200) return new Response("{}", { status });
    if (url.endsWith("/releases/latest")) return Response.json({ tag_name: latest, prerelease: false, draft: false });
    if (url.includes("/releases?")) return Response.json(list.map((tag) => ({ tag_name: tag, prerelease: tag.includes("-beta."), draft: false })));
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, requests };
}

function clock(start = Date.parse("2026-10-15T00:00:00Z")) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("an owner on stable is told about a newer stable release, with its notes and the upgrade guide", async () => {
  const { fetchImpl } = github({ latest: "v2026.10.16" });
  const checker = createUpdateChecker({ env: { FLOW_DEPLOYED_RELEASE: "v2026.10.15", FLOW_DEPLOYED_REF: "stable", FLOW_RUNTIME: "replit" }, fetchImpl, now: clock().now });
  const status = await checker.status();
  assert.equal(status.updateAvailable, true);
  assert.equal(status.current, "v2026.10.15");
  assert.equal(status.latest, "v2026.10.16");
  assert.equal(status.channel, "stable");
  assert.equal(status.releaseUrl, "https://github.com/arcforgelabs/flow/releases/tag/v2026.10.16");
  assert.equal(status.upgradeUrl, "https://github.com/arcforgelabs/flow/blob/main/docs/REPLIT.md#following-stable-releases");
  assert.equal(status.checkedAt, "2026-10-15T00:00:00.000Z");
});

test("the same or an older release is no update, and a beta is not offered to a stable installation", async () => {
  for (const latest of ["v2026.10.15", "v2026.10.14"]) {
    const checker = createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15" }, fetchImpl: github({ latest }).fetchImpl });
    const status = await checker.status();
    assert.equal(status.updateAvailable, false, latest);
    assert.equal(status.releaseUrl, null);
  }
  const { fetchImpl, requests } = github({ list: ["v2026.10.17-beta.1"] });
  const checker = createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15" }, fetchImpl });
  assert.equal((await checker.status()).updateAvailable, false);
  assert.ok(requests.every(({ url }) => url.endsWith("/releases/latest")));
});

test("a beta installation follows the beta channel: the newest release of all", async () => {
  assert.equal(updateChannel({ FLOW_RELEASE: "v2026.10.15-beta.2" }, "v2026.10.15-beta.2"), "beta");
  assert.equal(updateChannel({ FLOW_UPDATE_CHANNEL: "stable" }, "v2026.10.15-beta.2"), "stable");
  assert.equal(updateChannel({ FLOW_DEPLOYED_REF: "beta" }, "v2026.10.15"), "beta");
  assert.equal(updateChannel({ FLOW_DEPLOYED_REF: "main" }, null), "stable");
  const { fetchImpl } = github({ list: ["v2026.10.15-beta.2", "v2026.10.15"] });
  const checker = createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15-beta.2" }, fetchImpl });
  const status = await checker.status();
  assert.equal(status.channel, "beta");
  assert.equal(status.latest, "v2026.10.15");
  assert.equal(status.updateAvailable, true);
});

test("GitHub is asked at most every six hours, failures included", async () => {
  const time = clock();
  const ok = github({ latest: "v2026.10.16" });
  const checker = createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15" }, fetchImpl: ok.fetchImpl, now: time.now });
  await Promise.all([checker.status(), checker.status(), checker.status()]);
  assert.equal(ok.requests.length, 1, "concurrent requests share one check");
  time.advance(UPDATE_CHECK_INTERVAL_MS - 1);
  await checker.status();
  assert.equal(ok.requests.length, 1);
  time.advance(1);
  await checker.status();
  assert.equal(ok.requests.length, 2);

  const down = github({ status: 503 });
  const failing = createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15" }, fetchImpl: down.fetchImpl, now: time.now });
  const status = await failing.status();
  assert.equal(status.updateAvailable, false);
  assert.match(status.error, /HTTP 503/);
  const asked = down.requests.length;
  time.advance(5 * HOUR);
  await failing.status();
  assert.equal(down.requests.length, asked, "a failed check is not retried within the interval");
});

test("nothing is asked when the check is off, or when the build is not a release", async () => {
  const { fetchImpl, requests } = github({ latest: "v2026.10.16" });
  const off = await createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15" }, fetchImpl }).status({ enabled: false });
  assert.deepEqual([off.enabled, off.updateAvailable, off.latest], [false, false, null]);
  for (const env of [{}, { FLOW_DEPLOYED_REF: "main", FLOW_REVISION: "a".repeat(40) }, { FLOW_RELEASE: "0.0.0-placeholder" }]) {
    const status = await createUpdateChecker({ env, fetchImpl }).status();
    assert.equal(status.updateAvailable, false);
  }
  assert.equal(requests.length, 0);
});

test("the only thing that leaves the installation is an anonymous GET of public release data", async () => {
  const { fetchImpl, requests } = github({ status: 503 });
  // GitHub fails, so npm is asked too.
  await createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15", FLOW_CONFIG_JSON: '{"apiToken":"secret-token"}' }, fetchImpl }).status();
  assert.ok(requests.length >= 2);
  for (const { url, init } of requests) {
    assert.match(url, /^https:\/\/(api\.github\.com\/repos\/arcforgelabs\/flow\/releases|registry\.npmjs\.org\/@arcforgelabs%2fflow$)/);
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(init.body, undefined);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(headers.authorization, undefined);
    assert.doesNotMatch(JSON.stringify(headers), /secret-token|v2026\.10\.15/);
  }
});

test("the upgrade guide is the Replit runbook on Replit, else the self-hosting guide", () => {
  assert.match(upgradeGuideUrl({ FLOW_RUNTIME: "replit" }), /docs\/REPLIT\.md#following-stable-releases$/);
  assert.match(upgradeGuideUrl({}), /docs\/SELF_HOSTING\.md$/);
});

test("FLOW_UPDATE_CHECK=off turns the check off", async () => {
  const { fetchImpl, requests } = github({ latest: "v2026.10.16" });
  const status = await createUpdateChecker({ env: { FLOW_RELEASE: "v2026.10.15", FLOW_UPDATE_CHECK: "off" }, fetchImpl }).status();
  assert.deepEqual([status.enabled, status.updateAvailable, requests.length], [false, false, 0]);
});
