import { AsyncLocalStorage } from 'node:async_hooks';

// Xero rate-limit governor. Every Xero API call passes through it.
//
// Xero's limits, per connected organisation (tenant) unless noted: 5 calls
// at once, 60 a minute, a daily limit that depends on the app's plan (1,000
// on Starter, 5,000 on Core and above), and 10,000 a minute across all
// tenants of one app. The governor keeps one call and five a minute of
// headroom, so a 429 comes only from the app-wide bucket or a quota change
// Flow could not see. The daily limit starts at XERO_DAY_LIMIT and follows
// Xero's X-DayLimit-Remaining header once a response shows it.
//
// State is per process and per tenant: a counting semaphore, a sliding
// one-minute window, a day counter, and a circuit that opens when Xero says
// the day's calls are used up. One Flow process serves one lab.

// Each call counts against the lane that made it, so status shows where the
// day's budget went. Callers set the lane with withXeroLane().
export const XERO_LANES = Object.freeze(['writes', 'sync', 'reads', 'other']);
const laneStorage = new AsyncLocalStorage();

export function withXeroLane(lane, fn) {
  return laneStorage.run(XERO_LANES.includes(lane) ? lane : 'other', fn);
}

export function currentXeroLane() {
  return laneStorage.getStore() || 'other';
}

export const DEFAULT_GOVERNOR_CONFIG = Object.freeze({
  maxConcurrent: 4,
  maxPerMinute: 55,
  dayLimit: 1000,
  usageWarningFraction: 0.7,
  appMinuteLimit: 10000,
  minuteWindowMs: 60_000,
  dayMs: 24 * 60 * 60 * 1000,
  maxRetrySleepMs: 60_000,
});

function dayKeyOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function circuitOpenError(circuit, now) {
  const error = new Error(`Xero rate-limit circuit open (${circuit.reason}).`);
  error.code = 'xero_rate_limited';
  error.status = 429;
  error.retryAfterMs = Math.max(0, circuit.until - now);
  return error;
}

export function createGovernor({ config: overrides = {}, now = Date.now, random = Math.random, sleep, log = console } = {}) {
  const config = { ...DEFAULT_GOVERNOR_CONFIG, ...overrides };
  const sleepFn = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tenants = new Map();
  const appMinuteWindow = [];

  function tenantState(tenantId) {
    const key = String(tenantId || 'unknown');
    if (!tenants.has(key)) {
      tenants.set(key, {
        tenantId: key,
        inFlight: 0,
        waiters: [],
        minuteWindow: [],
        dayCount: 0,
        dayKey: dayKeyOf(now()),
        laneCounts: {},
        observedDayLimit: null,
        observedDayRemaining: null,
        observedMinuteRemaining: null,
        observedAppMinuteRemaining: null,
        warnedDayKey: null,
        circuit: { state: 'closed', reason: '', openedAt: 0, until: 0 },
        wakeScheduled: false,
      });
    }
    return tenants.get(key);
  }

  function prune(window, at) {
    while (window.length && window[0] <= at - config.minuteWindowMs) window.shift();
  }

  function rollover(tenant) {
    const today = dayKeyOf(now());
    if (tenant.dayKey === today) return;
    tenant.dayKey = today;
    tenant.dayCount = 0;
    tenant.laneCounts = {};
    if (tenant.circuit.state === 'open' && tenant.circuit.reason === 'DayLimit') {
      tenant.circuit = { state: 'closed', reason: '', openedAt: 0, until: 0 };
    }
  }

  // Xero's own count wins once a response has shown it.
  function dayLimitOf(tenant) {
    return Number.isFinite(tenant.observedDayLimit) && tenant.observedDayLimit > 0
      ? tenant.observedDayLimit
      : config.dayLimit;
  }

  function count(tenant, lane) {
    tenant.dayCount += 1;
    tenant.laneCounts[lane] = (tenant.laneCounts[lane] || 0) + 1;
    const limit = dayLimitOf(tenant);
    if (tenant.warnedDayKey !== tenant.dayKey && tenant.dayCount >= limit * config.usageWarningFraction) {
      tenant.warnedDayKey = tenant.dayKey;
      log.warn?.(`[xero] ${tenant.dayCount} of ${limit} Xero calls used today (${Math.round(config.usageWarningFraction * 100)}% warning). By lane: ${JSON.stringify(tenant.laneCounts)}`);
    }
  }

  function checkCircuit(tenant) {
    const at = now();
    if (tenant.circuit.state === 'open' && tenant.circuit.until && at >= tenant.circuit.until) {
      tenant.circuit = { ...tenant.circuit, state: 'half_open', until: 0 };
    }
    if (tenant.circuit.state === 'open') throw circuitOpenError(tenant.circuit, at);
  }

  function hasRoom(tenant) {
    return tenant.inFlight < config.maxConcurrent
      && tenant.minuteWindow.length < config.maxPerMinute
      && appMinuteWindow.length < config.appMinuteLimit;
  }

  function take(tenant, lane) {
    const at = now();
    tenant.inFlight += 1;
    tenant.minuteWindow.push(at);
    appMinuteWindow.push(at);
    count(tenant, lane);
  }

  function admitWaiting(tenant) {
    while (tenant.waiters.length && tenant.inFlight < config.maxConcurrent) {
      const at = now();
      prune(tenant.minuteWindow, at);
      prune(appMinuteWindow, at);
      if (!hasRoom(tenant)) {
        scheduleWake(tenant);
        return;
      }
      const waiter = tenant.waiters.shift();
      take(tenant, waiter.lane);
      waiter.resolve();
    }
  }

  function scheduleWake(tenant) {
    if (!tenant.waiters.length || tenant.wakeScheduled) return;
    const at = now();
    prune(tenant.minuteWindow, at);
    prune(appMinuteWindow, at);
    const wakeTimes = [];
    if (tenant.minuteWindow.length >= config.maxPerMinute) wakeTimes.push(tenant.minuteWindow[0] + config.minuteWindowMs);
    if (appMinuteWindow.length >= config.appMinuteLimit) wakeTimes.push(appMinuteWindow[0] + config.minuteWindowMs);
    const waitMs = wakeTimes.length ? Math.max(10, Math.max(...wakeTimes) - at) : 100;
    tenant.wakeScheduled = true;
    Promise.resolve(sleepFn(waitMs)).then(() => {
      tenant.wakeScheduled = false;
      admitWaiting(tenant);
    }, () => {
      tenant.wakeScheduled = false;
      scheduleWake(tenant);
    });
  }

  async function acquire(tenantId) {
    const tenant = tenantState(tenantId);
    rollover(tenant);
    checkCircuit(tenant);
    if (tenant.dayCount >= dayLimitOf(tenant)) {
      tripCircuit(tenantId, 'DayLimit', config.dayMs);
      checkCircuit(tenant);
    }
    const lane = currentXeroLane();
    const at = now();
    prune(tenant.minuteWindow, at);
    prune(appMinuteWindow, at);
    if (!tenant.waiters.length && hasRoom(tenant)) {
      take(tenant, lane);
      return;
    }
    await new Promise((resolve) => {
      tenant.waiters.push({ resolve, lane });
      scheduleWake(tenant);
    });
  }

  function release(tenantId) {
    const tenant = tenantState(tenantId);
    tenant.inFlight = Math.max(0, tenant.inFlight - 1);
    admitWaiting(tenant);
  }

  // Folds in Xero's rate-limit headers (see readRateLimitHeaders).
  function observe(tenantId, info) {
    if (!info) return;
    const tenant = tenantState(tenantId);
    if (typeof info.dayRemaining === 'number') {
      tenant.observedDayRemaining = info.dayRemaining;
      // Calls made today plus what Xero says is left. Xero's day does not
      // reset at UTC midnight, so this is an estimate the next response
      // corrects.
      tenant.observedDayLimit = Math.max(1, tenant.dayCount + info.dayRemaining);
      if (info.dayRemaining <= 0) tripCircuit(tenantId, 'DayLimit', config.dayMs);
    }
    if (typeof info.minuteRemaining === 'number') tenant.observedMinuteRemaining = info.minuteRemaining;
    if (typeof info.appMinuteRemaining === 'number') tenant.observedAppMinuteRemaining = info.appMinuteRemaining;
  }

  function tripCircuit(tenantId, reason, durationMs) {
    const tenant = tenantState(tenantId);
    const at = now();
    tenant.circuit = { state: 'open', reason: String(reason || 'Unknown'), openedAt: at, until: at + Math.max(1000, Number(durationMs) || 0) };
  }

  // How long to wait before retrying a 429, by Xero's X-Rate-Limit-Problem.
  // Never more than a minute inside one request: a longer wait fails fast and
  // the circuit and the caller decide when to try again.
  function retryDelayMs(problem, retryAfterMs) {
    const jitter = Math.floor(random() * 500);
    const hinted = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    const clamp = (ms) => Math.max(0, Math.min(config.maxRetrySleepMs, ms));
    switch (problem) {
      case 'ConcurrentLimit':
        return clamp((hinted ?? 200) + jitter);
      case 'MinuteLimit':
      case 'AppMinuteLimit':
        if (hinted !== null) return clamp(hinted + jitter);
        return clamp(60_000 - (now() % 60_000) + jitter);
      case 'DayLimit':
        return 0;
      default:
        return clamp((hinted ?? 1000) + jitter);
    }
  }

  function status(tenantId) {
    const tenant = tenantState(tenantId);
    rollover(tenant);
    const at = now();
    prune(tenant.minuteWindow, at);
    prune(appMinuteWindow, at);
    const dayLimit = dayLimitOf(tenant);
    return {
      inFlight: tenant.inFlight,
      waiting: tenant.waiters.length,
      minuteUsed: tenant.minuteWindow.length,
      minuteMax: config.maxPerMinute,
      dayCount: tenant.dayCount,
      dayLimit,
      dayLimitSource: Number.isFinite(tenant.observedDayLimit) ? 'xero' : 'setting',
      dayRemaining: Math.max(0, dayLimit - tenant.dayCount),
      usageWarning: tenant.dayCount >= dayLimit * config.usageWarningFraction,
      laneCounts: { ...tenant.laneCounts },
      observedDayRemaining: tenant.observedDayRemaining,
      observedMinuteRemaining: tenant.observedMinuteRemaining,
      circuit: { ...tenant.circuit },
    };
  }

  return {
    config,
    acquire,
    release,
    observe,
    tripCircuit,
    retryDelayMs,
    status,
    sleep: (ms) => sleepFn(ms),
  };
}
