import { FLOW_MARK, renderPage } from './page.js';

// The page at /sign-in and at each view (APP_PATHS): the sign-in screen and,
// once signed in, Flow's app
// (server/ui/app.js). <body data-state> says which part shows (flow.css):
// loading, off (sign-in not configured), error, signed-out, no-access or
// signed-in.
const BODY = `<div class="fx-app">
  <p class="fx-state-loading fx-loading" role="status"><span class="fx-spinner" aria-hidden="true"></span>Opening Flow…</p>

  <section class="fx-state-signed-out fx-auth" aria-labelledby="auth-title">
    <div class="fx-auth__brand">
      <span class="fx-brand fx-brand--large">${FLOW_MARK}<span>Flow</span></span>
      <h1 class="fx-auth__title" id="auth-title">Every job billed, every invoice paid.</h1>
    </div>
    <div class="fx-auth__form">
      <p class="fx-auth__note" id="sign-in-note"></p>
      <div id="sign-in" class="fx-auth__widget"></div>
      <button type="button" class="fx-btn fx-btn--ghost fx-btn--sm fx-mode-toggle" data-mode-toggle>Light or dark</button>
    </div>
  </section>

  <section class="fx-state-message fx-message">
    <span class="fx-brand">${FLOW_MARK}<span>Flow</span></span>
    <div class="fx-card fx-message__card fx-state-off">
      <h1 class="fx-title">Sign-in is not set up</h1>
      <p>The operator turns it on with FLOW_AUTH=clerk and the Clerk keys (docs/SELF_HOSTING.md).</p>
    </div>
    <div class="fx-card fx-message__card fx-state-error" role="alert">
      <h1 class="fx-title">Sign-in could not load</h1>
      <p>Check the connection, then try again.</p>
      <button type="button" class="fx-btn" onclick="location.reload()">Try again</button>
    </div>
    <div class="fx-card fx-message__card fx-state-no-access" id="no-access"></div>
  </section>

  <div class="fx-state-signed-in fx-shell">
    <aside class="fx-side">
      <a class="fx-brand" href="/">${FLOW_MARK}<span>Flow</span></a>
      <nav class="fx-nav" id="nav" aria-label="Flow"></nav>
      <div class="fx-side__end">
        <div id="user-button" class="fx-side__user"></div>
        <button type="button" class="fx-btn fx-btn--ghost fx-btn--icon fx-mode-toggle" data-mode-toggle>Light or dark</button>
      </div>
    </aside>
    <main id="main" class="fx-main" tabindex="-1"></main>
  </div>
  <div id="toasts" class="fx-toasts" aria-live="polite"></div>
</div>`;

export const APP_PATHS = ['/sign-in', '/jobs', '/invoices', '/invoices/:id', '/people', '/integrations', '/integrations/:id', '/account', '/appearance', '/invoicing-settings'];

export function appPage({ defaultFamily }) {
  return renderPage({
    title: 'Flow',
    defaultFamily,
    state: 'loading',
    scripts: ['/assets/ui/app.js'],
    body: BODY,
  });
}
