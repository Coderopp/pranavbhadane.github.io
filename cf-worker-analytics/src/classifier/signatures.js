// Configurable User-Agent signature database.
//
// Each entry:
//   name      Display name of the client.
//   operator  Organisation that publicly documents the client (if any).
//   category  One of CATEGORY.*.
//   purpose   What this client is documented to do.
//   pattern   Case-insensitive RegExp tested against the raw User-Agent.
//   verify    Optional identity verification procedures, tried in order:
//               ipRangesUrls   Operator-published JSON lists of IP prefixes
//                              ({ prefixes: [{ ipv4Prefix | ipv6Prefix }] }).
//               rdnsSuffixes   Forward-confirmed reverse DNS hostname suffixes.
//               asns           Autonomous System numbers documented by the operator.
//
// Order matters: the first matching entry wins, so more specific tokens must
// come before generic ones (e.g. "Claude-SearchBot" before "ClaudeBot").
//
// Only add verification sources that the operator documents. A User-Agent
// match without verification is reported as `unverified`.

import { CATEGORY } from './categories.js';

const GOOGLE_RDNS = ['.googlebot.com', '.google.com'];
const GOOGLEBOT_RANGES = ['https://developers.google.com/static/search/apis/ipranges/googlebot.json'];
const GOOGLE_SPECIAL_RANGES = ['https://developers.google.com/static/search/apis/ipranges/special-crawlers.json'];
const META_ASNS = [32934];

const META = 'Meta';

export const SIGNATURES = [
  // ---- Meta (handled explicitly; see docs/ANALYTICS.md "Meta crawlers") ----
  { name: 'facebookexternalhit', operator: META, category: CATEGORY.SOCIAL, purpose: 'Meta social link preview fetch (Facebook, Instagram, Messenger, Threads)', pattern: /facebookexternalhit/i, verify: { asns: META_ASNS } },
  { name: 'Facebot', operator: META, category: CATEGORY.SOCIAL, purpose: 'Meta social link preview fetch', pattern: /\bFacebot\b/i, verify: { asns: META_ASNS } },
  { name: 'meta-webindexer', operator: META, category: CATEGORY.AI, purpose: 'Meta web indexing (Meta AI search results)', pattern: /meta-webindexer/i, verify: { asns: META_ASNS } },
  { name: 'meta-externalfetcher', operator: META, category: CATEGORY.AGENT, purpose: 'Meta user-initiated fetch (e.g. a Meta AI user asked about a URL)', pattern: /meta-externalfetcher/i, verify: { asns: META_ASNS } },
  { name: 'meta-externalagent', operator: META, category: CATEGORY.AI, purpose: 'Meta crawler for AI training / product indexing', pattern: /meta-externalagent/i, verify: { asns: META_ASNS } },
  { name: 'WhatsApp link preview', operator: META, category: CATEGORY.SOCIAL, purpose: 'WhatsApp link preview fetch', pattern: /^WhatsApp\//i, verify: { asns: META_ASNS } },

  // ---- AI crawlers and AI-driven fetchers ----
  { name: 'OAI-SearchBot', operator: 'OpenAI', category: CATEGORY.AI, purpose: 'ChatGPT search indexing', pattern: /OAI-SearchBot/i, verify: { ipRangesUrls: ['https://openai.com/searchbot.json'] } },
  { name: 'ChatGPT-User', operator: 'OpenAI', category: CATEGORY.AGENT, purpose: 'Fetch on behalf of a ChatGPT user', pattern: /ChatGPT-User/i, verify: { ipRangesUrls: ['https://openai.com/chatgpt-user.json'] } },
  { name: 'ChatGPT Agent', operator: 'OpenAI', category: CATEGORY.AGENT, purpose: 'ChatGPT agent browsing', pattern: /ChatGPT[- ]Agent/i },
  { name: 'GPTBot', operator: 'OpenAI', category: CATEGORY.AI, purpose: 'OpenAI model training crawler', pattern: /GPTBot/i, verify: { ipRangesUrls: ['https://openai.com/gptbot.json'] } },
  { name: 'Claude-SearchBot', operator: 'Anthropic', category: CATEGORY.AI, purpose: 'Claude search indexing', pattern: /Claude-SearchBot/i },
  { name: 'Claude-User', operator: 'Anthropic', category: CATEGORY.AGENT, purpose: 'Fetch on behalf of a Claude user', pattern: /Claude-User/i },
  { name: 'ClaudeBot', operator: 'Anthropic', category: CATEGORY.AI, purpose: 'Anthropic model training crawler', pattern: /ClaudeBot|anthropic-ai/i },
  { name: 'Perplexity-User', operator: 'Perplexity', category: CATEGORY.AGENT, purpose: 'Fetch on behalf of a Perplexity user', pattern: /Perplexity-User/i },
  { name: 'PerplexityBot', operator: 'Perplexity', category: CATEGORY.AI, purpose: 'Perplexity search indexing', pattern: /PerplexityBot/i, verify: { ipRangesUrls: ['https://www.perplexity.com/perplexitybot.json'] } },
  { name: 'MistralAI-User', operator: 'Mistral AI', category: CATEGORY.AGENT, purpose: 'Fetch on behalf of a Le Chat user', pattern: /MistralAI-User/i },
  { name: 'DuckAssistBot', operator: 'DuckDuckGo', category: CATEGORY.AI, purpose: 'DuckDuckGo AI-assisted answers', pattern: /DuckAssistBot/i },
  { name: 'Amazonbot', operator: 'Amazon', category: CATEGORY.AI, purpose: 'Amazon crawler (Alexa / AI answers)', pattern: /Amazonbot/i, verify: { rdnsSuffixes: ['.crawl.amazonbot.amazon'] } },
  { name: 'Applebot-Extended', operator: 'Apple', category: CATEGORY.AI, purpose: 'Apple AI training crawler', pattern: /Applebot-Extended/i, verify: { rdnsSuffixes: ['.applebot.apple.com'] } },
  { name: 'Bytespider', operator: 'ByteDance', category: CATEGORY.AI, purpose: 'ByteDance AI crawler', pattern: /Bytespider/i },
  { name: 'CCBot', operator: 'Common Crawl', category: CATEGORY.AI, purpose: 'Open web corpus crawler used for AI training', pattern: /CCBot/i },
  { name: 'cohere-ai', operator: 'Cohere', category: CATEGORY.AI, purpose: 'Cohere AI crawler', pattern: /cohere-(?:ai|training-data-crawler)/i },
  { name: 'Diffbot', operator: 'Diffbot', category: CATEGORY.AI, purpose: 'Knowledge-graph extraction', pattern: /Diffbot/i },
  { name: 'YouBot', operator: 'You.com', category: CATEGORY.AI, purpose: 'You.com AI search', pattern: /YouBot/i },
  { name: 'Timpibot', operator: 'Timpi', category: CATEGORY.AI, purpose: 'Timpi index crawler', pattern: /Timpibot/i },
  { name: 'ImagesiftBot', operator: 'ImageSift', category: CATEGORY.AI, purpose: 'Image dataset crawler', pattern: /ImagesiftBot/i },

  // ---- Search engines ----
  { name: 'Google-InspectionTool', operator: 'Google', category: CATEGORY.SEARCH, purpose: 'Search Console URL inspection', pattern: /Google-InspectionTool/i, verify: { ipRangesUrls: GOOGLEBOT_RANGES, rdnsSuffixes: GOOGLE_RDNS } },
  { name: 'GoogleOther', operator: 'Google', category: CATEGORY.SEARCH, purpose: 'Google generic crawler (non-Search products)', pattern: /GoogleOther/i, verify: { ipRangesUrls: GOOGLEBOT_RANGES, rdnsSuffixes: GOOGLE_RDNS } },
  { name: 'AdsBot-Google', operator: 'Google', category: CATEGORY.SEARCH, purpose: 'Google Ads landing page quality check', pattern: /AdsBot-Google|Mediapartners-Google/i, verify: { ipRangesUrls: GOOGLE_SPECIAL_RANGES, rdnsSuffixes: GOOGLE_RDNS } },
  { name: 'Googlebot', operator: 'Google', category: CATEGORY.SEARCH, purpose: 'Google Search crawler / renderer', pattern: /Googlebot|Storebot-Google/i, verify: { ipRangesUrls: GOOGLEBOT_RANGES, rdnsSuffixes: GOOGLE_RDNS } },
  { name: 'Bingbot', operator: 'Microsoft', category: CATEGORY.SEARCH, purpose: 'Bing Search crawler (also feeds Copilot)', pattern: /bingbot|msnbot|BingPreview/i, verify: { ipRangesUrls: ['https://www.bing.com/toolbox/bingbot.json'], rdnsSuffixes: ['.search.msn.com'] } },
  { name: 'DuckDuckBot', operator: 'DuckDuckGo', category: CATEGORY.SEARCH, purpose: 'DuckDuckGo crawler', pattern: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i },
  { name: 'Applebot', operator: 'Apple', category: CATEGORY.SEARCH, purpose: 'Apple Search (Siri / Spotlight) crawler', pattern: /Applebot/i, verify: { rdnsSuffixes: ['.applebot.apple.com'] } },
  { name: 'YandexBot', operator: 'Yandex', category: CATEGORY.SEARCH, purpose: 'Yandex Search crawler', pattern: /Yandex(?:Bot|Images|Mobile|Accessibility|Metrika|Renderer)?\//i, verify: { rdnsSuffixes: ['.yandex.ru', '.yandex.net', '.yandex.com'] } },
  { name: 'Baiduspider', operator: 'Baidu', category: CATEGORY.SEARCH, purpose: 'Baidu Search crawler', pattern: /Baiduspider/i, verify: { rdnsSuffixes: ['.baidu.com', '.baidu.jp'] } },
  { name: 'PetalBot', operator: 'Huawei', category: CATEGORY.SEARCH, purpose: 'Petal Search crawler', pattern: /PetalBot/i, verify: { rdnsSuffixes: ['.petalsearch.com'] } },
  { name: 'SeznamBot', operator: 'Seznam', category: CATEGORY.SEARCH, purpose: 'Seznam Search crawler', pattern: /SeznamBot/i },
  { name: 'Qwant', operator: 'Qwant', category: CATEGORY.SEARCH, purpose: 'Qwant Search crawler', pattern: /Qwantify|Qwantbot/i },
  { name: 'MojeekBot', operator: 'Mojeek', category: CATEGORY.SEARCH, purpose: 'Mojeek Search crawler', pattern: /MojeekBot/i },
  { name: 'Yeti', operator: 'Naver', category: CATEGORY.SEARCH, purpose: 'Naver Search crawler', pattern: /\bYeti\//i },
  { name: 'Sogou', operator: 'Sogou', category: CATEGORY.SEARCH, purpose: 'Sogou Search crawler', pattern: /Sogou (?:web )?spider/i },
  { name: 'Yahoo Slurp', operator: 'Yahoo', category: CATEGORY.SEARCH, purpose: 'Yahoo crawler', pattern: /Yahoo! Slurp/i },

  // ---- Social / messaging link previews ----
  { name: 'LinkedInBot', operator: 'LinkedIn', category: CATEGORY.SOCIAL, purpose: 'LinkedIn link preview fetch', pattern: /LinkedInBot/i },
  { name: 'Twitterbot', operator: 'X', category: CATEGORY.SOCIAL, purpose: 'X/Twitter card preview fetch', pattern: /Twitterbot/i },
  { name: 'Slackbot', operator: 'Slack', category: CATEGORY.SOCIAL, purpose: 'Slack link unfurl', pattern: /Slackbot|Slack-ImgProxy/i },
  { name: 'Discordbot', operator: 'Discord', category: CATEGORY.SOCIAL, purpose: 'Discord link embed', pattern: /Discordbot/i },
  { name: 'TelegramBot', operator: 'Telegram', category: CATEGORY.SOCIAL, purpose: 'Telegram link preview', pattern: /TelegramBot/i },
  { name: 'Pinterestbot', operator: 'Pinterest', category: CATEGORY.SOCIAL, purpose: 'Pinterest pin preview', pattern: /Pinterestbot/i }, // not "Pinterest/": that token is the in-app browser
  { name: 'redditbot', operator: 'Reddit', category: CATEGORY.SOCIAL, purpose: 'Reddit link preview', pattern: /redditbot/i },
  { name: 'SkypeUriPreview', operator: 'Microsoft', category: CATEGORY.SOCIAL, purpose: 'Teams / Skype link preview', pattern: /SkypeUriPreview/i },
  { name: 'Snap URL Preview', operator: 'Snap', category: CATEGORY.SOCIAL, purpose: 'Snapchat link preview', pattern: /Snap URL Preview/i },
  { name: 'Bluesky Cardyb', operator: 'Bluesky', category: CATEGORY.SOCIAL, purpose: 'Bluesky link card', pattern: /Bluesky Cardyb/i },
  { name: 'Mastodon', operator: 'Mastodon instance', category: CATEGORY.SOCIAL, purpose: 'Mastodon link preview', pattern: /Mastodon\//i },
  { name: 'Embedly', operator: 'Embedly', category: CATEGORY.SOCIAL, purpose: 'Embed / preview service', pattern: /Embedly|Iframely/i },
  { name: 'vkShare', operator: 'VK', category: CATEGORY.SOCIAL, purpose: 'VK link preview', pattern: /vkShare/i },

  // ---- Browser automation and generic HTTP clients ----
  { name: 'HeadlessChrome', operator: null, category: CATEGORY.AGENT, purpose: 'Headless Chromium (Puppeteer, Playwright, etc.)', pattern: /HeadlessChrome/i },
  { name: 'PhantomJS', operator: null, category: CATEGORY.AGENT, purpose: 'Headless browser', pattern: /PhantomJS/i },
  { name: 'Selenium', operator: null, category: CATEGORY.AGENT, purpose: 'Browser automation', pattern: /Selenium|webdriver/i },
  { name: 'Playwright', operator: null, category: CATEGORY.AGENT, purpose: 'Browser automation', pattern: /Playwright/i },
  { name: 'Puppeteer', operator: null, category: CATEGORY.AGENT, purpose: 'Browser automation', pattern: /Puppeteer/i },
  { name: 'Cypress', operator: null, category: CATEGORY.AGENT, purpose: 'Browser test automation', pattern: /Cypress\//i },
  { name: 'Lighthouse', operator: 'Google', category: CATEGORY.AGENT, purpose: 'Lighthouse / PageSpeed Insights audit', pattern: /Chrome-Lighthouse|Google Page Speed/i },
  { name: 'GTmetrix', operator: 'GTmetrix', category: CATEGORY.AGENT, purpose: 'Performance audit', pattern: /GTmetrix/i },
  { name: 'HTTP client library', operator: null, category: CATEGORY.AGENT, purpose: 'Scripted HTTP request', pattern: /^(?:curl|Wget|python-requests|python-urllib|Python\/|aiohttp|python-httpx|httpx|Go-http-client|node-fetch|axios|undici|got|okhttp|Java\/|Apache-HttpClient|libwww-perl|PostmanRuntime|insomnia|Deno\/|Bun\/|Ruby|Faraday|http\.rb|Dart\/|reqwest|Scrapy)/i },
  { name: 'Scrapy', operator: null, category: CATEGORY.AGENT, purpose: 'Scraping framework', pattern: /Scrapy|HTTrack/i },

  // ---- Security scanners, link scanners and uptime monitors ----
  { name: 'UptimeRobot', operator: 'UptimeRobot', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /UptimeRobot/i },
  { name: 'Pingdom', operator: 'SolarWinds', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /Pingdom/i },
  { name: 'StatusCake', operator: 'StatusCake', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /StatusCake/i },
  { name: 'Better Stack', operator: 'Better Stack', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /Better ?Uptime|BetterStack/i },
  { name: 'Site24x7', operator: 'Zoho', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /Site24x7/i },
  { name: 'Datadog Synthetics', operator: 'Datadog', category: CATEGORY.SCANNER, purpose: 'Synthetic monitoring', pattern: /DatadogSynthetics|Datadog\/Synthetics/i },
  { name: 'Checkly', operator: 'Checkly', category: CATEGORY.SCANNER, purpose: 'Synthetic monitoring', pattern: /Checkly/i },
  { name: 'Uptime Kuma', operator: null, category: CATEGORY.SCANNER, purpose: 'Self-hosted uptime monitoring', pattern: /Uptime-Kuma/i },
  { name: 'HetrixTools', operator: 'HetrixTools', category: CATEGORY.SCANNER, purpose: 'Uptime monitoring', pattern: /HetrixTools/i },
  { name: 'Censys', operator: 'Censys', category: CATEGORY.SCANNER, purpose: 'Internet-wide scanning', pattern: /CensysInspect|censys/i },
  { name: 'Palo Alto Expanse', operator: 'Palo Alto Networks', category: CATEGORY.SCANNER, purpose: 'Internet-wide scanning', pattern: /Expanse|Xpanse/i },
  { name: 'InternetMeasurement', operator: null, category: CATEGORY.SCANNER, purpose: 'Internet-wide scanning', pattern: /InternetMeasurement|ModatScanner|LeakIX/i },
  { name: 'Vulnerability scanner', operator: null, category: CATEGORY.SCANNER, purpose: 'Vulnerability scanning', pattern: /zgrab|masscan|Nmap|Nuclei|Nikto|sqlmap|WPScan|Acunetix|Qualys|Detectify|Nessus|OpenVAS|wfuzz|gobuster|dirbuster/i },
  { name: 'Email link scanner', operator: null, category: CATEGORY.SCANNER, purpose: 'Email security link pre-fetch', pattern: /Barracuda|Proofpoint|Mimecast|Trend ?Micro|SafeLinks/i },
];

// Heuristic catch-all for self-identified crawlers that are not in the list.
// Deliberately narrow: plain "bot" substrings appear in real device names
// (e.g. Android "CUBOT" phones), so we only match the crawler conventions
// "compatible; SomethingBot/1.0" and "+http(s)://info-url".
export const GENERIC_BOT_PATTERNS = [
  /compatible;\s*[^;)]*(?:bot|crawler|spider|scraper|fetcher)\b/i,
  /\+https?:\/\//i,
];

export const GENERIC_NON_BROWSER_BOT = /bot|crawl|spider|scrap|fetch|preview|scan|monitor|check/i;

// ASNs of large hosting/cloud providers. Being on one of these is *not* proof
// of automation (VPNs, corporate proxies and remote desktops live there too);
// it only lowers confidence for a human browser candidate.
export const HOSTING_ASNS = new Set([
  16509, 14618, // Amazon AWS
  396982, // Google Cloud
  8075, // Microsoft Azure
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  63949, // Akamai / Linode
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  20473, // Vultr
  51167, // Contabo
  12876, // Scaleway
]);
