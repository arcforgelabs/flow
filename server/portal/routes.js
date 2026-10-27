import express from 'express';
import { FlowError } from '../core/errors.js';
import { resolveOrganisation } from '../api/invoicing.js';
import { createPracticeAuth } from '../auth/portal.js';
import { rateLimit } from '../rate-limit.js';
import { portalPage } from '../ui/portal-page.js';
import { inviteToPortal, portalSignInUrl } from './invite.js';
import { approveRequest, contactPortal, createJoinRequest, declineRequest, portalSettingsView, previewScope, savePortalSettings } from './lab.js';
import { publicMember } from './members.js';
import { practicesOf, readPortalSettings } from './scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = {
  invalid: 400, forbidden: 403, not_found: 404, conflict: 409, portal_off: 403, sign_in_unavailable: 503, organisation_required: 409,
};

// Practice routes. The test that every portal route stays inside one practice
// reads this list. Staff routes live under /api/portal and are not in it.
export const PRACTICE_ROUTES = [
  ['POST', '/portal/api/join'],
  ['GET', '/portal/api/config'],
  ['GET', '/portal/api/me'],
  ['GET', '/portal/api/jobs'],
  ['GET', '/portal/api/jobs/:id'],
  ['GET', '/portal/api/team'],
  ['POST', '/portal/api/team'],
  ['PATCH', '/portal/api/team/:id'],
  ['DELETE', '/portal/api/team/:id'],
];

function sendError(res, error, log) {
  if (error instanceof FlowError) {
    return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
  }
  log.error?.(`[portal] ${error.message}`);
  return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
}

const handle = (log, fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((error) => sendError(res, error, log));

function idOf(value, name) {
  if (!UUID.test(String(value ?? ''))) throw new FlowError('not_found', `${name} not found`);
  return value;
}

const unavailable = (_req, res) => res.status(503).json({
  ok: false,
  code: 'sign_in_not_configured',
  error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).',
});

export function createPortalRouter({
  db = null,
  clerk = null,
  personAuth = null,
  work = () => [],
  defaultFamily,
  log = console,
  rateLimitPerMinute = 60,
  joinRateLimitPerMinute = 5,
}) {
  const router = express.Router();
  const page = portalPage({ defaultFamily });
  const sendPage = (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.type('html').send(page);
  };
  router.get(['/portal', '/portal/sign-in', '/portal/join', '/portal/waiting', '/portal/jobs', '/portal/team', '/portal/jobs/:id'], sendPage);

  const practiceAuth = db && clerk ? createPracticeAuth({ db, clerk, work, log }) : null;
  const api = express.Router();
  api.use(rateLimit({ limit: rateLimitPerMinute, windowMs: 60_000 }));
  api.use(express.json({ limit: '16kb' }));

  if (!practiceAuth || !personAuth) {
    api.use(unavailable);
    router.use('/portal/api', api);
    router.use('/api/portal', unavailable);
    return router;
  }

  api.get('/config', handle(log, async (_req, res) => {
    const organisationId = await resolveOrganisation(db);
    const settings = await readPortalSettings(db, organisationId);
    res.json({ ok: true, enabled: settings.enabled });
  }));

  api.post('/join', rateLimit({ limit: joinRateLimitPerMinute, windowMs: 60_000 }), handle(log, async (req, res) => {
    await createJoinRequest(db, req.body ?? {});
    res.status(201).json({ ok: true });
  }));

  const member = express.Router();
  member.use(practiceAuth.requirePracticeMember);

  member.get('/me', handle(log, async (req, res) => {
    const practices = await practicesOf(db, req.practiceMembers);
    const practice = practices.find((row) => row.contactId === req.practiceMember.contactId);
    res.json({
      ok: true,
      member: publicMember(req.practiceMember, practice?.name ?? null),
      practices,
      practice: req.practiceMember.contactId,
    });
  }));

  member.get('/jobs', handle(log, async (req, res) => {
    const mine = req.query.mine === '1' || req.query.mine === 'true';
    const jobs = await req.portal.jobs({
      q: typeof req.query.q === 'string' ? req.query.q : '',
      mine,
      practitionerName: req.practiceMember.practitionerName,
    });
    res.json({ ok: true, jobs });
  }));

  member.get('/jobs/:id', handle(log, async (req, res) => {
    const job = await req.portal.job(idOf(req.params.id, 'job'));
    if (!job) throw new FlowError('not_found', 'job not found');
    res.json({ ok: true, job });
  }));

  member.get('/team', handle(log, async (req, res) => {
    res.json({ ok: true, team: await req.portal.team() });
  }));

  member.post('/team', handle(log, async (req, res) => {
    const email = req.body?.email;
    const memberRow = await req.portal.invite({
      email,
      name: req.body?.name ?? null,
      role: req.body?.role,
      practitionerName: req.body?.practitionerName ?? null,
    });
    let invite = { emailed: false };
    try {
      invite = await inviteToPortal(clerk, memberRow.email, portalSignInUrl(req), log);
    } catch (error) {
      sendError(res, error, log);
      return;
    }
    res.status(201).json({ ok: true, member: publicMember(memberRow), invite });
  }));

  member.patch('/team/:id', handle(log, async (req, res) => {
    const row = await req.portal.changeMember(idOf(req.params.id, 'member'), {
      role: req.body?.role,
      practitionerName: req.body?.practitionerName,
    });
    res.json({ ok: true, member: publicMember(row) });
  }));

  member.delete('/team/:id', handle(log, async (req, res) => {
    await req.portal.removeMember(idOf(req.params.id, 'member'));
    res.json({ ok: true });
  }));

  api.use(member);
  router.use('/portal/api', api);

  const staff = express.Router();
  staff.use(personAuth.requireSession, express.json({ limit: '16kb' }));
  const manager = personAuth.requireRole('owner', 'admin');

  staff.get('/settings', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.query.organisationId);
    res.json({ ok: true, ...(await portalSettingsView(db, organisationId, work)) });
  }));

  staff.put('/settings', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.body?.organisationId);
    const saved = await savePortalSettings(db, organisationId, { enabled: req.body?.enabled, names: req.body?.names }, req.person.id);
    res.json({ ok: true, enabled: saved.enabled, names: saved.names });
  }));

  staff.post('/requests/:id/approve', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.body?.organisationId);
    const { request, member: row } = await approveRequest(db, {
      organisationId,
      id: idOf(req.params.id, 'request'),
      contactId: idOf(req.body?.contactId, 'practice'),
      actorId: req.person.id,
    });
    let invite = { emailed: false };
    try {
      invite = await inviteToPortal(clerk, row.email, portalSignInUrl(req), log);
    } catch (error) {
      log.error?.(`[portal] invitation after approval failed: ${error.message}`);
    }
    log.info?.(`[portal] ${req.person.id} approved request ${request.id} onto contact ${row.contactId} as ${row.role}`);
    res.json({ ok: true, member: publicMember(row), invite });
  }));

  staff.post('/requests/:id/decline', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.body?.organisationId);
    await declineRequest(db, { organisationId, id: idOf(req.params.id, 'request'), actorId: req.person.id });
    res.json({ ok: true });
  }));

  staff.get('/contacts/:id', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.query.organisationId);
    const portal = await contactPortal(db, organisationId, idOf(req.params.id, 'contact'));
    res.json({ ok: true, ...portal });
  }));

  staff.get('/preview', manager, handle(log, async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.query.organisationId);
    const contactId = idOf(req.query.contactId, 'practice');
    const jobs = await previewScope(db, { organisationId, contactId, work, log }).jobs({});
    res.json({ ok: true, jobs });
  }));

  router.use('/api/portal', staff);
  return router;
}
