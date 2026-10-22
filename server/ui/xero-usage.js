// The Xero card's usage picture (Integrations › Xero). Three levels: the ring
// and chips always, today open, the week closed. Numbers come from
// GET /api/xero/status. No sentence is needed to read the first level.
import { h, notice } from '/assets/ui/kit.js';
import { svg } from '/assets/ui/view-bar.js';
import { USAGE_LANES, formatAge, formatWhen } from '/assets/ui/xero-usage-model.js';

const LANE_LABEL = { writes: 'Writes', sync: 'Sync', reads: 'Reads', other: 'Other' };
const num = new Intl.NumberFormat('en-AU');
const HOUR = 60 * 60 * 1000;

function lanePart(count, whole) {
  if (!whole) return '0%';
  return `${(count / whole) * 100}%`;
}

function ring(usage) {
  const pct = usage.dayLimit > 0 ? Math.min(100, Math.round((usage.used / usage.dayLimit) * 1000) / 10) : 0;
  const label = `${num.format(usage.used)} of ${num.format(usage.dayLimit)}`;
  return h('div', { class: 'fx-xu-ring', role: 'img', 'aria-label': label },
    svg(`<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="fx-xu-ring__track" cx="18" cy="18" r="15.5" pathLength="100"/><circle class="fx-xu-ring__used" cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="${pct} 100"/></svg>`),
    h('div', { class: 'fx-xu-ring__label' },
      h('span', { class: 'fx-xu-ring__num' }, num.format(usage.used)),
      h('span', { class: 'fx-xu-ring__of' }, num.format(usage.dayLimit))));
}

function chips(status, now) {
  const stopped = status.calls?.stopped;
  const connection = !status.connected
    ? ['mute', 'Off']
    : stopped && status.calls.all
      ? ['danger', 'Stopped']
      : stopped
        ? ['warn', 'Limited']
        : ['success', 'Connected'];
  const age = formatAge(status.freshness?.copyAt, now);
  return h('div', { class: 'fx-xu__chips' },
    h('span', { class: 'fx-status', 'data-tone': connection[0] }, connection[1]),
    status.usage.tier ? h('span', { class: 'fx-chip fx-chip--static' }, status.usage.tier) : null,
    h('span', { class: 'fx-chip fx-chip--static', title: 'Copy', 'aria-label': age ? `Copy ${age}` : 'Copy' }, age ?? '—'));
}

function legend() {
  return h('div', { class: 'fx-xu-legend' }, USAGE_LANES.map((lane) => h('span', {},
    h('i', { class: 'fx-xu-lane', 'data-lane': lane, 'aria-hidden': 'true' }),
    LANE_LABEL[lane])));
}

function hourChart(usage) {
  const peak = Math.max(1, ...usage.hours.map((hour) => USAGE_LANES.reduce((sum, lane) => sum + hour[lane], 0)));
  return h('div', { class: 'fx-xu-hours', role: 'img', 'aria-label': 'Calls by hour' }, usage.hours.map((hour) => {
    const total = USAGE_LANES.reduce((sum, lane) => sum + hour[lane], 0);
    const stack = h('span', { class: 'fx-xu-hour__stack', style: { '--h': `${(total / peak) * 100}%` } },
      USAGE_LANES.map((lane) => (hour[lane]
        ? h('i', { class: 'fx-xu-lane', 'data-lane': lane, style: { '--part': lanePart(hour[lane], total) } })
        : null)));
    const when = new Date(hour.hour);
    stack.title = `${when.getUTCHours()}:00 · ${total}`;
    return h('span', { class: 'fx-xu-hour' }, stack);
  }));
}

function budgetBar(usage) {
  return h('div', { class: 'fx-xu-budget', role: 'img', 'aria-label': 'Budget by lane' },
    USAGE_LANES.map((lane) => h('i', {
      class: 'fx-xu-lane',
      'data-lane': lane,
      style: { '--part': lanePart(usage.lanes[lane], usage.dayLimit) },
      title: `${LANE_LABEL[lane]} ${num.format(usage.lanes[lane])}`,
    })));
}

function dot(label, tone, title) {
  return h('span', { class: 'fx-xu-dot', 'data-tone': tone, title: title || label }, label);
}

function freshnessDots(freshness, limited, now) {
  const tone = (at, freshFor) => {
    if (!at) return 'mute';
    return now - new Date(at).getTime() <= freshFor ? 'success' : 'warn';
  };
  const recentLimit = limited.some((row) => row.at && now - new Date(row.at).getTime() <= 24 * HOUR);
  return h('div', { class: 'fx-xu-dots' },
    dot('Webhook', tone(freshness?.webhookAt, 24 * HOUR), formatWhen(freshness?.webhookAt) ?? 'Webhook'),
    dot('Poll', tone(freshness?.pollAt, 2 * HOUR), formatWhen(freshness?.pollAt) ?? 'Poll'),
    dot('Nightly', tone(freshness?.nightlyAt, 26 * HOUR), formatWhen(freshness?.nightlyAt) ?? 'Nightly'),
    dot('429', recentLimit ? 'danger' : 'success', recentLimit ? `${limited.length}` : '429'));
}

function dayChart(usage) {
  return h('div', { class: 'fx-xu-days', style: { '--warn': String(usage.warningFraction) }, role: 'img', 'aria-label': 'Calls over 7 days' },
    h('span', { class: 'fx-xu-days__line', title: 'Warning' }),
    usage.days.map((day) => {
      const height = usage.dayLimit > 0 ? Math.min(100, (day.total / usage.dayLimit) * 100) : 0;
      return h('span', { class: 'fx-xu-day', 'data-warning': String(day.warning), 'data-over': String(day.over), title: `${day.day} · ${num.format(day.total)}` },
        h('span', { class: 'fx-xu-day__bar' }, h('b', { style: { '--h': `${height}%` } })),
        h('span', {}, day.day.slice(8)));
    }));
}

function rows(items, empty) {
  if (!items.length) return h('p', { class: 'fx-dim' }, empty);
  return h('div', { class: 'fx-xu-rows' }, items.map((item) => h('div', { class: 'fx-xu-row' },
    h('span', {}, item.label),
    h('b', {}, item.value))));
}

// The picture for one connected organisation. `status` is GET /api/xero/status.
export function xeroUsage(status, now = Date.now()) {
  const usage = status?.usage;
  if (!usage) return null;
  const tone = usage.used >= usage.dayLimit && usage.dayLimit > 0 ? 'danger' : usage.warning ? 'warn' : 'ok';
  return h('section', { class: 'fx-xu', 'data-tone': tone, 'aria-label': 'Usage' },
    h('div', { class: 'fx-xu__top' }, ring(usage), chips(status, now)),
    h('details', { class: 'fx-xu__fold', open: true },
      h('summary', {}, 'Today'),
      legend(),
      hourChart(usage),
      budgetBar(usage),
      freshnessDots(status.freshness, usage.limited, now)),
    h('details', { class: 'fx-xu__fold' },
      h('summary', {}, 'Detail'),
      dayChart(usage),
      rows(usage.tasks.map((task) => ({ label: task.task, value: num.format(task.calls) })), '—'),
      rows(usage.limited.map((row) => ({
        label: row.problem || '429',
        value: formatWhen(row.at) ?? '—',
      })), '—'),
      h('div', { class: 'fx-xu-row' },
        h('span', {}, 'Token'),
        h('b', {}, formatWhen(status.freshness?.tokenRefreshedAt) ?? '—')),
      usage.suggestTier ? notice(`Calls passed the warning on ${usage.warnedDays} days. A higher Xero tier raises the day's limit.`, 'warn', 'Tier') : null));
}
