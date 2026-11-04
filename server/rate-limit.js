import expressRateLimit from 'express-rate-limit';

// A fixed-window request limit per client address (req.ip, which honours
// Express's `trust proxy`). In memory: one Flow process serves one lab. Each
// call makes its own counter. Built on express-rate-limit, which CodeQL
// recognises as rate limiting (js/missing-rate-limiting).
export function rateLimit({ limit, windowMs, keyGenerator }) {
  return expressRateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-8', // RateLimit-Policy, RateLimit and Retry-After
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) => res.status(429).json({ ok: false, code: 'rate_limited', error: 'Too many requests. Wait and try again.' }),
  });
}
