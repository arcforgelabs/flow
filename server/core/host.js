// Where this copy of Flow runs. A Replit workspace (the editor's Run button)
// shares its secrets with the published app, so without a rule it would sync,
// draft and send next to the live copy: twice the calls to Xero and Seazona,
// and a second sender. FLOW_BACKGROUND_JOBS decides; unset, it is off in a
// Replit workspace and on everywhere else (docs/SELF_HOSTING.md).

const read = (env, name) => String(env?.[name] ?? '').trim();

// Express counts trusted proxy hops from the app, not from the client.
export function resolveTrustProxy(env = process.env) {
  const value = read(env, 'FLOW_TRUST_PROXY_HOPS');
  if (!value) return read(env, 'REPL_ID') || read(env, 'REPLIT_DEPLOYMENT') ? 1 : false;
  const hops = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(hops)) {
    throw new Error('FLOW_TRUST_PROXY_HOPS must be a non-negative safe integer');
  }
  return hops;
}

// Replit sets REPL_ID in the workspace and REPLIT_DEPLOYMENT on the published
// app only.
export function isReplitWorkspace(env = process.env) {
  return Boolean(read(env, 'REPL_ID')) && !read(env, 'REPLIT_DEPLOYMENT');
}

// Whether this copy runs the jobs that call or write to other systems: the
// Seazona sync, the Xero read, the pipeline, the daily reconcile and the send
// worker. Off, it also never writes to Xero.
export function backgroundJobsOn(env = process.env) {
  const value = read(env, 'FLOW_BACKGROUND_JOBS').toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  if (value) throw new Error('FLOW_BACKGROUND_JOBS must be "on", "off" or unset');
  return !isReplitWorkspace(env);
}
