// What GET /health says about each integration: whether it is on, its state,
// and, when it is ready, its own health() answer (issue #10: each adapter's
// mode). An adapter's health reads Flow's own data and must answer quickly;
// one that fails or takes longer than `timeoutMs` is reported, never thrown.
export async function integrationsHealth(registry, { timeoutMs = 5_000 } = {}) {
  return Promise.all(registry.list().map(async (adapter) => {
    const entry = { id: adapter.id, name: adapter.name, enabled: adapter.enabled, state: adapter.state };
    if (adapter.state !== 'ready' || !adapter.capabilities.includes('health')) return entry;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `health did not answer within ${timeoutMs} ms` }), timeoutMs);
    });
    const answer = registry.whenEnabled(adapter.id, (defined) => defined.capabilities.health())
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
    try {
      return { ...entry, health: await Promise.race([answer, timeout]) };
    } finally {
      clearTimeout(timer);
    }
  }));
}
