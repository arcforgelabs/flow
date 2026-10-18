import { LANES } from './lanes.js';
import { readLaneStates } from './store.js';

// The background sync, for live mode only (issue #10: index.js never creates
// it in sandbox or replay). It runs the lanes that are due, then sleeps until
// the next lane is due, between 15 seconds and 30 minutes. One run at a time.

const MIN_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30 * 60_000;

export function createSeazonaScheduler({
  db,
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

  async function nextDelayMs() {
    const states = await readLaneStates(db);
    let soonest = Infinity;
    for (const lane of LANES) {
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
        for (const [lane, outcome] of failed) log.warn?.(`[seazona] ${lane}: ${outcome.error}`);
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
