import express from 'express';
import { FlowError } from '../core/errors.js';
import { findPersonById, publicPerson } from './people.js';
import {
  permissionGroups, personPermissionView, roleGrantMap, setPersonPermission, setRolePermission,
} from './permissions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = { invalid: 400, forbidden: 403, not_found: 404 };

function sendError(res, error, log) {
  if (error instanceof FlowError) {
    return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
  }
  log.error?.(`[permissions] ${error.message}`);
  return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
}

// Settings > Permissions. An owner with a verified sign-in reads and changes
// the role grid and one person's exceptions. Mounted at /api/permissions.
export function createPermissionRouter({ db, personAuth, log = console }) {
  const router = express.Router();
  router.use(personAuth.requireSession, personAuth.requireOwner);

  router.get('/', async (_req, res) => {
    try {
      res.json({ ok: true, groups: permissionGroups(), roles: ['owner', 'admin', 'staff'], grants: await roleGrantMap(db), ownerLocked: true });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  router.put('/roles/:role', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      const result = await setRolePermission(db, {
        role: req.params.role, key: req.body?.key, allowed: req.body?.allowed, actorId: req.person.id,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  router.get('/people/:id', async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) throw new FlowError('not_found', 'person not found');
      const person = await findPersonById(db, req.params.id);
      if (!person) throw new FlowError('not_found', 'person not found');
      res.json({ ok: true, person: publicPerson(person), permissions: await personPermissionView(db, person) });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  router.put('/people/:id', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) throw new FlowError('not_found', 'person not found');
      const result = await setPersonPermission(db, {
        personId: req.params.id, key: req.body?.key, effect: req.body?.effect, actorId: req.person.id,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  return router;
}
