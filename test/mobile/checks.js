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
// - sideways: parts that scroll sideways that no card lets scroll (a card's
//   mobile.json `scrollX`; CardRows never). A table cut at the right is one.
// - split: notices whose title sits on a line of its own, away from its text.
export function measure({ min, scrollX = '' }) {
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

  const sideways = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (!['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) continue;
    if (!onScreen(el.getBoundingClientRect())) continue;
    if (scrollX && el.matches(scrollX)) continue;
    sideways.push(describe(el));
  }

  const split = [];
  for (const note of document.querySelectorAll('.fx-notice')) {
    const [title, text] = [note.querySelector(':scope > strong'), note.querySelector(':scope > span:not(.fx-notice__short)')];
    if (!title || !text || !onScreen(note.getBoundingClientRect())) continue;
    const [a, b] = [title.getClientRects()[0], text.getClientRects()[0]];
    if (a && b && b.top >= a.bottom - 1) split.push(describe(note));
  }

  return {
    sideways: [...new Set(sideways)].sort(),
    split: [...new Set(split)].sort(),
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    small: [...new Set(small)].sort(),
    cut: [...new Set(cut)].sort(),
    toolbar: barBox ? { top: Math.round(barBox.top), left: Math.round(barBox.left), height: Math.round(barBox.height) } : null,
    rows,
  };
}
