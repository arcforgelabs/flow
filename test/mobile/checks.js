// What the phone suite measures on each screen (docs/MOBILE_TESTS.md). It
// runs in the page (page.evaluate sends only this function, so everything it
// uses is inside it) and answers plain data that the spec compares with the
// budget (budget.json).
//
// - overflow: px the page is wider than the screen. A table or board window
//   that scrolls inside itself is fine.
// - small: controls on screen smaller than `min` px either way (a label
//   around a control counts as its hit area).
// - cut: text cut with "…" that has no full text on hover or press.
// - toolbar: where the list toolbar sits (it must not move between lists).
// - rows: list rows wholly on the first screen.
export function measure(min) {
  const describe = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim().replace(/\s+/g, ' ').slice(0, 24);
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${cls}${label ? ` "${label}"` : ''}`;
  };
  const onScreen = (box) => box.width && box.height && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;

  const small = [];
  const controls = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"]';
  for (const el of document.querySelectorAll(controls)) {
    const box = el.getBoundingClientRect();
    if (!onScreen(box)) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
    const hit = el.closest('label')?.getBoundingClientRect() ?? box;
    if (hit.width < min - 0.5 || hit.height < min - 0.5) small.push(describe(el));
  }

  const cut = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.firstChild || el.scrollWidth <= el.clientWidth + 1) continue;
    const style = getComputedStyle(el);
    if (style.textOverflow !== 'ellipsis' || style.overflowX === 'visible') continue;
    if (!onScreen(el.getBoundingClientRect())) continue;
    if (el.closest('[title], [aria-label], [data-tip]')) continue;
    cut.push(describe(el));
  }

  const bar = document.querySelector('.fx-listhead .fx-toolbar') ?? document.querySelector('.fx-listhead');
  const barBox = bar?.getBoundingClientRect();

  let rows = 0;
  for (const row of document.querySelectorAll('tbody tr:not(.fx-table__group)')) {
    const box = row.getBoundingClientRect();
    if (box.height && box.top >= 0 && box.bottom <= window.innerHeight) rows += 1;
  }

  return {
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    small: [...new Set(small)].sort(),
    cut: [...new Set(cut)].sort(),
    toolbar: barBox ? { top: Math.round(barBox.top), left: Math.round(barBox.left), height: Math.round(barBox.height) } : null,
    rows,
  };
}
