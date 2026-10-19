// Errors and problem reports from the browser, to the installation's own
// Sentry project (docs/SENTRY.md). Only while the Sentry integration is on:
// GET /api/monitoring says so and gives the project's public DSN. The SDK
// comes from Sentry's CDN, pinned and checked against its integrity hash.
// With the integration off, nothing loads and the report button stays hidden.

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

export async function startMonitoring({ flow, person, button }) {
  const config = await flow('/api/monitoring');
  if (!config.on || config.service !== 'sentry') return;
  await loadScript(config.script);
  const Sentry = window.Sentry;
  const integrations = config.feedback ? [Sentry.feedbackIntegration({
    autoInject: false,
    colorScheme: document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light',
    showBranding: false,
    // Flow already knows who is signed in (setUser below).
    showName: false,
    // The form takes the installation's brand colour (CSS variables reach
    // into the form's shadow DOM).
    themeLight: { accentBackground: 'var(--t-brand)' },
    themeDark: { accentBackground: 'var(--t-brand)' },
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
  if (config.feedback) {
    Sentry.getFeedback()?.attachTo(button);
    button.hidden = false;
  }
}
