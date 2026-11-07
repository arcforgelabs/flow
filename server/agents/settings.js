// Bounds may reduce work or increase a limit only within the documented ceiling.
export const AGENT_LIMITS = Object.freeze({ minute: 60, day: 3000, concurrent: 2, fleet: 3, queue: 100, deadlineMs: 15000, statementMs: 5000, rows: 100, bytes: 524288, text: 16000, body: 102400, failures: 20 });
const ceilings = { minute: 120, day: 6000, concurrent: 2, fleet: 3, queue: 1000, deadlineMs: 15000, statementMs: 5000, rows: 100, bytes: 524288, text: 16000, body: 102400, failures: 20 };
export function agentLimits(input = {}) {
  for (const key of Object.keys(input)) if (!(key in ceilings)) throw new Error('Unknown MCP limit');
  const limits = { ...AGENT_LIMITS, ...input };
  const floors = { bytes: 32768, text: 512, body: 1024, deadlineMs: 50 };
  for (const [key,min] of Object.entries(floors)) if (limits[key] < min) throw new Error('Invalid MCP limit: ' + key);
  for (const [key, value] of Object.entries(limits)) if (!Number.isInteger(value) || value < 1 || value > ceilings[key]) throw new Error('Invalid MCP limit: ' + key);
  return Object.freeze(limits);
}
// The resource identity comes from deployment settings, never request headers.
export function resolveMcpSettings(env = process.env) {
  if (!env.FLOW_MCP || env.FLOW_MCP === 'off') return null;
  if (env.FLOW_MCP !== 'on') throw new Error('FLOW_MCP must be on, off or unset');
  const origin = new URL(env.FLOW_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('FLOW_PUBLIC_ORIGIN must be an HTTPS origin for MCP');
  const overrides = {};
  for (const key of Object.keys(AGENT_LIMITS)) {
    const name = 'FLOW_MCP_' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).toUpperCase();
    if (env[name] !== undefined) overrides[key] = Number(env[name]);
  }
  return { resource: new URL('/mcp', origin).href, limits: agentLimits(overrides) };
}
