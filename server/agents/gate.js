import { rateLimit } from '../rate-limit.js';
import { agentLimits } from './settings.js';

// One lease covers authentication, SQL, timeout cleanup and audit. Never release
// that lease while a pool acquisition can still produce a connection.
export function createAgentGate({ pool, verify, resource, limits: input, log = console }) {
  const limits = agentLimits(input);
  let active = 0, pruneAfter = 0;
  const running = new Map(), waiting = new Set();
  const capacity = () => Math.min(limits.fleet, Math.max(0,(pool.options?.max ?? 10)-1));
  // A lease stays held through the audit after a response. A call that comes
  // while a lease is only auditing waits up to a second for it, then is refused.
  const lease = async () => {
    const until = Date.now() + 1000;
    while (active >= capacity()) {
      const left = until - Date.now();
      if (left <= 0) return false;
      await new Promise(resolve => { const timer = setTimeout(done, left); function done() { clearTimeout(timer); waiting.delete(done); resolve(); } waiting.add(done); });
    }
    active++;
    return true;
  };
  const unlease = () => { active--; for (const wake of [...waiting]) wake(); };
  const fail = (res, status, code) => {
    if (res.writableEnded || res.destroyed) return;
    if ([429,503].includes(status) && !res.hasHeader('Retry-After')) res.set('Retry-After', '60');
    return res.status(status).json({ ok: false, code, error: 'Agent access refused. Check the connection in Flow.' });
  };
  const rates = [[60000,limits.minute,'agent-minute'],[86400000,limits.day,'agent-day']].map(([windowMs,limit,identifier]) => rateLimit({
    windowMs, limit, identifier, keyGenerator: req => req.agent.grant.id,
    handler(req,res) { req.agent.record('protocol',0,429); fail(res,429,'agent_rate'); },
  }));
  const rate = (middleware,req,res) => new Promise((resolve,reject) => {
    const end = () => { res.removeListener('finish',end); resolve(false); };
    res.once('finish',end);
    middleware(req,res,error => { res.removeListener('finish',end); error ? reject(error) : resolve(true); });
  });
  async function audit(client,grant,tool,status,count,started) {
    await client.query('INSERT INTO agent_audit (grant_id,person_id,tool,status,row_count,duration_ms) VALUES ($1,$2,$3,$4,$5,$6)', [grant.id,grant.person_id,tool,status,count,Math.min(Date.now()-started,2147483647)]);
    if (status >= 400 && !grant.paused_at) {
      const { rows } = await client.query(
        "UPDATE agent_grants SET failure_count = CASE WHEN failure_day = (now() AT TIME ZONE 'UTC')::date THEN failure_count + 1 ELSE 1 END, failure_day = (now() AT TIME ZONE 'UTC')::date, paused_at = CASE WHEN paused_at IS NOT NULL THEN paused_at WHEN (CASE WHEN failure_day = (now() AT TIME ZONE 'UTC')::date THEN failure_count + 1 ELSE 1 END) >= $2 THEN now() ELSE NULL END WHERE id=$1 RETURNING failure_count,paused_at", [grant.id,limits.failures]);
      if (rows[0]?.failure_count === limits.failures) log.error?.('[mcp] grant paused'); else log.warn?.('[mcp] refused or failed call');
    } else if (status >= 400) log.warn?.('[mcp] grant paused');
    if (Date.now() >= pruneAfter) {
      // No scheduler or unbounded delete. Each call removes at most 100 old rows.
      await client.query("DELETE FROM agent_audit WHERE id IN (SELECT id FROM agent_audit WHERE created_at < now() - interval '35 days' ORDER BY created_at LIMIT 100)");
      pruneAfter = Date.now() + 60000;
    }
  }
  const handle = handler => async (req,res) => {
    if (!await lease()) return fail(res,429,'agent_capacity');
    const started = Date.now(), controller = new AbortController();
    let client, acquiring, grant, ownConcurrency = false, status = 200, count = 0, tool = 'protocol', expired = false;
    // pg.Pool has no per-acquisition cancellation. Bound only the MCP wait,
    // keep the lease until the queued acquisition settles, and discard its
    // late connection before it can run SQL. Ordinary pool callers are unchanged.
    const acquire = async () => {
      let late = false, timeout;
      acquiring = pool.connect();
      try {
        return await Promise.race([
          acquiring.then(held => {
            if (late) { held.release(true); throw new Error('Agent acquisition expired'); }
            return held;
          }),
          new Promise((_resolve,reject) => {
            timeout = setTimeout(() => { late = true; reject(new Error('Agent acquisition timeout')); },1000);
          }),
        ]);
      } finally { clearTimeout(timeout); }
    };
    let wake;
    const deadline = new Promise(resolve => { wake = resolve; });
    const expire = () => {
      if (expired) return;
      expired = true; status = 408;
      controller.abort();
      if (client) { const held = client; client = undefined; held.release(true); }
      if (!res.headersSent) fail(res,408,'agent_timeout'); else if (!res.writableEnded) res.destroy();
      wake();
    };
    const timer = setTimeout(expire, limits.deadlineMs);
    const disconnected = () => { if (!res.writableEnded) expire(); };
    res.once('close',disconnected);
    const check = () => { if (expired) throw new Error('Agent deadline'); };
    const work = (async () => {
      const auth = await verify(req.get('authorization'), { signal: controller.signal });
      check();
      if (!auth) {
        status = 401;
        res.set('WWW-Authenticate','Bearer resource_metadata="' + new URL('/.well-known/oauth-protected-resource/mcp',resource).href + '"');
        return fail(res,401,'invalid_token');
      }
      const held = await acquire();
      if (expired) { held.release(true); return; }
      client = held;
      await client.query("SELECT set_config('statement_timeout',$1,false)",[String(limits.statementMs)]);
      check();
      const { rows } = await client.query("SELECT g.id,g.person_id,g.organisation_id,g.paused_at FROM agent_grants g JOIN people p ON p.id=g.person_id JOIN organisations o ON o.id=g.organisation_id WHERE p.clerk_user_id=$1 AND p.status='active' AND p.role IN ('owner','admin','staff') AND g.client_id=$2 AND g.resource=$3 AND g.revoked_at IS NULL AND g.access_level='read' LIMIT 1",[auth.extra.userId,auth.clientId,resource]);
      check(); grant = rows[0];
      if (!grant) { status=401; return fail(res,401,'invalid_token'); }
      req.agent = {
        grant, auth, limits, check,
        get client() { check(); return client; },
        record(name,n=0,code=200) { if (!expired) { tool=name; count=n; status=code; } },
      };
      if (grant.paused_at) { status=403; return fail(res,403,'grant_paused'); }
      for (const limiter of rates) if (!await rate(limiter,req,res)) return;
      check();
      if ((running.get(grant.id)??0) >= limits.concurrent) { status=429; return fail(res,429,'agent_concurrency'); }
      running.set(grant.id,(running.get(grant.id)??0)+1); ownConcurrency=true;
      const pending = await client.query("SELECT 1 FROM background_jobs WHERE state='queued' AND run_after<=now() LIMIT $1",[limits.queue+1]);
      check();
      if (pending.rows.length>limits.queue) { status=503; return fail(res,503,'worker_busy'); }
      await client.query("UPDATE agent_grants SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",[grant.id]);
      check();
      await handler(req,res);
    })();
    // The grant's slot covers its work, not the audit after the response: a
    // client that sends its next call at once must not meet its own last call.
    const freed = () => {
      if (!ownConcurrency) return;
      ownConcurrency = false;
      const n = running.get(grant.id) - 1; n ? running.set(grant.id,n) : running.delete(grant.id);
    };
    work.then(freed, freed);
    try { await Promise.race([work,deadline]); }
    catch { if (!expired) { status=503; fail(res,503,'agent_unavailable'); } }
    finally {
      clearTimeout(timer); res.removeListener('close',disconnected);
      // Aborted Clerk workers terminate their sockets. A non-cancellable pool
      // wait retains this lease even after its MCP timeout response, so there
      // can never be more pending acquisitions than agent leases.
      await Promise.allSettled([acquiring]);
      try {
        if (!client && grant) client = await acquire();
        if (client) {
          await client.query("SELECT set_config('statement_timeout',$1,false)",[String(limits.statementMs)]);
          if (grant) await audit(client,grant,tool,status,count,started);
          await client.query('RESET statement_timeout');
          client.release(); client=undefined;
        }
      } catch { if (client) { client.release(true); client=undefined; } log.warn?.('[mcp] audit unavailable'); }
      await Promise.allSettled([acquiring]);
      unlease();
    }
  };
  return { handle, fail, limits };
}
export async function readOnly(client,fn,statementMs=5000) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SELECT set_config('statement_timeout',$1,true)",[String(statementMs)]);
    await client.query("SET LOCAL lock_timeout='1s'");
    return await fn(client);
  } finally { await client.query('ROLLBACK'); }
}
