// Pure numbers for the Xero usage card. No DOM and no database: the server
// fills it from counters Flow already keeps, and the card draws it.

export const USAGE_LANES = Object.freeze(['writes', 'sync', 'reads', 'other']);
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfUtcDay(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// 1,000 a day is Xero's Starter plan; 5,000 is Core and above (docs/XERO.md).
export function appTier(dayLimit) {
  if (!Number.isFinite(dayLimit) || dayLimit <= 0) return null;
  return dayLimit >= 5000 ? 'Core' : 'Starter';
}

// How old a time is, as a short chip: "2 min", "3 h", "4 d".
export function formatAge(at, now) {
  if (!at) return null;
  const ms = Math.max(0, now - new Date(at).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(ms / DAY_MS)} d`;
}

export function formatWhen(at) {
  if (!at) return null;
  return new Date(at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function emptyLanes() {
  return { writes: 0, sync: 0, reads: 0, other: 0 };
}

function addLane(target, lane, n) {
  if (USAGE_LANES.includes(lane)) target[lane] += n;
}

// `hourRows` are { hour, lane, n } for today. `dayRows` are { day, n } over
// the last 7 UTC days. `limitRows` are 429s { at, problem, lane, task }.
export function assembleUsage({
  hourRows = [],
  dayRows = [],
  taskRows = [],
  limitRows = [],
  governor,
  warningFraction,
  now = Date.now(),
}) {
  const dayStart = startOfUtcDay(now);
  const hours = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(dayStart + index * 3_600_000).toISOString(),
    ...emptyLanes(),
  }));
  const lanes = emptyLanes();
  for (const row of hourRows) {
    const index = Math.round((Date.parse(row.hour) - dayStart) / 3_600_000);
    const n = Number(row.n) || 0;
    if (index >= 0 && index < 24) addLane(hours[index], row.lane, n);
    addLane(lanes, row.lane, n);
  }
  const logged = USAGE_LANES.reduce((sum, lane) => sum + lanes[lane], 0);
  const dayLimit = Number(governor?.dayLimit) || 0;
  const used = Math.max(Number(governor?.dayCount) || 0, logged);
  const observed = governor?.observedDayRemaining;
  const left = Number.isFinite(observed) ? observed : Math.max(0, dayLimit - used);
  const fraction = Number.isFinite(warningFraction) ? warningFraction : 0.7;
  const line = dayLimit * fraction;

  const byDay = new Map(dayRows.map((row) => [String(row.day).slice(0, 10), Number(row.n) || 0]));
  const weekStart = dayStart - 6 * DAY_MS;
  let warnedDays = 0;
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart + index * DAY_MS).toISOString().slice(0, 10);
    const total = byDay.get(day) ?? 0;
    const warning = dayLimit > 0 && total >= line;
    if (warning) warnedDays += 1;
    return { day, total, warning, over: dayLimit > 0 && total >= dayLimit };
  });

  return {
    used,
    dayLimit,
    left,
    dayLimitSource: governor?.dayLimitSource ?? 'setting',
    warningFraction: fraction,
    warning: dayLimit > 0 && used >= line,
    tier: appTier(dayLimit),
    lanes,
    hours,
    days,
    warnedDays,
    suggestTier: warnedDays >= 2,
    tasks: taskRows.map((row) => ({ task: row.task, calls: Number(row.n) || 0 })),
    limited: limitRows.map((row) => ({
      at: row.at ? new Date(row.at).toISOString() : null,
      problem: row.problem || null,
      lane: USAGE_LANES.includes(row.lane) ? row.lane : null,
      task: row.task || null,
    })),
  };
}
