import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// clerk-appearance.js reads the --t-* tokens from <html>; give it a fixed set.
const TOKENS = { '--t-text': '#1d2a33', '--t-paper': '#ffffff', '--t-dim': '#56606a' };
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => TOKENS[name] ?? '' });
const { flowClerkAppearance } = await import('../server/ui/clerk-appearance.js');

describe('Clerk appearance', () => {
  test('the "Manage account" icon is drawn as a gear, in the text colour', () => {
    const icon = flowClerkAppearance().elements.userButtonPopoverActionButtonIcon__manageAccount;
    assert.equal(icon['&&'].background, 'currentColor');
    const svg = decodeURIComponent(icon['&&'].mask.match(/data:image\/svg\+xml,([^"]+)"/)[1]);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 16 16"[^>]*stroke-width="1.5"/);
    assert.match(svg, /<circle /, 'the gear has a hub');
    assert.equal(icon['&&'].WebkitMask, icon['&&'].mask);
    assert.deepEqual(icon['&& > *'], { visibility: 'hidden' }, "Clerk's own cog is hidden");
  });

  test('windows Clerk opens itself follow a theme or mode change', () => {
    // The "Manage account" window takes the button's userProfileProps, and
    // any other Clerk window takes the appearance given to Clerk.load(). Both
    // must be refreshed, or the window keeps the colours from page load.
    const app = readFileSync(new URL('../server/ui/app.js', import.meta.url), 'utf8');
    assert.match(app, /if \(kind === 'userButton'\) props\.userProfileProps = \{ \.\.\.options\.userProfileProps, appearance: clerkAppearance\('modal'\) \};/);
    assert.match(app, /onAppearanceChange\(\(\) => \{\n  window\.Clerk\?\.__internal_updateProps\?\.\(\{ appearance: clerkAppearance\('modal'\) \}\);/);
  });

  test('the account button is a chip with the name, clipped to fit, and the photo alone on narrow screens', () => {
    const { elements } = flowClerkAppearance();
    assert.equal(elements.userButtonBox.flexDirection, 'row-reverse', 'the photo or initial comes first');
    const name = elements.userButtonOuterIdentifier;
    assert.equal(name.textOverflow, 'ellipsis');
    assert.equal(name.whiteSpace, 'nowrap');
    assert.equal(name.minWidth, 0);
    assert.deepEqual(name['@media (max-width: 820px)'], { display: 'none' });
    assert.equal(elements.userButtonTrigger['&&'].width, '100%');
    const app = readFileSync(new URL('../server/ui/app.js', import.meta.url), 'utf8');
    assert.match(app, /const userButton = \{ afterSignOutUrl: '\/sign-in', showName: true \};/);
    // The narrow-screen rule matches the one in flow.css, where the sidebar becomes a bar.
    const css = readFileSync(new URL('../server/ui/flow.css', import.meta.url), 'utf8');
    assert.match(css, /@media \(max-width: 820px\) \{\n  \.fx-shell \{ flex-direction: column; \}/);
  });
});
