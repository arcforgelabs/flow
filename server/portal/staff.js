import express from 'express';
import { boardJobs } from '../core/job-board.js';
import { getContact } from '../core/contacts.js';
import { sendClerkInvitation } from '../auth/clerk.js';
import { normaliseEmail } from '../auth/people.js';
import { listAuditEvents, publicAuditEvent, recordAudit } from './audit.js';
import { clientIp, sendError } from './http.js';
import { listMembers, publicMember } from './members.js';
import { approveRequest, declineRequest, listRequests, publicRequest } from './requests.js';
import { portalJobs } from './scope.js';
import { readPortalSettings, savePortalSettings } from './settings.js';
import { revokeMemberSessions } from './sessions.js';
import { labOrganisation } from '../auth/portal.js';

// Lab routes for the portal: approve a join, name the stages, read a
// practice's members and its audit log, and sign a member out. Reads of a
// practice's jobs use the same scoped helper as the portal. A portal
// session cannot call these: they sit on the staff guard.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signInUrl(req) {
  return `${req.protocol}://${req.get('host')}/portal/sign-in`;
}

export function createPortalStaffRouter({ db, personAuth, clerk, work = () => [], log = console }) {
  const router = express.Router();
  const { requireSession, requireRole } = personAuth;
  const manager = [requireSession, requireRole('owner', 'admin')];

  router.use(requireSession, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  router.param('contactId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ ok: false, code: 'not_found', error: 'contact not found' })));
  router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ ok: false, code: 'not_found', error: 'not found' })));

  async function orgOr(res) {
    const org = await labOrganisation(db);
    if (!org) {
      res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'This installation has no lab yet.' });
      return null;
    }
    return org;
  }

  router.get('/settings', async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const settings = await readPortalSettings(db, org.id);
      const board = await boardJobs(db, org.id, { work: work(), log });
      const statuses = (board.statuses ?? []).map((status) => (typeof status === 'string' ? status : status.label)).filter(Boolean);
      res.json({ ok: true, ...settings, statuses });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.put('/settings', ...manager, express.json({ limit: '32kb' }), async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const body = req.body ?? {};
      const changes = {};
      if ('enabled' in body) changes.enabled = body.enabled === true;
      if ('statusNames' in body) changes.statusNames = body.statusNames;
      const settings = await savePortalSettings(db, org.id, changes, { personId: req.person.id });
      res.json({ ok: true, ...settings });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.get('/requests', ...manager, async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const status = req.query.status === 'open' || req.query.status === 'approved' || req.query.status === 'declined' ? req.query.status : null;
      const requests = await listRequests(db, org.id, { status });
      res.json({ ok: true, requests: requests.map(publicRequest) });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.post('/requests/:id/approve', ...manager, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const { request, member } = await approveRequest(db, {
        organisationId: org.id,
        id: req.params.id,
        contactId: req.body?.contactId,
        personId: req.person.id,
        ip: clientIp(req),
      });
      let invite = { emailed: false };
      try {
        invite = await sendClerkInvitation(clerk, member.email, signInUrl(req));
      } catch (error) {
        log.error?.(`[portal] Clerk invitation failed: ${error.message}`);
      }
      res.status(201).json({ ok: true, request: publicRequest(request), member: publicMember(member), invite });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.post('/requests/:id/decline', ...manager, async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const request = await declineRequest(db, {
        organisationId: org.id,
        id: req.params.id,
        personId: req.person.id,
        ip: clientIp(req),
      });
      res.json({ ok: true, request: publicRequest(request) });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.get('/contacts/:contactId', async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const contact = await getContact(db, org.id, req.params.contactId);
      if (contact.kind !== 'customer') return res.json({ ok: true, members: [], requests: [], events: [] });
      const [members, requests, events] = await Promise.all([
        listMembers(db, { organisationId: org.id, contactId: contact.id }),
        listRequests(db, org.id, { contactId: contact.id }),
        listAuditEvents(db, org.id, contact.id),
      ]);
      res.json({
        ok: true,
        members: members.map(publicMember),
        requests: requests.map(publicRequest),
        events: events.map(publicAuditEvent),
      });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  // Read only. The same jobs the practice would see.
  router.get('/contacts/:contactId/jobs', ...manager, async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const contact = await getContact(db, org.id, req.params.contactId);
      if (contact.kind !== 'customer') return res.json({ ok: true, jobs: [] });
      const scope = { organisationId: org.id, contactId: contact.id };
      const jobs = await portalJobs(db, scope, { work: work(), log });
      await recordAudit(db, {
        organisationId: org.id,
        actorKind: 'person',
        actorId: req.person.id,
        practiceContactId: contact.id,
        action: 'read',
        recordType: 'job',
        recordId: 'list',
        ip: clientIp(req),
      });
      res.json({ ok: true, jobs });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.post('/contacts/:contactId/members/:memberId/sign-out', ...manager, async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const members = await listMembers(db, { organisationId: org.id, contactId: req.params.contactId });
      const member = members.find((row) => row.id === req.params.memberId);
      if (!member) return res.status(404).json({ ok: false, code: 'not_found', error: 'member not found' });
      await revokeMemberSessions(db, { memberId: member.id });
      await recordAudit(db, {
        organisationId: org.id,
        actorKind: 'person',
        actorId: req.person.id,
        practiceContactId: req.params.contactId,
        action: 'change',
        recordType: 'member',
        recordId: member.id,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  // Resend is the lab's way to email an invitation again. Unused here except
  // when the first send did not leave Clerk; kept for the approve result.
  router.post('/contacts/:contactId/members/:memberId/invite', ...manager, async (req, res) => {
    try {
      const org = await orgOr(res);
      if (!org) return;
      const members = await listMembers(db, { organisationId: org.id, contactId: req.params.contactId });
      const member = members.find((row) => row.id === req.params.memberId);
      if (!member) return res.status(404).json({ ok: false, code: 'not_found', error: 'member not found' });
      const invite = await sendClerkInvitation(clerk, normaliseEmail(member.email), signInUrl(req));
      res.json({ ok: true, invite });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  return router;
}
