// Home: the page a person lands on, a row of stat cards like an accounting
// dashboard. Ready (with Send), Pending, To match and Forms each show their
// count, and a total when it has one. A card with work has a thin edge in its
// tone; a card at 0 is plain. No card says "done": the counts say it. Each card
// opens its page. Send sends every ready invoice with the same step as the
// Invoices page (POST /invoices/send-ready). No calls of its own to other
// systems: every number is its page's own.
import { formatCents, localDate } from '/assets/ui/invoicing.js';
import { sendModeNote } from '/assets/ui/invoice-notes.js';
import { lucide } from '/assets/ui/custom-fields.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function renderHome(main, ui) {
  const { h, flow, toast, notice, pageHeader, dialog, go } = ui;
  const host = h('div', { class: 'fx-home' });
  main.append(pageHeader('Home'), host);
  const tabQuery = (tab) => `/api/invoicing/invoices?${new URLSearchParams({ status: tab, limit: '1' })}`;

  async function load() {
    let context;
    let body;
    let pending;
    let toMatch;
    let forms;
    try {
      [context, body, pending, toMatch, forms] = await Promise.all([
        flow('/api/invoicing/context'),
        flow(tabQuery('ready')),
        flow(tabQuery('pending')),
        // The two below are extras: Home still shows without them.
        flow('/api/invoicing/reconcile').catch(() => null),
        flow('/api/captures').catch(() => null),
      ]);
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger', 'Flow could not load your invoices.'));
      return;
    }
    if (!host.isConnected) return;
    draw(context, body, [
      { key: 'pending', href: '/invoices?tab=pending', label: 'Pending', tone: 'danger', count: pending.total, sum: pending.totalCents },
      { key: 'match', href: '/reconcile', label: 'Unmatched', tone: 'warn', count: toMatch ? (toMatch.jobs?.length ?? 0) + (toMatch.invoices?.length ?? 0) : null },
      forms && { key: 'forms', href: '/captures', label: 'Forms', tone: 'info', count: forms.captures.filter((c) => c.state === 'ready').length },
    ].filter(Boolean));
  }

  // One stat card. The link covers the card; Send sits above it, so the card
  // has no button inside a link. `count: null`: the page could not be read.
  function card({ key, href, label, tone, count, sum = null }, extra = null) {
    const unknown = count == null;
    return h('article', { class: 'fx-stat', 'data-tone': count ? tone : 'none', 'aria-labelledby': `home-${key}` },
      h('a', {
        class: 'fx-stat__link', href, onclick: open, id: `home-${key}`, title: unknown ? 'Could not load' : null,
        'aria-label': [label, unknown ? 'could not load' : String(count), count && sum != null ? formatCents(sum) : null].filter(Boolean).join(', '),
      },
        h('span', { class: 'fx-label' }, label),
        h('span', { class: 'fx-stat__n' }, unknown ? '–' : String(count)),
        h('span', { class: 'fx-stat__sum' }, count && sum != null ? formatCents(sum) : '')),
      extra);
  }

  function draw(context, body, items) {
    const to = body.sendsTo;
    const ready = body.counts?.ready ?? 0;
    const blocked = to && body.sendMode && (!body.sendMode.connected || !body.sendMode.writesAllowed);
    const canSend = context.canIssue && !blocked;
    // Send shows only to people who can send, and only while it can work.
    const sendButton = ready && canSend ? h('div', { class: 'fx-stat__act' }, h('button', {
      class: 'fx-btn fx-btn--primary', type: 'button',
      onclick: (event) => send(to, ready, body.sendMode, event.currentTarget),
    }, lucide(h, 'send'), h('span', {}, 'Send'))) : null;
    host.replaceChildren(...[
      // A broken accounting connection shows at any count, not only with Ready.
      blocked ? notice(sendModeNote(to, body.sendMode), 'warn') : null,
      h('section', { class: 'fx-stats', 'aria-label': 'Invoices and jobs' },
        card({ key: 'ready', href: '/invoices?tab=ready', label: 'Ready', tone: 'accent', count: ready, sum: body.totalCents }, sendButton),
        items.map((item) => card(item)))].filter(Boolean));
  }

  function open(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go(event.currentTarget.getAttribute('href'));
  }

  async function send(to, ready, sendMode, button) {
    const ok = await dialog({
      title: `Send ${plural(ready, 'invoice', 'invoices')}?`,
      body: h('p', {}, to ? sendModeNote(to, sendMode, 'each one') : 'Each one gets the next number and is locked.'),
      confirm: 'Send',
    });
    if (!ok) return;
    button.disabled = true;
    button.lastChild.textContent = 'Sending';
    try {
      const res = await flow('/api/invoicing/invoices/send-ready', { method: 'POST', body: JSON.stringify({ issueDate: localDate() }) });
      const notes = [
        to ? `${res.issued} on the way to ${to}.` : `${res.issued} approved.`,
        res.held ? `${res.held} need a look.` : '',
        res.waiting ? `${res.waiting} could not be checked with the work system yet: press Send again.` : '',
        res.remaining ? `${res.remaining} more are ready: press Send again.` : '',
      ].filter(Boolean);
      toast(notes.join(' '), res.held || res.waiting || res.remaining ? 'info' : 'success', { stay: Boolean(res.held || res.waiting) });
    } catch (error) {
      toast(error.message, 'danger', { stay: true });
    }
    await load();
  }

  await load();
}
