import { LANES } from './lanes.js';
import { readLaneStates } from './store.js';

// The background sync, for live mode only (issue #10: index.js never creates
// it in sandbox or replay). It runs the lanes that are due, then sleeps until
// the next lane is due, between 15 seconds and 30 minutes. One run at a time.
// A stopped lane (issue #101) is not due until a person or a release resets it.
//
// Issue #101: each held failure is reported once to the error services
// (log.error, server/core/monitoring.js): when a lane starts failing or its
// failure code changes, and when records are quarantined. A repeat of the
// same failure is a warning in the host log only. The report text is stable,
// so the error service groups repeats.

const MIN_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30 * 60_000;

export function createSeazonaScheduler({
  db,
  settings = null,
  run,
  now = Date.now,
  log = console,
  timers = { setTimeout, clearTimeout },
  firstDelayMs = 5_000,
} = {}) {
  let timer = null;
  let running = null;
  let stopped = false;
  let nextRunAt = null;
  let last = null;
  // lane -> the failure code last reported, while that lane keeps failing.
  const reported = new Map();
  const quarantineAt = settings?.sync?.orderQuarantineFailures ?? null;

  function newlyQuarantined(outcome) {
    if (Number.isInteger(outcome.newlyQuarantined)) return outcome.newlyQuarantined;
    const failures = outcome.failureDetails?.failures ?? [];
    return failures.filter((f) => f.quarantinedUntil && f.failureCount === quarantineAt).length;
  }

  function report(results) {
    for (const [lane, outcome] of Object.entries(results)) {
      if (outcome.ok) {
        reported.delete(lane);
        const count = newlyQuarantined(outcome);
        if (count) log.error?.(`[seazona] ${lane}: records quarantined after repeated failed reads`);
        // Issue #126: what the sweep found, once per run that found it.
        for (const line of outcome.reports ?? []) log.error?.(`[seazona] ${lane}: ${line}`);
        continue;
      }
      if (reported.get(lane) === outcome.code) {
        log.warn?.(`[seazona] ${lane}: ${outcome.error}`);
        continue;
      }
      reported.set(lane, outcome.code);
      log.error?.(`[seazona] ${lane} lane ${outcome.status === 'stopped' ? 'stopped' : 'failed'}: ${outcome.code}`);
      log.warn?.(`[seazona] ${lane}: ${outcome.error}`);
    }
  }

  async function nextDelayMs() {
    const states = await readLaneStates(db);
    let soonest = Infinity;
    for (const lane of LANES) {
      if (states.get(lane)?.status === 'stopped') continue;
      const at = states.get(lane)?.nextRunAt?.getTime();
      soonest = Math.min(soonest, Number.isFinite(at) ? at - Number(now()) : 0);
    }
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, soonest));
  }

  function schedule(delayMs) {
    if (stopped) return;
    nextRunAt = new Date(Number(now()) + delayMs).toISOString();
    timer = timers.setTimeout(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    running = (async () => {
      const startedAt = new Date(Number(now())).toISOString();
      try {
        const result = await run();
        const failed = Object.entries(result.results).filter(([, lane]) => !lane.ok);
        last = { at: startedAt, ok: result.ok, lanes: Object.keys(result.results), failed: failed.map(([lane]) => lane) };
        report(result.results);
      } catch (error) {
        last = { at: startedAt, ok: false, error: error?.message || String(error) };
        log.error?.(`[seazona] sync run failed: ${last.error}`);
      }
    })();
    await running;
    running = null;
    schedule(await nextDelayMs().catch(() => MIN_DELAY_MS));
  }

  return {
    start() {
      stopped = false;
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      nextRunAt = null;
      await running;
    },
    status() {
      return { running: Boolean(running), nextRunAt, lastRun: last };
    },
  };
}
