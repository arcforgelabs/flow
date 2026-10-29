import { h } from './kit.js';
import { applyPhoneRule } from './mobile.js';

const DAY = 86_400_000;
const words = ['Polishing', 'Glazing', 'Milling', 'Sintering'];
const date = value => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

// Neutral, read-only view of server state. No inferred event history. The caller
// owns actions and polling; dispose stops the display clock when unmounted.
export function syncStatus() {
  const word = h('span', { class: 'fx-sync__word' });
  const dots = h('span', { class: 'fx-sync__dots', 'aria-hidden': 'true' }, ...[0, 1, 2].map(() => h('i')));
  const result = h('span');
  const status = h('span', { class: 'fx-sync__status', role: 'status', 'aria-live': 'polite' }, dots, word, result);
  const clock = h('span', { class: 'fx-sync__clock', 'aria-label': 'Elapsed', 'aria-live': 'off' });
  const action = h('span', { class: 'fx-sync__action' });
  const rail = h('progress', { class: 'fx-sync__rail', max: 1, value: 0, 'aria-label': 'Days read' });
  const range = h('span');
  const eta = h('span');
  const track = h('div', { class: 'fx-sync__track' }, rail, h('span', { class: 'fx-sync__range' }, range, eta));
  const element = applyPhoneRule(h('div', { class: 'fx-sync' }, h('div', { class: 'fx-sync__line' }, status, clock, action), track), 'syncStatus');
  let current = {};
  let timer;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const updateClock = () => {
    const { phase, startedAt, endedAt, nextRunAt, count, from, through, at } = current;
    const active = ['running', 'waiting'].includes(phase);
    const elapsed = (active ? Date.now() : Date.parse(endedAt)) - Date.parse(startedAt);
    clock.textContent = Number.isFinite(elapsed) ? duration(elapsed) : '';
    // Rotating words and ticking clocks are decorative, not live announcements.
    if (phase === 'running' && !count) word.textContent = reduced.matches ? 'Reading' : words[Math.floor(Math.max(0, elapsed) / 2600) % words.length] ?? 'Reading';
    eta.textContent = '';
    if (phase === 'waiting' && nextRunAt) {
      const seconds = Math.max(0, Math.ceil((Date.parse(nextRunAt) - Date.now()) / 1000));
      clock.textContent = `${clock.textContent}${clock.textContent ? ' · ' : ''}${seconds}s until retry`;
    }
    const completed = Date.parse(at) - Date.parse(from);
    const total = Date.parse(through) - Date.parse(from) + DAY;
    if (phase === 'running' && count > 0 && completed > 0 && total > completed && elapsed > 0) {
      eta.textContent = `about ${Math.max(1, Math.ceil(elapsed * (total - completed) / completed / 60000))} min left`;
    }
  };
  const draw = (state, button = null) => {
    current = state;
    const { phase = 'not-started', count, unit = 'jobs', from, through, at, cause, checkedAt } = state;
    element.dataset.phase = phase;
    const running = phase === 'running';
    dots.hidden = !running || count > 0;
    word.setAttribute('aria-hidden', String(running && !count));
    status.setAttribute('aria-label', running && !count ? 'Reading' : '');
    word.textContent = running ? (count > 0 ? `Reading${at ? ` ${date(at)}` : ''}` : 'Reading') : ({ waiting: 'Waiting', stopped: 'Stopped', failed: 'Failed', done: 'Done', loading: 'Checking…', updated: 'Updated', unavailable: 'Unavailable' }[phase] ?? 'Not started');
    result.textContent = `${checkedAt ? `${phase === 'unavailable' ? ' · Last updated' : ''} ${new Date(checkedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}${count != null && (count > 0 || !running) ? ` · ${count.toLocaleString('en-AU')} ${unit}` : ''}${cause ? ` · ${cause}` : ''}${phase === 'stopped' && at ? ` · ${date(at)}` : ''}`;
    if (action.firstChild !== button) action.replaceChildren(...(button ? [button] : []));
    const total = Date.parse(through) - Date.parse(from) + DAY;
    track.hidden = !(count > 0 && total > 0);
    rail.value = phase === 'done' ? 1 : Math.min(1, Math.max(0, (Date.parse(at) - Date.parse(from)) / total || 0));
    range.textContent = track.hidden ? '' : `${date(from)} – ${date(through)}`;
    clearInterval(timer);
    updateClock();
    if (['running', 'waiting'].includes(phase)) timer = setInterval(() => {
      if (!element.isConnected) { clearInterval(timer); return; }
      if (!document.hidden) updateClock();
    }, 1000);
  };
  return { element, draw, dispose: () => clearInterval(timer) };
}

// The saved job is already visible. Only a held history job asks for a read.
export function historyStatus(ui, job, { refresh = null, done = () => {} } = {}) {
  if (!job?.historyHeld && !(job?.holdState === 'held' && job?.holdReason === 'history_import')) return null;
  const status = syncStatus();
  const draw = result => status.draw({ phase: ['read', 'fresh'].includes(result.state) ? 'updated'
    : result.state === 'waiting' ? 'loading' : 'unavailable',
    checkedAt: result.checkedAt, cause: [result.reason, result.deleted ? 'Deleted in Seazona' : null].filter(Boolean).join(' · ') });
  if (refresh) { draw(refresh); return status.element; }
  status.draw({ phase: 'loading' });
  const read = async () => {
    if (!status.element.isConnected) return;
    try {
      const { refresh: result } = await ui.flow(`/api/invoicing/jobs/${job.id}/open`, { method: 'POST', body: '{}' });
      if (!status.element.isConnected) return;
      draw(result);
      if (result.state === 'waiting') setTimeout(read, 1000);
      else if (['read', 'fresh'].includes(result.state)) await done(result);
    } catch {
      if (status.element.isConnected) status.draw({ phase: 'unavailable', cause: 'Could not check. Try opening the job again.' });
    }
  };
  queueMicrotask(read);
  return status.element;
}
