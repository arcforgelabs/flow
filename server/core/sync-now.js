// Sync now (docs/INTEGRATIONS.md, "Sync now"): a person asks Flow to read its
// systems again now, not at the next background run. An integration takes
// part while its own "Include in Sync now" setting is on, the default. Each
// integration's page also has its own Sync, which reads that one integration
// whatever the setting says. Each read goes through the integration's call guard
// and rate limit, as a background read does. The pipeline joins what they
// bring into jobs at its next run (every 2 minutes).

const named = (adapter, answer) => ({ id: adapter.id, name: adapter.name, ...answer });

// What the Sync now button shows: each integration that can take part,
// whether it does, whether a read is going, and when the last one started.
// Reads Flow's data only.
export async function syncNowStatus(registry) {
  return Promise.all(registry.with('syncNowStatus').map(async (adapter) => {
    try {
      return named(adapter, await adapter.capabilities.syncNowStatus());
    } catch {
      return named(adapter, { included: false, running: false, lastAt: null, ok: null });
    }
  }));
}

// Starts each included integration's read, one after the other, or only the
// integration `only` names. An integration that cannot read answers
// `unavailable` with its reason; the others still run.
export async function startSyncNow(registry, { only = null, actor = null, log = console } = {}) {
  const results = [];
  for (const adapter of registry.with('syncNow').filter((a) => !only || a.id === only)) {
    try {
      results.push(named(adapter, await adapter.capabilities.syncNow({ asked: Boolean(only) })));
    } catch (error) {
      results.push(named(adapter, { state: 'unavailable', reason: error?.message || 'the read failed' }));
    }
  }
  log.info?.(`[sync-now] person ${actor ?? 'unknown'}: ${results.map((r) => `${r.id} ${r.state}`).join(', ') || 'no integration can sync'}`);
  return results;
}
