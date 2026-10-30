// Crawler identity verification.
//
// Procedures, in order of preference:
//   1. Cloudflare verified-bot signal (request.cf.botManagement.verifiedBot),
//      only present on zones/plans with Bot Management.
//   2. Operator-published IP range lists (Google, Bing, OpenAI, Perplexity).
//   3. Forward-confirmed reverse DNS (PTR -> hostname suffix -> A/AAAA back to
//      the same IP), via DNS-over-HTTPS. Documented by Google, Bing, Apple,
//      Yandex, Baidu, Amazon.
//   4. ASN ownership (Meta documents verification by its AS32934 prefixes).
//
// A failed lookup is reported as `unverified`, never as `failed`; `failed`
// means the request definitely did not come from the claimed operator.

import { VERIFICATION } from './categories.js';
import { ipInCidr, parseIP, reverseDnsName } from '../util/ip.js';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const LOOKUP_TIMEOUT_MS = 3000;
const RANGES_TTL_MS = 24 * 60 * 60 * 1000;

// Isolate-local cache. Purely a performance optimisation: correctness does not
// depend on it surviving between requests.
const rangesMemo = new Map();

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadRanges(url, fetchImpl) {
  const memo = rangesMemo.get(url);
  if (memo && Date.now() - memo.at < RANGES_TTL_MS) return memo.prefixes;

  let res;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(url);
  if (cache) res = await cache.match(cacheKey);
  if (!res) {
    res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`ranges ${url} -> HTTP ${res.status}`);
    if (cache) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', 'public, max-age=86400');
      await cache.put(cacheKey, copy).catch(() => {});
    }
  }
  const json = await res.json();
  const prefixes = (json.prefixes || []).map((p) => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean);
  rangesMemo.set(url, { at: Date.now(), prefixes });
  return prefixes;
}

async function dohQuery(name, type, fetchImpl) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`DoH ${type} ${name} -> HTTP ${res.status}`);
  const json = await res.json();
  const typeCode = { PTR: 12, A: 1, AAAA: 28 }[type];
  return (json.Answer || []).filter((a) => a.type === typeCode).map((a) => a.data.replace(/\.$/, '').toLowerCase());
}

export async function forwardConfirmedReverseDns(ip, suffixes, fetchImpl) {
  const ptrName = reverseDnsName(ip);
  if (!ptrName) return { ok: false, detail: 'invalid IP' };
  const hosts = await dohQuery(ptrName, 'PTR', fetchImpl);
  const host = hosts.find((h) => suffixes.some((s) => h.endsWith(s)));
  if (!host) return { ok: false, detail: hosts.length ? `PTR ${hosts[0]} not in ${suffixes.join(', ')}` : 'no PTR record' };
  const version = parseIP(ip).version;
  const forward = await dohQuery(host, version === 4 ? 'A' : 'AAAA', fetchImpl);
  const target = parseIP(ip).value;
  const confirmed = forward.some((addr) => parseIP(addr)?.value === target);
  return { ok: confirmed, detail: confirmed ? `FCrDNS ${host}` : `${host} does not resolve back to ${ip}` };
}

export function cloudflareBotSignals(cf) {
  const bm = cf?.botManagement || {};
  return {
    score: Number.isFinite(bm.score) ? bm.score : null,
    verifiedBot: typeof bm.verifiedBot === 'boolean' ? bm.verifiedBot : null,
    verifiedBotCategory: bm.verifiedBotCategory || cf?.verifiedBotCategory || null,
  };
}

/**
 * Verify that `ip` belongs to the operator of `signature`.
 * @returns {Promise<{status: string, method: string|null, detail: string|null}>}
 */
export async function verifyCrawler(signature, { ip, cf }, { fetchImpl = fetch, enabled = true } = {}) {
  const cfSignals = cloudflareBotSignals(cf);
  if (cfSignals.verifiedBot === true) {
    return { status: VERIFICATION.VERIFIED, method: 'cloudflare_verified_bot', detail: cfSignals.verifiedBotCategory };
  }

  const v = signature.verify;
  if (!v) return { status: VERIFICATION.UNVERIFIED, method: null, detail: 'operator publishes no verification method we use' };
  if (!ip || !parseIP(ip)) return { status: VERIFICATION.UNVERIFIED, method: null, detail: 'client IP unavailable' };

  const errors = [];
  let definitiveMiss = false;

  if (enabled && v.ipRangesUrls) {
    try {
      let matched = false;
      for (const url of v.ipRangesUrls) {
        const prefixes = await loadRanges(url, fetchImpl);
        if (prefixes.some((cidr) => ipInCidr(ip, cidr))) {
          matched = true;
          break;
        }
      }
      if (matched) return { status: VERIFICATION.VERIFIED, method: 'published_ip_ranges', detail: v.ipRangesUrls.join(', ') };
      definitiveMiss = true;
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }

  if (enabled && v.rdnsSuffixes) {
    try {
      const r = await forwardConfirmedReverseDns(ip, v.rdnsSuffixes, fetchImpl);
      if (r.ok) return { status: VERIFICATION.VERIFIED, method: 'forward_confirmed_rdns', detail: r.detail };
      definitiveMiss = true;
      errors.push(r.detail);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }

  if (v.asns) {
    const asn = Number(cf?.asn);
    if (Number.isFinite(asn) && asn > 0) {
      if (v.asns.includes(asn)) return { status: VERIFICATION.VERIFIED, method: 'asn_ownership', detail: `AS${asn}` };
      definitiveMiss = true;
      errors.push(`AS${asn} is not operator ASN ${v.asns.map((a) => `AS${a}`).join('/')}`);
    } else {
      errors.push('ASN unavailable (request.cf missing)');
    }
  }

  if (definitiveMiss) return { status: VERIFICATION.FAILED, method: 'network_origin_mismatch', detail: errors.join('; ') };
  return { status: VERIFICATION.UNVERIFIED, method: null, detail: errors.join('; ') || 'verification disabled' };
}

export function _resetVerifyCacheForTests() {
  rangesMemo.clear();
}
