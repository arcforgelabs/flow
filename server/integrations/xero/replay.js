import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Replay mode (XERO_MODE=replay): a stand-in for fetch that answers from
// recorded, synthetic Xero responses and never opens a connection. Tests use
// it, and so can a development workspace. A request no interaction matches
// fails, so replay can never fall through to the real Xero.
//
// A fixture file is { "interactions": [ { "request": { "method", "url",
// "query"? }, "response": { "status"?, "headers"?, "body"? }, "repeat"? } ] }.
// A request matches on method, URL without query, and every query value the
// interaction lists. Interactions are used once, in file order, unless
// "repeat" is true. Fixtures hold synthetic data only (CONTRIBUTING.md).

export const DEFAULT_REPLAY_FIXTURES = fileURLToPath(new URL('./fixtures/replay.json', import.meta.url));

export function loadReplayFixtures(path = DEFAULT_REPLAY_FIXTURES) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed?.interactions)) throw new Error('A Xero replay fixture needs an "interactions" list');
  return parsed.interactions;
}

function noMatch(method, url) {
  const error = new Error(`Xero replay has no recorded answer for ${method} ${url.origin}${url.pathname}`);
  error.code = 'xero_replay_no_match';
  return error;
}

function matches(interaction, method, url) {
  const expected = interaction.request ?? {};
  if ((expected.method ?? 'GET').toUpperCase() !== method) return false;
  const want = new URL(expected.url);
  if (want.origin !== url.origin || want.pathname !== url.pathname) return false;
  for (const [key, value] of Object.entries(expected.query ?? {})) {
    if (url.searchParams.get(key) !== String(value)) return false;
  }
  return true;
}

function readBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return String(body);
}

// Returns a fetch function. `calls` records each request without its
// Authorization header, for tests.
export function createReplayFetch(interactions = loadReplayFixtures()) {
  const pending = interactions.map((interaction) => ({ ...interaction, used: false }));
  const calls = [];

  async function replayFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {})
      .filter(([name]) => name.toLowerCase() !== 'authorization'));
    calls.push({ method, url: url.toString(), path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: readBody(init.body) });

    const interaction = pending.find((entry) => (entry.repeat || !entry.used) && matches(entry, method, url));
    if (!interaction) throw noMatch(method, url);
    interaction.used = true;

    const { status = 200, headers: responseHeaders = {}, body } = interaction.response ?? {};
    if (interaction.response?.networkError) {
      throw Object.assign(new Error('replayed network failure'), { name: 'TypeError' });
    }
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 || status === 304 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...responseHeaders },
    });
  }

  replayFetch.calls = calls;
  replayFetch.unused = () => pending.filter((entry) => !entry.used && !entry.repeat);
  return replayFetch;
}
