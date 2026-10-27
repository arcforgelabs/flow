import { FLOW_MARK, renderPage } from './page.js';

// The practice portal (/portal). The same states as the lab app
// (server/ui/app-page.js): loading, signed-out, off, error, no-access
// (waiting for the lab) and signed-in.
const BODY = `<div class="fx-app">
  <p class="fx-state-loading fx-loading" role="status"><span class="fx-spinner" aria-hidden="true"></span>Opening Flow…</p>

  <section class="fx-state-signed-out fx-auth" role="main" aria-labelledby="portal-auth-title">
    <div class="fx-auth__brand">
      <span class="fx-brand fx-brand--large">${FLOW_MARK}<span>Flow</span></span>
      <h1 class="fx-auth__title" id="portal-auth-title">Your work, as it moves.</h1>
    </div>
    <div class="fx-auth__form">
      <p class="fx-auth__note" id="portal-note"></p>
      <div id="portal-sign-in" class="fx-auth__widget"></div>
      <div id="portal-join" hidden></div>
    </div>
  </section>

  <section class="fx-state-message fx-message" role="main">
    <span class="fx-brand">${FLOW_MARK}<span>Flow</span></span>
    <div class="fx-card fx-message__card fx-state-off">
      <h1 class="fx-title">The portal is turned off</h1>
      <p>The lab has not turned the practice portal on.</p>
    </div>
    <div class="fx-card fx-message__card fx-state-error" role="alert">
      <h1 class="fx-title">The portal could not open</h1>
      <p>Check the connection, then try again.</p>
      <button type="button" class="fx-btn" onclick="location.reload()">Try again</button>
    </div>
    <div class="fx-card fx-message__card fx-state-no-access" id="portal-waiting"></div>
  </section>

  <div class="fx-state-signed-in fx-shell" id="shell">
    <aside class="fx-side">
      <div class="fx-side__head">
        <a class="fx-brand" href="/portal/jobs">${FLOW_MARK}<span>Flow</span></a>
        <button type="button" class="fx-btn fx-btn--ghost fx-portal-menu" id="menu-toggle" aria-controls="nav" aria-expanded="false" aria-label="Menu"></button>
      </div>
      <nav class="fx-nav" id="nav" aria-label="Practice"></nav>
      <div class="fx-side__end">
        <div id="user-button" class="fx-side__user"></div>
      </div>
    </aside>
    <main id="main" class="fx-main" tabindex="-1"></main>
  </div>
  <div id="toasts" class="fx-toasts" aria-live="polite"></div>
</div>`;

export function portalPage({ defaultFamily }) {
  return renderPage({
    title: 'Flow',
    defaultFamily,
    state: 'loading',
    scripts: ['/assets/ui/portal.js'],
    bodyClass: 'fx-portal',
    body: BODY,
  });
}
