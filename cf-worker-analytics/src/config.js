// Runtime configuration from Worker vars/secrets, with safe defaults.
// See docs/ANALYTICS.md for the full list.

import { CATEGORY, CONFIDENCE } from './classifier/categories.js';

export const VERSION = '2.0.0';

export const MAX_BODY_BYTES = 4096;

export const DEFAULT_NOTIFY_POLICY = Object.freeze({
  [CATEGORY.HUMAN]: 'immediate',
  [CATEGORY.SOCIAL]: 'digest',
  [CATEGORY.SEARCH]: 'digest',
  [CATEGORY.AI]: 'digest',
  [CATEGORY.AGENT]: 'digest',
  [CATEGORY.SCANNER]: 'digest',
  [CATEGORY.UNKNOWN]: 'digest',
});

const POLICY_VALUES = ['immediate', 'digest', 'off'];

function int(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loadConfig(env = {}) {
  const warnings = [];

  const policy = { ...DEFAULT_NOTIFY_POLICY };
  if (env.NOTIFY_POLICY) {
    try {
      const parsed = typeof env.NOTIFY_POLICY === 'string' ? JSON.parse(env.NOTIFY_POLICY) : env.NOTIFY_POLICY;
      for (const [k, v] of Object.entries(parsed)) {
        if (k in policy && POLICY_VALUES.includes(v)) policy[k] = v;
        else warnings.push(`NOTIFY_POLICY: ignored ${k}=${v}`);
      }
    } catch {
      warnings.push('NOTIFY_POLICY is not valid JSON; using defaults');
    }
  }

  const minHumanConfidence = Object.values(CONFIDENCE).includes(env.NOTIFY_MIN_HUMAN_CONFIDENCE)
    ? env.NOTIFY_MIN_HUMAN_CONFIDENCE
    : CONFIDENCE.LOW;

  if (!env.IP_HASH_SALT) warnings.push('IP_HASH_SALT secret is not set; IP hashes are unsalted');
  if (!env.RESEND_API_KEY) warnings.push('RESEND_API_KEY secret is not set; email notifications disabled');
  if (!env.TO_EMAIL) warnings.push('TO_EMAIL var is not set; email notifications disabled');

  return {
    allowedOrigins: list(env.ALLOWED_ORIGINS || 'https://coderopp.github.io'),
    allowLocalhost: env.ALLOW_LOCALHOST === 'true',
    toEmail: env.TO_EMAIL || null,
    fromEmail: env.FROM_EMAIL || 'Portfolio Analytics <onboarding@resend.dev>',
    resendApiKey: env.RESEND_API_KEY || null,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET || null,
    resendTimeoutMs: int(env.RESEND_TIMEOUT_MS, 8000, 1000, 30000),
    ipHashSalt: env.IP_HASH_SALT || null,
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 30, 1, 1000),
    maxImmediateEmailsPerHour: int(env.MAX_IMMEDIATE_EMAILS_PER_HOUR, 10, 0, 500),
    notifyIpCooldownMinutes: int(env.NOTIFY_IP_COOLDOWN_MINUTES, 30, 0, 1440),
    crawlerAlertCooldownMinutes: int(env.CRAWLER_ALERT_COOLDOWN_MINUTES, 60, 1, 10080),
    minHumanConfidence,
    ipRetentionDays: int(env.IP_RETENTION_DAYS, 30, 0, 365),
    eventRetentionDays: int(env.EVENT_RETENTION_DAYS, 180, 1, 3650),
    verifyCrawlers: env.VERIFY_CRAWLERS !== 'false',
    digestEnabled: env.DIGEST_ENABLED !== 'false',
    policy,
    warnings,
  };
}

export function emailConfigured(cfg) {
  return Boolean(cfg.resendApiKey && cfg.toEmail);
}
