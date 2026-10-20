import { routePattern } from '../ui/monitoring.js';

// Performance traces for the installation's own tracing service
// (docs/SENTRY.md, "Traces"). The first integration that is on and offers the
// `traceSpan` and `traceRequest` capabilities gets them. With none on, each
// function here runs the work as it is and adds nothing.
//
// `tracers()` answers the adapters to trace with; it is read at each call,
// so an integration turned on or off later is followed.
export function createTracing({ tracers = () => [] } = {}) {
  const first = () => tracers()[0]?.capabilities ?? null;
  return {
    // Runs `work` inside a span named `name`, of kind `op`.
    span(name, op, work, attributes = {}) {
      const tracer = first();
      return tracer ? tracer.traceSpan({ name, op, attributes }, work) : work();
    },
    // Express middleware: names each request's trace by its route pattern
    // ("GET /api/invoicing/invoices/:id"), never by its URL, so the same
    // click on another invoice is the same name.
    requests() {
      return (req, res, next) => {
        const rename = first()?.traceRequest() ?? null;
        if (rename) res.once('finish', () => rename(requestName(req)));
        next();
      };
    },
  };
}

// The route Express matched, else the path with its ids as ":id".
export function requestName(req) {
  const route = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : null;
  return `${req.method} ${route ?? routePattern(req.originalUrl ?? req.url)}`;
}

// A span for each database query the pool runs. The span's name is the SQL
// with its values left out: Flow passes values as parameters, and any quoted
// text or number in the SQL itself becomes "?".
export function traceQueries(pool, tracing) {
  const wrap = (target) => {
    const query = target.query.bind(target);
    target.query = (...args) => {
      // Callback calls are pg's own (the pool's query runs through a
      // client's): the promise call around them already has its span.
      if (typeof args.at(-1) === 'function') return query(...args);
      return tracing.span(sqlName(args[0]), 'db', () => query(...args), { 'db.system': 'postgresql', 'db.system.name': 'postgresql' });
    };
  };
  wrap(pool);
  // A client a transaction holds (pool.connect()) queries directly.
  pool.on('connect', wrap);
  return pool;
}

export function sqlName(statement) {
  const text = typeof statement === 'string' ? statement : String(statement?.text ?? '');
  return text
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w$])\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'query';
}
