#!/usr/bin/env node
// May an automation publish an installation now, and did the publish land?
// An agent with a Replit connector runs this around its publish call, so a
// publish only starts for a finished release and is checked after.
//
//   node scripts/publish-guard.js before <app-origin> [stable|beta]
//   node scripts/publish-guard.js after <app-origin> <tag>
//
// before: the release the channel points at must be the same on GitHub and
// on npm, its release-manifest.json must match its .sha256, its commit must
// have passed CI (scripts/deploy-checks.js), and the live app's /health must
// be ok and follow that channel from GitHub. Exits 0 when the live app is
// older than that release (publish), 3 when it already runs it (nothing to
// do), and 1 with the reasons otherwise (do not publish).
//
// after: the live /health must name the tag, with checks passed. Exits 0 when
// it does, 1 otherwise. Call it once the publish status says success; the app
// can take a minute to restart, so it asks again for up to --wait seconds
// (default 300).
//
// The last line of stdout is one JSON object: { decision, tag, commit, live,
// problems, warnings }. It never treats an answer it could not read as a
// pass.
//
//   GH_TOKEN or GITHUB_TOKEN   optional: sent to api.github.com only, so a
//                              shared address does not hit the anonymous
//                              rate limit (60 an hour)
//   FLOW_DEPLOY_RELEASES_API, FLOW_DEPLOY_RELEASE_DOWNLOADS,
//   FLOW_DEPLOY_NPM_REGISTRY, FLOW_DEPLOY_CHECKS_API   tests only, as in
//                                                      scripts/deploy-release.js
import { resolve } from "node:path";
import { checkCommit, githubRepoSlug } from "./deploy-checks.js";
import {
  CHANNELS,
  compareReleases,
  DEFAULT_GITHUB_API,
  DEFAULT_GITHUB_DOWNLOADS,
  DEFAULT_NPM_REGISTRY,
  DEFAULT_PACKAGE,
  fromGitHub,
  fromNpm,
  parseReleaseTag,
  ReleaseUnavailable,
  verifyReleaseManifest,
} from "../server/release-channel.js";

export const REPOSITORY = "https://github.com/arcforgelabs/flow";
export const PUBLISH = 0;
export const STOP = 1;
export const UP_TO_DATE = 3;
const HEALTH_TIMEOUT_MS = 20_000;

const trim = (value, fallback) => (value || fallback).replace(/\/+$/, "");

function endpoints(env) {
  return {
    githubApi: trim(env.FLOW_DEPLOY_RELEASES_API, DEFAULT_GITHUB_API),
    githubDownloads: trim(env.FLOW_DEPLOY_RELEASE_DOWNLOADS, DEFAULT_GITHUB_DOWNLOADS),
    npmRegistry: trim(env.FLOW_DEPLOY_NPM_REGISTRY, DEFAULT_NPM_REGISTRY),
    checksApi: trim(env.FLOW_DEPLOY_CHECKS_API, DEFAULT_GITHUB_API),
  };
}

// The live app's /health body, or { unavailable } naming why it could not be
// read.
export async function readHealth(origin, { fetchImpl = fetch } = {}) {
  let url;
  try {
    url = new URL("/health", origin);
  } catch {
    return { unavailable: `${origin} is not an address` };
  }
  if (url.protocol !== "https:") return { unavailable: `${origin} is not https` };
  try {
    const response = await fetchImpl(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return { unavailable: `${url.href} answered HTTP ${response.status}` };
    return { body: await response.json() };
  } catch (error) {
    return { unavailable: `${url.href} did not answer (${error?.cause?.code || error?.name || "network error"})` };
  }
}

// Integrations that say they are not ok. A warning only: a publish does not
// fix them, and an older build may already show them.
function integrationWarnings(body) {
  const list = Array.isArray(body?.integrations) ? body.integrations : [];
  return list.filter((item) => item?.enabled && item?.health && item.health.ok === false).map((item) => `${item.id}: health not ok`);
}

export async function before({ origin, channel = "stable", env = process.env, fetchImpl = fetch, retryDelayMs = 2000 }) {
  const result = { decision: "stop", tag: null, commit: null, live: null, problems: [], warnings: [] };
  if (!CHANNELS.includes(channel)) {
    result.problems.push(`channel must be stable or beta, not "${channel}"`);
    return result;
  }
  const slug = githubRepoSlug(REPOSITORY);
  const { githubApi, githubDownloads, npmRegistry, checksApi } = endpoints(env);
  let github;
  let npm;
  try {
    github = await fromGitHub(channel, { slug, githubApi, fetchImpl, retryDelayMs });
  } catch (error) {
    if (!(error instanceof ReleaseUnavailable)) throw error;
    result.problems.push(`GitHub: ${error.message}`);
  }
  try {
    npm = await fromNpm(channel, { npmRegistry, packageName: DEFAULT_PACKAGE, fetchImpl, retryDelayMs });
  } catch (error) {
    if (!(error instanceof ReleaseUnavailable)) throw error;
    result.problems.push(`npm: ${error.message}`);
  }
  if (github && npm && github !== npm) result.problems.push(`GitHub names ${github} but npm names ${npm}: the release is not finished`);
  if (result.problems.length) return result;
  result.tag = github;

  try {
    result.commit = (await verifyReleaseManifest({ slug, tag: github, githubDownloads, fetchImpl, retryDelayMs })).commit;
  } catch (error) {
    if (!(error instanceof ReleaseUnavailable)) throw error;
    result.problems.push(`manifest: ${error.message}`);
    return result;
  }
  const checks = await checkCommit({ repoUrl: REPOSITORY, commit: result.commit, api: checksApi, fetchImpl, retryDelayMs });
  if (checks.unavailable) result.problems.push(`checks: could not be read: ${checks.unavailable}`);
  else if (!checks.passed) result.problems.push(...checks.problems.map((problem) => `checks: ${problem}`));

  const health = await readHealth(origin, { fetchImpl });
  if (health.unavailable) {
    result.problems.push(`health: ${health.unavailable}`);
    return result;
  }
  const build = health.body?.build ?? {};
  result.live = build.release ?? null;
  result.warnings.push(...integrationWarnings(health.body));
  if (health.body?.ok !== true) result.problems.push("health: the live app does not say ok");
  if (build.ref !== channel) result.problems.push(`health: the live app follows ${build.ref ?? "nothing"}, not ${channel}; publish it by hand`);
  if (build.source !== "github") result.problems.push(`health: the live build came from ${build.source ?? "nowhere"}, not github; publish it by hand`);
  if (!parseReleaseTag(build.release)) result.problems.push(`health: the live build names no release (${build.release ?? "none"})`);
  if (result.problems.length) return result;

  const order = compareReleases(build.release, github);
  if (order === 0) result.decision = "up-to-date";
  else if (order > 0) result.problems.push(`health: the live app runs ${build.release}, newer than ${github}; a rollback is a decision for a person`);
  else result.decision = "publish";
  return result;
}

export async function after({ origin, tag, waitSeconds = 300, intervalMs = 15_000, fetchImpl = fetch, sleep }) {
  const pause = sleep ?? ((ms) => new Promise((wake) => setTimeout(wake, ms)));
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const result = { decision: "stop", tag, commit: null, live: null, problems: [], warnings: [] };
    const health = await readHealth(origin, { fetchImpl });
    if (health.unavailable) {
      result.problems.push(`health: ${health.unavailable}`);
    } else {
      const build = health.body?.build ?? {};
      result.live = build.release ?? null;
      result.commit = build.revision ?? null;
      result.warnings.push(...integrationWarnings(health.body));
      if (health.body?.ok !== true) result.problems.push("health: the live app does not say ok");
      if (build.release !== tag) result.problems.push(`health: the live app runs ${build.release ?? "no release"}, not ${tag}`);
      if (build.checks !== "passed") result.problems.push(`health: build checks are ${build.checks ?? "missing"}, not passed`);
      if (build.source !== "github") result.problems.push(`health: the live build came from ${build.source ?? "nowhere"}, not github`);
    }
    if (!result.problems.length) {
      result.decision = "live";
      return result;
    }
    if (Date.now() + intervalMs > deadline) return result;
    await pause(intervalMs);
  }
}

// fetch, with the token on requests to api.github.com and nowhere else.
export function withGitHubToken(token, fetchImpl = fetch) {
  if (!token) return fetchImpl;
  return (url, options = {}) => {
    if (new URL(url).host !== "api.github.com") return fetchImpl(url, options);
    return fetchImpl(url, { ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
  };
}

async function main([mode, origin, third, ...rest], env) {
  const log = (line) => console.error(`[publish-guard] ${line}`);
  const fetchImpl = withGitHubToken(env.GH_TOKEN || env.GITHUB_TOKEN);
  let result;
  if (mode === "before" && origin) {
    result = await before({ origin, channel: third ?? "stable", env, fetchImpl });
  } else if (mode === "after" && origin && third) {
    const wait = rest.indexOf("--wait");
    const waitSeconds = wait >= 0 ? Number(rest[wait + 1]) : 300;
    result = await after({ origin, tag: third, waitSeconds: Number.isFinite(waitSeconds) ? waitSeconds : 300 });
  } else {
    log("usage: publish-guard.js before <app-origin> [stable|beta] | after <app-origin> <tag> [--wait seconds]");
    return STOP;
  }
  for (const problem of result.problems) log(`problem: ${problem}`);
  for (const warning of result.warnings) log(`warning: ${warning}`);
  log(`${mode}: ${result.decision}${result.tag ? ` (${result.tag})` : ""}, live ${result.live ?? "unknown"}`);
  console.log(JSON.stringify(result));
  if (result.decision === "publish" || result.decision === "live") return PUBLISH;
  if (result.decision === "up-to-date") return UP_TO_DATE;
  return STOP;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[publish-guard] failed: ${error?.stack || error}`);
      process.exit(STOP);
    },
  );
}
