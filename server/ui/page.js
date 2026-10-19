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
export function renderPage({ title, body, defaultFamily, scripts = [], bodyClass = '', state = '' }) {
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
<script>${bootScript(defaultFamily)}</script>
${scripts.map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`).join('\n')}
</head>
<body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}${state ? ` data-state="${escapeHtml(state)}"` : ''}>
${body}
</body>
</html>
`;
}

/** A one-message page, such as the end of connecting Xero. */
export function messagePage({ title, text, defaultFamily, tone = 'info' }) {
  return renderPage({
    title,
    defaultFamily,
    bodyClass: 'fx-centre',
    scripts: ['/assets/ui/appearance.js'],
    body: `<main class="fx-message">
  <a class="fx-brand" href="/">${FLOW_MARK}<span>Flow</span></a>
  <section class="fx-card fx-message__card" data-tone="${escapeHtml(tone)}">
    <h1 class="fx-title">${escapeHtml(title)}</h1>
    <p>${escapeHtml(text)}</p>
    <a class="fx-btn" href="/">Back to Flow</a>
  </section>
</main>`,
  });
}
