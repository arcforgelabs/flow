import { FlowError } from '../../core/errors.js';
import { XERO_ENDPOINTS } from './settings.js';

// The Xero Accounting API client. Every call goes through the rate-limit
// governor (governor.js). A 429 is retried after the wait Xero asks for,
// except a DayLimit 429, which opens the circuit and fails fast. Tokens are
// sent only in the Authorization header and never logged or put in errors.

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_ATTEMPTS = 2;
export const XERO_PAGE_SIZE = 100;
const MIRROR_PATHS = Object.freeze({ invoices: 'Invoices', credit_notes: 'CreditNotes', payments: 'Payments' });

export function xeroError(code, message, { status = 502, ...extra } = {}) {
  const error = new FlowError(code, message, extra.details);
  error.status = status;
  for (const [key, value] of Object.entries(extra)) if (key !== 'details') error[key] = value;
  return error;
}

function parseHeaderCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

export function readRateLimitHeaders(response) {
  const headers = response?.headers;
  if (typeof headers?.get !== 'function') return null;
  const info = {
    appMinuteRemaining: parseHeaderCount(headers.get('x-appminlimit-remaining')),
    minuteRemaining: parseHeaderCount(headers.get('x-minlimit-remaining')),
    dayRemaining: parseHeaderCount(headers.get('x-daylimit-remaining')),
  };
  return Object.values(info).every((value) => value === null) ? null : info;
}

function retryAfterMsOf(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Validation messages from a Xero ValidationException or a per-element
// ValidationErrors list.
export function validationMessages(payload) {
  const messages = [];
  const collect = (entity) => {
    for (const item of entity?.ValidationErrors ?? []) if (item?.Message) messages.push(String(item.Message));
  };
  collect(payload);
  for (const element of payload?.Elements ?? []) collect(element);
  return [...new Set(messages)];
}

// The message comes only from Xero's structured error fields, never from a
// raw body, so nothing unexpected in a body reaches a log.
export function apiError(response, payload) {
  const messages = validationMessages(payload);
  const message = messages.length
    ? messages.join(' ')
    : payload?.Message || payload?.Detail || payload?.Title || `Xero answered ${response.status}.`;
  return xeroError(response.status === 401 ? 'xero_unauthorized' : 'xero_api_error', message, {
    status: response.status,
    retryAfterMs: retryAfterMsOf(response),
    rateLimitProblem: response.headers?.get?.('x-rate-limit-problem')?.trim() || null,
    details: messages.length ? { validationErrors: messages } : undefined,
  });
}

// A where-clause string literal for Xero's filter syntax.
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);

// `accessToken()` returns a current access token; `invalidateAccessToken()`
// drops a cached one after Xero answers 401, and the request is tried once
// more with a fresh token.
export function createXeroClient({
  tenantId,
  accessToken,
  invalidateAccessToken = () => {},
  fetch: fetchImpl = globalThis.fetch,
  governor,
  apiBase = XERO_ENDPOINTS.api,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
  log = console,
}) {
  if (!tenantId) throw new TypeError('createXeroClient: tenantId is required');
  if (typeof accessToken !== 'function') throw new TypeError('createXeroClient: accessToken() is required');
  if (!governor) throw new TypeError('createXeroClient: a governor is required');
  const base = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  let lastRateLimit = null;

  async function send(method, url, headers, bodyText) {
    await governor.acquire(tenantId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, { method, headers, body: bodyText, signal: controller.signal });
      } catch (error) {
        if (error?.code === 'xero_replay_no_match') throw error;
        const timedOut = error?.name === 'AbortError';
        throw xeroError(timedOut ? 'xero_timeout' : 'xero_unreachable',
          timedOut ? `Xero did not answer within ${timeoutMs} ms.` : 'Flow could not reach Xero.',
          { status: timedOut ? 504 : 503 });
      }
      const text = await response.text().catch(() => '');
      lastRateLimit = readRateLimitHeaders(response);
      governor.observe(tenantId, lastRateLimit);
      return { response, text };
    } finally {
      clearTimeout(timer);
      governor.release(tenantId);
    }
  }

  async function request(method, path, { query, body, headers: extra = {} } = {}) {
    const url = new URL(String(path).replace(/^\/+/, ''), base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    // Serialised once, so a retry sends the same bytes under the same
    // Idempotency-Key.
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      const headers = {
        ...extra,
        Authorization: `Bearer ${await accessToken()}`,
        Accept: 'application/json',
        'xero-tenant-id': tenantId,
        ...(bodyText === undefined ? {} : { 'Content-Type': 'application/json' }),
      };
      const { response, text } = await send(method, url, headers, bodyText);
      const payload = parseJson(text);
      if (response.ok) return payload ?? {};

      const error = apiError(response, payload);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        invalidateAccessToken();
        attempt -= 1;
        continue;
      }
      if (response.status === 429) {
        const problem = error.rateLimitProblem || '';
        if (/DayLimit/i.test(problem)) {
          const ms = error.retryAfterMs > 0 ? error.retryAfterMs : governor.config.dayMs;
          governor.tripCircuit(tenantId, 'DayLimit', ms);
          log.warn?.(`[xero] daily call limit reached on ${method} ${url.pathname}; calls stop until ${new Date(Date.now() + ms).toISOString()}`);
          error.code = 'xero_rate_limited';
          throw error;
        }
        if (attempt < attempts) {
          const waitMs = governor.retryDelayMs(problem, error.retryAfterMs);
          log.info?.(`[xero] 429 ${problem || 'rate limit'} on ${method} ${url.pathname}; retry ${attempt + 1} of ${attempts} in ${waitMs} ms`);
          await governor.sleep(waitMs);
          continue;
        }
        error.code = 'xero_rate_limited';
      }
      throw error;
    }
  }

  async function collectPages(fetchPage, { maxPages = 100 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await fetchPage(page);
      if (!Array.isArray(batch) || !batch.length) break;
      rows.push(...batch);
      if (batch.length < XERO_PAGE_SIZE) break;
    }
    return rows;
  }

  return {
    tenantId,
    request,
    lastRateLimit: () => lastRateLimit,
    status: () => governor.status(tenantId),

    async getOrganisation() {
      return first((await request('GET', 'Organisation')).Organisations);
    },
    async listContacts({ maxPages } = {}) {
      return collectPages(async (page) => (await request('GET', 'Contacts', { query: { page } })).Contacts, { maxPages });
    },
    async findContactsByName(name) {
      return (await request('GET', 'Contacts', { query: { where: `Name==${quote(name)}` } })).Contacts ?? [];
    },
    async listItems() {
      return (await request('GET', 'Items')).Items ?? [];
    },
    async getTrackingCategories() {
      return (await request('GET', 'TrackingCategories')).TrackingCategories ?? [];
    },
    async getInvoice(invoiceId) {
      return first((await request('GET', `Invoices/${encodeURIComponent(invoiceId)}`)).Invoices);
    },
    async findInvoicesByReference(reference) {
      return collectPages(async (page) => (await request('GET', 'Invoices', {
        query: { page, where: `Type=="ACCREC" AND Reference==${quote(reference)}` },
      })).Invoices, { maxPages: 10 });
    },
    async findInvoicesByNumber(number) {
      return (await request('GET', 'Invoices', { query: { InvoiceNumbers: number } })).Invoices ?? [];
    },
    // Sales invoice payments created or changed since `since` (a Date), page
    // by page. Xero's If-Modified-Since narrows Payments to changed records.
    async listPaymentsSince(since, { maxPages } = {}) {
      return collectPages(async (page) => (await request('GET', 'Payments', {
        query: { page, where: 'PaymentType=="ACCRECPAYMENT"' },
        headers: { 'If-Modified-Since': since.toISOString().replace(/\.\d{3}Z$/, '') },
      })).Payments, { maxPages });
    },
    // One page of invoices, credit notes or payments changed since
    // `modifiedSince` (a Date, or null for all), oldest change first. The
    // mirror (mirror.js) pages by that time, so it never skips a record.
    async listChangedPage(resource, { page = 1, pageSize = XERO_PAGE_SIZE, modifiedSince = null } = {}) {
      const path = MIRROR_PATHS[resource];
      if (!path) throw new TypeError(`listChangedPage: unknown resource ${resource}`);
      const payload = await request('GET', path, {
        query: { page, pageSize, order: 'UpdatedDateUTC ASC' },
        headers: modifiedSince ? { 'If-Modified-Since': modifiedSince.toISOString().replace(/\.\d{3}Z$/, '') } : {},
      });
      return payload[path] ?? [];
    },
    // Xero emails one approved invoice to its contact, with the organisation's
    // own template, and marks it sent. Not idempotent: a repeat sends again.
    async emailInvoice(invoiceId) {
      await request('POST', `Invoices/${encodeURIComponent(invoiceId)}/Email`, { body: {} });
    },
    // One invoice. `idempotencyKey` makes a retry within Xero's window
    // return the first result instead of a second invoice.
    async createInvoice(invoice, { idempotencyKey }) {
      if (!idempotencyKey) throw new TypeError('createInvoice: idempotencyKey is required');
      const payload = await request('POST', 'Invoices', {
        query: { summarizeErrors: 'false' },
        body: { Invoices: [invoice] },
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      const created = first(payload.Invoices);
      const messages = validationMessages(created);
      if (created?.HasErrors || created?.StatusAttributeString === 'ERROR' || messages.length) {
        throw xeroError('xero_validation_failed', messages.join(' ') || 'Xero refused the invoice.', {
          status: 422,
          details: { validationErrors: messages },
        });
      }
      return created;
    },
  };
}
