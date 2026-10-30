// D1 persistence. D1 is a single-primary SQLite database: writes are
// serialised, so PRIMARY KEY / UPSERT give us atomic deduplication and
// counters without Durable Objects. (Read replication is not enabled; if it
// is turned on later, dedup reads must use the primary-session API.)

const PAGE_SEQUENCE_CAP = 50;
const SESSION_DUPLICATE_WINDOW_MS = 2000;

function sqlValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) || (v && typeof v === 'object')) return JSON.stringify(v);
  return v;
}

function insertStatement(db, table, row, { orIgnore = false } = {}) {
  const keys = Object.keys(row);
  const sql = `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return db.prepare(sql).bind(...keys.map((k) => sqlValue(row[k])));
}

// ---------------------------------------------------------------- rate limits

/** Fixed-window counter. Returns { allowed, count }. */
export async function rateLimitHit(db, scope, id, limit, windowSeconds, nowMs) {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  const key = `${scope}:${id}:${windowStart}`;
  const row = await db
    .prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, windowStart)
    .first();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count };
}

// --------------------------------------------------------------------- events

/** Returns true if the event was inserted, false if event_id already existed. */
export async function insertEvent(db, row) {
  const res = await insertStatement(db, 'events', row, { orIgnore: true }).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Same session, same page, within 2 s: a double-fired page_view, not a new view. */
export async function isDuplicateSessionView(db, event) {
  if (event.event_type !== 'page_view') return false;
  const row = await db
    .prepare('SELECT last_page, last_view_client_ts FROM sessions WHERE session_id = ?')
    .bind(event.session_id)
    .first();
  if (!row || row.last_page !== event.page_path || !row.last_view_client_ts) return false;
  return Math.abs(Date.parse(event.timestamp) - Date.parse(row.last_view_client_ts)) < SESSION_DUPLICATE_WINDOW_MS;
}

/**
 * Create or extend a human-candidate session for a page_view.
 * @returns {Promise<{ isNew: boolean, session: object }>}
 */
export async function upsertSessionForView(db, s) {
  const session = await db
    .prepare(
      `INSERT INTO sessions (
         session_id, first_seen_at, last_seen_at, first_client_ts, last_client_ts,
         landing_page, last_page, last_view_client_ts, page_views, pages_json,
         referrer, referrer_domain, is_returning, confidence, browser, os, device,
         country, region, city, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, json_array(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_client_ts = MAX(sessions.last_client_ts, excluded.last_client_ts),
         last_page = excluded.last_page,
         last_view_client_ts = excluded.last_view_client_ts,
         page_views = sessions.page_views + 1,
         pages_json = CASE WHEN json_array_length(sessions.pages_json) < ${PAGE_SEQUENCE_CAP}
                           THEN json_insert(sessions.pages_json, '$[#]', excluded.last_page)
                           ELSE sessions.pages_json END
       RETURNING *`
    )
    .bind(
      s.session_id, s.received_at, s.received_at, s.client_ts, s.client_ts,
      s.page_path, s.page_path, s.client_ts, s.page_path,
      s.referrer, s.referrer_domain, sqlValue(s.returning), s.confidence, s.browser, s.os, s.device,
      s.country, s.region, s.city, s.ip_hash
    )
    .first();
  return { isNew: session.page_views === 1, session };
}

/** Record foreground time reported by page_exit against its page_view. */
export async function applyPageExit(db, e) {
  await db.batch([
    db
      .prepare("UPDATE events SET visible_ms = MAX(COALESCE(visible_ms, 0), ?) WHERE event_id = ? AND session_id = ? AND event_type = 'page_view'")
      .bind(e.visible_ms, e.view_id, e.session_id),
    db
      .prepare(
        `UPDATE sessions SET
           last_seen_at = ?,
           last_client_ts = MAX(last_client_ts, ?),
           total_visible_ms = (SELECT COALESCE(SUM(visible_ms), 0) FROM events WHERE session_id = ? AND event_type = 'page_view')
         WHERE session_id = ?`
      )
      .bind(e.received_at, e.client_ts, e.session_id, e.session_id),
  ]);
}

export async function markSessionNotified(db, sessionId) {
  await db.prepare('UPDATE sessions SET notified = 1 WHERE session_id = ?').bind(sessionId).run();
}

// ---------------------------------------------------------------- crawler log

export async function insertCrawlerLog(db, row) {
  await insertStatement(db, 'crawler_log', row).run();
}

// -------------------------------------------------------------- notifications

export async function createNotification(db, row) {
  await insertStatement(db, 'notifications', row).run();
}

export async function updateNotification(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db
    .prepare(`UPDATE notifications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => sqlValue(fields[k])), id)
    .run();
}

export async function countImmediateSince(db, sinceIso) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'immediate' AND status != 'skipped' AND created_at >= ?")
    .bind(sinceIso)
    .first();
  return row?.n ?? 0;
}

export async function hasRecentNotificationForIp(db, ipHash, sinceIso) {
  if (!ipHash) return false;
  const row = await db
    .prepare("SELECT 1 AS hit FROM notifications WHERE kind = 'immediate' AND ip_hash = ? AND status != 'skipped' AND created_at >= ? LIMIT 1")
    .bind(ipHash, sinceIso)
    .first();
  return Boolean(row);
}

export async function hasRecentCrawlerAlert(db, botName, pagePath, sinceIso) {
  const row = await db
    .prepare("SELECT 1 AS hit FROM notifications WHERE kind = 'immediate' AND bot_name IS ? AND page_path IS ? AND created_at >= ? LIMIT 1")
    .bind(botName, pagePath, sinceIso)
    .first();
  return Boolean(row);
}

export async function updateNotificationByResendId(db, resendId, fields) {
  const keys = Object.keys(fields);
  const res = await db
    .prepare(`UPDATE notifications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE resend_id = ?`)
    .bind(...keys.map((k) => sqlValue(fields[k])), resendId)
    .run();
  return res.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------- meta

export async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

export async function setMeta(db, key, value) {
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

// -------------------------------------------------------------------- digest

export async function digestData(db, sinceIso, untilIso) {
  const [sessions, crawlers, probes, rejected, failures] = await Promise.all([
    db
      .prepare(
        `SELECT session_id, first_seen_at, last_seen_at, first_client_ts, last_client_ts, landing_page, page_views,
                pages_json, total_visible_ms, referrer_domain, is_returning, confidence, browser, os, device, country, city, notified
         FROM sessions WHERE last_seen_at >= ? AND last_seen_at < ? ORDER BY first_seen_at LIMIT 100`
      )
      .bind(sinceIso, untilIso)
      .all(),
    db
      .prepare(
        `SELECT category, COALESCE(bot_name, '(unnamed)') AS bot_name, operator, verification_status,
                confidence, COALESCE(page_path, '-') AS page_path, COUNT(*) AS n, MIN(received_at) AS first_at,
                MAX(received_at) AS last_at, MAX(as_org) AS as_org, MAX(asn) AS asn
         FROM crawler_log WHERE kind = 'event' AND received_at >= ? AND received_at < ?
         GROUP BY category, bot_name, verification_status, confidence, page_path ORDER BY n DESC LIMIT 100`
      )
      .bind(sinceIso, untilIso)
      .all(),
    db
      .prepare(
        `SELECT category, COALESCE(bot_name, '(unnamed)') AS bot_name, method, verification_status, COUNT(*) AS n,
                MIN(received_at) AS first_at, MAX(received_at) AS last_at, MAX(as_org) AS as_org
         FROM crawler_log WHERE kind = 'probe' AND received_at >= ? AND received_at < ?
         GROUP BY category, bot_name, method, verification_status ORDER BY n DESC LIMIT 50`
      )
      .bind(sinceIso, untilIso)
      .all(),
    db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM crawler_log WHERE kind = 'rejected' AND received_at >= ? AND received_at < ?
         GROUP BY reason ORDER BY n DESC LIMIT 20`
      )
      .bind(sinceIso, untilIso)
      .all(),
    db
      .prepare(
        `SELECT kind, subject, status, error, created_at FROM notifications
         WHERE status IN ('failed', 'bounced', 'complained') AND created_at >= ? AND created_at < ? ORDER BY created_at LIMIT 20`
      )
      .bind(sinceIso, untilIso)
      .all(),
  ]);
  return {
    sessions: sessions.results || [],
    crawlers: crawlers.results || [],
    probes: probes.results || [],
    rejected: rejected.results || [],
    failures: failures.results || [],
  };
}

// ----------------------------------------------------------------- retention

export async function applyRetention(db, { ipCutoffIso, eventCutoffIso, rateLimitCutoffSec }) {
  await db.batch([
    db.prepare('UPDATE events SET ip = NULL WHERE ip IS NOT NULL AND received_at < ?').bind(ipCutoffIso),
    db.prepare('UPDATE crawler_log SET ip = NULL WHERE ip IS NOT NULL AND received_at < ?').bind(ipCutoffIso),
    db.prepare('DELETE FROM events WHERE received_at < ?').bind(eventCutoffIso),
    db.prepare('DELETE FROM crawler_log WHERE received_at < ?').bind(eventCutoffIso),
    db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').bind(eventCutoffIso),
    db.prepare('DELETE FROM notifications WHERE created_at < ?').bind(eventCutoffIso),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(rateLimitCutoffSec),
  ]);
}
