// Test harness: a D1-compatible shim over better-sqlite3 (same SQLite engine
// family D1 uses), a programmable global fetch mock, and request builders.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8');

function toSqlite(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class D1Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new D1Statement(this.db, this.sql, args.map(toSqlite));
  }
  _exec() {
    const stmt = this.db.prepare(this.sql);
    if (stmt.reader) return { rows: stmt.all(...this.args), changes: 0 };
    const info = stmt.run(...this.args);
    return { rows: [], changes: info.changes, lastRowId: Number(info.lastInsertRowid) };
  }
  async first(column) {
    const { rows } = this._exec();
    const row = rows[0] ?? null;
    return column && row ? row[column] : row;
  }
  async all() {
    const { rows } = this._exec();
    return { results: rows, success: true, meta: {} };
  }
  async run() {
    const r = this._exec();
    return { results: r.rows, success: true, meta: { changes: r.changes || (r.rows.length ? r.rows.length : 0), last_row_id: r.lastRowId } };
  }
}

export function createD1() {
  const db = new Database(':memory:');
  db.exec(MIGRATION);
  return {
    raw: db,
    prepare(sql) {
      return new D1Statement(db, sql);
    },
    async batch(statements) {
      const tx = db.transaction(() => statements.map((s) => s._exec()));
      return tx().map((r) => ({ results: r.rows, success: true, meta: { changes: r.changes } }));
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

// ---------------------------------------------------------------- fetch mock

export function installFetchMock() {
  const original = globalThis.fetch;
  const calls = [];
  const handlers = [];
  const mock = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    for (const h of handlers) {
      if (h.match(url)) return h.respond(url, init);
    }
    throw new Error(`unmocked fetch: ${url}`);
  };
  globalThis.fetch = mock;
  return {
    calls,
    on(match, respond) {
      handlers.unshift({ match: typeof match === 'string' ? (u) => u.startsWith(match) : match, respond });
    },
    resendCalls() {
      return calls.filter((c) => c.url.startsWith('https://api.resend.com'));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function resendOk(id = 'resend-msg-1') {
  return async () => new Response(JSON.stringify({ id }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------- env / ctx

export const ORIGIN = 'https://coderopp.github.io';
export const ENDPOINT = 'https://blog-analytics-worker.pranavbhadane279.workers.dev';

export function makeEnv(overrides = {}) {
  return {
    DB: createD1(),
    TO_EMAIL: 'owner@example.com',
    RESEND_API_KEY: 're_test_key',
    IP_HASH_SALT: 'test-salt',
    ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  };
}

export function makeCtx() {
  const promises = [];
  return {
    promises,
    waitUntil(p) {
      promises.push(Promise.resolve(p).catch(() => {}));
    },
    async settle() {
      while (promises.length) await promises.shift();
    },
  };
}

// ----------------------------------------------------------------- requests

export const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  headlessChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
  facebookExternalHit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  metaWebIndexer: 'meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  metaExternalAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexitybot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  unknown: 'SomethingWeird/0.1',
};

export const BROWSER_HEADERS = {
  'accept-language': 'en-IN,en;q=0.9',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-dest': 'empty',
};

export const CF_INDIA = { country: 'IN', region: 'Maharashtra', city: 'Pune', asn: 24560, asOrganization: 'Bharti Airtel', colo: 'BOM' };

let counter = 0;
export function newId(prefix = 'evt') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString().padStart(8, '0')}`;
}

export function pageView(overrides = {}) {
  const path = overrides.page_path ?? '/pranavbhadane.github.io/';
  return {
    v: 2,
    event_id: newId(),
    event_type: 'page_view',
    timestamp: new Date().toISOString(),
    page_url: `${ORIGIN}${path}`,
    page_path: path,
    referrer: 'https://www.linkedin.com/feed/',
    session_id: 'session-aaaaaaaaaaaaaaaa',
    session_new: true,
    returning: false,
    screen: '1920x1080',
    timezone: 'Asia/Kolkata',
    language: 'en-IN',
    automation: false,
    ...overrides,
  };
}

export function makeRequest({ method = 'POST', path = '/track', body, rawBody, ua = UA.chromeWindows, origin = ORIGIN, headers = {}, cf = CF_INDIA, ip = '49.36.10.20', contentType = 'text/plain' } = {}) {
  const h = new Headers({ ...BROWSER_HEADERS, ...headers });
  if (ua !== null) h.set('user-agent', ua);
  if (origin) h.set('origin', origin);
  if (ip) h.set('cf-connecting-ip', ip);
  const init = { method, headers: h };
  if (method !== 'GET' && method !== 'HEAD') {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined) {
      init.body = payload;
      if (contentType) h.set('content-type', contentType);
    }
  }
  const req = new Request(`${ENDPOINT}${path}`, init);
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  return req;
}

export function count(env, table, where = '1=1', ...args) {
  return env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
}
