import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import worker, { runScheduled } from '../src/index.js';
import { _resetVerifyCacheForTests } from '../src/classifier/verify.js';
import { signWebhook } from '../src/notify/resend.js';
import { ORIGIN, UA, count, installFetchMock, makeCtx, makeEnv, makeRequest, newId, pageView, resendOk } from './helpers.js';

let fetchMock;
beforeEach(() => {
  _resetVerifyCacheForTests();
  fetchMock = installFetchMock();
  fetchMock.on('https://api.resend.com/emails', resendOk());
  fetchMock.on('https://openai.com/', async () => Response.json({ prefixes: [{ ipv4Prefix: '132.196.86.0/24' }] }));
  fetchMock.on('https://cloudflare-dns.com/', async () => Response.json({ Answer: [] }));
  fetchMock.on('https://developers.google.com/', async () => Response.json({ prefixes: [{ ipv4Prefix: '66.249.64.0/27' }] }));
});
afterEach(() => fetchMock.restore());

async function call(env, reqOpts) {
  const ctx = makeCtx();
  const res = await worker.fetch(makeRequest(reqOpts), env, ctx);
  await ctx.settle();
  let body = null;
  const raw = await res.text();
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { res, body };
}

describe('HTTP and validation', () => {
  test('1. valid POST is accepted, stored, and notifies once', async () => {
    const env = makeEnv();
    const evt = pageView();
    const { res, body } = await call(env, { body: evt });
    assert.equal(res.status, 202);
    assert.deepEqual(body, { status: 'accepted' });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(count(env, 'events', 'event_id = ?', evt.event_id), 1);
    assert.equal(count(env, 'sessions'), 1);
    assert.equal(fetchMock.resendCalls().length, 1);

    const sent = JSON.parse(fetchMock.resendCalls()[0].init.body);
    assert.equal(sent.subject, 'Portfolio Activity: New Browser Session — Pune, Maharashtra, IN');
    assert.match(sent.text, /Page visited\s+\/pranavbhadane\.github\.io\//);
    assert.match(sent.text, /IST/);
    assert.match(sent.text, /Human browser candidate/);
    assert.match(sent.text, /Exact model\s+Unknown/);

    const n = env.DB.raw.prepare('SELECT * FROM notifications').get();
    assert.equal(n.status, 'submitted');
    assert.equal(n.resend_id, 'resend-msg-1');
    assert.ok(n.submitted_at);
  });

  test('2. invalid POST (bad fields) is rejected without notification', async () => {
    const env = makeEnv();
    const { res, body } = await call(env, { body: pageView({ event_type: 'click', session_id: 'x' }) });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'invalid_payload');
    assert.ok(body.details.includes('invalid event_type'));
    assert.equal(count(env, 'events'), 0);
    assert.equal(fetchMock.resendCalls().length, 0);
    assert.equal(count(env, 'crawler_log', "kind = 'rejected'"), 1);
    assert.match(env.DB.raw.prepare("SELECT reason FROM crawler_log").get().reason, /^invalid_payload: .*invalid event_type/);
  });

  test('legacy v1 payload ({path, sessionId}) is rejected', async () => {
    const env = makeEnv();
    const { res, body } = await call(env, { body: { path: '/', sessionId: 'abc', isNewSession: true } });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'legacy_v1_payload');
    assert.equal(count(env, 'crawler_log', "reason = 'legacy_v1_payload'"), 1);
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('3. empty payload is rejected', async () => {
    const env = makeEnv();
    const { res, body } = await call(env, { rawBody: '' });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'empty_payload');
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('4. missing page path is rejected (no "Unknown" page events)', async () => {
    const env = makeEnv();
    const evt = pageView();
    delete evt.page_path;
    const { res, body } = await call(env, { body: evt });
    assert.equal(res.status, 400);
    assert.ok(body.details.includes('invalid page_path'));
    assert.equal(count(env, 'events'), 0);
  });

  test('page_url must match page_path and the request Origin', async () => {
    const env = makeEnv();
    let r = await call(env, { body: pageView({ page_url: `${ORIGIN}/other` }) });
    assert.equal(r.res.status, 400);
    r = await call(env, { body: pageView({ page_url: 'https://evil.example/pranavbhadane.github.io/' }) });
    assert.equal(r.res.status, 400);
    assert.equal(r.body.error, 'page_url_origin_mismatch');
  });

  test('5. invalid timestamp is rejected', async () => {
    const env = makeEnv();
    for (const timestamp of ['yesterday', '2026-10-30 10:00:00', '2026-13-45T99:99:99Z', '1990-01-01T00:00:00Z']) {
      const { res } = await call(env, { body: pageView({ timestamp }) });
      assert.equal(res.status, 400, timestamp);
    }
    assert.equal(count(env, 'events'), 0);
  });

  test('6. oversized payload is rejected with 413', async () => {
    const env = makeEnv();
    const { res } = await call(env, { rawBody: JSON.stringify({ ...pageView(), pad: 'x'.repeat(10000) }) });
    assert.equal(res.status, 413);
    assert.equal(count(env, 'events'), 0);
  });

  test('7. GET never creates an event or notification', async () => {
    const env = makeEnv();
    for (const path of ['/', '/track']) {
      const { res } = await call(env, { method: 'GET', path, ua: UA.facebookExternalHit, cf: { asn: 32934 } });
      assert.equal(res.status, 404);
    }
    assert.equal(count(env, 'events'), 0);
    assert.equal(fetchMock.resendCalls().length, 0);
    // ...but the probe is logged as a crawler request
    const probe = env.DB.raw.prepare("SELECT * FROM crawler_log WHERE kind = 'probe'").get();
    assert.equal(probe.bot_name, 'facebookexternalhit');
    assert.equal(probe.verification_status, 'verified');
    assert.equal(probe.method, 'GET');
  });

  test('GET /health is a side-effect-free health check', async () => {
    const env = makeEnv();
    const { res, body } = await call(env, { method: 'GET', path: '/health' });
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(count(env, 'crawler_log'), 0);
  });

  test('GET /robots.txt disallows crawling the endpoint', async () => {
    const { res, body } = await call(makeEnv(), { method: 'GET', path: '/robots.txt' });
    assert.equal(res.status, 200);
    assert.match(body, /Disallow: \//);
  });

  test('8. HEAD returns 405 and creates nothing', async () => {
    const env = makeEnv();
    const { res } = await call(env, { method: 'HEAD', path: '/track' });
    assert.equal(res.status, 405);
    assert.equal(count(env, 'events'), 0);
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('9. OPTIONS preflight: allowed origin gets CORS, others 403, nothing stored', async () => {
    const env = makeEnv();
    let { res } = await call(env, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    ({ res } = await call(env, { method: 'OPTIONS', origin: 'https://evil.example' }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(count(env, 'events'), 0);
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('10. unsupported methods return 405', async () => {
    const env = makeEnv();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const { res } = await call(env, { method, body: pageView() });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, POST, OPTIONS');
    }
    assert.equal(count(env, 'events'), 0);
  });

  test('POST from a disallowed or missing Origin is rejected', async () => {
    const env = makeEnv();
    let { res } = await call(env, { body: pageView(), origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    ({ res } = await call(env, { body: pageView(), origin: null }));
    assert.equal(res.status, 403);
    assert.equal(count(env, 'events'), 0);
  });

  test('unsupported content type is rejected with 415', async () => {
    const { res } = await call(makeEnv(), { body: pageView(), contentType: 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 415);
  });

  test('application/json is accepted as well as text/plain', async () => {
    const { res } = await call(makeEnv(), { body: pageView(), contentType: 'application/json; charset=utf-8' });
    assert.equal(res.status, 202);
  });

  test('30. malformed JSON is rejected', async () => {
    const env = makeEnv();
    const { res, body } = await call(env, { rawBody: '{"v":2,' });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'malformed_json');
    assert.equal(fetchMock.resendCalls().length, 0);
  });
});

describe('crawlers never produce human notifications', () => {
  test('Meta crawler executing the script is logged as a crawler, digest only', async () => {
    const env = makeEnv();
    const { res } = await call(env, { body: pageView(), ua: UA.metaWebIndexer, cf: { asn: 32934, asOrganization: 'Facebook, Inc.' }, ip: '57.141.0.5' });
    assert.equal(res.status, 202);
    assert.equal(count(env, 'sessions'), 0);
    assert.equal(count(env, 'crawler_log', "kind = 'event' AND bot_name = 'meta-webindexer'"), 1);
    assert.equal(fetchMock.resendCalls().length, 0);
    const row = env.DB.raw.prepare("SELECT * FROM crawler_log WHERE kind = 'event'").get();
    for (const field of ['user_agent', 'ip', 'request_url', 'received_at', 'method', 'referrer', 'confidence', 'verification_status']) {
      assert.ok(row[field] !== null && row[field] !== undefined, `crawler_log.${field} recorded`);
    }
  });

  test('Headless Chrome and GPTBot do not notify', async () => {
    const env = makeEnv();
    await call(env, { body: pageView(), ua: UA.headlessChrome });
    await call(env, { body: pageView({ session_id: 'session-bbbbbbbbbbbbbbbb' }), ua: UA.gptbot, ip: '132.196.86.9' });
    assert.equal(fetchMock.resendCalls().length, 0);
    assert.equal(count(env, 'crawler_log', "kind = 'event'"), 2);
  });

  test('crawler "immediate" policy uses crawler subjects with cooldown', async () => {
    const env = makeEnv({ NOTIFY_POLICY: JSON.stringify({ social_preview_crawler: 'immediate' }) });
    const opts = { ua: UA.facebookExternalHit, cf: { asn: 32934 }, ip: '31.13.115.1' };
    await call(env, { ...opts, body: pageView() });
    await call(env, { ...opts, body: pageView() });
    assert.equal(fetchMock.resendCalls().length, 1);
    const sent = JSON.parse(fetchMock.resendCalls()[0].init.body);
    assert.equal(sent.subject, 'Portfolio Crawler: Meta Social Preview — /pranavbhadane.github.io/');
  });
});

describe('reliability', () => {
  test('24. duplicate event_id is stored once and notifies once', async () => {
    const env = makeEnv();
    const evt = pageView();
    const first = await call(env, { body: evt });
    const second = await call(env, { body: evt });
    assert.equal(first.res.status, 202);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.status, 'duplicate');
    assert.equal(count(env, 'events'), 1);
    assert.equal(fetchMock.resendCalls().length, 1);
  });

  test('25. repeated session events: one email per session, navigation recorded', async () => {
    const env = makeEnv();
    const base = Date.now();
    const paths = ['/pranavbhadane.github.io/', '/pranavbhadane.github.io/career.html', '/pranavbhadane.github.io/blog/can-llms-be-intelligent.html'];
    for (const [i, p] of paths.entries()) {
      const r = await call(env, { body: pageView({ page_path: p, timestamp: new Date(base + i * 30000).toISOString(), session_new: i === 0 }) });
      assert.equal(r.res.status, 202);
    }
    assert.equal(fetchMock.resendCalls().length, 1);
    const s = env.DB.raw.prepare('SELECT * FROM sessions').get();
    assert.equal(s.page_views, 3);
    assert.deepEqual(JSON.parse(s.pages_json), paths);
    assert.equal(s.landing_page, paths[0]);
  });

  test('double-fired page_view (same page within 2s, new event_id) is deduplicated', async () => {
    const env = makeEnv();
    const ts = Date.now();
    await call(env, { body: pageView({ timestamp: new Date(ts).toISOString() }) });
    const { body } = await call(env, { body: pageView({ timestamp: new Date(ts + 500).toISOString() }) });
    assert.equal(body.status, 'duplicate');
    assert.equal(env.DB.raw.prepare('SELECT page_views FROM sessions').get().page_views, 1);
  });

  test('new session from same IP within cooldown does not email again', async () => {
    const env = makeEnv();
    await call(env, { body: pageView({ session_id: 'session-1111111111111111' }) });
    await call(env, { body: pageView({ session_id: 'session-2222222222222222' }) });
    assert.equal(count(env, 'sessions'), 2);
    assert.equal(fetchMock.resendCalls().length, 1);
    assert.equal(count(env, 'notifications', "status = 'skipped' AND error = 'ip_cooldown'"), 1);
  });

  test('a failed send does not start the per-IP cooldown', async () => {
    fetchMock.on('https://api.resend.com/emails', async () => Response.json({ message: 'nope' }, { status: 403 }));
    const env = makeEnv();
    await call(env, { body: pageView({ session_id: 'session-fail111111111111' }) });
    fetchMock.on('https://api.resend.com/emails', resendOk('after-fix'));
    await call(env, { body: pageView({ session_id: 'session-fail222222222222' }) });
    assert.equal(count(env, 'notifications', "status = 'submitted'"), 1);
  });

  test('hourly email cap prevents notification flooding', async () => {
    const env = makeEnv({ MAX_IMMEDIATE_EMAILS_PER_HOUR: '2', NOTIFY_IP_COOLDOWN_MINUTES: '0' });
    for (let i = 0; i < 4; i++) {
      await call(env, { body: pageView({ session_id: `session-cap${i}aaaaaaaaaaaaa` }), ip: `49.36.10.${i + 1}` });
    }
    assert.equal(fetchMock.resendCalls().length, 2);
    assert.equal(count(env, 'notifications', "error = 'hourly_cap_reached'"), 2);
  });

  test('per-IP rate limit returns 429', async () => {
    const env = makeEnv({ RATE_LIMIT_PER_MINUTE: '3' });
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const { res } = await call(env, { body: pageView({ session_id: `session-rl${i}aaaaaaaaaaaaaa` }) });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(3), [429, 429]);
    assert.equal(count(env, 'events'), 3);
  });

  test('26. Resend API failure: event kept, failure recorded with reason', async () => {
    fetchMock.on('https://api.resend.com/emails', async () => Response.json({ statusCode: 403, message: 'API key is invalid', name: 'validation_error' }, { status: 403 }));
    const env = makeEnv();
    const evt = pageView();
    const { res } = await call(env, { body: evt });
    assert.equal(res.status, 202);
    assert.equal(count(env, 'events', 'event_id = ?', evt.event_id), 1);
    const n = env.DB.raw.prepare('SELECT * FROM notifications').get();
    assert.equal(n.status, 'failed');
    assert.equal(n.http_status, 403);
    assert.match(n.error, /API key is invalid/);
    assert.equal(n.resend_id, null);
  });

  test('2xx without a message id is not treated as success', async () => {
    fetchMock.on('https://api.resend.com/emails', async () => new Response('{}', { status: 200 }));
    const env = makeEnv();
    await call(env, { body: pageView() });
    assert.equal(env.DB.raw.prepare('SELECT status FROM notifications').get().status, 'failed');
  });

  test('27. Resend timeout: event kept, timeout recorded', async () => {
    fetchMock.on('https://api.resend.com/emails', (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const env = makeEnv({ RESEND_TIMEOUT_MS: '1000' });
    const { res } = await call(env, { body: pageView() });
    assert.equal(res.status, 202);
    assert.equal(count(env, 'events'), 1);
    const n = env.DB.raw.prepare('SELECT * FROM notifications').get();
    assert.equal(n.status, 'failed');
    assert.match(n.error, /timed out/);
  });

  test('28a. missing RESEND_API_KEY / TO_EMAIL: event tracked, email skipped', async () => {
    const env = makeEnv({ RESEND_API_KEY: undefined, TO_EMAIL: undefined });
    const { res } = await call(env, { body: pageView() });
    assert.equal(res.status, 202);
    assert.equal(count(env, 'events'), 1);
    assert.equal(fetchMock.resendCalls().length, 0);
    assert.equal(env.DB.raw.prepare('SELECT error FROM notifications').get().error, 'email_not_configured');
  });

  test('28b. missing D1 binding: 503, no notification', async () => {
    const env = makeEnv({ DB: undefined });
    const { res, body } = await call(env, { body: pageView() });
    assert.equal(res.status, 503);
    assert.equal(body.error, 'storage_unavailable');
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('29. Cloudflare metadata unavailable: event still tracked with Unknown location', async () => {
    const env = makeEnv();
    const { res } = await call(env, { body: pageView(), cf: null });
    assert.equal(res.status, 202);
    const e = env.DB.raw.prepare('SELECT country, signals FROM events').get();
    assert.equal(e.country, null);
    assert.match(e.signals, /cloudflare_metadata_unavailable/);
    assert.match(JSON.parse(fetchMock.resendCalls()[0].init.body).subject, /— Unknown$/);
  });

  test('page_exit records foreground time against its page_view', async () => {
    const env = makeEnv();
    const view = pageView();
    await call(env, { body: view });
    const exit = {
      v: 2, event_id: newId('exit'), event_type: 'page_exit', timestamp: new Date(Date.now() + 45000).toISOString(),
      page_url: view.page_url, page_path: view.page_path, session_id: view.session_id, view_id: view.event_id, visible_ms: 42000,
    };
    const { res } = await call(env, { body: exit });
    assert.equal(res.status, 202);
    assert.equal(env.DB.raw.prepare('SELECT visible_ms FROM events WHERE event_id = ?').get(view.event_id).visible_ms, 42000);
    assert.equal(env.DB.raw.prepare('SELECT total_visible_ms FROM sessions').get().total_visible_ms, 42000);
    assert.equal(fetchMock.resendCalls().length, 1, 'page_exit does not notify');
  });

  test('worker never trusts client-supplied IP/location fields', async () => {
    const env = makeEnv();
    const { res } = await call(env, { body: { ...pageView(), ip: '1.1.1.1', country: 'US' } });
    assert.equal(res.status, 400);
  });
});

describe('digest, retention and webhooks', () => {
  test('daily digest groups sessions, crawlers and probes, then advances its window', async () => {
    const env = makeEnv();
    await call(env, { body: pageView() });
    await call(env, { body: pageView({ session_id: 'session-cccccccccccccccc' }), ua: UA.facebookExternalHit, cf: { asn: 32934 }, ip: '31.13.115.1' });
    await call(env, { method: 'GET', path: '/', ua: UA.metaExternalAgent, cf: { asn: 32934 } });
    fetchMock.calls.length = 0;

    const out = await runScheduled(env, Date.now() + 1000);
    assert.equal(out.digest, 'sent');
    assert.equal(out.retention, 'ok');
    const sent = JSON.parse(fetchMock.resendCalls()[0].init.body);
    assert.match(sent.subject, /^Portfolio Analytics Digest — \d{4}-\d{2}-\d{2} \(1 browser session · 2 automated requests\)$/);
    assert.match(sent.text, /facebookexternalhit \(Meta\)/);
    assert.match(sent.text, /meta-externalagent/);
    assert.match(sent.text, /DIRECT ANALYTICS-ENDPOINT REQUESTS/);

    fetchMock.calls.length = 0;
    assert.equal((await runScheduled(env, Date.now() + 2000)).digest, 'nothing_to_report');
    assert.equal(fetchMock.resendCalls().length, 0);
  });

  test('failed digest does not advance the window', async () => {
    const env = makeEnv();
    await call(env, { body: pageView() });
    fetchMock.on('https://api.resend.com/emails', async () => new Response('bad gateway', { status: 502 }));
    assert.equal((await runScheduled(env, Date.now() + 1000)).digest, 'failed');
    fetchMock.on('https://api.resend.com/emails', resendOk('digest-2'));
    assert.equal((await runScheduled(env, Date.now() + 2000)).digest, 'sent');
  });

  test('retention nulls IPs after IP_RETENTION_DAYS', async () => {
    const env = makeEnv({ IP_RETENTION_DAYS: '1' });
    await call(env, { body: pageView() });
    await runScheduled(env, Date.now() + 2 * 24 * 3600 * 1000);
    const e = env.DB.raw.prepare('SELECT ip, ip_hash FROM events').get();
    assert.equal(e.ip, null);
    assert.ok(e.ip_hash);
  });

  test('Resend webhook with a valid signature records delivery time', async () => {
    const secret = `whsec_${Buffer.from('super-secret-key-material').toString('base64')}`;
    const env = makeEnv({ RESEND_WEBHOOK_SECRET: secret });
    await call(env, { body: pageView() });
    const payload = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-30T07:00:05.000Z', data: { email_id: 'resend-msg-1' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signWebhook(secret, 'msg_1', ts, payload);

    const ctx = makeCtx();
    const bad = await worker.fetch(new Request('https://w.example/webhooks/resend', { method: 'POST', body: payload, headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' } }), env, ctx);
    assert.equal(bad.status, 401);
    const good = await worker.fetch(new Request('https://w.example/webhooks/resend', { method: 'POST', body: payload, headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } }), env, ctx);
    assert.equal(good.status, 200);
    const n = env.DB.raw.prepare('SELECT status, delivered_at, submitted_at FROM notifications').get();
    assert.equal(n.status, 'delivered');
    assert.equal(n.delivered_at, '2026-10-30T07:00:05.000Z');
    assert.ok(n.submitted_at);
  });

  test('webhook route is disabled when no secret is configured', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://w.example/webhooks/resend', { method: 'POST', body: '{}' }), env, makeCtx());
    assert.equal(res.status, 405);
  });
});

describe('timestamps', () => {
  test('client time, receipt time and processing time are recorded independently', async () => {
    const env = makeEnv();
    const clientTs = new Date(Date.now() - 5000).toISOString();
    await call(env, { body: pageView({ timestamp: clientTs }) });
    const e = env.DB.raw.prepare('SELECT client_ts, received_at, processing_ms, clock_skew_ms FROM events').get();
    assert.equal(e.client_ts, clientTs);
    assert.notEqual(e.received_at, e.client_ts);
    assert.ok(e.processing_ms >= 0);
    assert.ok(e.clock_skew_ms >= 5000);
  });
});

