// The notes on the Invoices page and on one invoice (invoicing.js). One fact
// per sentence; they follow the accounting integration's settings. Kept apart
// so tests can load them without a browser.

// What happens to a ready invoice in the accounting system, one fact per
// sentence. It follows the integration's settings: its connection, whether it
// takes writes, and the send mode on its page. `what` names the invoices:
// "each invoice" on the list, "this invoice" on one invoice.
export function sendModeNote(to, sendMode, what = 'each invoice') {
  if (!to) return 'No accounting system is on. Flow keeps each invoice here only.';
  if (sendMode && !sendMode.connected) return `${to} is not connected. Connect it in Integrations before you send.`;
  if (sendMode && !sendMode.writesAllowed) return `${to} does not take invoices from Flow yet. Turn this on in Integrations, ${to}.`;
  const text = sendMode?.mode === 'approve_and_email'
    ? [`Flow sends ${what} to ${to} as approved.`, `${to} emails it to the customer at once.`]
    : [`Flow sends ${what} to ${to} as a draft.`, `You approve and send it in ${to}.`];
  const others = sendMode?.otherCustomers ?? 0;
  if (others) text.push(`${others} ${others === 1 ? 'customer has' : 'customers have'} a different setting.`);
  return text.join(' ');
}

// A warning above a draft, only when its Send cannot work: the accounting
// system is off or takes no invoices. Otherwise nothing: the problems show
// on their own, and the Send dialog says what Send does.
export function draftNote(to, invoice) {
  const sendMode = invoice?.sendMode;
  if (!to || !sendMode || (sendMode.connected && sendMode.writesAllowed)) return null;
  return sendModeNote(to, sendMode);
}
