import express from 'express';
import { FlowError } from '../core/errors.js';
import { rateLimit } from '../rate-limit.js';
import { ensureClerkAccount, sendClerkInvitation } from './clerk.js';
import {
  findPersonByEmail,
  findPersonById,
  invitePerson,
  listPeople,
  normaliseEmail,
  normaliseAppearance,
  normaliseViews,
  publicPerson,
  removePerson,
  setPersonAppearance,
  setPersonView,
  updatePerson,
} from './people.js';
import { isPlainEmail } from './settings.js';
import { APP_PATHS, appPage } from '../ui/app-page.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

// The Clerk scripts the sign-in page loads: through Flow's own origin when
// CLERK_PROXY_URL is set, otherwise from the Clerk instance's Frontend API
// (its host is encoded in the publishable key). clerk-js 6 ships without its
// prebuilt components; the sign-in widget comes from @clerk/ui, passed to
// Clerk.load().
function clerkScriptBase({ publishableKey, proxyUrl }) {
  return proxyUrl
    ? proxyUrl.replace(/\/+$/, '')
    : `https://${Buffer.from(publishableKey.split('_')[2] ?? '', 'base64').toString('utf8').replace(/\$$/, '')}`;
}

export function clerkScriptUrl(keys) {
  return `${clerkScriptBase(keys)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
}

export function clerkUiScriptUrl(keys) {
  return `${clerkScriptBase(keys)}/npm/@clerk/ui@1/dist/ui.browser.js`;
}

function sendError(res, error, log) {
  if (error instanceof FlowError) {
    return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
  }
  log.error?.(`[people] ${error.message}`);
  return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
}

// Sign-in routes. `settings` comes from resolveSignInSettings; with sign-in
// off, person routes answer 503 and nothing else is mounted. The sign-in page
// and its config have their own limit per client (`rateLimitPerMinute`);
// /api/me and /api/people sit under the app's /api limit as well.
// `defaultFamily` is the installation's design system (FLOW_THEME).
export function createSignInRouter({ settings, db, clerk, personAuth, defaultFamily, rateLimitPerMinute = 30, log = console }) {
  const router = express.Router();
  const page = appPage({ defaultFamily });
  const signInOn = settings.mode === 'clerk';
  const signInLimit = rateLimit({ limit: rateLimitPerMinute, windowMs: 60_000 });

  // Public: what the sign-in page needs. The publishable key is meant for
  // browsers. Served at runtime, so one build serves Replit's development
  // and production Clerk instances.
  router.get('/api/auth/config', signInLimit, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!signInOn) return res.json({ ok: true, mode: 'off' });
    const { publishableKey, proxyUrl } = settings.keys;
    return res.json({
      ok: true,
      mode: 'clerk',
      // The widget creates Clerk accounts only when someone could ask for
      // access; Flow still refuses an email outside FLOW_SIGN_UP_DOMAINS.
      publicSignUp: settings.publicSignUp || Boolean(settings.signUpDomains?.length),
      clerk: { publishableKey, proxyUrl, scriptUrl: clerkScriptUrl(settings.keys), uiScriptUrl: clerkUiScriptUrl(settings.keys) },
    });
  });

  router.get('/', signInLimit, (_req, res) => res.redirect(302, '/sign-in'));
  // Signed out, every one of these shows sign-in.
  router.get(APP_PATHS, signInLimit, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.type('html').send(page);
  });

  if (!signInOn) {
    router.use(['/api/me', '/api/people'], (_req, res) => res.status(503).json({
      ok: false,
      code: 'sign_in_not_configured',
      error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).',
    }));
    return router;
  }

  const { requireSession, requireOwner, ownerVerification } = personAuth;

  router.get('/api/me', requireSession, async (req, res) => {
    const body = { ok: true, person: publicPerson(req.person) };
    if (req.person.role === 'owner') {
      const check = await ownerVerification(req.person, req.clerkAuth);
      body.ownerActions = { allowed: Boolean(check.verified), by: check.by ?? null };
    }
    body.appearance = req.person.appearance ? normaliseAppearance(req.person.appearance) : null;
    body.views = normaliseViews(req.person.views);
    res.json(body);
  });

  // Each person sets their own appearance; it follows their account.
  router.put('/api/me/appearance', requireSession, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      const appearance = await setPersonAppearance(db, { id: req.person.id, appearance: req.body });
      res.json({ ok: true, appearance });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  // Each person sets their own view of a page (how Jobs groups, sorts and
  // filters); it follows their account.
  router.put('/api/me/views/:page', requireSession, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const view = await setPersonView(db, { id: req.person.id, page: req.params.page, view: req.body });
      res.json({ ok: true, view });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  // Only an owner manages people.
  const people = express.Router();
  people.use(requireSession, requireOwner, express.json({ limit: '16kb' }));
  people.param('id', (_req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ ok: false, code: 'not_found', error: 'person not found' })));

  people.get('/', async (_req, res) => {
    try {
      res.json({ ok: true, people: (await listPeople(db)).map(publicPerson) });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  // The invitation email's link opens this installation's sign-in page.
  const signInUrl = (req) => `${req.protocol}://${req.get('host')}/sign-in`;

  // Clerk emails the invitation. If Clerk cannot, Flow makes the invitee's
  // Clerk account itself (with public sign-up off the sign-in page never
  // creates one) and the owner sends the sign-in message by hand.
  async function inviteWithClerk(req, email) {
    try {
      return await sendClerkInvitation(clerk, email, signInUrl(req));
    } catch (error) {
      log.error?.(`[people] Clerk invitation email failed: ${error.message}`);
    }
    await ensureClerkAccount(clerk, email);
    return { emailed: false };
  }

  // Invite someone.
  people.post('/', async (req, res) => {
    try {
      const email = normaliseEmail(req.body?.email);
      const role = req.body?.role;
      if (!isPlainEmail(email)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
      if (await findPersonByEmail(db, email)) throw new FlowError('conflict', 'that email address is already on the people list');
      let invite;
      try {
        invite = await inviteWithClerk(req, email);
      } catch (error) {
        log.error?.(`[people] Clerk account for an invitation failed: ${error.message}`);
        return res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'Flow could not prepare the sign-in account. Try again shortly.' });
      }
      const person = await invitePerson(db, { email, name: req.body?.name ?? null, role, invitedBy: req.person.id });
      log.info?.(`[people] ${req.person.id} invited ${person.id} as ${person.role} (${invite.emailed ? 'emailed' : 'not emailed'})`);
      res.status(201).json({ ok: true, person: publicPerson(person), invite });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  // Email an invited person's invitation again. Only for someone who has
  // not signed in yet.
  people.post('/:id/invite', async (req, res) => {
    try {
      const person = await findPersonById(db, req.params.id);
      if (!person) throw new FlowError('not_found', 'person not found');
      if (person.clerkUserId || person.status !== 'active') throw new FlowError('conflict', 'only an invited person who has not signed in yet gets an invitation email');
      let invite;
      try {
        invite = await sendClerkInvitation(clerk, person.email, signInUrl(req));
      } catch (error) {
        log.error?.(`[people] Clerk invitation email failed: ${error.message}`);
        return res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'Clerk could not send the invitation email. Try again shortly.' });
      }
      if (!invite.emailed) throw new FlowError('conflict', 'they already have a sign-in account: they can sign in now');
      log.info?.(`[people] ${req.person.id} emailed the invitation for ${person.id} again`);
      res.json({ ok: true, invite });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  people.patch('/:id', async (req, res) => {
    try {
      const person = await updatePerson(db, { id: req.params.id, actorId: req.person.id, role: req.body?.role, status: req.body?.status });
      log.info?.(`[people] ${req.person.id} set ${person.id} to ${person.role}, ${person.status}`);
      res.json({ ok: true, person: publicPerson(person) });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  people.delete('/:id', async (req, res) => {
    try {
      const person = await removePerson(db, { id: req.params.id, actorId: req.person.id });
      log.info?.(`[people] ${req.person.id} removed ${person.id}`);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, log);
    }
  });

  router.use('/api/people', people);
  return router;
}
