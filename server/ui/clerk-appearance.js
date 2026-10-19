// Clerk's components (sign-in, the account button and the account page) in
// Flow's active design system: colours, type and corners are read from the
// --t-* tokens at render time, so Clerk changes with the theme and mode.
// Ported from Arc Forge Labs' Field (client/src/lib/clerk-appearance.ts).

// Clerk's "Manage account" cog has no hub, so at 16px it reads as a blob.
// This gear has the same 1.5 stroke as Clerk's sign-out icon beside it.
const GEAR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"><path d="M7.06 3.45L7.20 2.05L8.80 2.05L8.94 3.45L10.55 4.11L11.64 3.23L12.77 4.36L11.89 5.45L12.55 7.06L13.95 7.20L13.95 8.80L12.55 8.94L11.89 10.55L12.77 11.64L11.64 12.77L10.55 11.89L8.94 12.55L8.80 13.95L7.20 13.95L7.06 12.55L5.45 11.89L4.36 12.77L3.23 11.64L4.11 10.55L3.45 8.94L2.05 8.80L2.05 7.20L3.45 7.06L4.11 5.45L3.23 4.36L4.36 3.23L5.45 4.11Z"/><circle cx="8" cy="8" r="2"/></svg>')}")`;
const gearIcon = {
  '&&': { background: 'currentColor', mask: `${GEAR} center / contain no-repeat`, WebkitMask: `${GEAR} center / contain no-repeat` },
  '&& > *': { visibility: 'hidden' },
};

function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * `embedded` is the account page, where Clerk's profile sits inside Flow's
 * page; otherwise Clerk's card stands on its own (sign-in) or pops over
 * (the account button).
 */
export function flowClerkAppearance({ embedded = false, publicSignUp = false } = {}) {
  const text = token('--t-text', '#333c45');
  const line = `color-mix(in srgb, ${text} 12%, transparent)`;
  const shadow = token('--t-shadow', '0 1px 2px rgba(16, 24, 40, .06)');
  // Clerk draws an input's and an outlined button's edge as a 1px box-shadow
  // ring, so a box-shadow here replaces it. Draw it in --t-control (3:1 on
  // the paper) and keep the hover and focus states with it. Clerk sets its
  // own ring on `[data-variant]`, which outranks a plain class, so each rule
  // doubles the class (`&&`) to win.
  const edge = (color) => `0 0 0 1px ${color}`;
  const control = token('--t-control', '#949494');
  const focus = `0 0 0 3px color-mix(in srgb, ${token('--t-ring', '#1f6f8f')} 35%, transparent)`;
  const controlEdge = {
    '&&': { boxShadow: edge(control) },
    '&&:hover': { boxShadow: edge(text) },
    '&&:focus-visible, &&:focus-within, &&[data-focus-within="true"]': { boxShadow: `${edge(text)}, ${focus}` },
  };
  const danger = token('--t-danger', '#b8442a');
  const inputEdge = { ...controlEdge, '&&[data-feedback="error"]': { boxShadow: edge(danger) } };
  const display = token('--t-display', 'ui-serif, Georgia, serif');
  const dim = token('--t-dim', '#5b6773');
  return {
    variables: {
      colorPrimary: token('--t-primary', '#1f6f8f'),
      colorPrimaryForeground: token('--t-on-primary', '#ffffff'),
      colorBackground: token('--t-paper', '#ffffff'),
      colorForeground: text,
      colorMutedForeground: dim,
      colorMuted: token('--t-s1', '#f7f9fb'),
      colorInput: token('--t-paper', '#ffffff'),
      colorInputForeground: text,
      colorDanger: danger,
      colorSuccess: token('--t-success', '#3f6b2a'),
      colorWarning: token('--t-warn', '#8a5a00'),
      colorNeutral: text,
      // Clerk builds its border shades (dividers, hover edges, the badge text)
      // as fractions of colorBorder, so it takes the opaque text colour: a
      // colour already faded to 12% left the "Primary" badge near 1:1.
      colorBorder: text,
      colorRing: token('--t-ring', '#1f6f8f'),
      fontFamily: token('--t-body', 'ui-sans-serif, system-ui, sans-serif'),
      fontSize: '14px',
      borderRadius: token('--t-radius', '6px'),
    },
    elements: {
      // With public sign-up off there is no sign-up link: an installation is
      // for one business's people, and an owner invites them.
      footerAction: embedded || publicSignUp ? undefined : { display: 'none' },
      headerTitle: { fontFamily: display, fontWeight: token('--t-display-weight', '700'), letterSpacing: '-0.01em' },
      card: { boxShadow: embedded ? 'none' : shadow, border: `1px solid ${line}`, borderRadius: token('--t-radius-lg', '10px') },
      cardBox: embedded
        ? { width: '100%', maxWidth: 'none', boxShadow: 'none', border: `1px solid ${line}`, borderRadius: token('--t-radius-lg', '10px') }
        : { boxShadow: shadow, borderRadius: token('--t-radius-lg', '10px') },
      rootBox: embedded ? { width: '100%' } : undefined,
      navbar: embedded ? { background: token('--t-s1', '#f7f9fb'), borderRight: `1px solid ${line}` } : undefined,
      scrollBox: embedded ? { borderRadius: 0 } : undefined,
      formFieldInput: inputEdge,
      otpCodeFieldInput: inputEdge,
      // Clerk's default badge ("Primary" by an email address) draws its text
      // in a 62% border shade, under 4.5:1 on light papers; --t-dim reads.
      badge: { '&&': { color: dim, background: `color-mix(in srgb, ${text} 5%, transparent)`, borderColor: line } },
      formButtonPrimary: { boxShadow: 'none', textTransform: 'none', fontWeight: 650 },
      socialButtonsBlockButton: controlEdge,
      userButtonPopoverCard: { border: `1px solid ${line}`, boxShadow: shadow },
      userButtonPopoverActionButtonIcon__manageAccount: gearIcon,
      footer: embedded ? { display: 'none' } : undefined,
    },
  };
}
