import { sql } from 'drizzle-orm';
import { FlowError, notFound } from './errors.js';

// Merge two contacts (docs/CONTACTS.md, "Merge two contacts"). One client is
// sometimes two Flow contacts: the work system's name and the accounting
// system's longer name. A person merges them in one step. The kept contact
// gets the other's jobs, invoices, links, rule values and Bill to rows, and
// keeps its name as an alias. The merged row stays, out of every list; Flow
// never deletes it and never merges without a person.

const invalid = (message, details) => new FlowError('invalid', message, details);
const conflict = (message, details) => new FlowError('conflict', message, details);

const ID_TESTS = new Set(['is', 'is_not', 'is_one_of', 'is_not_one_of']);

// A rule's conditions with the merged contact's id changed to the kept one,
// or null when no condition names it.
export function rewriteConditions(conditions, fromId, keepId) {
  let changed = false;
  const out = (conditions ?? []).map((c) => {
    if (c?.field !== 'customer' || !ID_TESTS.has(c.test)) return c;
    if (Array.isArray(c.value)) {
      if (!c.value.includes(fromId)) return c;
      changed = true;
      return { ...c, value: [...new Set(c.value.map((v) => (v === fromId ? keepId : v)))] };
    }
    if (c.value !== fromId) return c;
    changed = true;
    return { ...c, value: keepId };
  });
  return changed ? out : null;
}

async function lockedContact(tx, organisationId, id) {
  const { rows: [row] } = await tx.execute(sql`select id, kind, name, aliases, merged_into_id from contacts
    where organisation_id = ${organisationId} and id = ${id} for update`);
  if (!row) throw notFound('contact');
  return row;
}

// Answers what moved: { keep, from, moved: { jobs, invoices, links, rules, billTo } }.
export async function mergeContacts(db, organisationId, { keepId, fromId, actor }) {
  if (!actor) throw new TypeError('actor is required');
  if (!keepId || !fromId) throw invalid('keepId and fromId are required');
  if (keepId === fromId) throw invalid('pick two different contacts');
  return db.transaction(async (tx) => {
    // The same lock as Bill to, so a Bill to save and a merge take turns.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bill_to:${organisationId}`}))`);
    const [first, second] = [keepId, fromId].sort();
    const rows = new Map();
    for (const id of [first, second]) rows.set(id, await lockedContact(tx, organisationId, id));
    const keep = rows.get(keepId);
    const from = rows.get(fromId);
    if (keep.merged_into_id || from.merged_into_id) throw conflict('one of these contacts was already merged');
    if (keep.kind !== from.kind) throw invalid('a customer merges only with a customer, a supplier only with a supplier');

    // Links: the kept contact may hold one active link for each system.
    const { rows: links } = await tx.execute(sql`select id, system, external_id, state, flow_id from external_links
      where organisation_id = ${organisationId} and entity = 'contact' and flow_id in (${keepId}, ${fromId}) and state <> 'superseded'`);
    const activeKeep = new Map(links.filter((l) => l.flow_id === keepId && l.state === 'active').map((l) => [l.system, l]));
    for (const l of links) {
      if (l.flow_id === fromId && l.state === 'active' && activeKeep.has(l.system)) {
        throw conflict(`both contacts are linked in ${l.system}; keep one link first`, { system: l.system });
      }
    }

    // Bill to stays one level (docs/CONTACTS.md, "Bill to").
    const { rows: billing } = await tx.execute(sql`select contact_id, bill_to_contact_id from customer_billing_settings
      where organisation_id = ${organisationId} and (contact_id in (${keepId}, ${fromId}) or bill_to_contact_id in (${keepId}, ${fromId}))`);
    const own = (id) => billing.find((b) => b.contact_id === id) ?? null;
    const payerOf = (id) => own(id)?.bill_to_contact_id ?? null;
    const outside = (id) => (id === keepId || id === fromId ? null : id);
    const keepPayer = outside(payerOf(keepId));
    const fromPayer = outside(payerOf(fromId));
    if (keepPayer && fromPayer && keepPayer !== fromPayer) throw conflict('the two contacts bill to different payers; clear one Bill to first');
    const payer = keepPayer ?? (own(keepId) ? null : fromPayer);
    const clients = billing.filter((b) => [keepId, fromId].includes(b.bill_to_contact_id) && ![keepId, fromId].includes(b.contact_id));
    if (payer && clients.length) throw conflict('the merged contact would bill to a payer and be a payer; clear Bill to first');

    // Jobs: each moved job notes the merge, and an unbilled one goes back to
    // the matcher under its new customer.
    const { rows: jobs } = await tx.execute(sql`update billing_obligations set contact_id = ${keepId},
        accounting_checked_at = case when accounting_ref is null and invoice_id is null then null else accounting_checked_at end,
        updated_at = now()
      where organisation_id = ${organisationId} and contact_id = ${fromId} returning id`);
    if (jobs.length) {
      const evidence = JSON.stringify({ from: fromId, to: keepId });
      await tx.execute(sql`insert into obligation_events (organisation_id, obligation_id, kind, actor, evidence)
        select ${organisationId}, id, 'contact_merged', ${actor}, ${evidence}::jsonb from unnest(${sql.param(jobs.map((j) => j.id))}::uuid[]) as id`);
    }
    const { rows: invoices } = await tx.execute(sql`update invoices set contact_id = ${keepId}, updated_at = now()
      where organisation_id = ${organisationId} and contact_id = ${fromId} returning id`);

    // Links move; a guess that the kept contact already answers is closed.
    let movedLinks = 0;
    for (const l of links.filter((x) => x.flow_id === fromId)) {
      if (l.state === 'proposed' && activeKeep.has(l.system)) {
        await tx.execute(sql`update external_links set state = 'superseded', updated_at = now() where id = ${l.id}`);
        continue;
      }
      await tx.execute(sql`update external_links set flow_id = ${keepId}, updated_at = now() where id = ${l.id}`);
      movedLinks += 1;
    }

    // Rules that name the merged contact name the kept one.
    const { rows: rules } = await tx.execute(sql`select id, conditions from invoice_rules
      where organisation_id = ${organisationId} and conditions::text like ${`%${fromId}%`}`);
    let movedRules = 0;
    for (const rule of rules) {
      const next = rewriteConditions(rule.conditions, fromId, keepId);
      if (!next) continue;
      await tx.execute(sql`update invoice_rules set conditions = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${rule.id}`);
      movedRules += 1;
    }

    // Bill to: clients of the merged contact bill to the kept one; the kept
    // contact takes the merged one's own row when it has none.
    const { rows: billTo } = await tx.execute(sql`update customer_billing_settings
      set bill_to_contact_id = case when contact_id = ${keepId} then null else ${keepId}::uuid end, updated_at = now()
      where organisation_id = ${organisationId} and bill_to_contact_id = ${fromId} returning contact_id`);
    if (own(fromId) && !own(keepId)) {
      await tx.execute(sql`update customer_billing_settings set contact_id = ${keepId},
          bill_to_contact_id = case when bill_to_contact_id = ${keepId} then null else bill_to_contact_id end, updated_at = now()
        where organisation_id = ${organisationId} and contact_id = ${fromId}`);
    }

    // The names: the kept contact answers to the merged one's names too.
    const names = [from.name, ...(from.aliases ?? []), ...(keep.aliases ?? [])];
    const aliases = [...new Set(names.filter((n) => n && n !== keep.name))].slice(0, 20);
    await tx.execute(sql`update contacts set aliases = ${JSON.stringify(aliases)}::jsonb, updated_at = now()
      where organisation_id = ${organisationId} and id = ${keepId}`);
    await tx.execute(sql`update contacts set merged_into_id = ${keepId}, merged_at = now(), merged_by = ${actor},
        hidden = true, active = false, updated_at = now()
      where organisation_id = ${organisationId} and id = ${fromId}`);

    return {
      keep: keepId,
      from: fromId,
      moved: { jobs: jobs.length, invoices: invoices.length, links: movedLinks, rules: movedRules, billTo: billTo.length },
    };
  });
}
