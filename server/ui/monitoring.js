// Errors and problem reports from the browser, to the installation's own
// Sentry project (docs/SENTRY.md). Only while the Sentry integration is on:
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
    enableScreenshot: true,
    triggerLabel: 'Report a problem',
    formTitle: 'Report a problem',
    messageLabel: 'What went wrong?',
    messagePlaceholder: 'What you did, what you expected, and what happened.',
    submitButtonLabel: 'Send report',
    successMessageText: 'Thank you. Your report is sent.',
  })] : [];
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release ?? undefined,
    sendDefaultPii: false,
    integrations,
  });
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
