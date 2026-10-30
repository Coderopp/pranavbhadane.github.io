// Plain-text email templates. Plain text avoids any HTML injection from
// attacker-controlled fields (User-Agent, referrer, paths).
//
// Every section labels where its data comes from: browser-reported,
// server-observed (Cloudflare), verified, or inferred.

import { CATEGORY, CATEGORY_LABEL, VERIFICATION } from '../classifier/categories.js';
import { describeReported } from '../classifier/useragent.js';
import { formatBoth, formatDuration, formatIst, istDate } from '../util/time.js';

function oneLine(s, max = 120) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function location(server) {
  const parts = [server.city, server.region, server.country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Unknown';
}

function lines(rows) {
  const width = Math.max(...rows.filter(Boolean).map(([k]) => k.length));
  return rows
    .filter(Boolean)
    .map(([k, v]) => `  ${k.padEnd(width)}  ${v ?? 'n/a'}`)
    .join('\n');
}

function serverSection(server, cfBot) {
  return lines([
    ['Approximate location', `${location(server)} (IP geolocation; VPNs and proxies make this unreliable)`],
    ['IP address', server.ip || 'Unknown'],
    ['Network', server.asn ? `AS${server.asn} ${server.as_org || ''}`.trim() : 'Unknown'],
    ['Cloudflare data center', server.colo || 'Unknown'],
    ['Cloudflare bot score', cfBot.score ?? 'n/a (Bot Management not available on this plan)'],
  ]);
}

function classificationSection(c) {
  return lines([
    ['Category', CATEGORY_LABEL[c.category]],
    c.bot_name && ['Client', `${c.bot_name}${c.operator ? ` (${c.operator})` : ''}`],
    c.purpose && ['Documented purpose', c.purpose],
    ['Confidence', c.confidence],
    ['Identity verification', `${c.verification_status}${c.verification_method ? ` via ${c.verification_method}` : ''}`],
    c.verification_detail && ['Verification detail', oneLine(c.verification_detail, 200)],
    ['Detection method', c.detection_method],
    ['Signals', c.signals.length ? c.signals.join(', ') : 'none'],
    ['User-Agent (raw)', oneLine(c.raw_user_agent, 400) || '(empty)'],
  ]);
}

export function humanSessionEmail({ event, classification, ua, server, cfBot, receivedAt }) {
  const reported = describeReported(ua);
  const subject = `Portfolio Activity: New Browser Session — ${oneLine(location(server), 60)}`;
  const text = `New browser session on your portfolio.

This is a *human browser candidate*: the page script ran in a browser and no
bot signature was found. It is not verified as a human, and nothing here
identifies who the visitor is, where they work, or why they visited.

TIMING
${lines([
    ['Browser event time', `${formatBoth(event.timestamp)} (client clock)`],
    ['Worker received', formatBoth(receivedAt)],
    ['Clock difference', `${Math.round(event.clock_skew_ms / 1000)}s (receipt minus client time)`],
  ])}

PAGE
${lines([
    ['Page visited', event.page_path],
    ['Full URL', event.page_url],
    ['Referrer', event.referrer ? `${event.referrer_domain} (${oneLine(event.referrer, 200)})` : 'None (direct, bookmark, or referrer stripped)'],
    ['Session ID', event.session_id],
    ['Returning browser', event.returning === null ? 'Unknown' : event.returning ? 'Yes (browser-reported)' : 'No (browser-reported)'],
  ])}

BROWSER-REPORTED (unverified, can be spoofed)
${lines([
    ['Browser', reported.browser],
    ['Operating system', reported.os],
    ['Device category', reported.device],
    ['Exact model', 'Unknown'],
    ua.in_app && ['In-app browser', ua.in_app],
    ['Screen', event.screen || 'n/a'],
    ['Timezone', event.timezone || 'n/a'],
    ['Language', event.language || 'n/a'],
    ua.notes.length && ['Notes', ua.notes.join('; ')],
  ])}

SERVER-OBSERVED (Cloudflare)
${serverSection(server, cfBot)}

CLASSIFICATION (inferred)
${classificationSection(classification)}

The daily digest will include this session's full navigation path.
`;
  return { subject, text };
}

export function crawlerAlertEmail({ event, classification, server, cfBot, receivedAt, kind }) {
  const page = event?.page_path || '(analytics endpoint)';
  let subject;
  if (classification.category === CATEGORY.SOCIAL && classification.operator === 'Meta') {
    subject = `Portfolio Crawler: Meta Social Preview — ${oneLine(page, 80)}`;
  } else if (classification.category === CATEGORY.AI || classification.category === CATEGORY.SEARCH) {
    subject = `Portfolio Crawler: AI/Search Indexer — ${oneLine(classification.bot_name || 'Unnamed', 60)}`;
  } else if (classification.category === CATEGORY.UNKNOWN) {
    subject = 'Portfolio Analytics: Unclassified Request';
  } else {
    subject = `Portfolio Crawler: ${CATEGORY_LABEL[classification.category]} — ${oneLine(classification.bot_name || 'Unnamed', 60)}`;
  }
  const text = `Automated or unclassified request (${kind === 'probe' ? 'direct request to the analytics endpoint, not a page view' : 'page event'}).

${lines([
    ['Received', formatBoth(receivedAt)],
    ['Page', page],
    event?.referrer && ['Referrer', oneLine(event.referrer, 200)],
  ])}

SERVER-OBSERVED (Cloudflare)
${serverSection(server, cfBot)}

CLASSIFICATION (inferred)
${classificationSection(classification)}

Further requests from this client are throttled into the daily digest.
`;
  return { subject, text };
}

// --------------------------------------------------------------------- digest

function sessionBlock(s) {
  let pages = [];
  try {
    pages = JSON.parse(s.pages_json || '[]');
  } catch {
    pages = [];
  }
  const span = s.first_client_ts && s.last_client_ts ? Date.parse(s.last_client_ts) - Date.parse(s.first_client_ts) : null;
  return `- ${formatIst(s.first_seen_at)} · ${[s.city, s.country].filter(Boolean).join(', ') || 'Unknown location'} · ${s.confidence}
    Path: ${pages.map((p) => oneLine(p, 80)).join(' → ')}${s.page_views > pages.length ? ` (+${s.page_views - pages.length} more)` : ''}
    Page views: ${s.page_views} · Event span: ${formatDuration(span)} · Foreground time (browser-reported): ${formatDuration(s.total_visible_ms)}
    Referrer: ${s.referrer_domain || 'none'} · Returning: ${s.is_returning === null ? 'unknown' : s.is_returning ? 'yes' : 'no'}
    ${s.browser} / ${s.os} / ${s.device} · Session ${s.session_id}${s.notified ? '' : ' · (no immediate email sent)'}`;
}

export function digestEmail({ data, sinceIso, untilIso }) {
  const automatedCount = data.crawlers.reduce((a, r) => a + r.n, 0) + data.probes.reduce((a, r) => a + r.n, 0);
  const subject = `Portfolio Analytics Digest — ${istDate(untilIso)} (${plural(data.sessions.length, 'browser session')} · ${plural(automatedCount, 'automated request')})`;

  const crawlerLines = data.crawlers.map(
    (r) =>
      `- [${CATEGORY_LABEL[r.category] || r.category}] ${r.bot_name}${r.operator ? ` (${r.operator})` : ''} · ${r.verification_status === VERIFICATION.VERIFIED ? 'verified' : r.verification_status} · ${r.confidence}\n` +
      `    ${r.n}× ${oneLine(r.page_path, 80)} · ${formatIst(r.first_at)} → ${formatIst(r.last_at)}${r.as_org ? ` · ${r.as_org}` : ''}`
  );
  const probeLines = data.probes.map(
    (r) => `- ${r.method} × ${r.n} · ${r.bot_name} [${CATEGORY_LABEL[r.category] || r.category}, ${r.verification_status}]${r.as_org ? ` · ${r.as_org}` : ''} · last ${formatIst(r.last_at)}`
  );
  const rejectedLines = data.rejected.map((r) => `- ${r.reason}: ${r.n}`);
  const failureLines = data.failures.map((f) => `- ${formatIst(f.created_at)} ${f.kind} "${oneLine(f.subject, 80)}": ${f.status} ${oneLine(f.error, 160)}`);

  const text = `Portfolio analytics digest
Window: ${formatBoth(sinceIso)}  →  ${formatBoth(untilIso)}

HUMAN BROWSER CANDIDATE SESSIONS (${data.sessions.length})
Sessions where the page script ran and no bot signature was found. Event span
is the time between the first and last event; foreground time is how long the
tab was visible. Neither is reading time.
${data.sessions.length ? data.sessions.map(sessionBlock).join('\n') : '  none'}

CRAWLER / AUTOMATED PAGE EVENTS (${data.crawlers.length} groups)
Clients that executed the tracking script but were classified as automated.
${crawlerLines.length ? crawlerLines.join('\n') : '  none'}

DIRECT ANALYTICS-ENDPOINT REQUESTS (${data.probes.length} groups)
Requests to the Worker URL itself (not page views). Usually crawlers that
found the endpoint in analytics.js. These never create visits or alerts.
${probeLines.length ? probeLines.join('\n') : '  none'}

REJECTED REQUESTS
${rejectedLines.length ? rejectedLines.join('\n') : '  none'}

NOTIFICATION FAILURES
${failureLines.length ? failureLines.join('\n') : '  none'}
`;
  return { subject, text };
}
