// Errors, problem reports and performance traces from the browser, to the
// installation's own Sentry project (docs/SENTRY.md). Only while the Sentry
// integration is on:
// GET /api/monitoring says so and gives the project's public DSN. The SDK
// comes from Sentry's CDN, pinned and checked against its integrity hash.
// With the integration off, nothing loads and there is no "Report a problem".

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => reject(new Error('The Sentry SDK could not load.'));
    document.head.append(script);
  });
}

// "Notify me": the form's email field (Sentry's own words) starts empty and
// is optional. A person who types an address there asks to hear back; Flow
// tags the report notify=yes, so the support desk sees it on the task.
// Sentry's form has no tick box of its own; this keeps to its stock options.
export function tagNotify(event) {
  if (event?.type !== 'feedback') return;
  const email = String(event.contexts?.feedback?.contact_email ?? '').trim();
  event.tags = { ...event.tags, notify: email ? 'yes' : 'no' };
}

// A path as a pattern: each id in it becomes ":id", so every invoice's page
// is one name in a trace. The server names its requests the same way when no
// route matched (server/core/tracing.js).
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z_-]*\d[0-9a-z_-]{15,})$/i;
export function routePattern(path) {
  const bare = String(path ?? '').replace(/[?#].*$/, '');
  return bare.split('/').map((part) => (ID_SEGMENT.test(part) ? ':id' : part)).join('/');
}

// What a trace span keeps: timings, the route, the status. Never a query
// string (a search can hold a name), a header, a cookie, an address or an
// email. The person's Flow id stays, as on errors. Used here and by the
// server (server/integrations/sentry/index.js).
const DROPPED_ATTRIBUTE = /^(http\.(request|response)\.header\.|client\.|network\.(peer|local)\.|url\.(query|fragment)$|user\.(?!id$))/;
export function scrubSpan(span) {
  if (!span) return span;
  // "GET /api/search?q=…" loses its query; a database span's SQL keeps its "?".
  const request = /^((?:GET|POST|PUT|PATCH|DELETE) \S*?)[?#]\S*/;
  if (typeof span.name === 'string') span.name = span.name.replace(request, '$1');
  if (typeof span.description === 'string') span.description = span.description.replace(request, '$1');
  const attributes = span.attributes ?? span.data;
  if (attributes) {
    for (const key of Object.keys(attributes)) {
      if (DROPPED_ATTRIBUTE.test(key)) delete attributes[key];
      else if (typeof attributes[key] === 'string' && /(^|\.)url(\.full)?$|^http\.url$/.test(key)) attributes[key] = attributes[key].replace(/[?#].*$/, '');
    }
  }
  return span;
}

/** Resolves to a function that opens the "Report a problem" form, or null. */
export async function startMonitoring({ flow, person }) {
  const config = await flow('/api/monitoring');
  if (!config.on || config.service !== 'sentry') return null;
  await loadScript(config.script);
  const Sentry = window.Sentry;
  const integrations = config.feedback ? [Sentry.feedbackIntegration({
    autoInject: false,
    // The form's colours and font come from flow.css (#sentry-feedback), so
    // it follows each person's theme and mode, even when they change it.
    colorScheme: 'light',
    showBranding: false,
    // Flow already knows who is signed in (setUser below).
    showName: false,
    // The email field is the opt-in (tagNotify), so it is not filled from
    // the signed-in person: a key setUser never sets.
    useSentryUser: { name: 'username', email: 'notify_email' },
    enableScreenshot: true,
    triggerLabel: 'Report a problem',
    formTitle: 'Report a problem',
    messageLabel: 'What went wrong?',
    messagePlaceholder: 'What you did, what you expected, and what happened.',
    submitButtonLabel: 'Send report',
    successMessageText: 'Thank you. Your report is sent.',
  })] : [];
  // Traces: page loads, moves between pages and each click's wait, with the
  // calls to Flow's server joined to the server's own trace. Only when the
  // installation set a share above 0 (SENTRY_TRACES_SAMPLE_RATE).
  const tracesSampleRate = Number(config.tracesSampleRate) || 0;
  if (tracesSampleRate > 0) {
    integrations.push(Sentry.browserTracingIntegration({
      beforeStartSpan: (options) => ({ ...options, name: routePattern(options.name) }),
    }));
  }
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release ?? undefined,
    sendDefaultPii: false,
    integrations,
    tracesSampleRate,
    beforeSendSpan: scrubSpan,
  });
  Sentry.getClient()?.on('beforeSendFeedback', tagNotify);
  // Who reported or met the error, so the lab can follow up.
  Sentry.setUser({ id: person.id, email: person.email });
  const feedback = config.feedback ? Sentry.getFeedback() : null;
  if (!feedback) return null;
  // One form, made on first use and opened again after that.
  let form = null;
  return async () => {
    if (!form) {
      form = await feedback.createForm();
      form.appendToDom();
    }
    form.open();
  };
}
