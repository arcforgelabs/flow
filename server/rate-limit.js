// A fixed-window request limit per client address (req.ip, which honours
// Express's `trust proxy`). In memory: one Flow process serves one lab.
export function rateLimit({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  return (req, res, next) => {
    const at = now();
    if (windows.size > 10_000) {
      for (const [key, entry] of windows) if (entry.resetAt <= at) windows.delete(key);
    }
    const key = req.ip || 'unknown';
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= limit) return next();
    res.set('Retry-After', String(Math.ceil((entry.resetAt - at) / 1000)));
    return res.status(429).json({ ok: false, code: 'rate_limited', error: 'Too many requests. Wait and try again.' });
  };
}
