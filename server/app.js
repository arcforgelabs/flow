import express from 'express';

// The Flow HTTP app. Routes are added per module (invoices, bills, payments,
// dashboard). Today it serves only the health check.
export function createApp({ revision = process.env.FLOW_REVISION || null, database = null } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_req, res) => {
    let databaseOk = null;
    if (database) {
      databaseOk = await database.pool.query('SELECT 1').then(() => true, () => false);
    }
    const ok = databaseOk !== false;
    res.status(ok ? 200 : 503).json({ ok, service: 'flow', revision, database: databaseOk });
  });

  return app;
}
