import { defineConfig, devices } from '@playwright/test';
import { ENGINES, SIZES, THEMES } from './themes.js';

// The phone suite (docs/MOBILE_TESTS.md): every screen at every size, in
// WebKit (iPhone Safari) and Chromium, in each theme. MOBILE_ENGINES picks
// the engines (a laptop without WebKit: MOBILE_ENGINES=chromium).
const engines = (process.env.MOBILE_ENGINES ?? ENGINES.join(',')).split(',').map((e) => e.trim()).filter(Boolean);
const base = { webkit: devices['iPhone 15'], chromium: devices['Pixel 7'] };

const projects = [];
for (const engine of engines) {
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const { viewport: _v, screen: _s, deviceScaleFactor: _d, isMobile: _m, hasTouch: _t, defaultBrowserType: _b, ...device } = base[engine];
      projects.push({
        name: `${size.id}-${engine}-${theme.id}`,
        use: {
          ...(size.mobile ? device : {}),
          browserName: engine,
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
          isMobile: size.mobile && engine === 'chromium',
          hasTouch: size.mobile,
        },
        metadata: { size, engine, theme, shots: theme.shots === 'all' || size.id === 'phone' },
      });
    }
  }
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  globalSetup: './server.js',
  // A project's screens run in order on one worker, so its account's state
  // (the Jobs layout) never changes under a screen; projects run in parallel.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'report' }], ['blob']] : [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide', scale: 'css' } },
  use: { locale: 'en-AU', timezoneId: 'UTC', colorScheme: 'light', trace: 'retain-on-failure' },
  projects,
});
