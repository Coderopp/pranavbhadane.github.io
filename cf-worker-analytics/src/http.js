// Response helpers and CORS handling.
//
// CORS only stops *browsers* on other origins from reading responses; any
// client can still POST directly. Origin checks are therefore enforced
// server-side too (see index.js), alongside validation and rate limiting.

const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function isAllowedOrigin(origin, cfg) {
  if (!origin) return false;
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (cfg.allowLocalhost && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) return true;
  return false;
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...BASE_HEADERS, ...extraHeaders },
  });
}

export function text(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...extraHeaders },
  });
}

export function empty(status, extraHeaders = {}) {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...extraHeaders } });
}
