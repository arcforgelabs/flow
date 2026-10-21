import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPager, pageNumbers, pageRange } from '../server/ui/pager.js';

// The pages of a long list (server/ui/pager.js), in the list window's foot.

test('page numbers show the ends and the pages near the one shown', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pageNumbers(1, 13), [1, 2, 3, 4, '…', 13]);
  assert.deepEqual(pageNumbers(7, 13), [1, '…', 6, 7, 8, '…', 13]);
  assert.deepEqual(pageNumbers(13, 13), [1, '…', 10, 11, 12, 13]);
  assert.deepEqual(pageNumbers(3, 13), [1, 2, 3, 4, '…', 13]);
});

test('the range names the rows shown and every row', () => {
  assert.equal(pageRange({ offset: 0, limit: 100, total: 1204 }), '1–100 of 1,204');
  assert.equal(pageRange({ offset: 1200, limit: 100, total: 1204 }), '1,201–1,204 of 1,204');
  assert.equal(pageRange({ offset: 0, limit: 100, total: 0 }), '0 of 0');
});

// A small stand-in for the page's elements.
class El {
  constructor(tag) { Object.assign(this, { tag, attrs: {}, children: [] }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...kids) { this.children.push(...kids.flat().filter((k) => k != null)); }
  // As the DOM's, replaceChildren writes null as the text "null".
  replaceChildren(...kids) { this.children = kids.map((k) => (k == null ? String(k) : k)); }
  set innerHTML(markup) { this.children = []; }
  get text() { return this.children.map((k) => (k instanceof El ? k.text : String(k))).join(''); }
  all(test) { return this.children.filter((k) => k instanceof El).flatMap((k) => [...(test(k) ? [k] : []), ...k.all(test)]); }
}
function h(tag, props = {}, ...kids) {
  const el = new El(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith('on')) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

test('a page button asks for its rows; a new size starts at the first page', () => {
  const asked = [];
  const pager = listPager(h, { label: 'Invoice pages', change: (page) => asked.push(page) });
  pager.draw({ offset: 100, limit: 100, total: 1204 });
  const nums = pager.element.all((el) => el.attrs.class === 'fx-pages__num');
  assert.deepEqual(nums.map((n) => n.text), ['1', '2', '3', '4', '13']);
  assert.equal(nums.find((n) => n.attrs['aria-current'] === 'page').text, '2');
  nums.find((n) => n.text === '13').onclick();
  const [prev, next] = pager.element.all((el) => el.attrs.class === 'fx-pages__step');
  prev.onclick();
  next.onclick();
  pager.element.all((el) => el.tag === 'select')[0].onchange({ target: { value: '50' } });
  assert.deepEqual(asked, [{ offset: 1200, limit: 100 }, { offset: 0, limit: 100 }, { offset: 200, limit: 100 }, { offset: 0, limit: 50 }]);

  // One page: no page buttons, the size stays.
  pager.draw({ offset: 0, limit: 100, total: 30 });
  assert.equal(pager.element.all((el) => el.attrs.class === 'fx-pages__num').length, 0);
  assert.equal(pager.element.all((el) => el.tag === 'select').length, 1);
  assert.match(pager.element.text, /1–30 of 30/);
  assert.doesNotMatch(pager.element.text, /null/);
});
