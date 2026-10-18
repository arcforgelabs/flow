// Is a newer Flow release out? GET /api/updates answers, and the server logs
// a notice when one is (server/index.js).
//
// Flow knows its own release from GET /health's build.release
// (server/deployed-build.js): the tag a Replit deploy of a channel or a pinned
// release resolved to, a release image's FLOW_RELEASE, or an installed npm
// package's version (server/flow-server.js). A build that is not a release (a checkout of main, a CI
// image) has none, so it is never told to update and asks nobody.
//
// The channel is the one the installation follows: FLOW_UPDATE_CHANNEL when
// set, else FLOW_DEPLOYED_REF when that is stable or beta, else beta for a
// beta release, else stable. The newest release on that channel comes from
// server/release-channel.js: an anonymous GET of public data on GitHub, or
// npm. Nothing about the installation is sent. The answer, or the reason
// there is none, is cached and asked again at most every six hours.
// FLOW_UPDATE_CHECK=off turns the check off.
import { deployedBuildStatus } from "./deployed-build.js";
import { CHANNELS, compareReleases, parseReleaseTag, resolveChannelRelease } from "./release-channel.js";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FLOW_REPOSITORY = "arcforgelabs/flow";

export function updateChannel(env = process.env, current = null) {
  const pick = (value) => (CHANNELS.includes(String(value ?? "").trim()) ? String(value).trim() : null);
  return pick(env.FLOW_UPDATE_CHANNEL) || pick(env.FLOW_DEPLOYED_REF) || (parseReleaseTag(current)?.channel === "beta" ? "beta" : "stable");
}

export function updateCheckEnabled(env = process.env) {
  return !["off", "0", "false", "no"].includes(String(env.FLOW_UPDATE_CHECK ?? "").trim().toLowerCase());
}

// Where an operator reads how to move their installation to a release.
export function upgradeGuideUrl(env = process.env) {
  const doc = env.FLOW_RUNTIME === "replit" ? "docs/REPLIT.md#following-stable-releases" : "docs/SELF_HOSTING.md";
  return `https://github.com/${FLOW_REPOSITORY}/blob/main/${doc}`;
}

export function createUpdateChecker({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  resolve = resolveChannelRelease,
} = {}) {
  let cache = null; // { channel, checkedAt, latest, error }
  let inflight = null;

  async function refresh(channel) {
    const checkedAt = now();
    try {
      const { tag } = await resolve({ channel, slug: FLOW_REPOSITORY, fetchImpl, retryDelayMs: 500 });
      cache = { channel, checkedAt, latest: tag, error: null };
    } catch (error) {
      // A failed check waits out the interval too, so an unreachable GitHub
      // is not asked on every page load.
      cache = { channel, checkedAt, latest: null, error: error?.message || String(error) };
    }
    return cache;
  }

  return {
    /** The update status; `enabled` false (or FLOW_UPDATE_CHECK=off) asks nobody. */
    async status({ enabled = updateCheckEnabled(env) } = {}) {
      const current = deployedBuildStatus(env).release;
      const channel = updateChannel(env, current);
      const base = { enabled, channel, current, latest: null, updateAvailable: false, checkedAt: null, error: null, releaseUrl: null, upgradeUrl: upgradeGuideUrl(env) };
      if (!enabled || !parseReleaseTag(current)) return base;
      if (!cache || cache.channel !== channel || now() - cache.checkedAt >= intervalMs) {
        inflight ??= refresh(channel).finally(() => { inflight = null; });
        await inflight;
      }
      const { latest, error, checkedAt } = cache;
      const updateAvailable = Boolean(latest) && compareReleases(latest, current) > 0;
      return {
        ...base,
        latest,
        updateAvailable,
        checkedAt: new Date(checkedAt).toISOString(),
        error,
        releaseUrl: updateAvailable ? `https://github.com/${FLOW_REPOSITORY}/releases/tag/${latest}` : null,
      };
    },
  };
}
