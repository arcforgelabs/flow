import { applyPhoneRule } from '/assets/ui/mobile.js';

// One presentation owner for invoice holds in lists, drafts and issued pages.
// Keep the reason visible on phones; a short label alone cannot explain a hold.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nextStep = (code) => {
  if (['no_lines', 'no_amount', 'line_no_item'].includes(code)) return 'Edit the invoice, then check again.';
  if (code === 'non_chargeable') return 'No invoice will be sent. Check the rule if this is wrong.';
  if (code === 'rule') return 'Check the rule and fix the source job.';
  if (code === 'job_review') return 'Review the job before sending.';
  if (/contact/.test(code)) return 'Check the client in Xero, then sync.';
  if (/item|tracking/.test(code)) return 'Check Xero settings, then sync.';
  if (/reconnect|token|not_connected/.test(code)) return 'Connect Xero in Integrations.';
  if (/writes_off/.test(code)) return 'Ask an owner to check sending in Integrations.';
  if (/earlier_version/.test(code)) return 'Check the earlier invoice in Xero before sending this version.';
  if (/same_reference/.test(code)) return 'Compare the matched invoice before taking another action.';
  if (/outcome_unknown|push_in_progress/.test(code)) return 'Check Xero before trying again.';
  return 'Check the reason, then retry when it is fixed.';
};
const safeWeb = (value) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

export function invoiceProblems(ui, invoice, { compact = false, problems = invoice.problems ?? [] } = {}) {
  const { h, notice } = ui;
  if (!problems.length) return null;
  const described = problems.map((p) => {
    const rule = p.rule ? (p.ruleName ?? p.short ?? 'Lab rule') : null;
    const label = rule ? `Rule: ${rule}` : (p.short ?? p.code ?? 'Problem');
    const message = p.message || 'Sending failed.';
    const reason = rule ? `${label}. ${message}` : message;
    return { p, rule, label, explanation: `${reason} ${nextStep(p.code ?? '')}` };
  });
  if (compact) {
    const explanation = described.map((p) => p.explanation).join(' ');
    // The row opens the invoice with every reason and link. Do not squeeze
    // full explanations or interactive links into its 20px metadata line.
    return applyPhoneRule(h('span', {
      class: 'fx-problem fx-problems--compact', role: 'note', title: explanation, 'aria-label': explanation,
    }, described[0].label, problems.length > 1 ? ` +${problems.length - 1}` : null), 'invoiceProblems');
  }
  const rows = described.map(({ p, rule, label, explanation }) => {
    const links = [];
    const link = (href, text, outside = false) => h('a', {
      class: 'fx-btn fx-btn--sm fx-btn--ghost', href,
      ...(outside ? { target: '_blank', rel: 'noopener' } : {}), onclick: (e) => e?.stopPropagation?.(),
    }, text);
    if (uuid.test(p.xero?.invoiceId ?? '')) links.push(link(`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(p.xero.invoiceId)}`, 'Open in Xero', true));
    if (p.rule) links.push(link('/invoicing-settings/invoices', 'Check rule'));
    if (p.code === 'xero_tracking_missing') links.push(link('/integrations/xero#tracking', 'Tracking settings'));
    if (invoice.job && ['rule', 'non_chargeable', 'job_review'].includes(p.code)) {
      const source = safeWeb(invoice.job.link?.url ?? invoice.job.link);
      links.push(link(source ?? `/jobs/${invoice.job.id}`, source ? 'Fix job' : 'Review job', Boolean(source)));
    }
    return h('div', { class: 'fx-offer' }, notice(explanation, p.code === 'non_chargeable' ? 'info' : 'danger', rule ? null : label), ...links);
  });
  return applyPhoneRule(h('div', { class: 'fx-problems' }, ...rows), 'invoiceProblems');
}
