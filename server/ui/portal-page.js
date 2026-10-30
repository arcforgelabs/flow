import { FLOW_MARK, renderPage } from './page.js';

// The practice portal (/portal). A separate shell from the lab app: a
// practice member is not a lab person. <body data-state> uses the same
// names as the lab app (flow.css).
const BODY = `<div class="fx-app fx-portal">
  <p class="fx-state-loading fx-loading" role="status"><span class="fx-spinner" aria-hidden="true"></span>Opening Flow…</p>

  <section class="fx-state-signed-out fx-auth" aria-labelledby="auth-title">
    <div class="fx-auth__brand">
      <span class="fx-brand fx-brand--large">${FLOW_MARK}<span>Flow</span></span>
      <h1 class="fx-auth__title" id="auth-title">Your jobs</h1>
    </div>
    <div class="fx-auth__form">
      <div id="sign-in" class="fx-auth__widget"></div>
      <div id="join" class="fx-auth__widget" hidden></div>
      <p class="fx-auth__note"><a href="/portal/join" id="join-link">Join</a></p>
      <button type="button" class="fx-btn fx-btn--ghost fx-btn--sm fx-mode-toggle" data-mode-toggle>Light or dark</button>
    </div>
  </section>

  <section class="fx-state-message fx-message">
    <span class="fx-brand">${FLOW_MARK}<span>Flow</span></span>
    <div class="fx-card fx-message__card fx-state-off">
      <h1 class="fx-title">Sign-in is not set up</h1>
    </div>
    <div class="fx-card fx-message__card fx-state-error" role="alert">
      <h1 class="fx-title">Sign-in could not load</h1>
      <button type="button" class="fx-btn" onclick="location.reload()">Try again</button>
    </div>
    <div class="fx-card fx-message__card fx-state-no-access" id="no-access"></div>
  </section>

  <div class="fx-state-signed-in fx-shell" id="shell">
    <aside class="fx-side">
      <div class="fx-side__head">
        <a class="fx-brand" href="/portal/jobs">${FLOW_MARK}<span>Flow</span></a>
        <button type="button" class="fx-btn fx-btn--ghost fx-btn--icon" id="menu-toggle" aria-controls="nav" aria-label="Menu"></button>
      </div>
      <nav class="fx-nav" id="nav" aria-label="Practice"></nav>
      <div class="fx-side__end">
        <label class="fx-field" id="practice-switch" hidden>Practice<select class="fx-select" id="practice"></select></label>
        <div id="user-button" class="fx-side__user"></div>
      </div>
    </aside>
    <main id="main" class="fx-main" tabindex="-1"></main>
  </div>
  <div id="toasts" class="fx-toasts" aria-live="polite"></div>
</div>`;

export function portalPage({ defaultFamily, nonce }) {
  return renderPage({
    title: 'Flow',
    defaultFamily,
    state: 'loading',
    nonce,
    scripts: ['/assets/ui/portal.js'],
    body: BODY,
  });
}
