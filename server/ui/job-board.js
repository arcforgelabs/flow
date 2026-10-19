// The Jobs board's rules, with no page code, so tests can read them
// (test/job-board.test.js). server/ui/jobs.js draws the page.
//
// The board's columns are the work system's own job statuses, one to one.
// A job's invoice has a stage of its own (invoiceStage), shown in the job's
// detail panel; a job whose invoice needs a person has a problem (fixes).

// Where a status sits on the board when the work system gives no order:
// first the statuses of new work, then the ones Flow does not know (in the
// order Flow first saw them), then checking, complete, shipped, delivered,
// and cancelled last.
const STATUS_RANKS = [
  [/\b(new|draft|received|booked|submitted|ordered|pending)\b/i, 0],
  [/\b(scan|scanned|design|designed|model|wax|impression)/i, 1],
  [/\b(qc|quality|check|checked|checking|finish|finished|finishing)\b/i, 3],
  [/\bcomplete(d)?\b|\bready\b/i, 4],
  [/\b(shipped|dispatched|sent)\b/i, 5],
  [/\bdelivered\b/i, 6],
  [/\b(cancell?ed|void|closed|archived|deleted)\b/i, 7],
];
const UNKNOWN_RANK = 2;
// From this rank on, the work is out of the lab: shipped, delivered, cancelled.
export const FINAL_RANK = 5;
export const NO_STATUS = 'No status';

export function statusRank(label) {
  return STATUS_RANKS.find(([pattern]) => pattern.test(label ?? ''))?.[1] ?? UNKNOWN_RANK;
}

// The board's column labels, left to right. `statuses` is the work system's
// list ({ label, firstSeenAt }); `jobs` adds any status only a job names.
export function orderStatuses(statuses = [], jobs = []) {
  const seen = new Map();
  for (const s of statuses) if (s?.label && !seen.has(s.label)) seen.set(s.label, s.firstSeenAt ?? null);
  for (const job of jobs) {
    const label = job.status ?? NO_STATUS;
    if (!seen.has(label)) seen.set(label, null);
  }
  return [...seen].sort(([a, at], [b, bt]) => statusRank(a) - statusRank(b)
    || String(at ?? '9').localeCompare(String(bt ?? '9'))
    || a.localeCompare(b)).map(([label]) => label);
}

export const INVOICE_STAGES = {
  drafted: 'Drafted', problem: 'Problem', ready: 'Ready to invoice', invoiced: 'Invoiced', paid: 'Paid',
};

const PROBLEM_VIEWS = ['pending', 'review_required', 'held'];
// A rule's reason, as ruleBlockers writes it (server/core/invoicing-rules.js).
const isRule = (reason) => reason !== 'the job is not marked ready to invoice';

// The stage of a job's invoice, from its billing obligation (the API's job
// shape, server/core/job-board.js), or null while the job has none or is
// still in work.
//   Drafted           a draft in Flow that nobody marked ready, or a job
//                     that passes every check and waits for the automation
//   Problem           something a person must fix: the job's checks, a rule
//                     that stops the draft, or a problem with the draft
//   Ready to invoice  a person marked the draft ready
//   Invoiced          issued, sent, or in the accounting system
//   Paid              paid in full
export function invoiceStage(o) {
  if (!o || o.view === 'in_work') return null;
  if (o.view === 'paid') return 'paid';
  if (PROBLEM_VIEWS.includes(o.view)) return 'problem';
  if (o.view === 'invoiced') return 'invoiced';
  if (o.invoiceView === 'problem' || o.invoiceStatus === 'void') return 'problem';
  if (o.invoiceStatus === 'issued') return 'invoiced';
  if (o.invoiceView === 'ready') return 'ready';
  if (o.view === 'ready') return (o.waitingFor ?? []).some(isRule) ? 'problem' : 'drafted';
  if (o.view === 'drafted') return 'drafted';
  return null;
}

const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const sentence = (text) => capital(String(text).trim().replace(/\.?$/, '.'));

// One ledger reason (server/core/ledger.js) as a fix: a short label, what is
// wrong, and what to do.
function reasonFix(reason, acct) {
  const fix = (label, todo) => ({ label, text: sentence(reason), todo });
  if (reason === 'the accounting system was not checked') {
    return { label: `Not checked in ${acct}`, text: `Flow did not check ${acct} for an invoice for this job yet.`, todo: `Wait for the next check, a few minutes. If it stays, check ${acct} under Settings, Integrations.` };
  }
  if (reason === 'a line does not map to a price item') {
    return { label: 'No price code', text: 'A line has a code that is not in the price list.', todo: 'Add the code to the price list, or correct the code in the work system.' };
  }
  if (reason === 'the job has no customer contact') {
    return { label: 'Client not linked', text: 'The client is not linked to a customer in Flow.', todo: 'Link the client to a customer in Flow.' };
  }
  if (reason === 'the work system report is out of date') {
    return { label: 'Out of date', text: 'Flow has no news of this job from the work system for more than a day.', todo: 'Check the work system under Settings, Integrations.' };
  }
  if (reason === 'the job changed after its invoice was made') return fix('Job changed', 'Compare the invoice with the job, then correct the invoice.');
  if (/deleted in /i.test(reason)) return fix('Deleted', 'Check the job in the work system. Void its invoice if it has one.');
  if (/^the accounting evidence is ambiguous/.test(reason)) return fix(`${acct} match unclear`, `Find the invoice for this job in ${acct}, then link it.`);
  if (/^the accounting evidence is conflict/.test(reason)) return fix(`Two ${acct} invoices`, `Find the right invoice for this job in ${acct}. Void the other.`);
  if (/^invoice .* was (voided|deleted)$/.test(reason)) return fix(`Invoice ${/voided$/.test(reason) ? 'voided' : 'deleted'}`, 'Make a new invoice, or close the job.');
  if (/^the accounting system reports /.test(reason)) return fix(`Already in ${acct}`, `Check the invoice in ${acct}. Link it to this job if it is the right one.`);
  if (/^the job is held$/.test(reason)) return fix('On hold', 'Release the hold when the job can be invoiced.');
  if (/^the job is review$/.test(reason)) return fix('Needs review', 'Check the job and its invoice.');
  if (reason === 'held') return fix('On hold', 'Release the hold when the job can be invoiced.');
  return fix('Needs review', 'Check the job and its invoice.');
}

// One draft problem (server/core/sending.js, and the accounting system's) as a fix.
function draftFix(problem, acct) {
  const code = problem.code ?? '';
  const fix = (label, todo) => ({ label, text: sentence(problem.message ?? label), todo });
  if (code === 'no_lines') return fix('No lines', 'Open the invoice and add the lines.');
  if (code === 'no_amount') return fix('Total is $0', 'Open the invoice and correct the amounts.');
  if (code === 'line_no_item') return fix('No price code', 'Open the invoice and choose a price item for each line.');
  if (code.endsWith('_item_missing')) return fix(`Item not in ${acct}`, `Add the item in ${acct}, then sync.`);
  if (code.endsWith('_contact_missing')) return fix(`Client not in ${acct}`, `Add the client in ${acct}, then sync.`);
  if (code.endsWith('_contact_ambiguous')) return fix(`Two ${acct} clients`, `Merge or rename the clients in ${acct}, then sync.`);
  if (code.includes('earlier_version')) return fix(`Old copy in ${acct}`, 'Open the invoice for the steps.');
  if (code.startsWith('send_') || code.endsWith('_push_failed') || code.endsWith('_outcome_unknown')) return fix('Not sent', 'Open the invoice and send it again.');
  return fix('Invoice problem', 'Open the invoice to correct it.');
}

// What a person must fix on a job, in order: [{ label, text, todo }]. Empty
// unless invoiceStage is Problem. `accountingName` names the accounting
// system (for example Xero).
export function fixes(o, { accountingName = null } = {}) {
  if (invoiceStage(o) !== 'problem') return [];
  const acct = accountingName ?? 'the accounting system';
  const found = [];
  if (PROBLEM_VIEWS.includes(o.view)) found.push(...(o.reasons ?? []).map((r) => reasonFix(r, acct)));
  if (o.view === 'ready') {
    found.push(...(o.waitingFor ?? []).filter(isRule).map((r) => ({
      label: 'Stopped by a rule', text: sentence(r), todo: 'Draft the invoice here, or change the rule under Settings, Invoicing, Rules.',
    })));
  }
  if (o.invoiceStatus === 'void') {
    found.push({ label: 'Invoice void', text: 'The invoice for this job is void.', todo: 'Make a new invoice, or close the job.' });
  }
  found.push(...(o.invoiceProblems ?? []).map((p) => draftFix(p, acct)));
  return found;
}

// The short words for a job's problems: the first label, and "+N" for more.
export function problemSummary(found) {
  const labels = [...new Set(found.map((f) => f.label))];
  if (!labels.length) return '';
  return labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0];
}

// Does a job match the search text? Case, client, practitioner or invoice
// number; the case is not shown on the board, but a person can find it.
export function matches(job, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [job.caseRef, job.sourceJobRef, job.clientName, job.workClientName, job.practitioner, job.obligation?.invoiceNumber]
    .some((value) => value && String(value).toLowerCase().includes(needle));
}
