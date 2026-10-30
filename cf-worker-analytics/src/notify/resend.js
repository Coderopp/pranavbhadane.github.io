// Resend API client. A send is only "submitted" when Resend answers 2xx with a
// message id; everything else is reported as a failure with the reason.
// Delivery (as opposed to submission) is confirmed later by Resend webhooks.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * @returns {Promise<{ ok: boolean, status: number|null, id: string|null, error: string|null }>}
 */
export async function sendEmail(cfg, { subject, text, idempotencyKey }, { fetchImpl = fetch } = {}) {
  if (!cfg.resendApiKey || !cfg.toEmail) {
    return { ok: false, status: null, id: null, error: 'email not configured (RESEND_API_KEY / TO_EMAIL)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.resendTimeoutMs);
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: cfg.fromEmail, to: [cfg.toEmail], subject, text }),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body?.id) {
      const message = body?.message || body?.error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, id: null, error: `Resend rejected request: ${message}` };
    }
    return { ok: true, status: res.status, id: body.id, error: null };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ok: false, status: null, id: null, error: timedOut ? `Resend request timed out after ${cfg.resendTimeoutMs}ms` : `Resend request failed: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ webhooks
// Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>"
// using the base64 secret after the "whsec_" prefix.

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyWebhook(secret, headers, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = await signWebhook(secret, id, timestamp, body);
  return signatures
    .split(' ')
    .map((s) => s.split(','))
    .some(([version, sig]) => version === 'v1' && sig && timingSafeEqual(sig, expected));
}
