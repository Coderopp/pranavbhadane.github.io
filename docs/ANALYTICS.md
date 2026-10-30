# Portfolio visitor analytics

Privacy-conscious visitor tracking for the GitHub Pages portfolio. A small
client script (`analytics.js`) sends validated page events to a Cloudflare
Worker (`cf-worker-analytics/`). The Worker classifies each request (human
browser candidate, crawler, automation or unknown), stores it in D1, and sends
email through Resend according to a notification policy.

The system separates four kinds of information and labels them in every email:

| Kind | Examples | Trust |
|---|---|---|
| Browser-reported | User-Agent, screen, timezone, language, returning flag, foreground time | Can be spoofed |
| Server-observed | IP, Cloudflare geolocation, ASN, data center, bot score | Observed by Cloudflare; geolocation is approximate |
| Verified | Crawler identity confirmed by Cloudflare, published IP ranges, FCrDNS or ASN | Strong |
| Inferred | Category and confidence | A judgement, never proof |

It does **not** identify individuals, employers or professions, and it never
labels anyone a "verified human" or a recruiter.

---

## 1. Audit of the previous implementation (v1)

### Architecture and request lifecycle

1. All 17 HTML pages loaded `analytics.js` synchronously in `<head>` (render-blocking).
2. The script created a `sessionStorage` session ID (falling back to `Math.random`) and POSTed `{path, sessionId, isNewSession}` to `…workers.dev/track`.
3. The Worker accepted **any method on any path**. For a non-POST request it skipped the body and used `path = "Unknown"`.
4. It emailed, through Resend, **on every request**, with no validation, deduplication, rate limiting, storage or bot detection.
5. It returned `{"status":"tracked"}` with `Access-Control-Allow-Origin: *`.

Google Analytics (`gtag.js`, `G-FVXG5JHXW7`) is also loaded on 7 of the 17 pages. It is independent of this system and was left unchanged.

### Bugs

| # | Bug | Effect |
|---|---|---|
| B1 | Any GET or HEAD to the Worker sent an email | **"Page Visited: Unknown" emails.** Crawlers read `analytics.js`, find the Worker URL and fetch it. Confirmed: `curl https://blog-analytics-worker…workers.dev/` returns `200 {"status":"tracked"}`. |
| B2 | No method or path routing | `GET /anything` was treated as a visit |
| B3 | Every page view emailed, not every session | Inbox noise; one visitor reading 5 pages produced 5 emails |
| B4 | No bot classification | Meta, Google and AI crawlers that render JavaScript looked like visitors |
| B5 | `request.json()` threw on bad bodies, returning 500 | Malformed requests surfaced as server errors |
| B6 | The email timestamp was Worker time, labelled as visit time | Misleading timing |
| B7 | `res.json()` on the Resend response was logged as "Email sent" even on 4xx | Delivery failures were invisible |
| B8 | `isNewSession` and the session ID were trusted from the client without validation | Arbitrary strings appeared in email |
| B9 | The script was synchronous in `<head>` | Delayed first render on every page |

### Security issues

| # | Issue | Severity |
|---|---|---|
| S1 | **The Resend API key was committed** to `wrangler.toml` (added in `70aa0df`, removed in `c073ee7`). It is still in the public git history. | **High — rotate the key** |
| S2 | `Access-Control-Allow-Origin: *` and no Origin check | Anyone could submit events |
| S3 | No payload limit, rate limit or email cap | Anyone could flood your inbox and exhaust the Resend quota |
| S4 | Raw User-Agent, referrer and path were interpolated into email with no length limit | Spam and abuse vector |
| S5 | `.wrangler/cache/wrangler-account.json` (account ID and email) was committed | Information disclosure (low) |

### Missing functionality

There was no storage, so no history, no navigation paths and no digest. There was no crawler log, no opt-out, no privacy controls or retention policy, no tests, and no documentation.

### Other observations

- `robots.txt` lives at `/pranavbhadane.github.io/robots.txt`. Crawlers only read `https://coderopp.github.io/robots.txt` (from the `coderopp.github.io` repo, if it exists), so this file has **no effect**.
- The wrangler CLI on the dev machine is logged into `pranav.bhadane.iitkgp@gmail.com`'s account. The Worker lives in account `a0ebaac6…` (`pranavbhadane279@gmail.com`). `account_id` is now pinned in `wrangler.toml` so a deploy cannot go to the wrong account.

### Backward compatibility

- The v1 payload `{path, sessionId, isNewSession}` is now **rejected** (400). Browsers that cached the old `analytics.js` (GitHub Pages sets `max-age=600`) stop being tracked for at most about 10 minutes after deploy.
- The Worker name, URL and `/track` path are unchanged, so no DNS or URL changes are needed.

---

## 2. Why Meta crawlers appeared

- `facebookexternalhit` and `Facebot` fetch a page when its URL is **shared or previewed** on Facebook, Instagram, Messenger, Threads or WhatsApp (by anyone, including you), and they re-scrape periodically to refresh previews. They do not run JavaScript, so they never trigger `analytics.js`. What reached the Worker was their direct fetch of the Worker URL, which they discovered in `analytics.js` (bug B1).
- `meta-webindexer` indexes pages for Meta AI search. `meta-externalagent` crawls for AI training. Some Meta and Google crawlers render pages and so *can* execute the script.
- Repeated Meta requests for one article usually mean the article's URL was shared or posted (the site links to Instagram), or that Meta is refreshing its index. It is **not evidence of recruitment screening**, and the system does not interpret it that way.

The Worker now logs every Meta request separately with User-Agent, IP, ASN verification (AS32934), Cloudflare bot fields, requested URL, method, referrer, timestamp and confidence. Meta requests appear only in the digest.

---

## 3. Architecture

```
Portfolio page ──analytics.js──► POST /track (text/plain JSON, ≤4 KB)
                                        │
                     Origin allowlist ──┤── 403
                 content-type / size ───┤── 415 / 413
                 JSON + schema v2 ──────┤── 400 (logged as "rejected")
            per-IP rate limit (D1) ─────┤── 429
                                        ▼
                      classifier/ (UA signatures → verification → heuristics)
                                        │
                 dedup: event_id PK + same-page-within-2s check (D1)
                                        │
         ┌──────────────────────────────┼──────────────────────────────┐
  human browser candidate        crawler / automated             unknown
  events + sessions              events + crawler_log            events + crawler_log
         │                              │                              │
         └──────────── notify/policy.js (immediate | digest | off) ────┘
                                        │
     flood controls: 1 email/session, per-IP cooldown, hourly cap, crawler cooldown
                                        │
                 notifications row ──► Resend (waitUntil) ──► status + message id
                                                         ◄── webhook: delivered_at

Any other request (GET /, HEAD, PUT …) ──► 404/405, logged as "probe", never a visit
Cron 03:30 UTC (09:00 IST) ──► digest email + retention purge
```

### Files

| File | Responsibility |
|---|---|
| `analytics.js` | Client: session handling, opt-out, page_view and page_exit events |
| `cf-worker-analytics/src/index.js` | Router, request pipeline, probe logging, webhook, cron |
| `src/validate.js` | Strict schema v2 validation and bounded body reading |
| `src/http.js` | CORS and response helpers |
| `src/config.js` | Vars and secrets with defaults |
| `src/classifier/` | **Separate classification module**: `signatures.js` (configurable database), `verify.js` (Cloudflare, IP ranges, FCrDNS, ASN), `useragent.js` (reported browser/OS/device), `index.js` (decision logic) |
| `src/storage.js` | D1 queries |
| `src/notify/` | `policy.js` (decision and flood control), `resend.js` (API client and webhook signatures), `templates.js` (emails) |
| `migrations/0001_init.sql` | D1 schema |
| `test/` | `node:test` suites (classifier, worker, client) |

### Classification output

Every request gets `category`, `bot_name`, `operator`, `purpose`, `detection_method`, `confidence`, `verification_status`, `verification_method`, `signals` and `raw_user_agent`.

| Category | How it is assigned |
|---|---|
| Human browser candidate | Browser User-Agent **and** the page script ran **and** no bot signal. Confidence is Medium by default. It drops to Low on a missing Accept-Language, missing Sec-Fetch headers, a client-hint mismatch or a hosting-provider ASN. It rises to High only with a Cloudflare bot score of 80 or more. |
| Social / Search / AI crawler, automated agent, scanner | Signature match. **Verified** if identity is confirmed, **High** if the UA matches but identity is unverified. |
| Unknown | No signature and not a browser. Also any UA claiming a known crawler whose network origin does not match (`verification_status = failed`, flagged as possible spoofing). Also a browser UA hitting the endpoint directly. |

Verification order: Cloudflare `botManagement.verifiedBot` (Bot Management plans only) → operator IP lists (Google, Bing, OpenAI, Perplexity) → forward-confirmed reverse DNS over DoH (Google, Bing, Apple, Yandex, Baidu, Amazon, Petal) → ASN (Meta AS32934). A failed lookup yields `unverified`, never `failed`.

Rules the classifier enforces: no "verified human"; a hosting-provider IP is not proof of automation; a residential IP is not proof of a human; in-app browsers (Instagram, Facebook, LinkedIn) are not crawlers.

---

## 4. Environment variables

Set non-secret **vars** in `wrangler.toml`. Set **secrets** with `wrangler secret put NAME`.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `RESEND_API_KEY` | secret | – | Resend API key. Without it, events are stored and emails are skipped. |
| `IP_HASH_SALT` | secret | – (warns) | Salt for pseudonymous IP hashes used in rate limits and cooldowns. Use a long random string. |
| `RESEND_WEBHOOK_SECRET` | secret, optional | – | `whsec_…` signing secret. Enables `POST /webhooks/resend` for delivery timestamps. |
| `TO_EMAIL` | var | – | Recipient. While sending from `onboarding@resend.dev`, this must be the Resend account owner's address. |
| `FROM_EMAIL` | var | `Portfolio Analytics <onboarding@resend.dev>` | Sender. `onboarding@resend.dev` can only send to the Resend account owner's address. Use a verified domain otherwise. |
| `ALLOWED_ORIGINS` | var | `https://coderopp.github.io` | Comma-separated Origin allowlist |
| `ALLOW_LOCALHOST` | var | `false` | Allow `http://localhost:*` origins (dev only) |
| `RATE_LIMIT_PER_MINUTE` | var | `30` | Accepted events per IP per minute |
| `MAX_IMMEDIATE_EMAILS_PER_HOUR` | var | `10` | Global cap on immediate emails |
| `NOTIFY_IP_COOLDOWN_MINUTES` | var | `5` (code default `30`) | At most one session email per IP in this window |
| `CRAWLER_ALERT_COOLDOWN_MINUTES` | var | `60` | Per bot and page, if a crawler category is set to `immediate` |
| `NOTIFY_MIN_HUMAN_CONFIDENCE` | var | `Low confidence` | Minimum confidence for an immediate session email |
| `NOTIFY_POLICY` | var (JSON) | humans `immediate`, all others `digest` | Per-category `immediate`, `digest` or `off` |
| `IP_RETENTION_DAYS` | var | `30` | Full IPs are nulled after this. Hashes remain. |
| `EVENT_RETENTION_DAYS` | var | `180` | All rows are deleted after this |
| `VERIFY_CRAWLERS` | var | `true` | Enable IP-range and FCrDNS lookups |
| `DIGEST_ENABLED` | var | `true` | Daily digest |
| `RESEND_TIMEOUT_MS` | var | `8000` | Resend request timeout |
| `DB` | D1 binding | – | Required. Without it, `/track` returns 503 and sends no email. |

---

## 5. Deployment guide

All commands run from `cf-worker-analytics/`.

```bash
# 0. Log in to the account that owns the Worker (pranavbhadane279@gmail.com).
wrangler logout && wrangler login
wrangler whoami   # must list account a0ebaac6603921ccb1f99ca87d3b93f5

# 1. Rotate the leaked Resend key: revoke it at resend.com/api-keys, then create a new one.
wrangler secret put RESEND_API_KEY        # paste the NEW key
openssl rand -hex 32 | wrangler secret put IP_HASH_SALT

# 2. Create the database, then put the printed id into wrangler.toml (database_id).
wrangler d1 create portfolio-analytics
npm run db:migrate:remote

# 3. Test, then deploy.
npm ci && npm test
wrangler deploy

# 4. Verify the deployed version.
curl -s https://blog-analytics-worker.pranavbhadane279.workers.dev/health
#   → {"status":"ok","version":"2.0.0","storage":true,"email":true}
curl -s -o /dev/null -w "%{http_code}\n" https://blog-analytics-worker.pranavbhadane279.workers.dev/
#   → 404 (previously 200 + an email)

# 5. Optional: delivery timestamps. In Resend → Webhooks, add
#    https://blog-analytics-worker.pranavbhadane279.workers.dev/webhooks/resend
#    for email.delivered / bounced / delivery_delayed / complained, then:
wrangler secret put RESEND_WEBHOOK_SECRET
```

Then push the site changes (`analytics.js` and the `defer` attribute on the 17 pages) to `main`. Confirm that GitHub Pages serves the new script:

```bash
curl -s https://coderopp.github.io/pranavbhadane.github.io/analytics.js | head -3   # "Portfolio analytics client (schema v2)"
```

Open the site in a normal browser. The response to the `/track` POST should be `202` and the session email should arrive. Run `wrangler tail` to watch `event_accepted` logs.

**Deploy the Worker first, then the site.** The new Worker rejects the old payload, but the old Worker happily accepts the new one, so this order loses the least data.

### Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev        # http://localhost:8787, accepts Origin https://coderopp.github.io and localhost
```

### Useful queries

```bash
wrangler d1 execute portfolio-analytics --remote --command "SELECT first_seen_at, landing_page, page_views, pages_json, referrer_domain, city, country, confidence FROM sessions ORDER BY first_seen_at DESC LIMIT 20"
wrangler d1 execute portfolio-analytics --remote --command "SELECT bot_name, verification_status, kind, COUNT(*) n FROM crawler_log GROUP BY 1,2,3 ORDER BY n DESC"
wrangler d1 execute portfolio-analytics --remote --command "SELECT created_at, kind, status, error, submitted_at, delivered_at FROM notifications ORDER BY created_at DESC LIMIT 20"
```

---

## 6. Storage, consistency and timestamps

- **D1** is the only new infrastructure. It has a single primary that serialises writes. That makes the `event_id` primary key and the `INSERT … ON CONFLICT … RETURNING` counters atomic, so deduplication and rate limits need no Durable Objects or KV. Read replication is off. If it is enabled later, use the D1 Sessions API with `first-primary` for the dedup reads.
- No in-memory deduplication. The only isolate cache is the crawler IP-range list, a performance optimisation backed by the Cache API.
- Timestamps are recorded independently: `events.client_ts` (browser clock), `events.received_at` (Worker), `events.processing_ms`, `events.clock_skew_ms`, `notifications.created_at` (decision), `notifications.submitted_at` (Resend accepted, with `resend_id`), and `notifications.delivered_at` (Resend webhook). Emails show UTC and IST.

## 7. Privacy

- The script collects: page URL (campaign parameters only, no hash), path, the referrer's origin and path (no query), a random session ID, a "seen before" flag, screen size, timezone, language, `navigator.webdriver`, and foreground time. It collects no cookies, form data, persistent visitor ID or fingerprinting.
- **Opt out:** `?analytics=off` (persisted in `localStorage`; `?analytics=on` re-enables). Global Privacy Control and Do Not Track are honoured. Nothing is tracked outside `coderopp.github.io`.
- IPs are kept for 30 days for abuse investigation, then nulled. Salted hashes and all other rows are deleted after 180 days. Both periods are configurable.
- Consider adding a one-line privacy note to the site footer that mentions the opt-out link. Google Analytics, which is loaded separately, has its own consent implications.

## 8. Known limitations

- **The Worker only sees what reaches it.** Crawlers that fetch HTML without running JavaScript (most link-preview bots) never trigger `analytics.js`. Seeing every page fetch would require serving the site through Cloudflare (a custom domain plus a proxying Worker). GitHub Pages access logs are not available.
- Cloudflare bot score and `verifiedBot` are only present with Bot Management. On the free plan, verification relies on IP ranges, FCrDNS and ASN.
- ClaudeBot, CCBot, DuckDuckBot and similar crawlers have no machine-readable verification source wired in, so they are reported `unverified` (High confidence for the category).
- Ad blockers, GPC and DNT users, and opt-outs are not counted. That is intentional.
- "Event span" and "foreground time" are estimates, not reading time. `page_exit` is best-effort: mobile browsers sometimes kill pages without firing it.
- The cooldown and cap checks are check-then-insert. Under heavy concurrency, one extra email can slip through, which is acceptable at this scale.
- A determined bot running a real browser with spoofed headers can still look like a human browser candidate. That is why the label is "candidate".
