// Portfolio analytics Worker.
//
// Routes
//   POST    /track            Validated page events from analytics.js
//   OPTIONS /track            CORS preflight (approved origins only)
//   GET     /health           Health check, no side effects
//   GET     /robots.txt       Disallow everything (keeps crawlers off the endpoint)
//   POST    /webhooks/resend  Resend delivery webhooks (only if RESEND_WEBHOOK_SECRET is set)
//   anything else             404/405; logged as an endpoint probe, never a visit
//
// Scheduled (cron): daily digest email + data retention.

import { CATEGORY } from './classifier/categories.js';
import { classifyRequest } from './classifier/index.js';
import { parseUserAgent } from './classifier/useragent.js';
import { cloudflareBotSignals } from './classifier/verify.js';
import { emailConfigured, loadConfig, MAX_BODY_BYTES, VERSION } from './config.js';
import { corsHeaders, empty, isAllowedOrigin, json, text } from './http.js';
import { decideNotification, dispatchImmediate, sendAndRecord } from './notify/policy.js';
import { verifyWebhook } from './notify/resend.js';
import { crawlerAlertEmail, digestEmail, humanSessionEmail } from './notify/templates.js';
import * as storage from './storage.js';
import { hashIp } from './util/ip.js';
import { daysAgoIso } from './util/time.js';
import { isAcceptedContentType, readBodyLimited, validateEvent } from './validate.js';

const LOG_RATE_PER_MINUTE = 10;
const MAX_WEBHOOK_BYTES = 64 * 1024;

function serverMeta(request) {
  const cf = request.cf;
  return {
    ip: request.headers.get('cf-connecting-ip') || null,
    country: cf?.country || null,
    region: cf?.region || null,
    city: cf?.city || null,
    asn: Number.isFinite(cf?.asn) ? cf.asn : null,
    as_org: cf?.asOrganization || null,
    colo: cf?.colo || null,
  };
}

function log(level, msg, fields = {}) {
  console[level](JSON.stringify({ msg, ...fields }));
}

// ------------------------------------------------------------------- router

export default {
  async fetch(request, env, ctx) {
    const cfg = loadConfig(env);
    const url = new URL(request.url);
    const { method } = request;
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/track') {
        if (method === 'POST') return await handleTrack(request, env, ctx, cfg);
        if (method === 'OPTIONS') return handlePreflight(request, cfg);
      }
      if (path === '/health' && method === 'GET') {
        return json(200, { status: 'ok', version: VERSION, storage: Boolean(env.DB), email: emailConfigured(cfg) });
      }
      if (path === '/robots.txt' && method === 'GET') {
        return text(200, 'User-agent: *\nDisallow: /\n');
      }
      if (path === '/webhooks/resend' && method === 'POST' && cfg.resendWebhookSecret) {
        return await handleResendWebhook(request, env, cfg);
      }
      return handleProbe(request, env, ctx, cfg, path);
    } catch (err) {
      log('error', 'unhandled_error', { error: String(err?.stack || err), path, method });
      const origin = request.headers.get('Origin');
      return json(500, { error: 'internal_error' }, isAllowedOrigin(origin, cfg) ? corsHeaders(origin) : {});
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, Date.now()));
  },
};

// -------------------------------------------------------------- preflight

function handlePreflight(request, cfg) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, cfg)) return empty(403);
  return empty(204, corsHeaders(origin));
}

// -------------------------------------------------------------- tracking

async function handleTrack(request, env, ctx, cfg) {
  const started = Date.now();
  const receivedAt = new Date(started).toISOString();
  const origin = request.headers.get('Origin');
  const server = serverMeta(request);
  const userAgent = request.headers.get('user-agent') || '';
  const ipHash = await hashIp(server.ip, cfg.ipHashSalt);
  const db = env.DB;

  const reject = (status, reason, extra = {}) => {
    if (db) ctx.waitUntil(logRejected({ db, cfg, request, server, ipHash, userAgent, receivedAt, reason, now: started }));
    return json(status, { error: reason, ...extra }, isAllowedOrigin(origin, cfg) ? corsHeaders(origin) : {});
  };

  if (!isAllowedOrigin(origin, cfg)) return reject(403, 'origin_not_allowed');
  const cors = corsHeaders(origin);
  if (!db) {
    log('error', 'storage_unavailable', { hint: 'D1 binding "DB" is missing' });
    return json(503, { error: 'storage_unavailable' }, cors);
  }
  if (!isAcceptedContentType(request.headers.get('content-type'))) return reject(415, 'unsupported_content_type');

  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return reject(413, 'payload_too_large');
  if (!body.text) return reject(400, 'empty_payload');

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return reject(400, 'malformed_json');
  }
  const validation = validateEvent(payload, { now: started });
  if (!validation.ok) return reject(400, 'invalid_payload', { details: validation.errors });
  const event = validation.event;
  if (event.page_origin !== origin) return reject(400, 'page_url_origin_mismatch');

  const limit = await storage.rateLimitHit(db, 'track', ipHash || 'no-ip', cfg.rateLimitPerMinute, 60, started);
  if (!limit.allowed) {
    if (limit.count === cfg.rateLimitPerMinute + 1) ctx.waitUntil(logRejected({ db, cfg, request, server, ipHash, userAgent, receivedAt, reason: 'rate_limited', now: started }));
    return json(429, { error: 'rate_limited' }, { ...cors, 'Retry-After': '60' });
  }

  const classification = await classifyRequest(
    { userAgent, headers: request.headers, cf: request.cf, ip: server.ip, jsExecuted: true, client: { automation: event.automation } },
    { verify: cfg.verifyCrawlers }
  );
  const ua = parseUserAgent(userAgent, { mobile: request.headers.get('sec-ch-ua-mobile') });
  const cfBot = cloudflareBotSignals(request.cf);
  const isHuman = classification.category === CATEGORY.HUMAN;

  if (isHuman && (await storage.isDuplicateSessionView(db, event))) {
    return json(200, { status: 'duplicate' }, cors);
  }

  const inserted = await storage.insertEvent(db, {
    event_id: event.event_id,
    event_type: event.event_type,
    session_id: event.session_id,
    view_id: event.view_id,
    client_ts: event.timestamp,
    received_at: receivedAt,
    processing_ms: Date.now() - started,
    clock_skew_ms: event.clock_skew_ms,
    page_url: event.page_url,
    page_path: event.page_path,
    referrer: event.referrer,
    referrer_domain: event.referrer_domain,
    screen: event.screen,
    timezone: event.timezone,
    language: event.language,
    is_returning: event.returning,
    visible_ms: event.event_type === 'page_view' ? null : event.visible_ms,
    automation_flag: event.automation,
    category: classification.category,
    bot_name: classification.bot_name,
    operator: classification.operator,
    detection_method: classification.detection_method,
    confidence: classification.confidence,
    verification_status: classification.verification_status,
    verification_method: classification.verification_method,
    signals: classification.signals,
    user_agent: userAgent,
    browser: ua.browser,
    os: ua.os,
    device: ua.device,
    ip: server.ip,
    ip_hash: ipHash,
    country: server.country,
    region: server.region,
    city: server.city,
    asn: server.asn,
    as_org: server.as_org,
    colo: server.colo,
    cf_bot_score: cfBot.score,
    cf_verified_bot: cfBot.verifiedBot,
    origin,
  });
  if (!inserted) return json(200, { status: 'duplicate' }, cors);

  let isNewSession = false;
  if (isHuman) {
    if (event.event_type === 'page_view') {
      const s = await storage.upsertSessionForView(db, {
        session_id: event.session_id,
        received_at: receivedAt,
        client_ts: event.timestamp,
        page_path: event.page_path,
        referrer: event.referrer,
        referrer_domain: event.referrer_domain,
        returning: event.returning,
        confidence: classification.confidence,
        browser: ua.browser,
        os: ua.os,
        device: ua.device,
        country: server.country,
        region: server.region,
        city: server.city,
        ip_hash: ipHash,
      });
      isNewSession = s.isNew;
    } else {
      await storage.applyPageExit(db, { ...event, client_ts: event.timestamp, received_at: receivedAt });
    }
  } else {
    await storage.insertCrawlerLog(db, crawlerLogRow({ kind: 'event', request, server, ipHash, userAgent, receivedAt, classification, cfBot, event }));
  }

  const decision = decideNotification({ classification, eventType: event.event_type, isNewSession, cfg });
  let notification = { status: decision.action, reason: decision.reason };
  if (decision.action === 'immediate') {
    notification = await dispatchImmediate({
      db,
      cfg,
      ctx,
      now: started,
      receivedAt,
      decisionInput: { classification, ipHash, sessionId: event.session_id, eventId: event.event_id, pagePath: event.page_path },
      buildEmail: () =>
        isHuman
          ? humanSessionEmail({ event, classification, ua, server, cfBot, receivedAt })
          : crawlerAlertEmail({ event, classification, server, cfBot, receivedAt, kind: 'event' }),
    });
  }

  log('log', 'event_accepted', {
    event_id: event.event_id,
    event_type: event.event_type,
    category: classification.category,
    bot_name: classification.bot_name,
    confidence: classification.confidence,
    new_session: isNewSession,
    notification: notification.status,
    notification_reason: notification.reason,
    processing_ms: Date.now() - started,
  });
  return json(202, { status: 'accepted' }, cors);
}

function crawlerLogRow({ kind, request, server, ipHash, userAgent, receivedAt, classification, cfBot, event = null, reason = null }) {
  return {
    received_at: receivedAt,
    kind,
    method: request.method,
    request_url: request.url.slice(0, 1024),
    page_path: event?.page_path ?? null,
    event_id: event?.event_id ?? null,
    reason,
    user_agent: userAgent.slice(0, 1024),
    ip: server.ip,
    ip_hash: ipHash,
    referrer: (event?.referrer || request.headers.get('referer') || '').slice(0, 1024) || null,
    category: classification?.category ?? null,
    bot_name: classification?.bot_name ?? null,
    operator: classification?.operator ?? null,
    purpose: classification?.purpose ?? null,
    detection_method: classification?.detection_method ?? null,
    confidence: classification?.confidence ?? null,
    verification_status: classification?.verification_status ?? null,
    verification_method: classification?.verification_method ?? null,
    verification_detail: classification?.verification_detail ?? null,
    cf_bot_score: cfBot.score,
    cf_verified_bot: cfBot.verifiedBot,
    asn: server.asn,
    as_org: server.as_org,
    country: server.country,
    city: server.city,
  };
}

async function logRejected({ db, cfg, request, server, ipHash, userAgent, receivedAt, reason, now }) {
  try {
    const limit = await storage.rateLimitHit(db, 'log', ipHash || 'no-ip', LOG_RATE_PER_MINUTE, 60, now);
    if (!limit.allowed) return;
    const classification = await classifyRequest(
      { userAgent, headers: request.headers, cf: request.cf, ip: server.ip, jsExecuted: false },
      { verify: false }
    );
    await storage.insertCrawlerLog(db, crawlerLogRow({ kind: 'rejected', request, server, ipHash, userAgent, receivedAt, classification, cfBot: cloudflareBotSignals(request.cf), reason }));
  } catch (err) {
    log('error', 'reject_log_failed', { error: String(err), reason });
  }
}

// ----------------------------------------------------------------- probes

function handleProbe(request, env, ctx, cfg, path) {
  const now = Date.now();
  if (env.DB) {
    ctx.waitUntil(
      (async () => {
        try {
          const server = serverMeta(request);
          const ipHash = await hashIp(server.ip, cfg.ipHashSalt);
          const limit = await storage.rateLimitHit(env.DB, 'log', ipHash || 'no-ip', LOG_RATE_PER_MINUTE, 60, now);
          if (!limit.allowed) return;
          const userAgent = request.headers.get('user-agent') || '';
          const classification = await classifyRequest(
            { userAgent, headers: request.headers, cf: request.cf, ip: server.ip, jsExecuted: false },
            { verify: cfg.verifyCrawlers }
          );
          await storage.insertCrawlerLog(
            env.DB,
            crawlerLogRow({ kind: 'probe', request, server, ipHash, userAgent, receivedAt: new Date(now).toISOString(), classification, cfBot: cloudflareBotSignals(request.cf), reason: `${request.method} ${path}` })
          );
        } catch (err) {
          log('error', 'probe_log_failed', { error: String(err) });
        }
      })()
    );
  }
  if (request.method === 'GET') return json(404, { error: 'not_found' });
  return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, OPTIONS' });
}

// ---------------------------------------------------------- resend webhook

const WEBHOOK_STATUS = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.delivery_delayed': 'delayed',
  'email.complained': 'complained',
};

async function handleResendWebhook(request, env, cfg) {
  const body = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) return json(413, { error: 'payload_too_large' });
  if (!(await verifyWebhook(cfg.resendWebhookSecret, request.headers, body.text))) return json(401, { error: 'invalid_signature' });
  if (!env.DB) return json(503, { error: 'storage_unavailable' });

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return json(400, { error: 'malformed_json' });
  }
  const resendId = payload?.data?.email_id;
  if (!resendId) return json(200, { status: 'ignored' });

  const at = payload.created_at || new Date().toISOString();
  const fields = { last_webhook_type: String(payload.type).slice(0, 64), last_webhook_at: at };
  const status = WEBHOOK_STATUS[payload.type];
  if (status) fields.status = status;
  if (status === 'delivered') fields.delivered_at = at;
  const changed = await storage.updateNotificationByResendId(env.DB, resendId, fields);
  return json(200, { status: changed ? 'updated' : 'unknown_email' });
}

// --------------------------------------------------------------- scheduled

export async function runScheduled(env, now, { fetchImpl } = {}) {
  const cfg = loadConfig(env);
  if (!env.DB) {
    log('error', 'scheduled_without_storage');
    return { digest: 'skipped_no_storage' };
  }
  const out = {};
  try {
    out.digest = cfg.digestEnabled ? await runDigest(env.DB, cfg, now, fetchImpl) : 'disabled';
  } catch (err) {
    out.digest = 'error';
    log('error', 'digest_failed', { error: String(err?.stack || err) });
  }
  try {
    await storage.applyRetention(env.DB, {
      ipCutoffIso: daysAgoIso(now, cfg.ipRetentionDays),
      eventCutoffIso: daysAgoIso(now, cfg.eventRetentionDays),
      rateLimitCutoffSec: Math.floor(now / 1000) - 2 * 3600,
    });
    out.retention = 'ok';
  } catch (err) {
    out.retention = 'error';
    log('error', 'retention_failed', { error: String(err) });
  }
  return out;
}

async function runDigest(db, cfg, now, fetchImpl) {
  const untilIso = new Date(now).toISOString();
  const sinceIso = (await storage.getMeta(db, 'last_digest_until')) || daysAgoIso(now, 1);
  const data = await storage.digestData(db, sinceIso, untilIso);
  const empty = !data.sessions.length && !data.crawlers.length && !data.probes.length && !data.rejected.length && !data.failures.length;
  if (empty) {
    await storage.setMeta(db, 'last_digest_until', untilIso);
    return 'nothing_to_report';
  }
  const { subject, text: body } = digestEmail({ data, sinceIso, untilIso });
  const id = crypto.randomUUID();
  if (!emailConfigured(cfg)) {
    await storage.createNotification(db, { id, kind: 'digest', subject, status: 'skipped', error: 'email_not_configured', created_at: untilIso });
    await storage.setMeta(db, 'last_digest_until', untilIso);
    return 'skipped_email_not_configured';
  }
  await storage.createNotification(db, { id, kind: 'digest', subject, status: 'pending', created_at: untilIso });
  const result = await sendAndRecord({ db, cfg, id, subject, text: body, fetchImpl });
  // Only advance the window on success, so a failed digest is retried next run.
  if (result.ok) await storage.setMeta(db, 'last_digest_until', untilIso);
  return result.ok ? 'sent' : 'failed';
}

