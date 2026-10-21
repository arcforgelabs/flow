// Tips: every control that shows only an icon says its name on hover and on
// keyboard focus, in one small tip beside it. One listener on the document
// serves the whole app, so a new icon button needs only a name:
//
//   data-tip="Clear"       the tip, when it differs from the spoken name
//   aria-label="Close"     an icon-only control's name is its tip
//   title="Search"         taken over as the tip (no second, native tip)
//
// A control with words on it shows no tip. Clerk's own components keep their
// own tips. The tip floats on <body>, so a scrolling list cannot cut it off.

const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="switch"], summary';
const CANDIDATE = `[data-tip], ${INTERACTIVE.split(', ').map((s) => `${s}[aria-label], ${s}[title]`).join(', ')}, [role="img"][aria-label], [role="img"][title]`;

// True when the element shows no word of its own: only icons or a symbol.
export function iconOnly(text) {
  return !/[\p{L}\p{N}]/u.test(String(text ?? ''));
}

// The tip for this element, or null. `el` needs getAttribute, textContent
// and closest (a DOM element, or a test's stand-in).
export function tipText(el) {
  if (!el || el.closest?.('[class*="cl-"]')) return null;
  if (!iconOnly(el.textContent) && !el.getAttribute('data-tip')) return null;
  return el.getAttribute('title') || el.getAttribute('data-tip') || el.getAttribute('aria-label') || null;
}

// Marks a control icon-only: its spoken name and its tip. Returns the node.
export function named(node, label, tip = label) {
  node.setAttribute('aria-label', label);
  node.setAttribute('data-tip', tip);
  node.removeAttribute('title');
  return node;
}

let bubble = null;
let anchor = null;

function place() {
  if (!bubble || !anchor) return;
  const box = anchor.getBoundingClientRect();
  const tip = bubble.getBoundingClientRect();
  const gap = 6;
  // A folded sidebar's icons take their tip at the right, as in ClickUp.
  if (anchor.dataset.tipSide === 'right') {
    bubble.style.transform = `translate(${Math.round(box.right + gap)}px, ${Math.round(box.top + box.height / 2 - tip.height / 2)}px)`;
    return;
  }
  const above = box.top - tip.height - gap;
  const top = above >= 4 ? above : box.bottom + gap;
  const left = Math.min(Math.max(4, box.left + box.width / 2 - tip.width / 2), window.innerWidth - tip.width - 4);
  bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function show(el) {
  const text = tipText(el);
  if (!text) return;
  // A native title would show a second tip after a pause, so the tip takes
  // it over (a title set again later wins).
  if (el.hasAttribute('title')) {
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.getAttribute('title'));
    el.setAttribute('data-tip', el.getAttribute('title'));
    el.removeAttribute('title');
    return show(el);
  }
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'fx-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.setAttribute('aria-hidden', 'true');
  }
  bubble.textContent = text;
  anchor = el;
  (el.closest('dialog[open]') ?? document.body).append(bubble);
  place();
}

function hide(el) {
  if (el && el !== anchor) return;
  anchor = null;
  bubble?.remove();
}

export function startTips() {
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const el = event.target.closest?.(CANDIDATE);
    if (el && el !== anchor) show(el);
    else if (!el) hide();
  });
  document.addEventListener('focusin', (event) => {
    const el = event.target.closest?.(CANDIDATE);
    if (el && el.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', (event) => hide(event.target.closest?.(CANDIDATE)));
  document.addEventListener('pointerdown', () => hide());
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  window.addEventListener('scroll', () => hide(), true);
}
