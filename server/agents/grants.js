import express from 'express';
import { z } from 'zod';

const grantInput = z.object({ clientId: z.string().min(1).max(200), appName: z.string().min(1).max(100), organisationId: z.string().uuid() }).strict();
const idInput = z.string().uuid();

// Minimal private-pilot management. No invitation, role, integration or token write.
// Only a verified owner can provision their own grant in this slice.
export function createAgentGrantsRouter({ pool, personAuth, resource }) {
  const router = express.Router();
  router.use(personAuth.requireSession, express.json({ limit: '4kb' }));
  const unavailable = (res, status = 404) => res.status(status).json({ ok: false, code: 'grant_unavailable' });
  const projection = 'id, person_id, client_id, app_name, resource, organisation_id, access_level, created_at, last_used_at, revoked_at, paused_at';
  router.get('/', async (req, res) => {
    const { rows } = await pool.query('SELECT ' + projection + ' FROM agent_grants WHERE person_id = $1 ORDER BY created_at DESC LIMIT 100', [req.person.id]);
    res.json({ ok: true, grants: rows });
  });
  router.post('/', personAuth.requireOwner, async (req, res) => {
    const input = grantInput.safeParse(req.body);
    if (!input.success) return unavailable(res, 400);
    const { clientId, appName, organisationId } = input.data;
    // Explicit verified-owner provisioning may reauthorize only this revoked
    // binding. Preserve its historical ID/scope; active or paused duplicates
    // still conflict, and ordinary pause-resume never clears revocation.
    const { rows } = await pool.query(
      'INSERT INTO agent_grants (person_id, client_id, app_name, resource, organisation_id) SELECT $1,$2,$3,$4,id FROM organisations WHERE id = $5 ON CONFLICT (person_id,client_id,resource) DO UPDATE SET revoked_at=NULL, paused_at=NULL, failure_count=0, failure_day=NULL, app_name=EXCLUDED.app_name WHERE agent_grants.revoked_at IS NOT NULL AND agent_grants.organisation_id=EXCLUDED.organisation_id RETURNING ' + projection,
      [req.person.id, clientId, appName, resource, organisationId],
    );
    if (!rows[0]) return unavailable(res, 409);
    res.status(201).json({ ok: true, grant: rows[0] });
  });
  for (const action of ['revoke', 'resume']) {
    router.post('/:id/' + action, async (req, res, next) => {
      if (!idInput.safeParse(req.params.id).success) return unavailable(res);
      const { rows } = await pool.query('SELECT person_id FROM agent_grants WHERE id = $1', [req.params.id]);
      if (!rows[0]) return unavailable(res);
      if (rows[0].person_id !== req.person.id) {
        if (req.person.role !== 'owner') return unavailable(res);
        return personAuth.requireOwner(req, res, next);
      }
      next();
    }, async (req, res) => {
      const set = action === 'revoke' ? 'revoked_at = coalesce(revoked_at, now())' : 'paused_at = NULL, failure_count = 0, failure_day = NULL';
      const { rows } = await pool.query('UPDATE agent_grants SET ' + set + ' WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return unavailable(res);
      res.json({ ok: true });
    });
  }
  router.use((_error, _req, res, _next) => unavailable(res, 503));
  return router;
}
