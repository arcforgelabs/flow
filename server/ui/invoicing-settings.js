// Settings, Invoicing (/invoicing-settings): the rules that decide when Flow
// drafts a job's invoice by itself, and how a checked invoice goes to the
// accounting system (server/core/invoicing-rules.js, /api/invoicing/settings).
// Everyone can read them; an owner or admin changes them. app.js passes in
// its shared pieces as `ui`.

const SEND_MODES = [
  {
    value: 'accounting_draft',
    label: 'Check in Flow, approve in Xero',
    help: 'A person checks the draft in Flow and sends it. It arrives in Xero as a draft. A person approves it and sends it to the customer in Xero.',
  },
  {
    value: 'approve_and_email',
    label: 'Approve in Flow, Xero emails it',
    help: 'A person approves the draft in Flow. It arrives in Xero approved, and Xero emails it to the customer with your Xero template. The Xero contact needs an email address.',
  },
];

export async function renderInvoicingSettings(main, ui) {
  const { h, flow, toast, notice, pageHeader, me } = ui;
  const host = h('div', { class: 'fx-fields' }, h('div', { class: 'fx-skeleton' }));
  main.append(
    pageHeader('Invoicing', { subtitle: 'When Flow drafts invoices from jobs, and how they go to Xero.' }),
    host);
  let body;
  try {
    body = await flow('/api/invoicing/settings');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const canChange = ['owner', 'admin'].includes(me?.person.role);
  const s = body.settings;
  const disabled = !canChange;

  const field = (label, input, help) => h('label', { class: 'fx-field' },
    h('span', { class: 'fx-label' }, label), input, help ? h('span', { class: 'fx-dim' }, help) : null);
  const onOff = (value) => h('select', { class: 'fx-select', disabled },
    h('option', { value: 'on', selected: value }, 'On'), h('option', { value: 'off', selected: !value }, 'Off'));
  const number = (value, min, max) => h('input', { class: 'fx-input', type: 'number', min, max, step: 1, value, disabled });

  const autoDraft = onOff(s.autoDraft);
  const sendMode = h('select', { class: 'fx-select', disabled },
    SEND_MODES.map((m) => h('option', { value: m.value, selected: s.sendMode === m.value }, m.label)));
  const sendHelp = h('span', { class: 'fx-dim' });
  const showSendHelp = () => { sendHelp.textContent = SEND_MODES.find((m) => m.value === sendMode.value)?.help ?? ''; };
  sendMode.addEventListener('change', showSendHelp);
  showSendHelp();
  const readyStatuses = h('input', { class: 'fx-input', type: 'text', value: s.readyStatuses.join(', '), disabled });
  const paymentTermsDays = number(s.paymentTermsDays, 0, 365);
  const staleDays = number(s.staleDays, 1, 3650);
  const requirePractitioner = onOff(s.requirePractitioner);
  const rushItemCode = h('input', { class: 'fx-input', type: 'text', value: s.rushItemCode ?? '', disabled, placeholder: 'No rush rule' });
  const rushPercent = number(s.rushPercent, 0, 100);

  const save = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled }, 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const changes = {
        autoDraft: autoDraft.value === 'on',
        sendMode: sendMode.value,
        readyStatuses: readyStatuses.value.split(',').map((x) => x.trim()).filter(Boolean),
        paymentTermsDays: Number(paymentTermsDays.value),
        staleDays: Number(staleDays.value),
        requirePractitioner: requirePractitioner.value === 'on',
        rushItemCode: rushItemCode.value.trim() || null,
        rushPercent: Number(rushPercent.value),
      };
      await flow('/api/invoicing/settings', { method: 'PUT', body: JSON.stringify(changes) });
      toast('Invoicing settings saved.', 'success');
    } catch (error) {
      toast(error.message, 'danger');
    } finally {
      save.disabled = false;
    }
  });

  const card = (title, ...children) => h('section', { class: 'fx-card', style: { padding: '18px' } },
    h('h2', { class: 'fx-strong', style: { margin: '0 0 14px' } }, title),
    h('div', { class: 'fx-fields', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', alignItems: 'start' } }, ...children));
  host.replaceChildren(...[
    canChange ? null : notice('An owner or admin can change these settings.', 'info'),
    card('Drafts',
        field('Draft invoices by rule', autoDraft, 'Flow drafts the invoice of each job that passes every rule. The draft waits in Flow for a person.'),
        field('Ready statuses', readyStatuses, 'The work system statuses that make a job ready to bill, separated by commas.'),
        field('Payment terms (days)', paymentTermsDays, 'The due date is this many days after the invoice date.'),
        field('Old job limit (days)', staleDays, 'A job older than this waits for a person.'),
        field('Practitioner required', requirePractitioner, 'A job needs a practitioner, its own or the customer\'s default.'),
        field('Rush item code', rushItemCode, 'The price item of a rush charge. Leave it empty for no rush rule.'),
        field('Rush share (%)', rushPercent, 'A rush line must be this share of the other lines.')),
    card('Sending',
        h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'How invoices go to Xero'), sendMode, sendHelp),
        h('p', { class: 'fx-dim' }, 'Flow reads each invoice back from Xero, so approvals, payments, voids and credit notes made in Xero show on the job.')),
    h('div', { class: 'fx-row fx-row--end' }, save),
  ].filter(Boolean));
}
