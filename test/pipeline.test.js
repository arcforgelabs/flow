import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { ledgerView } from '../server/core/ledger.js';
import { externalIdFor } from '../server/core/links.js';
import {
  linkCustomers, normaliseName, rankCandidates, runPipelineOnce, scoreCandidate,
} from '../server/core/pipeline.js';
import { billingObligations, linkRejections, linkSuggestions, priorLinks } from '../server/db/schema.js';
import { findInvoices, listCustomers, mirrorState } from '../server/integrations/xero/lookup.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { refreshStaleCatalogues } from '../server/integrations/xero/import.js';
import { bootFlow, connectDirectly, scriptedXero, xeroAnswer } from './support/xero.js';

// The pipeline joins jobs to accounting invoices from Flow's own copies. The
// work system and the accounting system are fakes with synthetic records.

const job = (ref, { clientId, invoiceRef = null, jobDate, cents = 20000, code = 'CROWN' }) => ({
  clientId,
  ledgerJob: {
    sourceSystem: 'seazona',
    sourceJobRef: ref,
    sourceInvoiceRef: invoiceRef,
    caseRef: ref,
    lines: [{ itemCode: code, description: 'Crown', quantity: 1, unitAmountCents: cents, taxCode: 'GST' }],
    jobDate,
    observedAt: '2026-04-01T00:00:00.000Z',
    actor: 'seazona',
  },
});

const invoice = (id, { contactId, total = 22000, issuedOn, number = `INV-${id}`, status = 'AUTHORISED', codes = ['CROWN'] }) => ({
  id, number, contactId, status, issuedOn, totalCents: total, subtotalCents: Math.round(total / 1.1), itemCodes: codes,
  state: { AUTHORISED: 'authorised', VOIDED: 'voided', PAID: 'paid', DRAFT: 'drafted' }[status],
});

function fakeWork(pages) {
  const calls = [];
  return {
    calls,
    adapter: {
      id: 'seazona',
      capabilities: {
        listCustomers: async () => [
          { id: 'c1', name: 'Example Dental Pty Ltd' },
          { id: 'c2', name: 'Bright Smiles' },
          { id: 'c3', name: 'Nobody We Know' },
        ],
        pullWorkItems: async (cursor) => {
          calls.push(cursor);
          const index = cursor ? Number(cursor) : 0;
          const page = pages[index] ?? { items: [], withdrawn: [] };
          return { ...page, cursor: String(index + 1), more: index + 1 < pages.length };
        },
      },
    },
  };
}

function fakeAccounting(state) {
  return {
    id: 'xero',
    capabilities: {
      listCustomers: async () => [{ id: 'x1', name: 'Example Dental' }, { id: 'x2', name: 'Bright Smiles' }],
      findInvoices: async ({ invoiceIds = [], numbers = [], flowInvoiceIds = [], contactId = null, from = null, to = null }) => {
        const upper = numbers.map((n) => n.toUpperCase());
        const invoices = state.invoices.filter((i) => invoiceIds.includes(i.id)
          || upper.includes(String(i.number).toUpperCase())
          || (flowInvoiceIds.length && flowInvoiceIds.includes(i.flowInvoiceId))
          || (contactId && i.contactId === contactId && (!from || i.issuedOn >= from) && (!to || i.issuedOn <= to)));
        return { complete: true, fresh: true, changedAt: state.changedAt, invoices };
      },
    },
  };
}

const integrationsOf = (adapters) => ({
  with: (capability) => adapters.filter((a) => typeof a.capabilities[capability] === 'function'),
});

describe('names and scores', () => {
  test('names compare without case, punctuation or a company suffix', () => {
    assert.equal(normaliseName('Example Dental Pty. Ltd.'), 'example dental');
    assert.equal(normaliseName('  Smith &  Jones  '), 'smith and jones');
    assert.notEqual(normaliseName('Example Dental North'), normaliseName('Example Dental'));
  });

  const ob = { totalCents: 22000, subtotalCents: 20000, jobDate: '2026-03-10', lines: [{ itemCode: 'CROWN' }] };

  test('a candidate scores its total, its items and its date, and says why', () => {
    const { score, signals } = scoreCandidate(ob, invoice('a', { contactId: 'x', issuedOn: '2026-03-11' }));
    assert.equal(score, 11);
    assert.deepEqual(signals.map((s) => s.signal), ['total', 'items_same', 'date_close']);
    assert.equal(scoreCandidate(ob, invoice('b', { contactId: 'x', issuedOn: '2026-03-11', total: 20000 })).signals[0].signal, 'total_gst');
    assert.ok(scoreCandidate(ob, invoice('c', { contactId: 'x', issuedOn: '2026-03-11', status: 'VOIDED' })).score < 11);
  });

  test('one clear leader is a suggestion; two close ones need a person; another amount is not a candidate', () => {
    const one = rankCandidates(ob, [invoice('a', { issuedOn: '2026-03-11' }), invoice('b', { issuedOn: '2026-03-12', total: 5000 })]);
    assert.equal(one.decision, 'suggested');
    assert.equal(one.ranked.length, 1);
    assert.equal(rankCandidates(ob, [invoice('a', { issuedOn: '2026-03-11' }), invoice('b', { issuedOn: '2026-03-12' })]).decision, 'unsure');
    assert.equal(rankCandidates(ob, [invoice('b', { issuedOn: '2026-03-12', total: 5000 })]).decision, 'none');
  });
});

describe('the pipeline', { skip: skipWithoutDatabase }, () => {
  let handle;
  let organisationId;
  const state = { invoices: [], changedAt: new Date('2026-04-01T00:00:00Z') };
  const accounting = fakeAccounting(state);
  const NOW = new Date('2026-04-02T00:00:00Z');

  const obligation = async (ref) => {
    const [row] = await handle.db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.sourceJobRef, ref)));
    return row;
  };

  before(async () => {
    handle = await freshDatabase();
    organisationId = (await createOrganisation(handle.db, { name: 'Example Lab' })).id;
    await createContact(handle.db, organisationId, { kind: 'customer', name: 'Example Dental' });
    await createContact(handle.db, organisationId, { kind: 'customer', name: 'Bright Smiles' });
    await createPriceItem(handle.db, organisationId, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
    state.invoices = [
      invoice('X-100', { contactId: 'x1', number: '5001', issuedOn: '2026-03-01' }),
      invoice('X-200', { contactId: 'x1', issuedOn: '2026-03-06' }),
      invoice('X-300', { contactId: 'x2', issuedOn: '2026-03-11' }),
      invoice('X-400', { contactId: 'x2', issuedOn: '2026-03-21' }),
      invoice('X-401', { contactId: 'x2', issuedOn: '2026-03-22' }),
      invoice('X-500', { contactId: 'x1', issuedOn: '2026-03-26', total: 5000, codes: ['MODEL'] }),
    ];
    await handle.db.insert(priorLinks).values({
      organisationId, sourceSystem: 'seazona', sourceJobRef: '1002', system: 'xero', externalId: 'X-200', matchedBy: 'imported', origin: 'test',
    });
  });
  after(async () => { await handle?.close(); });

  test('customers link by one exact name on each side, and never by a guess', async () => {
    const result = await linkCustomers(handle.db, organisationId, {
      system: 'xero', customers: [{ id: 'x1', name: 'EXAMPLE DENTAL' }, { id: 'x9', name: 'Example Dental North' }],
    });
    assert.equal(result.linked, 1);
    assert.equal(result.unmatched, 1);
    const again = await linkCustomers(handle.db, organisationId, { system: 'xero', customers: [{ id: 'x1', name: 'Example Dental' }] });
    assert.equal(again.linked, 0);
    assert.equal(again.alreadyLinked, 1);
  });

  test('one run reads the jobs, links what is exact, suggests what is likely and finds what has no invoice', async () => {
    const work = fakeWork([
      { items: [
        job('1001', { clientId: 'c1', invoiceRef: '5001', jobDate: '2026-03-01' }),
        job('1002', { clientId: 'c1', jobDate: '2026-03-05' }),
        job('1003', { clientId: 'c2', jobDate: '2026-03-10' }),
      ], withdrawn: [] },
      { items: [
        job('1004', { clientId: 'c2', jobDate: '2026-03-20' }),
        job('1005', { clientId: 'c1', jobDate: '2026-03-25' }),
        job('1006', { clientId: 'c1', jobDate: '2025-01-10' }),
        job('1007', { clientId: 'c3', jobDate: '2026-03-25' }),
      ], withdrawn: [] },
    ]);
    const summary = await runPipelineOnce(handle.db, integrationsOf([work.adapter, accounting]), { now: NOW });
    assert.equal(summary.work.observed, 7);
    assert.equal(summary.work.withoutCustomer, 1);
    assert.deepEqual(work.calls, [null, '1']);

    const states = Object.fromEntries(await Promise.all(['1001', '1002', '1003', '1004', '1005', '1006', '1007']
      .map(async (ref) => [ref, await obligation(ref)])));
    assert.deepEqual([states['1001'].accountingState, states['1001'].accountingRef, states['1001'].accountingMatchedBy], ['authorised', 'X-100', 'source_invoice_ref']);
    assert.deepEqual([states['1002'].accountingState, states['1002'].accountingRef, states['1002'].accountingMatchedBy], ['authorised', 'X-200', 'prior_link']);
    // A likely invoice never links by itself.
    assert.equal(states['1003'].accountingState, 'ambiguous');
    assert.equal(states['1003'].accountingRef, null);
    assert.equal(ledgerView(states['1003'], { now: NOW }).view, 'review_required');
    assert.equal(states['1004'].accountingState, 'ambiguous');
    assert.equal(states['1005'].accountingState, 'not_found');
    assert.equal(states['1006'].accountingState, 'not_found');
    assert.equal(states['1006'].holdState, 'held');
    assert.equal(states['1007'].accountingState, 'unknown');
    assert.equal(states['1007'].contactId, null);

    const suggestions = await handle.db.select().from(linkSuggestions).where(eq(linkSuggestions.state, 'open'));
    const top = (o) => suggestions.filter((s) => s.obligationId === o.id).sort((a, b) => a.rank - b.rank);
    assert.deepEqual([top(states['1003'])[0].externalId, top(states['1003'])[0].score], ['X-300', 11]);
    assert.deepEqual(top(states['1004']).map((s) => s.externalId).sort(), ['X-400', 'X-401']);
    assert.deepEqual(summary.matching.linked + summary.matching.suggested + summary.matching.unsure + summary.matching.notFound, 6);
    assert.equal(await externalIdFor(handle.db, organisationId, { system: 'seazona', entity: 'contact', flowId: states['1003'].contactId }), 'c2');
  });

  test('a run with nothing new checks nothing', async () => {
    const summary = await runPipelineOnce(handle.db, integrationsOf([fakeWork([]).adapter, accounting]), { now: NOW });
    assert.equal(summary.matching.checked, 0);
  });

  test('a linked invoice is followed through its life: voided in Xero, the job needs a person', async () => {
    state.invoices = state.invoices.map((i) => (i.id === 'X-100' ? { ...i, status: 'VOIDED', state: 'voided' } : i));
    state.changedAt = new Date('2026-04-02T12:00:00Z');
    const later = new Date('2026-04-03T00:00:00Z');
    await runPipelineOnce(handle.db, integrationsOf([fakeWork([]).adapter, accounting]), { now: later });
    const row = await obligation('1001');
    assert.equal(row.accountingState, 'voided');
    assert.equal(ledgerView(row, { now: later }).view, 'review_required');
  });

  test('a person\'s "not this one" removes the pair for good', async () => {
    const row = await obligation('1003');
    await handle.db.insert(linkRejections).values({ organisationId, obligationId: row.id, system: 'xero', externalId: 'X-300', actor: 'person:test' });
    await handle.db.update(billingObligations).set({ accountingCheckedAt: null }).where(eq(billingObligations.id, row.id));
    await runPipelineOnce(handle.db, integrationsOf([fakeWork([]).adapter, accounting]), { now: new Date('2026-04-04T00:00:00Z') });
    const { rows } = await handle.db.execute(sql`select external_id, state from link_suggestions where obligation_id = ${row.id} order by external_id`);
    assert.deepEqual(rows.find((r) => r.external_id === 'X-300').state, 'stale');
    assert.ok(rows.filter((r) => r.state === 'open').every((r) => r.external_id !== 'X-300'));
  });

  test('an order deleted in the work system sends its job to review', async () => {
    const work = fakeWork([{ items: [], withdrawn: [{ sourceId: '1005', reason: 'deleted_in_seazona', ledgerHold: { sourceSystem: 'seazona', sourceJobRef: '1005', holdState: 'review', reason: 'the order was deleted in Seazona' } }] }]);
    await handle.db.execute(sql`delete from pipeline_cursors`);
    await runPipelineOnce(handle.db, integrationsOf([work.adapter]), { now: NOW });
    assert.equal((await obligation('1005')).holdState, 'review');
  });
});

describe('the Xero copy the matcher reads', { skip: skipWithoutDatabase }, () => {
  let handle;
  let xero;
  let integrations;
  let organisationId;
  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    ({ integrations } = await bootFlow(handle, { runtime: xero.runtime }));
    organisationId = (await createOrganisation(handle.db, { name: 'Example Lab' })).id;
    const row = (id, contact, issued, total, status = 'AUTHORISED') => sql`(${organisationId}, ${id}, 'ACCREC', ${`INV-${id}`}, ${contact}, ${status}, ${issued}::date, ${total - 2000}, ${total}, ${total}, 0, 0, ${JSON.stringify([{ itemCode: 'CROWN' }])}::jsonb, 'h')`;
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_credited_cents, lines, record_hash)
      values ${sql.join([row('a', 'x1', '2026-03-01', 22000), row('b', 'x1', '2026-05-01', 22000), row('c', 'x2', '2026-03-02', 11000, 'VOIDED')], sql`, `)}`);
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status) values (${organisationId}, 'x1', 'Example Dental', 'ACTIVE'), (${organisationId}, 'x2', 'Gone', 'ARCHIVED')`);
  });
  after(async () => {
    await integrations?.stop();
    await handle?.close();
  });

  test('it finds invoices by id, number or customer and dates, with the ledger state', async () => {
    const byContact = await findInvoices(handle.db, organisationId, { contactId: 'x1', from: '2026-02-20', to: '2026-03-31' });
    assert.deepEqual(byContact.invoices.map((i) => i.id), ['a']);
    assert.equal(byContact.invoices[0].state, 'authorised');
    assert.deepEqual(byContact.invoices[0].itemCodes, ['CROWN']);
    assert.equal(byContact.complete, false);
    assert.deepEqual((await findInvoices(handle.db, organisationId, { numbers: ['inv-b'] })).invoices.map((i) => i.id), ['b']);
    const [voided] = (await findInvoices(handle.db, organisationId, { invoiceIds: ['c'] })).invoices;
    assert.equal(voided.state, 'voided');
    assert.deepEqual((await listCustomers(handle.db, organisationId)).map((c) => c.id), ['x1']);
  });

  test('the copy counts as complete once invoices and credit notes finished a pass, without payments', async () => {
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at) values (${organisationId}, 'invoices', 1, now())`);
    assert.equal((await mirrorState(handle.db, organisationId)).complete, false);
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at) values (${organisationId}, 'credit_notes', 1, now())`);
    // A connection without a payments scope: Xero refuses the payments read.
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_error) values (${organisationId}, 'payments', 0, 'xero_unauthorized: AuthorizationUnsuccessful')`);
    const state = await mirrorState(handle.db, organisationId);
    assert.equal(state.complete, true);
    assert.equal(state.fresh, true);
    assert.ok(state.changedAt instanceof Date);
  });

  test('the import worker reads contacts and items once a day, so customers can link', async () => {
    await connectDirectly(handle, xero.runtime, organisationId);
    const contact = (id, name) => ({ ContactID: id, Name: name, ContactStatus: 'ACTIVE', IsCustomer: true });
    xero.script([
      xeroAnswer('Contacts', { Contacts: [contact('x1', 'Example Dental'), contact('x3', 'Bright Smiles')] }, { query: { page: 1 } }),
      xeroAnswer('Items', { Items: [] }),
    ]);
    await refreshStaleCatalogues(handle.db, xero.runtime, { log: { info() {}, error() {} } });
    assert.deepEqual((await listCustomers(handle.db, organisationId)).map((c) => c.id).sort(), ['x1', 'x3']);
    // Read today: no second call (the script has none left to answer).
    await refreshStaleCatalogues(handle.db, xero.runtime, { log: { info() {}, error: (line) => assert.fail(line) } });
  });
});
