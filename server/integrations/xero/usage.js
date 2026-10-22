import { sql } from 'drizzle-orm';
import { assembleUsage, startOfUtcDay } from '../../ui/xero-usage-model.js';

// What the Xero card draws. Read from counters Flow already keeps: the
// governor's budget, the call log, and the copy's own timestamps. No Xero call.

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (value) => (value ? new Date(value).toISOString() : null);

// Calls that count toward the day's budget. A token refresh is recorded, and
// it is not an Accounting API call, so it stays out of the lanes.
const BUDGET_CALL = sql`lane is not null and coalesce(resource, '') <> 'token'`;

export async function readXeroUsage(db, { organisationId, tenantId, governor, warningFraction, refreshedAt, now = Date.now() }) {
  const at = Number(now);
  const dayStart = startOfUtcDay(at);
  const weekStart = new Date(dayStart - 6 * DAY_MS);
  const dayEnd = new Date(dayStart + DAY_MS);
  const today = new Date(dayStart);

  const [hours, days, tasks, limited, freshness] = await Promise.all([
    db.execute(sql`
      select to_char(date_trunc('hour', "at" at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"') as hour,
             lane, count(*)::int as n
      from xero_calls
      where key = ${tenantId} and "at" >= ${today} and "at" < ${dayEnd} and ${BUDGET_CALL}
      group by 1, 2`),
    db.execute(sql`
      select to_char("at" at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
      from xero_calls
      where key = ${tenantId} and "at" >= ${weekStart} and "at" < ${dayEnd} and ${BUDGET_CALL}
      group by 1`),
    db.execute(sql`
      select coalesce(nullif(resource, ''), 'call') as task, count(*)::int as n
      from xero_calls
      where key = ${tenantId} and "at" >= ${today} and "at" < ${dayEnd} and coalesce(resource, '') <> 'token'
      group by 1
      order by n desc, task
      limit 8`),
    db.execute(sql`
      select "at", rate_limit_problem as problem, lane, resource as task
      from xero_calls
      where key = ${tenantId} and status_code = 429 and "at" >= ${weekStart}
      order by "at" desc
      limit 12`),
    db.execute(sql`
      select
        (select max(received_at) from xero_webhook_events where organisation_id = ${organisationId} and source = 'webhook') as webhook_at,
        (select max(last_read_at) from xero_mirror_cursors where organisation_id = ${organisationId}) as poll_at,
        (select last_finished_at from xero_daily_checks where organisation_id = ${organisationId}) as nightly_at,
        (select max(read_at) from xero_webhook_events where organisation_id = ${organisationId}) as read_at`),
  ]);

  const fresh = freshness.rows[0] ?? {};
  const copyCandidates = [fresh.poll_at, fresh.nightly_at, fresh.read_at].filter(Boolean).map((value) => new Date(value).getTime());
  return {
    usage: assembleUsage({
      hourRows: hours.rows,
      dayRows: days.rows,
      taskRows: tasks.rows,
      limitRows: limited.rows,
      governor,
      warningFraction,
      now: at,
    }),
    freshness: {
      webhookAt: iso(fresh.webhook_at),
      pollAt: iso(fresh.poll_at),
      nightlyAt: iso(fresh.nightly_at),
      copyAt: copyCandidates.length ? new Date(Math.max(...copyCandidates)).toISOString() : null,
      tokenRefreshedAt: iso(refreshedAt),
    },
  };
}
