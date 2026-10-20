import * as SentryNode from '@sentry/node';
import { isReplitWorkspace } from '../../core/host.js';
import { scrubSpan } from '../../ui/monitoring.js';

// The Sentry adapter (docs/SENTRY.md). It sends the errors Flow logs, the
// browser's errors and problem reports, and performance traces from both
// (when SENTRY_TRACES_SAMPLE_RATE is above 0), to the installation's own Sentry
// project. Flow ships no DSN: each installation enters its own, here or as
// the host setting SENTRY_DSN. It has no tables.

// The browser SDK, loaded from Sentry's CDN only while this adapter is on
// (server/ui/monitoring.js). Pinned, with its integrity hash. With traces on,
// the bundle that also traces; Sentry ships it only with session replay in
// it too, which Flow never turns on.
export const SENTRY_BROWSER = Object.freeze({
  src: 'https://browser.sentry-cdn.com/11.4.0/bundle.feedback.min.js',
  integrity: 'sha384-H9RmZ/VaqOPZrUezgCSqHp4t3LoQMd/5+0Y4oEGUB2bddZzSnwZiOYoWneK4diWt',
});
export const SENTRY_BROWSER_TRACING = Object.freeze({
  src: 'https://browser.sentry-cdn.com/11.4.0/bundle.tracing.replay.feedback.min.js',
  integrity: 'sha384-LjwHQKAojcITl6Q7innDSAFjziFnqV9ovZBNXnXnQwub1VXIdBMJnYrQNihtxSa6',
});

// The share of requests and page loads traced when the setting is empty.
export const DEFAULT_TRACES_SAMPLE_RATE = 0.2;

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
    { name: 'SENTRY_ENVIRONMENT', label: 'Environment', help: 'How Sentry labels this installation, for example production. Empty: production, or workspace in a Replit workspace.' },
    { name: 'SENTRY_FEEDBACK', label: 'Report a problem button', kind: 'onoff', help: 'On: everyone signed in can send a report, with a screenshot, to this Sentry project.' },
    { name: 'SENTRY_TRACES_SAMPLE_RATE', label: 'Traces', help: 'The share of clicks, page loads and requests timed, from 0 (off) to 1 (all). Empty: 0.2.' },
  ],
};

export function readSentrySettings(env) {
  const dsn = String(env.SENTRY_DSN ?? '').trim();
  if (!dsn) throw new Error('SENTRY_DSN is not set. Enter the Sentry project\'s DSN in Settings, Integrations.');
  if (!DSN_PATTERN.test(dsn)) throw new Error('SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project id>).');
  // A Replit workspace shares the published app's secrets; its errors are
  // labelled apart so they never read as the live app's.
  const environment = String(env.SENTRY_ENVIRONMENT ?? '').trim() || (isReplitWorkspace(env) ? 'workspace' : 'production');
  const feedback = String(env.SENTRY_FEEDBACK ?? 'on').trim() !== 'off';
  const rate = String(env.SENTRY_TRACES_SAMPLE_RATE ?? '').trim();
  const tracesSampleRate = rate === '' ? DEFAULT_TRACES_SAMPLE_RATE : Number(rate);
  if (!/^\d*\.?\d+$/.test(rate || '0') || !(tracesSampleRate >= 0 && tracesSampleRate <= 1)) {
    throw new Error('SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1, such as 0.2.');
  }
  return { dsn, environment, feedback, tracesSampleRate };
}

// No trace for the host's health check: it is not a person waiting.
const UNTRACED_PATHS = new Set(['/health']);

// The release Sentry groups events by: Flow's release tag, else its commit.
export function sentryRelease(env) {
  const read = (value) => String(value ?? '').trim() || null;
  const release = read(env.FLOW_DEPLOYED_RELEASE) ?? read(env.FLOW_RELEASE);
  const revision = read(env.FLOW_REVISION);
  return release ? `flow@${release.replace(/^v/, '')}` : revision ? `flow@${revision.slice(0, 12)}` : null;
}

// `sdk` is for tests: anything with init, captureEvent, captureException
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
        // A request the browser traced keeps the browser's choice, so a
        // click and the server work it caused stay one trace.
        tracesSampler: ({ attributes, inheritOrSampleWith }) => (
          UNTRACED_PATHS.has(attributes?.['url.path']) ? 0 : inheritOrSampleWith(settings.tracesSampleRate)
        ),
        beforeSendSpan: scrubSpan,
      });
      log.info?.(`[sentry] on: environment ${settings.environment}; report button ${settings.feedback ? 'on' : 'off'}; traces ${settings.tracesSampleRate > 0 ? settings.tracesSampleRate : 'off'}`);
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
        // Not captureMessage: the SDK adds a stack to it, and Sentry then
        // names the issue after its top frame ("Object.captureError"), not
        // the line Flow logged. A plain event keeps the line as the title.
        else sdk.captureEvent({ message, ...scope });
      },
      // What the browser needs to report to the same project. The DSN is
      // meant for browsers.
      browserMonitoring() {
        if (!settings) return null;
        const { tracesSampleRate } = settings;
        return {
          dsn: settings.dsn,
          environment: settings.environment,
          release,
          feedback: settings.feedback,
          tracesSampleRate,
          script: tracesSampleRate > 0 ? SENTRY_BROWSER_TRACING : SENTRY_BROWSER,
        };
      },
      // Runs `work` in a span of the current trace (server/core/tracing.js).
      // Work outside a traced request (the pipeline, the workers) starts no
      // trace of its own.
      traceSpan({ name, op, attributes }, work) {
        if (!settings?.tracesSampleRate) return work();
        return sdk.startSpan({ name, op, attributes, onlyIfParent: true }, work);
      },
      // At a request's start: a function that names its trace once the route
      // is known, or null when this request is not traced.
      traceRequest() {
        if (!settings?.tracesSampleRate) return null;
        const span = sdk.getActiveSpan();
        if (!span) return null;
        const root = sdk.getRootSpan(span);
        return (name) => sdk.updateSpanName(root, name);
      },
    },
  };
}

export const sentryAdapter = createSentryAdapter();
