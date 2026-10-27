import express from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { clerkFrontendOrigin, sendClerkInvitation } from '../auth/clerk.js';
import { normaliseEmail } from '../auth/people.js';
import { deny } from '../auth/session.js';
import { FlowError } from '../core/errors.js';
import { contacts } from '../db/schema.js';
import { rateLimit } from '../rate-limit.js';
import { portalPage } from '../ui/portal-page.js';
import { recordAudit } from './audit.js';
import { applyPortalHeaders, portalNonce } from './headers.js';
import { clientIp, sendError } from './http.js';
import { addMember, listMembers, managesTeam, publicMember, removeMember, updateMember } from './members.js';
import { createJoinRequest } from './requests.js';
import { labOrganisation } from '../auth/portal.js';
import { assertPortalScope, portalJob, portalJobs } from './scope.js';
import { readPortalSettings } from './settings.js';

// Practice HTTP API and pages. Mounted at the app root. Staff routes are
// /api/portal (server/portal/staff.js). Every job read goes through scope.js.

export const PORTAL_PAGES = ['/portal', '/portal/sign-in', '/portal/join', '/portal/waiting', '/portal/jobs', '/portal/jobs/:id', '/portal/team'];

// Every /portal/api route. The scope test calls each one as practice A.
export const PORTAL_API = Object.freeze([
  ['GET', '/auth/config'],
  ['POST', '/join'],
  ['GET', '/me'],
  ['GET', '/jobs'],
  ['GET', '/jobs/:id'],
  ['GET', '/team'],
  ['POST', '/team'],
  ['PATCH', '/team/:id'],
  ['DELETE', '/team/:id'],
]);

function signInUrl(req) {
  return `${req.protocol}://${req.get('host')}/portal/sign-in`;
}

export function createPortalRouter({
  db = null,
  clerk = null,
  portalAuth = null,
  settings = { mode: 'off' },
  defaultFamily,
  work = () => [],
  joinLimit = 5,
  joinWindowMs = 15 * 60 * 1000,
  apiLimit = 120,
  memberLimit = 120,
  signInLimit = 30,
  log = console,
} = {}) {
  const router = express.Router();
  const signInOn = settings.mode === 'clerk' && portalAuth && db && clerk;
  const origin = signInOn ? clerkFrontendOrigin(settings.keys ?? {}) : null;
  const scriptOrigins = origin ? [origin] : [];

  router.get(PORTAL_PAGES, rateLimit({ limit: signInLimit, windowMs: 60_000 }), (req, res) => {
    const nonce = portalNonce();
    applyPortalHeaders(req, res, { scriptOrigins, nonce });
    res.type('html').send(portalPage({ defaultFamily, nonce }));
  });

  const api = express.Router();
  api.use(rateLimit({ limit: apiLimit, windowMs: 60_000 }));
  api.use((req, res, next) => {
    applyPortalHeaders(req, res, { scriptOrigins });
    next();
  });

  const unavailable = (_req, res) => res.status(503).json({
    ok: false,
    code: 'sign_in_not_configured',
    error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).',
  });

  api.get('/auth/config', rateLimit({ limit: signInLimit, windowMs: 60_000 }), (_req, res) => {
    if (!signInOn) return res.json({ ok: true, mode: 'off' });
    const { publishableKey, proxyUrl } = settings.keys;
    return res.json({
      ok: true,
      mode: 'clerk',
      clerk: {
        publishableKey,
        proxyUrl,
        scriptUrl: `${origin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
        uiScriptUrl: `${origin}/npm/@clerk/ui@1/dist/ui.browser.js`,
      },
    });
  });

  if (!signInOn) {
    api.use(unavailable);
    router.use('/portal/api', api);
    return router;
  }

  const { requirePracticeMember, requireTeamManager } = portalAuth;
  const jobOptions = () => ({ work: work(), log });

  // Join has no session. Limited per address and again per email.
  api.post('/join',
    rateLimit({ limit: joinLimit, windowMs: joinWindowMs }),
    express.json({ limit: '8kb' }),
    rateLimit({
      limit: joinLimit,
      windowMs: joinWindowMs,
      keyGenerator: (req) => `join:${normaliseEmail(req.body?.email) || 'none'}`,
    }),
    async (req, res) => {
      try {
        const org = await labOrganisation(db);
        if (!org) return res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'This installation has no lab yet.' });
        const portal = await readPortalSettings(db, org.id);
        if (!portal.enabled) return deny(res, 'portal_off');
        await createJoinRequest(db, {
          organisationId: org.id,
          name: req.body?.name,
          email: req.body?.email,
          practiceName: req.body?.practiceName,
          phone: req.body?.phone,
          ip: clientIp(req),
        });
        res.status(201).json({ ok: true });
      } catch (error) {
        sendError(res, error, log, 'portal');
      }
    });

  api.use(requirePracticeMember);
  api.use(rateLimit({
    limit: memberLimit,
    windowMs: 60_000,
    keyGenerator: (req) => `member:${req.portal.member.id}`,
  }));

  api.get('/me', async (req, res) => {
    const ids = req.portal.contactIds;
    const names = ids.length
      ? await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(
        eq(contacts.organisationId, req.portal.organisationId),
        inArray(contacts.id, ids),
      ))
      : [];
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    res.json({
      ok: true,
      member: publicMember(req.portal.member),
      practiceId: req.portal.contactId,
      practices: req.portal.members.map((member) => ({
        contactId: member.contactId,
        name: nameOf.get(member.contactId) ?? 'Practice',
        role: member.role,
      })),
    });
  });

  api.get('/jobs', async (req, res) => {
    try {
      assertPortalScope(req.portal);
      const jobs = await portalJobs(db, req.portal, jobOptions());
      await recordAudit(db, {
        organisationId: req.portal.organisationId,
        actorKind: 'member',
        actorId: req.portal.member.id,
        practiceContactId: req.portal.contactId,
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

  api.get('/jobs/:id', async (req, res) => {
    try {
      assertPortalScope(req.portal);
      const job = await portalJob(db, req.portal, req.params.id, jobOptions());
      await recordAudit(db, {
        organisationId: req.portal.organisationId,
        actorKind: 'member',
        actorId: req.portal.member.id,
        practiceContactId: req.portal.contactId,
        action: 'read',
        recordType: 'job',
        recordId: job.id,
        ip: clientIp(req),
      });
      res.json({ ok: true, job });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  api.get('/team', requireTeamManager, async (req, res) => {
    try {
      const members = await listMembers(db, req.portal);
      res.json({ ok: true, members: members.map(publicMember) });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  api.post('/team', requireTeamManager, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const actor = req.portal.member;
      if (!managesTeam(actor)) throw new FlowError('forbidden', 'Your role does not manage the team');
      const role = req.body?.role;
      if (role === 'owner' && actor.role !== 'owner') throw new FlowError('forbidden', 'An admin cannot add an owner');
      let invite;
      try {
        invite = await sendClerkInvitation(clerk, normaliseEmail(req.body?.email), signInUrl(req));
      } catch (error) {
        log.error?.(`[portal] Clerk invitation failed: ${error.message}`);
        return res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'Flow could not send the invitation. Try again shortly.' });
      }
      const member = await addMember(db, {
        organisationId: req.portal.organisationId,
        contactId: req.portal.contactId,
        email: req.body?.email,
        name: req.body?.name,
        role,
        practitionerName: req.body?.practitionerName,
        invitedByMember: actor.id,
        actorKind: 'member',
        actorId: actor.id,
        ip: clientIp(req),
      });
      res.status(201).json({ ok: true, member: publicMember(member), invite });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  api.patch('/team/:id', requireTeamManager, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const member = await updateMember(db, {
        organisationId: req.portal.organisationId,
        contactId: req.portal.contactId,
        id: req.params.id,
        actor: req.portal.member,
        role: req.body?.role,
        practitionerName: req.body?.practitionerName,
        ip: clientIp(req),
      });
      res.json({ ok: true, member: publicMember(member) });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  api.delete('/team/:id', requireTeamManager, async (req, res) => {
    try {
      await removeMember(db, {
        organisationId: req.portal.organisationId,
        contactId: req.portal.contactId,
        id: req.params.id,
        actor: req.portal.member,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, log, 'portal');
    }
  });

  router.use('/portal/api', api);
  return router;
}
