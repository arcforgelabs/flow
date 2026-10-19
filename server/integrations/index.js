import { adapters as shipped } from './adapters.js';
import { createRegistry } from './port.js';

// FLOW_INTEGRATIONS: the adapter ids to turn on, separated by commas
// (`seazona,xero`). Unset or empty: none. An unknown id stops boot, so a typo
// never leaves an integration silently off.
export function resolveEnabledIntegrations(env = process.env, adapters = shipped) {
  const known = new Set(adapters.map((a) => a.id));
  const ids = [...new Set((env.FLOW_INTEGRATIONS ?? '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))];
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    const offer = known.size ? `Known: ${[...known].join(', ')}.` : 'This build ships no integrations.';
    throw new Error(`FLOW_INTEGRATIONS names an unknown integration: ${unknown.join(', ')}. ${offer}`);
  }
  return ids;
}

// The registry for one Flow process: every shipped adapter registered, the
// chosen ones enabled. `turnedOnInFlow` are the ids an owner turned on in
// Settings (server/integrations/setup.js): one of those that cannot start is
// reported, not fatal. `settingsEnv` is what adapters read as their settings.
// Call registry.start(db) after the core migrations.
export function createIntegrations({ env = process.env, adapters = shipped, log = console, turnedOnInFlow = [], settingsEnv = env } = {}) {
  const enabled = resolveEnabledIntegrations(env, adapters);
  const registry = createRegistry({ log, env: settingsEnv });
  for (const adapter of adapters) registry.register(adapter);
  for (const id of enabled) registry.enable(id);
  for (const id of turnedOnInFlow) {
    if (!enabled.includes(id) && registry.get(id)) registry.enable(id, { optional: true });
  }
  return registry;
}
