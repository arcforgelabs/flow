import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Every list page is built from the shared parts, so a change to them
// reaches every list (Samuel, 2026-10-29: the Price list drifted far from
// Jobs and Invoices with its own table and header, and nothing caught it).
// A page with a columnTable has the shared list head and window. A page
// that draws its own list table is on OLD_TABLES until it moves (#411);
// that list only gets shorter.
const UI = new URL('../server/ui/', import.meta.url);
const OLD_TABLES = new Set(['app.js', 'contacts.js', 'price-reconcile.js', 'xero-import.js']);
const pages = readdirSync(UI).filter((f) => f.endsWith('.js') && f !== 'columns.js')
  .map((file) => ({ file, source: readFileSync(new URL(file, UI), 'utf8') }));

test('a page with a list table uses the shared table, list head and window', () => {
  for (const { file, source } of pages) {
    if (source.includes('columnTable(')) {
      assert.ok(source.includes('listHead(') && source.includes('listFrame('), `${file} draws a columnTable: put it under listHead and in listFrame (kit.js), as Jobs and Invoices do`);
    }
    const ownTable = /h\('table', \{ class: 'fx-table [^']/.test(source);
    if (OLD_TABLES.has(file)) assert.ok(ownTable, `${file} no longer draws its own list table: take it off OLD_TABLES`);
    else assert.ok(!ownTable, `${file} draws its own list table: use columnTable (columns.js)`);
  }
});
