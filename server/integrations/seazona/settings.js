// Seazona adapter settings. Everything that names an installation (the API
// host, the API client) comes from configuration; the code holds no default
// host or account. docs/SEAZONA.md lists every setting.
//
// The mode says which environment the adapter acts on (issue #10):
//   live     the installation's real Seazona account; the scheduler runs.
//   sandbox  a Seazona test account; runs only when asked, never on a timer.
//   replay   recorded, synthetic responses from a file; no network at all.
// There is no default mode. Without one the adapter does nothing.

export const MODES = Object.freeze(['live', 'sandbox', 'replay']);

// Seazona publishes 60 requests a minute per API client. Flow stays at half of
// that, across every process that shares the database, and a setting can only
// lower it.
export const PUBLISHED_REQUESTS_PER_MINUTE = 60;
export const MAX_REQUESTS_PER_MINUTE = 30;

const DAY_MS = 24 * 60 * 60_000;

export class SeazonaSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeazonaSettingsError';
    this.code = 'seazona_settings_invalid';
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// SEAZONA_API_BASE_URL is the API root, with or without /v1. It must be https:
// the API takes basic authentication.
export function normaliseBaseUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SeazonaSettingsError('SEAZONA_API_BASE_URL is not a URL');
  }
  if (url.protocol !== 'https:') throw new SeazonaSettingsError('SEAZONA_API_BASE_URL must use https');
  if (url.search || url.hash || url.username || url.password) {
    throw new SeazonaSettingsError('SEAZONA_API_BASE_URL must be a plain address with no query, fragment or credentials');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${url.origin}${path}/v1`;
}

// Returns the resolved settings, or throws SeazonaSettingsError. `mode` is
// null when SEAZONA_MODE is unset: the adapter is then not configured.
export function resolveSeazonaSettings(env = process.env) {
  const modeText = text(env.SEAZONA_MODE).toLowerCase();
  if (modeText && !MODES.includes(modeText)) {
    throw new SeazonaSettingsError(`SEAZONA_MODE must be one of ${MODES.join(', ')}`);
  }
  const mode = modeText || null;

  const rate = {
    requestsPerMinute: clampInt(env.SEAZONA_API_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE, 1, MAX_REQUESTS_PER_MINUTE),
    publishedLimitPerMinute: PUBLISHED_REQUESTS_PER_MINUTE,
    // Retries cover 429 and 5xx answers only. Every attempt counts against
    // the limit, so keep this small.
    maxRetries: clampInt(env.SEAZONA_API_MAX_RETRIES, 2, 0, 6),
    timeoutMs: clampInt(env.SEAZONA_API_TIMEOUT_MS, 30_000, 1_000, 120_000),
    // How long one request may wait for a free slot before it gives up.
    maxWaitMs: clampInt(env.SEAZONA_API_MAX_WAIT_MS, 120_000, 1_000, 15 * 60_000),
    // Long enough to answer a vendor's question about last month.
    telemetryRetentionMs: clampInt(env.SEAZONA_API_TELEMETRY_RETENTION_DAYS, 35, 1, 90) * DAY_MS,
    // Issue #101: a vendor can cut off API access after many failed calls,
    // even inside the rate limit. This many failed calls inside the window
    // open the circuit: no call goes out for the pause, which doubles each
    // time the probe after it fails, to at most 6 hours.
    circuitFailures: clampInt(env.SEAZONA_CIRCUIT_FAILURES, 5, 1, 100),
    circuitWindowMs: clampInt(env.SEAZONA_CIRCUIT_WINDOW_MS, 10 * 60_000, 60_000, DAY_MS),
    circuitPauseMs: clampInt(env.SEAZONA_CIRCUIT_PAUSE_MS, 5 * 60_000, 60_000, 6 * 60 * 60_000),
    // Failed calls allowed in one UTC day. When they are spent, calls stop
    // until the next day.
    dailyFailureBudget: clampInt(env.SEAZONA_DAILY_FAILURE_BUDGET, 50, 1, 10_000),
  };

  const MINUTE = 60_000;
  const ms = (name, fallback, min, max) => clampInt(env[name], fallback, min, max);
  const sync = {
    // How often each lane runs in live mode, and how old its data may get
    // before /health calls it stale.
    lanes: {
      invoices: { cadenceMs: ms('SEAZONA_INVOICE_CADENCE_MS', 2 * MINUTE, MINUTE, DAY_MS), freshnessMs: 10 * MINUTE },
      orders_recent: { cadenceMs: ms('SEAZONA_ORDER_CADENCE_MS', 5 * MINUTE, MINUTE, DAY_MS), freshnessMs: 15 * MINUTE },
      orders_active: { cadenceMs: ms('SEAZONA_ACTIVE_ORDER_CADENCE_MS', 5 * MINUTE, MINUTE, DAY_MS), freshnessMs: 30 * MINUTE },
      clients: { cadenceMs: ms('SEAZONA_CLIENT_CADENCE_MS', 30 * MINUTE, MINUTE, DAY_MS), freshnessMs: 60 * MINUTE },
      products: { cadenceMs: ms('SEAZONA_REFERENCE_CADENCE_MS', DAY_MS, MINUTE, 30 * DAY_MS), freshnessMs: 2 * DAY_MS },
      users: { cadenceMs: ms('SEAZONA_REFERENCE_CADENCE_MS', DAY_MS, MINUTE, 30 * DAY_MS), freshnessMs: 2 * DAY_MS },
    },
    // Re-read this much before a lastModified cursor, so a change written
    // while the last run was reading is not missed.
    cursorOverlapMs: 5 * MINUTE,
    // The recent-order lane reads orders placed in the last N days, a few
    // days per run, page by page (GET orders/?ordered=&page=&pageSize=).
    orderLookbackDays: clampInt(env.SEAZONA_ORDER_LOOKBACK_DAYS, 30, 1, 3650),
    orderDaysPerRun: clampInt(env.SEAZONA_ORDER_DAYS_PER_RUN, 6, 1, 31),
    // The first invoice run reads from the start of today (UTC) minus this.
    invoiceLookbackDays: clampInt(env.SEAZONA_INVOICE_LOOKBACK_DAYS, 0, 0, 3650),
    // A list this long may be cut off, so the lane reads on (issue #125):
    // the next part of a changed list from its last row, the next order
    // page. Also the order page size (at most 500).
    listCap: clampInt(env.SEAZONA_LIST_CAP, 50, 1, 10_000),
    // A lane makes at most this many list calls a run; the next run goes on
    // from where it stopped.
    listPagesPerRun: clampInt(env.SEAZONA_LIST_PAGES_PER_RUN, 10, 1, 100),
    // The active-order lane re-reads this many open orders per run, oldest first.
    activeOrdersPerRun: clampInt(env.SEAZONA_ACTIVE_ORDERS_PER_RUN, 25, 1, 500),
    // Issue #12: after this many failed reads in a row an order waits this long.
    orderQuarantineFailures: clampInt(env.SEAZONA_ORDER_QUARANTINE_FAILURES, 3, 1, 20),
    orderQuarantineMs: ms('SEAZONA_ORDER_QUARANTINE_MS', DAY_MS, 5 * MINUTE, 30 * DAY_MS),
    // A failed lane waits 1 minute, doubling to at most 6 hours.
    retryBaseMs: MINUTE,
    retryMaxMs: 6 * 60 * MINUTE,
    heldRetryMs: 60 * MINUTE,
    // A lane marked as running for longer than this is taken to have died.
    stuckLaneMs: 20 * MINUTE,
    // VISION.md: Flow keeps a patient reference only where an invoice must
    // print one. Off by default; on, orders and invoices keep Seazona's
    // patient field as the reference.
    keepPatientReference: ['1', 'true', 'on', 'yes'].includes(text(env.SEAZONA_KEEP_PATIENT_REFERENCE).toLowerCase()),
  };

  const settings = {
    mode,
    sync,
    baseUrl: '',
    credentials: null,
    replayFile: '',
    rate,
    // The scheduler starts only in live mode (issue #10).
    scheduled: mode === 'live',
  };

  if (mode === 'live' || mode === 'sandbox') {
    settings.baseUrl = normaliseBaseUrl(env.SEAZONA_API_BASE_URL);
    if (!settings.baseUrl) throw new SeazonaSettingsError(`SEAZONA_API_BASE_URL is required in ${mode} mode`);
    const clientId = text(env.SEAZONA_API_CLIENT_ID);
    const clientSecret = text(env.SEAZONA_API_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new SeazonaSettingsError(`SEAZONA_API_CLIENT_ID and SEAZONA_API_CLIENT_SECRET are required in ${mode} mode`);
    }
    settings.credentials = { clientId, clientSecret };
  } else if (mode === 'replay') {
    settings.replayFile = text(env.SEAZONA_REPLAY_FILE);
    if (!settings.replayFile) throw new SeazonaSettingsError('SEAZONA_REPLAY_FILE is required in replay mode');
    // Replay never reaches a network, so the address is only a label.
    settings.baseUrl = 'https://seazona.replay.invalid/v1';
  }

  return settings;
}

// What /health and Settings may show. Never the credentials or the host.
export function describeSeazonaSettings(settings) {
  return {
    mode: settings?.mode ?? null,
    configured: Boolean(settings?.mode),
    scheduled: Boolean(settings?.scheduled),
    requestsPerMinute: settings?.rate?.requestsPerMinute ?? null,
    publishedLimitPerMinute: PUBLISHED_REQUESTS_PER_MINUTE,
  };
}
