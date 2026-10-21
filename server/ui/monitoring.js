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

// "Request a response": a tick box under the form's email field, off by
// default. The email field (Sentry's own words) starts with the signed-in
// person's email, but an address alone does not ask for a reply. A report
// sent with the box ticked and an address is tagged notify=yes, so the
// support desk replies (fixed, planned or won't fix). Every other report
// sends notify=no. Sentry's form has no tick box of its own (SDK 11.4.0),
// so Flow adds one to it (addResponseBox).
export function tagNotify(event, wantsResponse = false) {
  if (event?.type !== 'feedback') return;
  const email = String(event.contexts?.feedback?.contact_email ?? '').trim();
  event.tags = { ...event.tags, notify: wantsResponse && email ? 'yes' : 'no' };
}

export const RESPONSE_LABEL = 'Request a response';

// The tick box goes under the email field inside the form's shadow root, so
// flow.css cannot reach it: its look comes from the form's own variables,
// which flow.css sets from the --t-* tokens (#sentry-feedback). Ticked, the
// email is required. No email field (or no form yet): no box.
const RESPONSE_STYLE = `
.form__response { display: flex; flex-direction: row; align-items: center; gap: 8px; margin: 0; cursor: pointer; }
.form__response input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent-background); cursor: pointer; }`;
function addResponseBox(root, onChange) {
  const email = root?.querySelector('input[name="email"]:not([type="hidden"])');
  if (!email || root.querySelector('.form__response')) return Boolean(email);
  const style = document.createElement('style');
  style.textContent = RESPONSE_STYLE;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.name = 'response';
  box.addEventListener('change', () => {
    email.required = box.checked;
    onChange(box.checked);
  });
  const label = document.createElement('label');
  label.className = 'form__response';
  label.append(box, RESPONSE_LABEL);
  (email.closest('label') ?? email).after(label);
  root.append(style);
  return true;
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
    // The form fills in the signed-in person's name and email (setUser).
    useSentryUser: { name: 'username', email: 'email' },
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
    initialScope: { tags: config.tags ?? {} },
  });
  // Read when the report is sent: the tick box of the form open now.
  let wantsResponse = false;
  Sentry.getClient()?.on('beforeSendFeedback', (event) => tagNotify(event, wantsResponse));
  // Who reported or met the error, so the lab can follow up.
  Sentry.setUser({ id: person.id, email: person.email, username: person.name || undefined });
  const feedback = config.feedback ? Sentry.getFeedback() : null;
  if (!feedback) return null;
  // A new form each time. Sentry's form keeps a refused screenshot's error
  // ("Permission denied by user") until the next click, so a reused form
  // would show it before the person tries again.
  let form = null;
  return async () => {
    form?.removeFromDom();
    wantsResponse = false;
    form = await feedback.createForm();
    form.appendToDom();
    form.open();
    // The form draws itself a moment after open(); add the tick box once its
    // email field is there.
    const root = document.getElementById('sentry-feedback')?.shadowRoot;
    const onChange = (checked) => { wantsResponse = checked; };
    if (!addResponseBox(root, onChange) && root) {
      const watch = new MutationObserver(() => { if (addResponseBox(root, onChange)) watch.disconnect(); });
      watch.observe(root, { childList: true, subtree: true });
      setTimeout(() => watch.disconnect(), 5000);
    }
  };
}
