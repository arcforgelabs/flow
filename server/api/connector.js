import express from 'express';

// The Flow API (`/api/flow/v1`, issue #9) is for scripts, the `flow` CLI and
// outside agents. Callers authenticate with a signed connector key, never a
// Clerk session: sign-in and machine access stay separate. Nothing here reads
// a Clerk session. Until connector keys exist, every request is refused.
export function createConnectorApi() {
  const router = express.Router();
  router.use((_req, res) => {
    res.status(401).json({
      ok: false,
      code: 'connector_signature_required',
      error: 'The Flow API needs a signed connector request. Connector keys are not available yet.',
    });
  });
  return router;
}
