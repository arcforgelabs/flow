import { fileURLToPath } from 'node:url';
import express from 'express';
import { FlowError } from '../core/errors.js';
import { rateLimit } from '../rate-limit.js';
import { ensureClerkAccount } from './clerk.js';
import {
  findPersonByEmail,
  invitePerson,
  listPeople,
  normaliseEmail,
  publicPerson,
  removePerson,
  updatePerson,
} from './people.js';
import { isPlainEmail } from './settings.js';

const signInPage = fileURLToPath(new URL('./sign-in.html', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

// The Clerk script the sign-in page loads: through Flow's own origin when
// CLERK_PROXY_URL is set, otherwise from the Clerk instance's Frontend API
// (its host is encoded in the publishable key).
export function clerkScriptUrl({ publishableKey, proxyUrl }) {
  const base = proxyUrl
    ? proxyUrl.replace(/\/+$/, '')
    : `https://${Buffer.from(publishableKey.split('_')[2] ?? '', 'base64').toString('utf8').replace(/\$$/, '')}`;
  return `${base}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
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
export function createSignInRouter({ settings, db, clerk, personAuth, rateLimitPerMinute = 30, log = console }) {
  const router = express.Router();
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
      publicSignUp: settings.publicSignUp,
      clerk: { publishableKey, proxyUrl, scriptUrl: clerkScriptUrl(settings.keys) },
    });
  });

  router.get('/', signInLimit, (_req, res) => res.redirect(302, '/sign-in'));
  router.get('/sign-in', signInLimit, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.sendFile(signInPage);
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
    res.json(body);
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

  // Invite someone. Flow also makes sure they have a Clerk account, because
  // with public sign-up off the sign-in page never creates one.
  people.post('/', async (req, res) => {
    try {
      const email = normaliseEmail(req.body?.email);
      const role = req.body?.role;
      if (!isPlainEmail(email)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
      if (await findPersonByEmail(db, email)) throw new FlowError('conflict', 'that email address is already on the people list');
      try {
        await ensureClerkAccount(clerk, email);
      } catch (error) {
        log.error?.(`[people] Clerk account for an invitation failed: ${error.message}`);
        return res.status(503).json({ ok: false, code: 'sign_in_unavailable', error: 'Flow could not prepare the sign-in account. Try again shortly.' });
      }
      const person = await invitePerson(db, { email, name: req.body?.name ?? null, role, invitedBy: req.person.id });
      log.info?.(`[people] ${req.person.id} invited ${person.id} as ${person.role}`);
      res.status(201).json({ ok: true, person: publicPerson(person) });
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
