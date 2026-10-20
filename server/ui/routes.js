import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from '../rate-limit.js';
import { FONT_PACKAGES } from '../theme/font-families.js';
import { themeStylesheet } from '../theme/themes.js';

// The files every page loads (server/ui/page.js), under /assets:
//   /assets/themes.css       every design system as [data-theme][data-mode] rules
//   /assets/theme/<file>.js  the theme engine itself, as browser modules
//   /assets/ui/<file>        Flow's components (flow.css) and page scripts
//   /assets/fonts/<pkg>/…    the families' faces (server/theme/font-families.js)
//   /assets/icons/<name>.svg one Lucide icon (lucide-static, ISC), for any page
// Only the files named here are served. They change only with a release, so
// browsers may keep them for an hour.

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const themeDir = join(here, '..', 'theme');
const logoDir = join(here, 'logos');
const LOGO_FILES = new Set(['xero.svg', 'seazona.svg', 'sentry.svg']);
const THEME_FILES = new Set(['themes.js', 'color-contrast.js', 'openclaw-palettes.js', 'font-families.js']);
const UI_FILES = new Set(['flow.css', 'appearance.js', 'clerk-appearance.js', 'app.js', 'invoicing.js', 'invoice-notes.js', 'job-change.js', 'invoicing-settings.js', 'automations.js', 'invoice-rules.js', 'line-mappings.js', 'price-list.js', 'custom-fields.js', 'jobs.js', 'job-board.js', 'job-view.js', 'monitoring.js', 'search.js', 'alerts.js', 'bulk-bar.js', 'flow-mark.svg']);
const iconDir = join(dirname(require.resolve('lucide-static/package.json')), 'icons');
const ICON_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/;
const MAX_AGE = '1h';

// Send one named file from dir. Passing dir as root limits the dotfile check
// to the file name, so an install under a dot directory (such as
// .flow-deploy/) still serves its assets. A missing file falls through to the
// app's own 404.
const sendNamed = (res, next, dir, file) =>
  res.sendFile(file, { root: dir, maxAge: MAX_AGE }, (err) => err && !res.headersSent && next());

export function createUiAssetsRouter({ rateLimitPerMinute = 600 } = {}) {
  const router = express.Router();
  const css = themeStylesheet();
  router.use('/assets', rateLimit({ limit: rateLimitPerMinute, windowMs: 60_000 }));

  router.get('/assets/themes.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('css').send(css);
  });

  const sendFrom = (dir, allowed) => (req, res, next) => {
    if (!allowed.has(req.params.file)) return next();
    sendNamed(res, next, dir, req.params.file);
  };
  router.get('/assets/theme/:file', sendFrom(themeDir, THEME_FILES));
  router.get('/assets/ui/:file', sendFrom(here, UI_FILES));
  // Each integration's logo, the maker's own mark (Integrations).
  router.get('/assets/ui/logos/:file', sendFrom(logoDir, LOGO_FILES));

  // The whole Lucide set: a page names any icon, and only the icons a page
  // uses are fetched. A name outside the set falls through to the 404.
  router.get('/assets/icons/:file', (req, res, next) => {
    if (!ICON_FILE.test(req.params.file)) return next();
    sendNamed(res, next, iconDir, req.params.file);
  });

  for (const name of FONT_PACKAGES) {
    const dir = dirname(require.resolve(`@fontsource-variable/${name}/LICENSE`));
    router.get(`/assets/fonts/${name}/index.css`, (_req, res, next) => sendNamed(res, next, dir, 'index.css'));
    router.use(`/assets/fonts/${name}/files`, express.static(join(dir, 'files'), { maxAge: MAX_AGE, index: false, fallthrough: false }));
  }

  return router;
}
