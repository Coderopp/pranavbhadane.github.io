// Notification policy: decides whether an accepted event triggers an
// immediate email, is left for the digest, or is ignored. Separate from
// classification (what is it?) and from delivery (resend.js).

import { CATEGORY, CONFIDENCE_RANK } from '../classifier/categories.js';
import { emailConfigured } from '../config.js';
import * as storage from '../storage.js';
import { minutesAgoIso } from '../util/time.js';
import { sendEmail } from './resend.js';

/**
 * Pure policy decision (no I/O).
 * @returns {{ action: 'immediate'|'digest'|'none', reason: string }}
 */
export function decideNotification({ classification, eventType, isNewSession, cfg }) {
  const policy = cfg.policy[classification.category] || 'digest';
  if (policy === 'off') return { action: 'none', reason: 'policy_off' };
  if (policy === 'digest') return { action: 'digest', reason: 'policy_digest' };

  if (classification.category === CATEGORY.HUMAN) {
    if (eventType !== 'page_view') return { action: 'digest', reason: 'not_a_page_view' };
    if (!isNewSession) return { action: 'digest', reason: 'session_already_seen' };
    if (CONFIDENCE_RANK[classification.confidence] < CONFIDENCE_RANK[cfg.minHumanConfidence]) {
      return { action: 'digest', reason: 'below_min_confidence' };
    }
  }
  return { action: 'immediate', reason: 'policy_immediate' };
}

/**
 * Apply flood controls, record the notification, and send it in the
 * background. The event itself is already stored before this runs, so a
 * Resend failure never loses tracking data.
 */
export async function dispatchImmediate({ db, cfg, ctx, now, receivedAt, decisionInput, buildEmail, fetchImpl }) {
  const { classification, ipHash, sessionId, eventId, pagePath } = decisionInput;
  const isHuman = classification.category === CATEGORY.HUMAN;

  const hourCount = await storage.countImmediateSince(db, minutesAgoIso(now, 60));
  let skipReason = null;
  if (hourCount >= cfg.maxImmediateEmailsPerHour) skipReason = 'hourly_cap_reached';
  else if (isHuman && cfg.notifyIpCooldownMinutes > 0 && (await storage.hasRecentNotificationForIp(db, ipHash, minutesAgoIso(now, cfg.notifyIpCooldownMinutes)))) skipReason = 'ip_cooldown';
  else if (!isHuman && (await storage.hasRecentCrawlerAlert(db, classification.bot_name, pagePath, minutesAgoIso(now, cfg.crawlerAlertCooldownMinutes)))) skipReason = 'crawler_cooldown';
  else if (!emailConfigured(cfg)) skipReason = 'email_not_configured';

  const { subject, text } = buildEmail();
  const id = crypto.randomUUID();
  await storage.createNotification(db, {
    id,
    kind: 'immediate',
    category: classification.category,
    bot_name: classification.bot_name,
    page_path: pagePath,
    session_id: sessionId,
    event_id: eventId,
    ip_hash: ipHash,
    subject,
    status: skipReason ? 'skipped' : 'pending',
    error: skipReason,
    created_at: receivedAt,
  });
  if (skipReason) return { status: 'skipped', reason: skipReason, id };

  if (isHuman) await storage.markSessionNotified(db, sessionId);
  const delivery = sendAndRecord({ db, cfg, id, subject, text, fetchImpl });
  ctx.waitUntil(delivery);
  return { status: 'queued', id, delivery };
}

export async function sendAndRecord({ db, cfg, id, subject, text, fetchImpl }) {
  const result = await sendEmail(cfg, { subject, text, idempotencyKey: id }, { fetchImpl });
  const fields = result.ok
    ? { status: 'submitted', resend_id: result.id, http_status: result.status, submitted_at: new Date().toISOString(), error: null }
    : { status: 'failed', http_status: result.status, error: result.error };
  if (!result.ok) console.error(JSON.stringify({ msg: 'email_failed', notification_id: id, error: result.error, status: result.status }));
  try {
    await storage.updateNotification(db, id, fields);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'notification_update_failed', notification_id: id, error: String(err) }));
  }
  return result;
}
