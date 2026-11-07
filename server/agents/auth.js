import { Worker } from 'node:worker_threads';
import { verifyClerkToken } from '@clerk/mcp-tools/server';

// Use a separate verifier. The browser adapter can link invitations and fill names.
// Clerk checks signature/introspection, expiry, instance and exact audience here.
export function createMcpVerifier({ keys, resource, client }) {
  let workers = 0;
  if (!client) return (authorization, { signal } = {}) => new Promise((resolve) => {
    if (workers >= 3 || signal?.aborted || typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 16384) return resolve(null);
    // backend 3.25.0 exposes no per-request AbortSignal. Termination bounds both
    // verification and its sockets without changing global fetch or SDK internals.
    workers++;
    const worker = new Worker(new URL('./auth-worker.js', import.meta.url), { workerData: { keys, resource, authorization }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let done = false;
    const finish = async (result) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      await worker.terminate();
      workers--;
      resolve(result);
    };
    const abort = () => finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', finish);
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
  return async (authorization) => {
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization)) return null;
    try {
      const state = await client.authenticateRequest(new Request(resource, { headers: { authorization } }), {
        acceptsToken: 'oauth_token', audience: resource,
      });
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth();
      if (auth.tokenType !== 'oauth_token' || !auth.userId || !auth.clientId || auth.subject !== auth.userId) return null;
      // The machine auth object does not expose expiry in backend 3.25.0.
      // Read the official verified resource too; reject non-expiring tokens.
      const token = await client.idPOAuthAccessToken.verify(state.token, { audience: resource });
      if (token.revoked || token.expired || !Number.isFinite(token.expiration) || token.expiration * 1000 <= Date.now()) return null;
      if (token.subject !== auth.userId || token.clientId !== auth.clientId) return null;
      return verifyClerkToken(auth, state.token) ?? null;
    } catch {
      // Never log Clerk errors: they can contain tokens and request details.
      return null;
    }
  };
}
