// Home: the page a person lands on. One job first: send the invoices that
// are ready. The big number is the Ready tab's count, and Send sends them
// all with the same step as the Invoices page (POST /invoices/send-ready).
// Beside it, at most three things that need a person most days: invoices
// that need a look, jobs and invoices to match (Reconcile), and form photos
// to check (Capture). Each opens its page. No calls of its own to other
// systems: every number is its page's own.
import { formatCents, localDate } from '/assets/ui/invoicing.js';
import { sendModeNote } from '/assets/ui/invoice-notes.js';
import { lucide } from '/assets/ui/custom-fields.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function greeting(person, now = new Date()) {
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = String(person?.name ?? '').trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export async function renderHome(main, ui) {
  const { h, flow, toast, notice, pageHeader, dialog, go, me } = ui;
  const host = h('div', { class: 'fx-home' });
  main.append(pageHeader(greeting(me?.person)), host);
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
      { href: '/invoices?tab=pending', icon: 'circle-alert', label: 'Need a look', tone: 'danger', count: pending.total, sum: pending.totalCents },
      toMatch && { href: '/reconcile', icon: 'link', label: 'To match', tone: 'warn', count: (toMatch.jobs?.length ?? 0) + (toMatch.invoices?.length ?? 0) },
      forms && { href: '/captures', icon: 'camera', label: 'Forms to check', tone: 'info', count: forms.captures.filter((c) => c.state === 'ready').length },
    ].filter(Boolean));
  }

  function draw(context, body, items) {
    const to = body.sendsTo;
    const counts = body.counts ?? {};
    const ready = counts.ready ?? 0;
    const blocked = to && body.sendMode && (!body.sendMode.connected || !body.sendMode.writesAllowed);
    const canSend = context.canIssue && !blocked;

    const hero = ready
      ? h('section', { class: 'fx-home__send', 'aria-labelledby': 'home-ready' },
        h('p', { class: 'fx-home__count', id: 'home-ready' }, String(ready),
          h('span', {}, ready === 1 ? 'invoice ready' : 'invoices ready')),
        h('p', { class: 'fx-home__sum' }, formatCents(body.totalCents)),
        h('button', {
          class: 'fx-btn fx-btn--primary fx-home__btn', type: 'button', disabled: !canSend,
          onclick: (event) => send(to, ready, body.sendMode, event.currentTarget),
        }, lucide(h, 'send'), h('span', {}, 'Send')),
        context.canIssue ? null : h('p', { class: 'fx-home__note' }, 'An owner or admin sends.'),
        blocked ? h('p', { class: 'fx-home__note' }, sendModeNote(to, body.sendMode)) : null)
      : h('section', { class: 'fx-home__send', 'data-done': '', 'aria-labelledby': 'home-ready' },
        h('span', { class: 'fx-home__done', 'aria-hidden': 'true' }, lucide(h, 'check')),
        h('p', { class: 'fx-home__count', id: 'home-ready' }, h('span', {}, 'All caught up')),
        h('p', { class: 'fx-home__sum' }, 'Nothing waits to be sent.'));

    const needs = h('section', { class: 'fx-home__needs', 'aria-labelledby': 'home-needs' },
      h('h2', { class: 'fx-label', id: 'home-needs' }, 'Needs you'),
      h('ul', {}, items.map((item) => h('li', {},
        h('a', { href: item.href, onclick: open, 'data-tone': item.count ? item.tone : 'clear' },
          h('span', { class: 'fx-home__dot', 'aria-hidden': 'true' }, lucide(h, item.count ? item.icon : 'check')),
          h('span', { class: 'fx-home__what' }, item.label,
            item.count && item.sum ? h('small', {}, formatCents(item.sum)) : null),
          h('span', { class: 'fx-home__n' }, String(item.count)))))));

    host.replaceChildren(hero, needs);
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
