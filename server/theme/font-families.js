// Each design system's faces, as the fontsource packages Flow serves under
// /assets/fonts/<package>/ (server/ui/routes.js). A page loads only the chosen
// family's faces, plus JetBrains Mono for codes. Shared by the server and the
// browser, so it imports nothing.
export const MONO_FONT = 'jetbrains-mono';

export const FAMILY_FONTS = {
  harbour: ['nunito-sans', 'playfair-display'],
  beacon: ['atkinson-hyperlegible-next'],
  tide: ['ibm-plex-sans'],
  claw: ['instrument-sans'],
  knot: ['geist'],
  dash: ['dm-sans'],
  absolutely: ['space-grotesk'],
  phosphor: [],
  crt: [],
  manuscript: ['lora'],
  rose: ['dm-sans'],
  miami: ['space-grotesk'],
};

/** Every package a family can ask for, so the server serves only these. */
export const FONT_PACKAGES = [...new Set([MONO_FONT, ...Object.values(FAMILY_FONTS).flat()])];

/** The stylesheet URLs a family needs, mono first. */
export function fontStylesheets(family) {
  return [MONO_FONT, ...(FAMILY_FONTS[family] ?? [])].map((name) => `/assets/fonts/${name}/index.css`);
}
