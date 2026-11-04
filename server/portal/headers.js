import { randomBytes } from 'node:crypto';

// Practice pages and their API answers. The API never caches practice data.
// The page allows scripts only from this installation and its Clerk host.
// Clerk's widget injects its own styles, so styles allow inline rules.
// HSTS is set when the request arrived over HTTPS (directly or via the proxy).

export function portalNonce() {
  return randomBytes(16).toString('base64');
}

export function portalSecurityHeaders(req, { scriptOrigins = [], nonce = null } = {}) {
  const extra = scriptOrigins.filter(Boolean).join(' ');
  const nonceSrc = nonce ? `'nonce-${nonce}'` : '';
  const scriptSrc = ['\'self\'', nonceSrc, extra].filter(Boolean).join(' ');
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      `style-src 'self' 'unsafe-inline'${extra ? ` ${extra}` : ''}`,
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${extra ? ` ${extra}` : ''}`,
      `frame-src 'self'${extra ? ` ${extra}` : ''}`,
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  };
  const forwarded = req.get?.('x-forwarded-proto');
  if (req.secure || forwarded === 'https') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export function applyPortalHeaders(req, res, options) {
  for (const [name, value] of Object.entries(portalSecurityHeaders(req, options))) res.set(name, value);
}
