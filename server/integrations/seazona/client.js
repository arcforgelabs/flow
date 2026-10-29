import { createHash } from 'node:crypto';
import { createSeazonaGovernor, normaliseRequestPath } from './governor.js';
import { createReplayFetch } from './replay.js';

// The Seazona REST client. It only reads: Flow's billing needs invoices,
// orders, clients, products and users, and none of that writes to Seazona.
//
// Every request goes through the rate governor (governor.js). In live and
// sandbox mode a client without a governor refuses to start, so no code path
// can call Seazona ungoverned. Replay mode answers from a file and never
// reaches a network.

const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// A failed Seazona request. The message names the method, the path and the
// status or failure kind; never the host, the query or a credential.
// kind: http, timeout, network, invalid_json, replay_miss, governor_timeout.
// The governor's own SeazonaCallsStopped (kind calls_stopped) passes through
// unchanged: no call was made.
export class SeazonaApiError extends Error {
  constructor(message, { statusCode = null, kind = 'http', path = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SeazonaApiError';
    this.code = 'seazona_api_request_failed';
    this.statusCode = statusCode;
    this.kind = kind;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

// A stable, non-secret name for one API client, so processes that share the
// database share one rate limit without storing the client id.
export function deriveClientKey(settings) {
  if (settings.mode === 'replay') return 'replay';
  return createHash('sha256')
    .update(`${settings.credentials?.clientId || ''}@${settings.baseUrl}`)
    .digest('hex')
    .slice(0, 24);
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function describeFailure(error) {
  if (error?.name === 'AbortError') return 'timeout';
  if (error?.kind === 'replay_miss') return 'replay_miss';
  return 'network';
}

export function createSeazonaClient({
  settings,
  db = null,
  governor = null,
  fetchImpl = null,
  workflow = 'seazona',
  now = Date.now,
  sleepFn = sleep,
  random = Math.random,
} = {}) {
  if (!settings?.mode) throw new TypeError('The Seazona client needs a mode (SEAZONA_MODE)');
  const { mode, baseUrl, credentials, rate } = settings;

  let transport = fetchImpl;
  if (mode === 'replay') {
    // Replay never falls back to a real fetch.
    transport ??= createReplayFetch(settings.replayFile);
  } else {
    transport ??= globalThis.fetch;
    if (!credentials) throw new TypeError(`The Seazona client needs credentials in ${mode} mode`);
  }
  if (typeof transport !== 'function') throw new TypeError('A fetch implementation is required');

  let gate = governor;
  if (!gate && db) {
    gate = createSeazonaGovernor({
      db,
      clientKey: deriveClientKey(settings),
      requestsPerMinute: rate.requestsPerMinute,
      maxWaitMs: rate.maxWaitMs,
      telemetryRetentionMs: rate.telemetryRetentionMs,
      circuitFailures: rate.circuitFailures,
      circuitWindowMs: rate.circuitWindowMs,
      circuitPauseMs: rate.circuitPauseMs,
      dailyFailureBudget: rate.dailyFailureBudget,
      now,
      sleepFn,
    });
  }
  if (!gate && mode !== 'replay') {
    throw new TypeError(`The Seazona client needs the rate governor in ${mode} mode`);
  }

  const authorization = credentials
    ? `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`
    : null;
  const stats = { requests: 0, retries: 0, rateLimited: 0 };

  // Ungoverned replay stays serial. With a governor, every waiting request
  // reaches the shared queue so a person can pass queued background work.
  let tail = Promise.resolve();
  function serialise(work) {
    const run = tail.catch(() => {}).then(work);
    tail = run.catch(() => {});
    return run;
  }

  async function attempt(url, isRetry, options) {
    const path = normaliseRequestPath(url.pathname);
    const admission = gate ? await gate.reserve({ workflow, isRetry, ...options }) : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rate.timeoutMs);
    const startedAt = Number(now());
    stats.requests += 1;
    try {
      const headers = { Accept: 'application/json' };
      if (authorization) headers.Authorization = authorization;
      const response = await transport(url, { method: 'GET', headers, signal: controller.signal });
      const body = await response.text();
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), Number(now()));
      if (admission) {
        await gate.recordResponse({
          requestId: admission.requestId,
          path,
          statusCode: response.status,
          durationMs: Number(now()) - startedAt,
          retryAfterMs: response.status === 429 && retryAfterMs !== null ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : null,
        });
      }
      return { status: response.status, ok: response.ok, body, retryAfterMs };
    } catch (error) {
      const kind = describeFailure(error);
      if (admission) {
        await gate.recordResponse({ requestId: admission.requestId, path, failureKind: kind, durationMs: Number(now()) - startedAt });
      }
      return { failure: kind, path };
    } finally {
      clearTimeout(timer);
    }
  }

  // GET a resource path relative to the API root. Returns the parsed JSON, or
  // null for an empty body; the caller decides whether empty is a failure.
  async function get(path, query = {}, options = {}) {
    const url = buildUrl(baseUrl, path, query);
    const label = `GET ${url.pathname}`;
    for (let tryNumber = 0; ; tryNumber += 1) {
      const run = () => attempt(url, tryNumber > 0, options);
      const result = await (gate ? run() : serialise(run));
      if (result.failure) {
        throw new SeazonaApiError(`Seazona ${label} failed (${result.failure})`, { kind: result.failure, path: url.pathname });
      }
      const retryable = result.status === 429 || result.status >= 500;
      if (retryable && tryNumber < rate.maxRetries) {
        if (result.status === 429) stats.rateLimited += 1;
        stats.retries += 1;
        const backoffMs = Math.min(MAX_RETRY_AFTER_MS, 1_000 * (2 ** tryNumber));
        const delayMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(result.retryAfterMs ?? 0, backoffMs) + Math.floor(random() * 250));
        await sleepFn(delayMs);
        continue;
      }
      if (!result.ok) {
        throw new SeazonaApiError(`Seazona ${label} failed with HTTP ${result.status}`, {
          statusCode: result.status,
          kind: 'http',
          path: url.pathname,
          retryAfterMs: result.retryAfterMs === null ? null : Math.min(result.retryAfterMs, MAX_RETRY_AFTER_MS),
        });
      }
      if (!result.body.trim()) return null;
      try {
        return JSON.parse(result.body);
      } catch {
        throw new SeazonaApiError(`Seazona ${label} returned invalid JSON`, { kind: 'invalid_json', path: url.pathname });
      }
    }
  }

  return {
    mode,
    stats,
    governor: gate,
    get,
    // A request count per run, for lane results.
    requestCount: () => stats.requests,
  };
}
