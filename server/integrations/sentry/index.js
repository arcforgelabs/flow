import * as SentryNode from '@sentry/node';

// The Sentry adapter (docs/SENTRY.md). It sends the errors Flow logs, and the
// browser's errors and problem reports, to the installation's own Sentry
// project. Flow ships no DSN: each installation enters its own, here or as
// the host setting SENTRY_DSN. It has no tables.

// The browser SDK, loaded from Sentry's CDN only while this adapter is on
// (server/ui/monitoring.js). Pinned, with its integrity hash.
export const SENTRY_BROWSER = Object.freeze({
  src: 'https://browser.sentry-cdn.com/11.4.0/bundle.feedback.min.js',
  integrity: 'sha384-H9RmZ/VaqOPZrUezgCSqHp4t3LoQMd/5+0Y4oEGUB2bddZzSnwZiOYoWneK4diWt',
});

// A DSN is https://<public key>@<host>/<project id>.
const DSN_PATTERN = /^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(:\d+)?\/(\d+)$/i;

export const SENTRY_SETUP = {
  guide: {
    title: 'Connect your own Sentry project',
    link: 'https://sentry.io/signup/',
    steps: [
      'Sign in to your organisation\'s own Sentry account, or create one.',
      'Create a project. Choose Express as the platform.',
      'Open the project\'s Settings, Client Keys (DSN), and copy the DSN.',
      'Paste it below, or set SENTRY_DSN where Flow is hosted. Then turn Sentry on.',
      'Optional: in Sentry, Settings, Integrations, add your issue tracker to turn a report into a task.',
    ],
  },
  fields: [
    { name: 'SENTRY_DSN', label: 'DSN', kind: 'url', help: 'From the Sentry project\'s Client Keys. Browsers see it, so it is not a secret.' },
    { name: 'SENTRY_ENVIRONMENT', label: 'Environment', help: 'How Sentry labels this installation, for example production. Empty: production.' },
    { name: 'SENTRY_FEEDBACK', label: 'Report a problem button', kind: 'onoff', help: 'On: everyone signed in can send a report, with a screenshot, to this Sentry project.' },
  ],
};

export function readSentrySettings(env) {
  const dsn = String(env.SENTRY_DSN ?? '').trim();
  if (!dsn) throw new Error('SENTRY_DSN is not set. Enter the Sentry project\'s DSN in Settings, Integrations.');
  if (!DSN_PATTERN.test(dsn)) throw new Error('SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project id>).');
  const environment = String(env.SENTRY_ENVIRONMENT ?? '').trim() || 'production';
  const feedback = String(env.SENTRY_FEEDBACK ?? 'on').trim() !== 'off';
  return { dsn, environment, feedback };
}

// The release Sentry groups events by: Flow's release tag, else its commit.
export function sentryRelease(env) {
  const read = (value) => String(value ?? '').trim() || null;
  const release = read(env.FLOW_DEPLOYED_RELEASE) ?? read(env.FLOW_RELEASE);
  const revision = read(env.FLOW_REVISION);
  return release ? `flow@${release.replace(/^v/, '')}` : revision ? `flow@${revision.slice(0, 12)}` : null;
}

// `sdk` is for tests: anything with init, captureMessage, captureException
// and close, as @sentry/node has.
export function createSentryAdapter({ sdk = SentryNode, env: hostEnv = process.env } = {}) {
  let settings = null;
  let release = null;

  return {
    id: 'sentry',
    name: 'Sentry',
    bundled: false,
    setup: SENTRY_SETUP,
    async start({ log, env }) {
      settings = readSentrySettings(env ?? hostEnv);
      release = sentryRelease(hostEnv);
      sdk.init({
        dsn: settings.dsn,
        environment: settings.environment,
        release: release ?? undefined,
        // Flow sends what it logs; no request bodies, cookies or IP addresses.
        sendDefaultPii: false,
        tracesSampleRate: 0,
        skipOpenTelemetrySetup: true,
      });
      log.info?.(`[sentry] on: environment ${settings.environment}; report button ${settings.feedback ? 'on' : 'off'}`);
    },
    async stop() {
      if (settings) await sdk.close(2000);
      settings = null;
    },
    capabilities: {
      async health() {
        return { ok: Boolean(settings), environment: settings?.environment ?? null, feedback: settings?.feedback ?? false };
      },
      // One error Flow logged: `source` is its "[tag]", `error` the Error when
      // there is one.
      captureError({ message, source = 'server', error = null }) {
        if (!settings) return;
        const scope = { level: 'error', tags: { source } };
        if (error instanceof Error) sdk.captureException(error, { ...scope, extra: { log: message } });
        else sdk.captureMessage(message, scope);
      },
      // What the browser needs to report to the same project. The DSN is
      // meant for browsers.
      browserMonitoring() {
        if (!settings) return null;
        return { dsn: settings.dsn, environment: settings.environment, release, feedback: settings.feedback, script: SENTRY_BROWSER };
      },
    },
  };
}

export const sentryAdapter = createSentryAdapter();
