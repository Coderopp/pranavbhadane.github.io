import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CATEGORY, CONFIDENCE, VERIFICATION, classifyRequest } from '../src/classifier/index.js';
import { parseUserAgent } from '../src/classifier/useragent.js';
import { _resetVerifyCacheForTests } from '../src/classifier/verify.js';
import { ipInCidr, reverseDnsName } from '../src/util/ip.js';
import { BROWSER_HEADERS, CF_INDIA, UA, installFetchMock } from './helpers.js';

const browserHeaders = () => new Headers(BROWSER_HEADERS);
const META_CF = { asn: 32934, asOrganization: 'Facebook, Inc.', country: 'US' };

let fetchMock;
beforeEach(() => {
  _resetVerifyCacheForTests();
  fetchMock = installFetchMock();
  fetchMock.on('https://openai.com/gptbot.json', async () => Response.json({ prefixes: [{ ipv4Prefix: '132.196.86.0/24' }] }));
  fetchMock.on('https://www.perplexity.com/perplexitybot.json', async () => Response.json({ prefixes: [{ ipv4Prefix: '18.97.1.0/24' }] }));
  fetchMock.on('https://developers.google.com/', async () => Response.json({ prefixes: [{ ipv4Prefix: '66.249.64.0/27' }, { ipv6Prefix: '2001:4860:4801:10::/64' }] }));
  fetchMock.on('https://cloudflare-dns.com/', async () => Response.json({ Status: 3, Answer: [] }));
});
afterEach(() => fetchMock.restore());

const classify = (ua, extra = {}) =>
  classifyRequest({ userAgent: ua, headers: browserHeaders(), cf: CF_INDIA, ip: '49.36.10.20', jsExecuted: true, ...extra });

describe('Meta crawlers', () => {
  test('11. facebookexternalhit from Meta ASN is a verified social preview crawler', async () => {
    const c = await classify(UA.facebookExternalHit, { cf: META_CF, ip: '31.13.115.1' });
    assert.equal(c.category, CATEGORY.SOCIAL);
    assert.equal(c.bot_name, 'facebookexternalhit');
    assert.equal(c.operator, 'Meta');
    assert.equal(c.verification_status, VERIFICATION.VERIFIED);
    assert.equal(c.verification_method, 'asn_ownership');
    assert.equal(c.confidence, CONFIDENCE.VERIFIED);
    assert.equal(c.raw_user_agent, UA.facebookExternalHit);
  });

  test('facebookexternalhit from a non-Meta ASN is flagged as a spoofed claim', async () => {
    const c = await classify(UA.facebookExternalHit, { cf: CF_INDIA });
    assert.equal(c.category, CATEGORY.UNKNOWN);
    assert.equal(c.verification_status, VERIFICATION.FAILED);
    assert.ok(c.signals.includes('possible_user_agent_spoofing'));
  });

  test('12. meta-webindexer is Meta web indexing, not a social preview', async () => {
    const c = await classify(UA.metaWebIndexer, { cf: META_CF, ip: '57.141.0.5' });
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.bot_name, 'meta-webindexer');
    assert.match(c.purpose, /web indexing/i);
    assert.equal(c.confidence, CONFIDENCE.VERIFIED);
  });

  test('meta-externalagent is a separate Meta automated category', async () => {
    const c = await classify(UA.metaExternalAgent, { cf: META_CF, ip: '57.141.0.5' });
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.bot_name, 'meta-externalagent');
  });

  test('Facebot and meta-externalfetcher are recognised', async () => {
    assert.equal((await classify('Facebot', { cf: META_CF })).bot_name, 'Facebot');
    assert.equal((await classify('meta-externalfetcher/1.1', { cf: META_CF })).category, CATEGORY.AGENT);
  });

  test('Instagram / Facebook in-app browsers stay human candidates', async () => {
    const ig = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0 (iPhone15,2; iOS 18_6; en_IN)';
    // Mobile Safari-based in-app browsers lack "Version/x Safari/"; they are still not crawlers.
    const c = await classify(`${ig} Safari/604.1`);
    assert.equal(c.category, CATEGORY.HUMAN);
    assert.equal(parseUserAgent(ig).in_app, 'Instagram in-app browser');
  });
});

describe('search and AI crawlers', () => {
  test('13. Googlebot from a published Google range is verified', async () => {
    const c = await classify(UA.googlebot, { ip: '66.249.64.10', cf: { asn: 15169 } });
    assert.equal(c.category, CATEGORY.SEARCH);
    assert.equal(c.bot_name, 'Googlebot');
    assert.equal(c.verification_status, VERIFICATION.VERIFIED);
    assert.equal(c.verification_method, 'published_ip_ranges');
  });

  test('Googlebot UA from a residential IP fails verification', async () => {
    const c = await classify(UA.googlebot, { ip: '49.36.10.20' });
    assert.equal(c.category, CATEGORY.UNKNOWN);
    assert.equal(c.verification_status, VERIFICATION.FAILED);
    assert.match(c.bot_name, /unverified claim/);
  });

  test('Googlebot verified by forward-confirmed reverse DNS when not in the list', async () => {
    fetchMock.on((u) => u.includes('type=PTR'), async () => Response.json({ Answer: [{ type: 12, data: 'crawl-66-249-70-1.googlebot.com.' }] }));
    fetchMock.on((u) => u.includes('crawl-66-249-70-1.googlebot.com') && u.includes('type=A'), async () => Response.json({ Answer: [{ type: 1, data: '66.249.70.1' }] }));
    const c = await classify(UA.googlebot, { ip: '66.249.70.1' });
    assert.equal(c.verification_status, VERIFICATION.VERIFIED);
    assert.equal(c.verification_method, 'forward_confirmed_rdns');
  });

  test('14. GPTBot is an AI crawler, verified against OpenAI ranges', async () => {
    const c = await classify(UA.gptbot, { ip: '132.196.86.42' });
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.bot_name, 'GPTBot');
    assert.equal(c.operator, 'OpenAI');
    assert.equal(c.confidence, CONFIDENCE.VERIFIED);
  });

  test('15. ClaudeBot is an AI crawler; unverified (no published method) but high confidence', async () => {
    const c = await classify(UA.claudebot);
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.bot_name, 'ClaudeBot');
    assert.equal(c.verification_status, VERIFICATION.UNVERIFIED);
    assert.equal(c.confidence, CONFIDENCE.HIGH);
  });

  test('Claude-SearchBot is matched before ClaudeBot', async () => {
    assert.equal((await classify('Mozilla/5.0 (compatible; Claude-SearchBot/1.0)')).bot_name, 'Claude-SearchBot');
  });

  test('16. PerplexityBot is an AI crawler', async () => {
    const c = await classify(UA.perplexitybot, { ip: '18.97.1.10' });
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.bot_name, 'PerplexityBot');
    assert.equal(c.verification_status, VERIFICATION.VERIFIED);
  });

  test('IP-range lookup failure leaves the crawler unverified, not failed', async () => {
    fetchMock.on('https://openai.com/gptbot.json', async () => new Response('oops', { status: 500 }));
    const c = await classify(UA.gptbot, { ip: '1.2.3.4' });
    assert.equal(c.category, CATEGORY.AI);
    assert.equal(c.verification_status, VERIFICATION.UNVERIFIED);
  });

  test('Cloudflare verified-bot signal is trusted', async () => {
    const c = await classify(UA.claudebot, { cf: { botManagement: { verifiedBot: true, score: 1 }, verifiedBotCategory: 'AI Crawler' } });
    assert.equal(c.verification_status, VERIFICATION.VERIFIED);
    assert.equal(c.verification_method, 'cloudflare_verified_bot');
  });
});

describe('browsers', () => {
  test('17. normal Chrome desktop is a human browser candidate (never "verified human")', async () => {
    const c = await classify(UA.chromeWindows);
    assert.equal(c.category, CATEGORY.HUMAN);
    assert.equal(c.confidence, CONFIDENCE.MEDIUM);
    assert.equal(c.verification_status, VERIFICATION.NOT_APPLICABLE);
    const ua = parseUserAgent(UA.chromeWindows);
    assert.equal(ua.os, 'Windows');
    assert.equal(ua.device, 'Desktop/laptop candidate');
  });

  test('18. Safari on macOS: reported browser/platform, model unknown', async () => {
    const c = await classify(UA.safariMac);
    assert.equal(c.category, CATEGORY.HUMAN);
    const ua = parseUserAgent(UA.safariMac);
    assert.equal(ua.browser, 'Safari');
    assert.equal(ua.os, 'macOS-compatible');
    assert.equal(ua.device, 'Desktop/laptop candidate');
    assert.equal(ua.exact_model, 'Unknown');
  });

  test('19. Android Chrome is a mobile candidate', async () => {
    const c = await classify(UA.chromeAndroid);
    assert.equal(c.category, CATEGORY.HUMAN);
    const ua = parseUserAgent(UA.chromeAndroid);
    assert.equal(ua.os, 'Android');
    assert.equal(ua.device, 'Mobile candidate');
  });

  test('20. iPhone Safari is a mobile candidate', async () => {
    const c = await classify(UA.safariIphone);
    assert.equal(c.category, CATEGORY.HUMAN);
    const ua = parseUserAgent(UA.safariIphone);
    assert.equal(ua.os, 'iOS');
    assert.equal(ua.device, 'Mobile candidate');
    assert.equal(ua.browser, 'Safari');
  });

  test('21. Linux Chrome: Chrome-compatible, Linux x86_64 reported', async () => {
    const c = await classify(UA.chromeLinux);
    assert.equal(c.category, CATEGORY.HUMAN);
    const ua = parseUserAgent(UA.chromeLinux);
    assert.equal(ua.browser, 'Chrome-compatible');
    assert.equal(ua.os, 'Linux x86_64');
    assert.equal(ua.device, 'Desktop/laptop candidate');
  });

  test('22. HeadlessChrome is browser automation', async () => {
    const c = await classify(UA.headlessChrome);
    assert.equal(c.category, CATEGORY.AGENT);
    assert.equal(c.bot_name, 'HeadlessChrome');
  });

  test('navigator.webdriver=true marks automation even with a normal UA', async () => {
    const c = await classify(UA.chromeWindows, { client: { automation: true } });
    assert.equal(c.category, CATEGORY.AGENT);
    assert.equal(c.detection_method, 'client_navigator_webdriver');
  });

  test('23. unknown User-Agent stays unclassified', async () => {
    const c = await classify(UA.unknown);
    assert.equal(c.category, CATEGORY.UNKNOWN);
    assert.equal(c.confidence, CONFIDENCE.UNKNOWN);
  });

  test('empty User-Agent is unknown', async () => {
    const c = await classify('');
    assert.equal(c.category, CATEGORY.UNKNOWN);
    assert.equal(c.detection_method, 'missing_user_agent');
  });

  test('browser UA hitting the endpoint without the page script is not a human candidate', async () => {
    const c = await classify(UA.chromeWindows, { jsExecuted: false });
    assert.equal(c.category, CATEGORY.UNKNOWN);
    assert.ok(c.signals.includes('direct_endpoint_request'));
  });

  test('cloud ASN lowers confidence but does not mark automation', async () => {
    const c = await classify(UA.chromeWindows, { cf: { ...CF_INDIA, asn: 16509 } });
    assert.equal(c.category, CATEGORY.HUMAN);
    assert.equal(c.confidence, CONFIDENCE.LOW);
  });

  test('missing Accept-Language lowers confidence', async () => {
    const c = await classify(UA.chromeWindows, { headers: new Headers({ 'sec-fetch-mode': 'cors' }) });
    assert.equal(c.confidence, CONFIDENCE.LOW);
    assert.ok(c.signals.includes('missing_accept_language'));
  });

  test('29. Cloudflare metadata unavailable: still classified, signal recorded', async () => {
    const c = await classify(UA.chromeWindows, { cf: undefined });
    assert.equal(c.category, CATEGORY.HUMAN);
    assert.ok(c.signals.includes('cloudflare_metadata_unavailable'));
    const meta = await classify(UA.facebookExternalHit, { cf: undefined });
    assert.equal(meta.category, CATEGORY.SOCIAL);
    assert.equal(meta.verification_status, VERIFICATION.UNVERIFIED);
  });

  test('CUBOT phone is not mistaken for a bot', async () => {
    const c = await classify('Mozilla/5.0 (Linux; Android 11; CUBOT KINGKONG 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    assert.equal(c.category, CATEGORY.HUMAN);
  });

  test('curl and python-requests are automated agents', async () => {
    assert.equal((await classify('curl/8.5.0')).category, CATEGORY.AGENT);
    assert.equal((await classify('python-requests/2.32.3')).category, CATEGORY.AGENT);
  });

  test('uptime monitor is a scanner/monitor', async () => {
    assert.equal((await classify('Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)')).category, CATEGORY.SCANNER);
  });
});

describe('ip utilities', () => {
  test('CIDR matching v4/v6 and reverse names', () => {
    assert.ok(ipInCidr('66.249.64.10', '66.249.64.0/27'));
    assert.ok(!ipInCidr('66.249.64.40', '66.249.64.0/27'));
    assert.ok(ipInCidr('2001:4860:4801:10::abcd', '2001:4860:4801:10::/64'));
    assert.ok(!ipInCidr('2001:4860:4801:11::1', '2001:4860:4801:10::/64'));
    assert.equal(reverseDnsName('66.249.70.1'), '1.70.249.66.in-addr.arpa');
    assert.match(reverseDnsName('2001:db8::1'), /^1\.0\.0\.0\..*\.8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa$/);
  });
});
