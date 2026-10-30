// Request classification. Pure decision logic plus crawler verification; no
// storage or notification concerns live here.
//
// Output (every field always present):
//   category            CATEGORY.*
//   bot_name            Named client, or null
//   operator            Organisation behind a named client, or null
//   purpose             Documented purpose of a named client, or null
//   detection_method    How the category was reached
//   confidence          CONFIDENCE.* (confidence in the category)
//   verification_status VERIFICATION.* (identity of a named crawler)
//   verification_method How identity was (or was not) verified
//   verification_detail Human-readable explanation
//   signals             Array of observed signals that influenced the result
//   raw_user_agent      Unmodified User-Agent header

import { CATEGORY, CONFIDENCE, VERIFICATION } from './categories.js';
import { GENERIC_BOT_PATTERNS, GENERIC_NON_BROWSER_BOT, HOSTING_ASNS, SIGNATURES } from './signatures.js';
import { isBrowserLike, parseUserAgent, platformHintMismatch } from './useragent.js';
import { cloudflareBotSignals, verifyCrawler } from './verify.js';

export function matchSignature(ua, signatures = SIGNATURES) {
  if (!ua) return null;
  return signatures.find((s) => s.pattern.test(ua)) || null;
}

function result(fields) {
  return {
    category: CATEGORY.UNKNOWN,
    bot_name: null,
    operator: null,
    purpose: null,
    detection_method: null,
    confidence: CONFIDENCE.UNKNOWN,
    verification_status: VERIFICATION.NOT_APPLICABLE,
    verification_method: null,
    verification_detail: null,
    signals: [],
    raw_user_agent: '',
    ...fields,
  };
}

/**
 * @param {object} input
 * @param {string} input.userAgent
 * @param {Headers} input.headers         Request headers (for client hints, Accept-Language, Sec-Fetch-*)
 * @param {object|undefined} input.cf     request.cf (may be undefined in local dev / tests)
 * @param {string|null} input.ip          CF-Connecting-IP
 * @param {boolean} input.jsExecuted      True when the request is a validated page event sent by analytics.js
 * @param {object} [input.client]         Browser-reported signals ({ automation: boolean })
 * @param {object} [deps]                 { fetchImpl, verify: boolean, signatures }
 */
export async function classifyRequest(input, deps = {}) {
  const ua = (input.userAgent || '').trim();
  const headers = input.headers || new Headers();
  const cf = input.cf;
  const signals = [];
  const cfBot = cloudflareBotSignals(cf);
  if (!cf) signals.push('cloudflare_metadata_unavailable');
  if (cfBot.score !== null) signals.push(`cf_bot_score=${cfBot.score}`);
  if (cfBot.verifiedBot) signals.push(`cf_verified_bot${cfBot.verifiedBotCategory ? `=${cfBot.verifiedBotCategory}` : ''}`);

  if (!ua) {
    return result({ detection_method: 'missing_user_agent', signals: [...signals, 'empty_user_agent'], raw_user_agent: '' });
  }

  // 1. Known signatures.
  const sig = matchSignature(ua, deps.signatures);
  if (sig) {
    const v = await verifyCrawler(sig, { ip: input.ip, cf }, { fetchImpl: deps.fetchImpl || fetch, enabled: deps.verify !== false });
    if (v.status === VERIFICATION.FAILED) {
      // Claims to be a known crawler but does not originate from its operator.
      return result({
        category: CATEGORY.UNKNOWN,
        bot_name: `${sig.name} (unverified claim)`,
        operator: null,
        purpose: `User-Agent claims "${sig.name}" but network origin does not match ${sig.operator || 'the operator'}`,
        detection_method: 'user_agent_signature+verification_failed',
        confidence: CONFIDENCE.MEDIUM,
        verification_status: v.status,
        verification_method: v.method,
        verification_detail: v.detail,
        signals: [...signals, 'possible_user_agent_spoofing'],
        raw_user_agent: ua,
      });
    }
    return result({
      category: sig.category,
      bot_name: sig.name,
      operator: sig.operator,
      purpose: sig.purpose,
      detection_method: v.status === VERIFICATION.VERIFIED ? `user_agent_signature+${v.method}` : 'user_agent_signature',
      confidence: v.status === VERIFICATION.VERIFIED ? CONFIDENCE.VERIFIED : CONFIDENCE.HIGH,
      verification_status: v.status,
      verification_method: v.method,
      verification_detail: v.detail,
      signals,
      raw_user_agent: ua,
    });
  }

  // 2. Cloudflare says it is a verified bot we have no signature for.
  if (cfBot.verifiedBot === true) {
    const cat = (cfBot.verifiedBotCategory || '').toLowerCase();
    const category = cat.includes('search') ? CATEGORY.SEARCH
      : cat.includes('ai') ? CATEGORY.AI
      : cat.includes('preview') || cat.includes('social') ? CATEGORY.SOCIAL
      : cat.includes('monitor') || cat.includes('security') ? CATEGORY.SCANNER
      : CATEGORY.AGENT;
    return result({
      category,
      bot_name: 'Cloudflare-verified bot',
      detection_method: 'cloudflare_verified_bot',
      confidence: CONFIDENCE.VERIFIED,
      verification_status: VERIFICATION.VERIFIED,
      verification_method: 'cloudflare_verified_bot',
      verification_detail: cfBot.verifiedBotCategory,
      signals,
      raw_user_agent: ua,
    });
  }

  // 3. Browser automation reported by the page itself (navigator.webdriver).
  if (input.client?.automation === true) {
    return result({
      category: CATEGORY.AGENT,
      bot_name: 'WebDriver-controlled browser',
      detection_method: 'client_navigator_webdriver',
      confidence: CONFIDENCE.HIGH,
      signals: [...signals, 'navigator.webdriver=true'],
      raw_user_agent: ua,
    });
  }

  const browserLike = isBrowserLike(ua);

  // 4. Self-identified but unlisted crawlers.
  if (GENERIC_BOT_PATTERNS.some((re) => re.test(ua)) || (!browserLike && GENERIC_NON_BROWSER_BOT.test(ua))) {
    return result({
      category: CATEGORY.UNKNOWN,
      bot_name: 'Unlisted self-identified crawler',
      detection_method: 'generic_bot_token',
      confidence: CONFIDENCE.MEDIUM,
      signals: [...signals, 'generic_bot_token'],
      raw_user_agent: ua,
    });
  }

  if (!browserLike) {
    return result({ detection_method: 'unrecognised_user_agent', signals: [...signals, 'non_browser_user_agent'], raw_user_agent: ua });
  }

  // 5. Browser-like User-Agent. Only a *candidate* human, and only when the
  //    page script actually ran (a direct endpoint hit proves nothing).
  if (!input.jsExecuted) {
    return result({
      detection_method: 'browser_user_agent_without_page_event',
      confidence: CONFIDENCE.LOW,
      signals: [...signals, 'direct_endpoint_request'],
      raw_user_agent: ua,
    });
  }

  if (cfBot.score !== null && cfBot.score < 30) {
    return result({
      bot_name: 'Likely automated (Cloudflare bot score)',
      detection_method: 'cloudflare_bot_score',
      confidence: CONFIDENCE.MEDIUM,
      signals: [...signals, 'low_cf_bot_score'],
      raw_user_agent: ua,
    });
  }

  const parsed = parseUserAgent(ua);
  const negatives = [];
  if (!headers.get('accept-language')) negatives.push('missing_accept_language');
  if (!headers.get('sec-fetch-mode') && supportsFetchMetadata(parsed)) negatives.push('missing_sec_fetch_headers');
  if (platformHintMismatch(parsed.os, headers.get('sec-ch-ua-platform'))) negatives.push('client_hint_platform_mismatch');
  if (headers.get('sec-ch-ua-mobile') === '?1' && parsed.device === 'Desktop/laptop candidate') negatives.push('client_hint_mobile_mismatch');
  const asn = Number(cf?.asn);
  if (HOSTING_ASNS.has(asn)) negatives.push(`hosting_provider_asn=AS${asn}`);

  let confidence = CONFIDENCE.MEDIUM;
  if (negatives.length) confidence = CONFIDENCE.LOW;
  else if (cfBot.score !== null && cfBot.score >= 80) confidence = CONFIDENCE.HIGH;

  return result({
    category: CATEGORY.HUMAN,
    detection_method: 'browser_user_agent+page_script_executed+header_consistency',
    confidence,
    signals: [...signals, ...negatives],
    raw_user_agent: ua,
  });
}

// Fetch Metadata (Sec-Fetch-*) headers: Chromium 76+, Firefox 90+, Safari 16.4+.
function supportsFetchMetadata(parsed) {
  const m = parsed.browser_major;
  if (!m) return false;
  if (parsed.browser.startsWith('Chrome-compatible') || parsed.browser === 'Edge' || parsed.browser === 'Opera') return m >= 76;
  if (parsed.browser === 'Firefox') return m >= 90;
  if (parsed.browser === 'Safari') return m >= 17;
  return false;
}

export { CATEGORY, CONFIDENCE, VERIFICATION } from './categories.js';
export { parseUserAgent, describeReported } from './useragent.js';
