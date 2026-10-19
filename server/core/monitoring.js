// The logger every part of Flow writes to. It passes each line to the host's
// own log first, unchanged, then sends each error to the error services that
// are on (the `captureError` capability, docs/SENTRY.md). With none on, it is
// the host's log. A line's leading "[tag]" is its source.
//
// `reporters()` answers the adapters to send to; it is read at each error,
// so an integration turned on or off later is followed. A failure to send is
// logged as a warning at most once a minute, never sent, so it cannot loop.
export function createMonitoredLog({ log = console, reporters = () => [], now = Date.now }) {
  let lastFailure = -Infinity;

  function error(...args) {
    log.error?.(...args);
    const cause = args.find((arg) => arg instanceof Error) ?? null;
    const message = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    const source = /^\[([a-z0-9_-]+)\]/i.exec(message)?.[1].toLowerCase() ?? 'server';
    for (const adapter of reporters()) {
      try {
        adapter.capabilities.captureError({ message, source, error: cause });
      } catch (failure) {
        const at = now();
        if (at - lastFailure < 60_000) continue;
        lastFailure = at;
        log.warn?.(`[monitoring] ${adapter.id} could not take an error: ${failure.message}`);
      }
    }
  }

  return {
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
    error,
  };
}
