// The themes and sizes the phone suite runs (docs/MOBILE_TESTS.md).
// `shots`: the themes that also keep screenshots at every size. The others
// keep them at the main phone size only, so the saved images stay small.
export const THEMES = [
  { id: 'meridian-light', label: 'Meridian light', family: 'meridian', mode: 'light', shots: 'all' },
  { id: 'meridian-dark', label: 'Meridian dark', family: 'meridian', mode: 'dark', shots: 'phone' },
  { id: 'harbour-light', label: 'Harbour light', family: 'harbour', mode: 'light', shots: 'phone' },
];

export const SIZES = [
  { id: 'phone-s', width: 375, height: 667, mobile: true },
  { id: 'phone', width: 393, height: 852, mobile: true },
  { id: 'phone-l', width: 412, height: 915, mobile: true },
  { id: 'tablet', width: 768, height: 1024, mobile: true },
  { id: 'desk', width: 1280, height: 800, mobile: false },
];

export const ENGINES = ['webkit', 'chromium'];
