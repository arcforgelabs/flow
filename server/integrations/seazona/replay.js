import { readFileSync } from 'node:fs';

// Replay mode: Seazona answers come from a file of recorded, synthetic
// responses, and nothing reaches a network (issue #10). Tests and development
// use it. A replay file holds synthetic data only (CONTRIBUTING.md).
//
// Format (docs/SEAZONA.md, "Replay files"):
//   { "responses": [
//       { "path": "invoices/", "query": { "lastModified": "*" }, "status": 200, "body": [] },
//       { "path": "orders/ORD-1", "status": 404 },
//       { "path": "orders/ORD-2", "sequence": [{ "status": 500 }, { "status": 200, "body": {} }] }
//   ] }
// `path` is relative to the API root. `query` is optional; each listed key
// must match, and "*" matches any value. The first matching entry answers. A
// `sequence` answers in order and then repeats its last answer. A request that
// no entry matches fails closed with the kind `replay_miss`.

function normalisePath(path) {
  return String(path || '').replace(/^\/+/, '').replace(/^v1\//i, '');
}

function queryMatches(expected, actual) {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => (
    value === '*' ? actual.has(key) : actual.get(key) === String(value)
  ));
}

export function loadReplay(source) {
  const replay = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
  if (!replay || !Array.isArray(replay.responses)) {
    throw new TypeError('A Seazona replay needs a "responses" list');
  }
  return replay;
}

// A fetch() that answers from the replay. `calls` lists what was asked, so a
// test can check exactly which requests the adapter made.
export function createReplayFetch(source) {
  const replay = loadReplay(source);
  const entries = replay.responses.map((entry) => ({ ...entry, path: normalisePath(entry.path), served: 0 }));
  const calls = [];

  async function replayFetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const path = normalisePath(url.pathname.replace(/^\/v1\//i, ''));
    calls.push({ method, path, query: Object.fromEntries(url.searchParams) });
    const entry = entries.find((candidate) => (
      (candidate.method || 'GET').toUpperCase() === method
      && candidate.path === path
      && queryMatches(candidate.query, url.searchParams)
    ));
    if (!entry) {
      const error = new Error(`replay has no answer for ${method} ${path}`);
      error.kind = 'replay_miss';
      throw error;
    }
    const answers = Array.isArray(entry.sequence) ? entry.sequence : [entry];
    const answer = answers[Math.min(entry.served, answers.length - 1)];
    entry.served += 1;
    if (answer.error === 'timeout') {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    const status = answer.status ?? 200;
    let body = null;
    if (typeof answer.rawBody === 'string') body = answer.rawBody;
    else if (answer.body !== undefined) body = JSON.stringify(answer.body);
    return new Response(status === 204 ? null : body, {
      status,
      headers: { 'content-type': 'application/json', ...(answer.headers || {}) },
    });
  }

  replayFetch.calls = calls;
  return replayFetch;
}
