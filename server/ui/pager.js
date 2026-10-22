// Two pagers live here:
//
// listPager — the pages of a long list, in the list window's foot bar
// (listFrame), as HubSpot's: rows per page, "1–100 of 1,204", and numbered
// pages between previous and next. The server cuts the page
// (GET /api/invoicing/invoices takes offset and limit), so a list works with
// any number of rows. listPager(h, { label, sizes, change }) answers
// { element, draw(page) }. page = { offset, limit, total }.
// change({ offset, limit }) asks for a page; a new size starts again at the
// first page. One page or none hides the page numbers; the size stays, so a
// person can show more per page.
//
// pager — ".fx-pager" over one record opened from a list: "← Back", "n of N",
// previous and next. pager(h, { label, back, … }) answers { element, draw }.
// draw({ count, prev, next, prevLabel, nextLabel }) fills the count and
// steps; omit draw (or draw with steps: false) for Back only, as when an
// invoice is not yet in the list. Invoices, Reconcile and Price list ›
// Reconcile use it (issue #220).

import { applyPhoneRule } from './mobile.js';

export const PAGE_SIZES = Object.freeze([25, 50, 100, 200]);

const chevron = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PREV = chevron('M14.5 6l-6 6 6 6');
const NEXT = chevron('M9.5 6l6 6-6 6');
const count = new Intl.NumberFormat('en-AU');

// The bar over one record: Back, optional "n of N", previous and next.
export function pager(h, { label = 'Records', back }) {
  const backBtn = h('button', { class: 'fx-pager__back', type: 'button', onclick: back }, '← Back');
  const element = h('nav', { class: 'fx-pager', 'aria-label': label }, backBtn);

  function draw({
    count: text = '',
    prev = null,
    next = null,
    prevLabel = 'Previous',
    nextLabel = 'Next',
    steps = true,
  } = {}) {
    if (!steps) {
      element.replaceChildren(backBtn);
      return;
    }
    const step = (go, name, markup) => {
      const button = h('button', {
        class: 'fx-pager__step', type: 'button',
        'aria-label': name, title: name,
        ...(!go ? { disabled: true } : { onclick: go }),
      });
      button.innerHTML = markup;
      return button;
    };
    element.replaceChildren(
      backBtn,
      h('span', { class: 'fx-pager__count' }, text),
      h('span', { class: 'fx-pager__steps' },
        step(prev, prevLabel, PREV),
        step(next, nextLabel, NEXT)));
  }

  return { element, draw };
}

// The page numbers to show: the first, the last, and two each side of the
// one shown, with '…' for a gap. Pages count from 1.
export function pageNumbers(at, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, n) => n + 1);
  const near = new Set([1, pages, at - 1, at, at + 1]);
  if (at <= 3) [2, 3, 4].forEach((n) => near.add(n));
  if (at >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => near.add(n));
  const list = [...near].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return list.flatMap((n, i) => (i && n - list[i - 1] > 1 ? ['…', n] : [n]));
}

// "1–100 of 1,204", or "0 of 0".
export function pageRange({ offset, limit, total }) {
  if (!total) return '0 of 0';
  return `${count.format(offset + 1)}–${count.format(Math.min(offset + limit, total))} of ${count.format(total)}`;
}

export function listPager(h, { label = 'Pages', sizes = PAGE_SIZES, change }) {
  const element = applyPhoneRule(h('nav', { class: 'fx-pages', 'aria-label': label }), 'listPager');
  const icon = (markup) => { const span = h('span', { 'aria-hidden': 'true' }); span.innerHTML = markup; return span; };

  function draw({ offset = 0, limit = sizes[0], total = 0 }) {
    const pages = Math.max(1, Math.ceil(total / limit));
    const at = Math.min(pages, Math.floor(offset / limit) + 1);
    const go = (n) => change({ offset: (n - 1) * limit, limit });
    const size = h('select', {
      class: 'fx-select fx-pages__size', 'aria-label': 'Rows per page', title: 'Rows per page',
      onchange: (event) => change({ offset: 0, limit: Number(event.target.value) }),
    }, sizes.map((n) => h('option', { value: String(n), ...(n === limit ? { selected: true } : {}) }, String(n))));
    const step = (n, markup, name) => h('button', {
      type: 'button', class: 'fx-pages__step', 'aria-label': name, title: name,
      ...(n < 1 || n > pages ? { disabled: true } : {}), onclick: () => go(n),
    }, icon(markup));
    element.replaceChildren(
      h('label', { class: 'fx-pages__rows' }, 'Rows', size),
      h('span', { class: 'fx-pages__range' }, pageRange({ offset, limit, total })),
      pages > 1 ? h('span', { class: 'fx-pages__steps' },
        step(at - 1, PREV, 'Previous page'),
        pageNumbers(at, pages).map((n) => (n === '…'
          ? h('span', { class: 'fx-pages__gap', 'aria-hidden': 'true' }, '…')
          : h('button', {
            type: 'button', class: 'fx-pages__num', 'aria-label': `Page ${n}`,
            ...(n === at ? { 'aria-current': 'page' } : {}), onclick: () => { if (n !== at) go(n); },
          }, String(n)))),
        step(at + 1, NEXT, 'Next page')) : '');
  }

  return { element, draw };
}
