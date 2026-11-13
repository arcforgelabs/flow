// No Charge with a reason (docs/INVOICE_RULES.md, "No Charge"): an owner or
// admin says a job's work is not charged, and why, from the lab's reasons
// (Settings, Invoicing). The same dialog changes the reason, or charges the
// job again when the No Charge was a mistake. The job page and the invoice
// page both open it. Answers the saved job, or null when the person cancels.
export async function chooseNoCharge(ui, { jobId, current = null }) {
  const { h } = ui;
  const { settings } = await ui.flow('/api/invoicing/settings');
  const reasons = settings?.noChargeReasons ?? [];
  // A reason that was renamed or taken off the list still shows, so the
  // person sees what the job has now.
  const listed = current && !reasons.includes(current) ? [current, ...reasons] : reasons;
  const select = h('select', { class: 'fx-select', name: 'reason', required: true },
    ...listed.map((r) => h('option', { value: r, ...(r === current ? { selected: true } : {}) }, r)),
    ...(current ? [h('option', { value: '' }, 'Charge it again')] : []));
  const form = await ui.dialog({
    title: current ? 'Change the No Charge' : 'No Charge',
    body: h('label', { class: 'fx-field' }, h('span', {}, 'Reason'), select),
    confirm: 'Save',
  });
  if (!form) return null;
  const reason = form.get('reason') || null;
  const { job } = await ui.flow(`/api/invoicing/jobs/${jobId}/no-charge`, { method: 'POST', body: JSON.stringify({ reason }) });
  ui.toast(reason ? `No Charge: ${reason}.` : 'Charged again. Flow checks it like any job.', 'success');
  return job;
}
