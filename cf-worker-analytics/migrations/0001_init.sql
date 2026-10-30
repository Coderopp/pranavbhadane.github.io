-- Visitor intelligence schema (Cloudflare D1 / SQLite).
-- Timestamps are ISO-8601 UTC strings so they sort lexicographically.

-- Every validated page event, whatever its classification. event_id is the
-- primary key, which makes event deduplication atomic.
CREATE TABLE IF NOT EXISTS events (
  event_id            TEXT PRIMARY KEY,
  event_type          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  view_id             TEXT,
  client_ts           TEXT NOT NULL,      -- browser-reported event time
  received_at         TEXT NOT NULL,      -- Worker receipt time
  processing_ms       INTEGER,            -- Worker processing time until storage
  clock_skew_ms       INTEGER,            -- received_at - client_ts
  page_url            TEXT,
  page_path           TEXT,
  referrer            TEXT,
  referrer_domain     TEXT,
  screen              TEXT,
  timezone            TEXT,
  language            TEXT,
  is_returning        INTEGER,
  visible_ms          INTEGER,            -- page_view: max foreground time reported by page_exit
  automation_flag     INTEGER,
  category            TEXT NOT NULL,
  bot_name            TEXT,
  operator            TEXT,
  detection_method    TEXT,
  confidence          TEXT,
  verification_status TEXT,
  verification_method TEXT,
  signals             TEXT,
  user_agent          TEXT,
  browser             TEXT,
  os                  TEXT,
  device              TEXT,
  ip                  TEXT,               -- nulled after IP_RETENTION_DAYS
  ip_hash             TEXT,
  country             TEXT,
  region              TEXT,
  city                TEXT,
  asn                 INTEGER,
  as_org              TEXT,
  colo                TEXT,
  cf_bot_score        INTEGER,
  cf_verified_bot     INTEGER,
  origin              TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category, received_at);

-- One row per human browser candidate session.
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  first_client_ts     TEXT,
  last_client_ts      TEXT,
  landing_page        TEXT,
  last_page           TEXT,
  last_view_client_ts TEXT,
  page_views          INTEGER NOT NULL DEFAULT 0,
  pages_json          TEXT NOT NULL DEFAULT '[]',   -- navigation sequence (capped at 50)
  total_visible_ms    INTEGER NOT NULL DEFAULT 0,
  referrer            TEXT,
  referrer_domain     TEXT,
  is_returning        INTEGER,
  confidence          TEXT,
  browser             TEXT,
  os                  TEXT,
  device              TEXT,
  country             TEXT,
  region              TEXT,
  city                TEXT,
  ip_hash             TEXT,
  notified            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);

-- Crawler / automated / unclassified traffic, endpoint probes and rejected requests.
CREATE TABLE IF NOT EXISTS crawler_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at         TEXT NOT NULL,
  kind                TEXT NOT NULL,      -- 'event' | 'probe' | 'rejected'
  method              TEXT,
  request_url         TEXT,
  page_path           TEXT,
  event_id            TEXT,
  reason              TEXT,
  user_agent          TEXT,
  ip                  TEXT,               -- nulled after IP_RETENTION_DAYS
  ip_hash             TEXT,
  referrer            TEXT,
  category            TEXT,
  bot_name            TEXT,
  operator            TEXT,
  purpose             TEXT,
  detection_method    TEXT,
  confidence          TEXT,
  verification_status TEXT,
  verification_method TEXT,
  verification_detail TEXT,
  cf_bot_score        INTEGER,
  cf_verified_bot     INTEGER,
  asn                 INTEGER,
  as_org              TEXT,
  country             TEXT,
  city                TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawler_received ON crawler_log(received_at);
CREATE INDEX IF NOT EXISTS idx_crawler_bot      ON crawler_log(bot_name, received_at);

-- Every notification decision and its delivery lifecycle.
CREATE TABLE IF NOT EXISTS notifications (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,      -- 'immediate' | 'digest'
  category            TEXT,
  bot_name            TEXT,
  page_path           TEXT,
  session_id          TEXT,
  event_id            TEXT,
  ip_hash             TEXT,
  subject             TEXT,
  status              TEXT NOT NULL,      -- pending | submitted | failed | skipped | delivered | bounced | delayed | complained
  error               TEXT,
  http_status         INTEGER,
  resend_id           TEXT,
  created_at          TEXT NOT NULL,      -- decision time
  submitted_at        TEXT,               -- Resend accepted the request
  delivered_at        TEXT,               -- from Resend webhook (email.delivered)
  last_webhook_type   TEXT,
  last_webhook_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_resend  ON notifications(resend_id);
CREATE INDEX IF NOT EXISTS idx_notifications_ip      ON notifications(ip_hash, created_at);

-- Fixed-window counters for rate limiting (key embeds the window).
CREATE TABLE IF NOT EXISTS rate_limits (
  key                 TEXT PRIMARY KEY,
  window_start        INTEGER NOT NULL,
  count               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key                 TEXT PRIMARY KEY,
  value               TEXT
);
