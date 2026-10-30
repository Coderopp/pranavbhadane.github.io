// Strict validation of tracking payloads (schema v2, produced by analytics.js).
// Anything not described here is rejected, so malformed or legacy requests can
// never become events or notifications.

export const EVENT_TYPES = ['page_view', 'page_exit'];

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PATH_RE = /^\/[^\s\u0000-\u001f\u007f]{0,511}$/;
const SCREEN_RE = /^\d{2,5}x\d{2,5}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_URL = 1024;
const MAX_SKEW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_VISIBLE_MS = 24 * 60 * 60 * 1000;

const ALLOWED_KEYS = new Set([
  'v', 'event_id', 'event_type', 'timestamp', 'page_url', 'page_path', 'referrer',
  'session_id', 'session_new', 'returning', 'screen', 'timezone', 'language',
  'visible_ms', 'view_id', 'automation',
]);

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

function optional(body, key, test, errors, message) {
  if (body[key] === undefined || body[key] === null) return;
  if (!test(body[key])) errors.push(message || `invalid ${key}`);
}

/**
 * @returns {{ ok: true, event: object } | { ok: false, errors: string[] }}
 */
export function validateEvent(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }
  const errors = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unexpected field ${key}`);
  }
  if (body.v !== 2) errors.push('unsupported schema version (expected v=2)');
  if (typeof body.event_id !== 'string' || !ID_RE.test(body.event_id)) errors.push('invalid event_id');
  if (!EVENT_TYPES.includes(body.event_type)) errors.push('invalid event_type');
  if (typeof body.session_id !== 'string' || !ID_RE.test(body.session_id)) errors.push('invalid session_id');

  let clientMs = null;
  if (typeof body.timestamp !== 'string' || !TS_RE.test(body.timestamp)) {
    errors.push('invalid timestamp (expected ISO-8601 UTC)');
  } else {
    clientMs = Date.parse(body.timestamp);
    if (Number.isNaN(clientMs)) errors.push('invalid timestamp (expected ISO-8601 UTC)');
    else if (Math.abs(now - clientMs) > MAX_SKEW_MS) errors.push('timestamp out of range');
  }

  if (typeof body.page_path !== 'string' || !PATH_RE.test(body.page_path)) errors.push('invalid page_path');
  const pageUrl = httpUrl(body.page_url);
  if (!pageUrl) errors.push('invalid page_url');
  else if (typeof body.page_path === 'string' && pageUrl.pathname !== body.page_path) errors.push('page_url does not match page_path');

  if (body.referrer !== undefined && body.referrer !== '' && body.referrer !== null && !httpUrl(body.referrer)) {
    errors.push('invalid referrer');
  }

  optional(body, 'session_new', (v) => typeof v === 'boolean', errors);
  optional(body, 'returning', (v) => typeof v === 'boolean', errors);
  optional(body, 'automation', (v) => typeof v === 'boolean', errors);
  optional(body, 'screen', (v) => typeof v === 'string' && SCREEN_RE.test(v), errors);
  optional(body, 'timezone', (v) => typeof v === 'string' && TZ_RE.test(v), errors);
  optional(body, 'language', (v) => typeof v === 'string' && LANG_RE.test(v), errors);

  if (body.event_type === 'page_exit') {
    if (!Number.isInteger(body.visible_ms) || body.visible_ms < 0 || body.visible_ms > MAX_VISIBLE_MS) errors.push('invalid visible_ms');
    if (typeof body.view_id !== 'string' || !ID_RE.test(body.view_id)) errors.push('invalid view_id');
  } else if (body.visible_ms !== undefined || body.view_id !== undefined) {
    errors.push('visible_ms/view_id only allowed on page_exit');
  }

  if (errors.length) return { ok: false, errors };

  let referrerDomain = null;
  if (body.referrer) referrerDomain = new URL(body.referrer).hostname;

  return {
    ok: true,
    event: {
      event_id: body.event_id,
      event_type: body.event_type,
      timestamp: new Date(clientMs).toISOString(),
      clock_skew_ms: now - clientMs,
      page_url: pageUrl.toString(),
      page_origin: pageUrl.origin,
      page_path: body.page_path,
      referrer: body.referrer || '',
      referrer_domain: referrerDomain,
      session_id: body.session_id,
      session_new: body.session_new === true,
      returning: typeof body.returning === 'boolean' ? body.returning : null,
      screen: body.screen || null,
      timezone: body.timezone || null,
      language: body.language || null,
      visible_ms: body.event_type === 'page_exit' ? body.visible_ms : null,
      view_id: body.event_type === 'page_exit' ? body.view_id : null,
      automation: body.automation === true,
    },
  };
}

/**
 * Read a request body up to `limit` bytes without buffering anything larger.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: 'too_large' }>}
 */
export async function readBodyLimited(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

export function isAcceptedContentType(value) {
  const type = (value || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type === 'text/plain';
}
