import express from 'express';

// The Flow HTTP app. Routes are added per module (invoices, bills, payments,
// dashboard); this skeleton serves only the health check.
export function createApp({ revision = process.env.FLOW_REVISION || null } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'flow', revision });
  });

  return app;
}
