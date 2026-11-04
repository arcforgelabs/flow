import { fontStylesheets } from '../theme/font-families.js';
import { THEME_FAMILIES } from '../theme/themes.js';

// Every Flow page starts here: the design system's tokens, Flow's components
// (flow.css) and a small script that puts the person's design system and
// light or dark on <html> before first paint, with that family's faces.
// server/ui/appearance.js reads and writes the same choice afterwards; keep
// the storage key and resolution in step (docs/DESIGN.md).

export const APPEARANCE_KEY = 'flow_appearance';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Flow's mark: two waves on a rounded square, in the theme's primary colours.
export const FLOW_MARK = '<svg class="fx-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
  + '<rect width="32" height="32" rx="8" fill="var(--t-primary)"/>'
  + '<path d="M7 13.5c3-3 6-3 9 0s6 3 9 0M7 20.5c3-3 6-3 9 0s6 3 9 0" fill="none" stroke="var(--t-on-primary)" stroke-width="2.4" stroke-linecap="round"/>'
  + '</svg>';

const FONTS = Object.fromEntries(THEME_FAMILIES.map(({ id }) => [id, fontStylesheets(id)]));

function bootScript(defaultFamily) {
  const boot = JSON.stringify({ key: APPEARANCE_KEY, defaultFamily, fonts: FONTS }).replace(/</g, '\\u003c');
  return `(function () {
  var boot = ${boot};
  var mode = 'system';
  var family = boot.defaultFamily;
  try {
    var saved = JSON.parse(localStorage.getItem(boot.key) || '{}');
    mode = saved.colorMode || 'system';
    if (Object.prototype.hasOwnProperty.call(boot.fonts, saved.themeFamily)) family = saved.themeFamily;
  } catch (e) {}
  var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', family);
  root.setAttribute('data-mode', dark ? 'dark' : 'light');
  boot.fonts[family].forEach(function (href) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-font', '');
    document.head.appendChild(link);
  });
})();`;
}

/**
 * A full HTML page in the installation's design system. `body` is trusted
 * markup (escape any text with escapeHtml); `scripts` are module URLs.
 */
export function renderPage({ title, body, defaultFamily, scripts = [], bodyClass = '', state = '', nonce = null }) {
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(defaultFamily)}" data-mode="light" data-default-theme="${escapeHtml(defaultFamily)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/ui/flow-mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/themes.css">
<link rel="stylesheet" href="/assets/ui/flow.css">
<script${nonceAttr}>${bootScript(defaultFamily)}</script>
${scripts.map((src) => `<script type="module" src="${escapeHtml(src)}"${nonceAttr}></script>`).join('\n')}
</head>
<body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}${state ? ` data-state="${escapeHtml(state)}"` : ''}>
${body}
</body>
</html>
`;
}

// Mode labels on the connected callback card (issue #211). Sandbox is the
// Demo Company; replay is for development and CI.
const MODE_LABELS = Object.freeze({ live: 'Live', sandbox: 'Demo', replay: 'Replay' });

function modeLabel(mode) {
  if (mode == null || mode === '') return '';
  const key = String(mode).toLowerCase();
  return MODE_LABELS[key] ?? String(mode).replace(/^./, (c) => c.toUpperCase());
}

function lucideIcon(name) {
  return `<span class="fx-lucide" style="--icon: url(/assets/icons/${escapeHtml(name)}.svg)" aria-hidden="true"></span>`;
}

/**
 * A one-message page, such as the end of connecting an integration.
 *
 * Optional `integration` ({ name, logo }) shows Flow's mark beside the
 * maker's logo. Optional `organisation` and `mode` become a status line.
 * On success, `autoReturnSeconds` (default 5 when tone is success and an
 * integration is named) starts a polite countdown and returns to Flow; set
 * it to 0 or false to keep the person on the page. Failure never auto-returns.
 */
export function messagePage({
  title,
  text,
  defaultFamily,
  tone = 'info',
  integration = null,
  organisation = null,
  mode = null,
  autoReturnSeconds,
  href = '/',
}) {
  const safeHref = typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') ? href : '/';
  const logo = integration?.logo && /^[a-z0-9][a-z0-9._-]*\.svg$/i.test(integration.logo) ? integration.logo : null;
  const integrationName = integration?.name ? String(integration.name) : '';
  const showMarks = Boolean(logo || integrationName);
  const resultIcon = tone === 'success' ? 'check-circle' : tone === 'danger' ? 'x-circle' : null;
  const org = organisation != null && String(organisation).trim() ? String(organisation).trim() : '';
  const modeText = modeLabel(mode);
  const statusParts = [org, modeText].filter(Boolean);
  const returnSeconds = autoReturnSeconds === false || autoReturnSeconds === 0
    ? 0
    : tone === 'success' && showMarks
      ? Math.max(1, Math.min(30, Number(autoReturnSeconds) || 5))
      : 0;

  const marks = showMarks
    ? `<div class="fx-message__marks" aria-hidden="true">
      <span class="fx-logo fx-logo--lg fx-message__flow">${FLOW_MARK}</span>
      <span class="fx-message__plus">+</span>
      <span class="fx-logo fx-logo--lg">${logo
        ? `<img src="/assets/ui/logos/${escapeHtml(logo)}" alt="">`
        : lucideIcon('plug')}</span>
      ${resultIcon ? `<span class="fx-message__result" data-tone="${escapeHtml(tone)}">${lucideIcon(resultIcon)}</span>` : ''}
    </div>`
    : resultIcon
      ? `<div class="fx-message__marks fx-message__marks--solo" aria-hidden="true">
      <span class="fx-message__result" data-tone="${escapeHtml(tone)}">${lucideIcon(resultIcon)}</span>
    </div>`
      : '';

  const status = statusParts.length
    ? `<p class="fx-message__status"><span class="fx-status" data-tone="${escapeHtml(tone === 'danger' ? 'danger' : 'success')}">${escapeHtml(statusParts.join(' · '))}</span></p>`
    : '';

  const returnLine = returnSeconds
    ? `<p class="fx-message__return" hidden aria-live="polite" data-return-after="${returnSeconds}" data-return-href="${escapeHtml(safeHref)}"></p>`
    : '';

  // Clean the OAuth query from the address. On success only, count down and
  // return to Flow. Without JavaScript the Back button is enough.
  const cleanScript = showMarks || returnSeconds
    ? `<script>try{history.replaceState(null,'',location.pathname)}catch(e){}</script>`
    : '';
  const returnScript = returnSeconds
    ? `<script>
(function () {
  var el = document.querySelector('[data-return-after]');
  if (!el) return;
  var left = Number(el.getAttribute('data-return-after')) || 0;
  var href = el.getAttribute('data-return-href') || '/';
  if (left < 1) return;
  el.hidden = false;
  function say(n) {
    el.textContent = n === 1 ? 'Going back to Flow in 1 second' : 'Going back to Flow in ' + n + ' seconds';
  }
  say(left);
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      location.assign(href);
      return;
    }
    say(left);
  }, 1000);
})();
</script>`
    : '';

  return renderPage({
    title,
    defaultFamily,
    bodyClass: 'fx-centre',
    scripts: ['/assets/ui/appearance.js'],
    body: `<main class="fx-message">
  <a class="fx-brand" href="${escapeHtml(safeHref)}">${FLOW_MARK}<span>Flow</span></a>
  <section class="fx-card fx-message__card" data-tone="${escapeHtml(tone)}">
    ${marks}
    <h1 class="fx-title">${escapeHtml(title)}</h1>
    ${status}
    <p>${escapeHtml(text)}</p>
    ${returnLine}
    <a class="fx-btn" href="${escapeHtml(safeHref)}">Back to Flow</a>
  </section>
</main>
${cleanScript}
${returnScript}`,
  });
}
