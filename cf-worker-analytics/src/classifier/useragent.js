// Best-effort parsing of *reported* browser identity.
//
// Everything returned here is what the client claims. A User-Agent string can
// be set to anything, iPadOS Safari reports itself as macOS by default, and
// Chromium freezes OS versions and device models. We therefore never report an
// exact device model, and label the device as a "candidate".

export const DEVICE = Object.freeze({
  DESKTOP: 'Desktop/laptop candidate',
  MOBILE: 'Mobile candidate',
  TABLET: 'Tablet candidate',
  UNKNOWN: 'Unknown',
});

const BROWSER_RULES = [
  [/EdgiOS\//, 'Edge (iOS, WebKit)'],
  [/Edg(?:e|A)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/YaBrowser\//, 'Yandex Browser'],
  [/Vivaldi\//, 'Vivaldi'],
  [/FxiOS\//, 'Firefox (iOS, WebKit)'],
  [/Firefox\//, 'Firefox'],
  [/CriOS\//, 'Chrome (iOS, WebKit)'],
  [/Chrome\/|Chromium\//, 'Chrome-compatible'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
];

const IN_APP_RULES = [
  [/Instagram/, 'Instagram in-app browser'],
  [/FBAN\/|FBAV\/|FB_IAB/, 'Facebook in-app browser'],
  [/LinkedInApp/, 'LinkedIn in-app browser'],
  [/Twitter for|TwitterAndroid/, 'X/Twitter in-app browser'],
  [/\bLine\//, 'LINE in-app browser'],
  [/Snapchat/, 'Snapchat in-app browser'],
  [/GSA\//, 'Google app'],
];

export function parseUserAgent(ua, hints = {}) {
  const result = {
    browser: 'Unknown',
    browser_major: null,
    os: 'Unknown',
    device: DEVICE.UNKNOWN,
    in_app: null,
    exact_model: 'Unknown',
    notes: [],
  };
  if (!ua) return result;

  for (const [re, label] of BROWSER_RULES) {
    if (re.test(ua)) {
      result.browser = label;
      break;
    }
  }
  const major = ua.match(/(?:Edg|EdgiOS|OPR|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/);
  if (major) result.browser_major = Number(major[1]);

  for (const [re, label] of IN_APP_RULES) {
    if (re.test(ua)) {
      result.in_app = label;
      break;
    }
  }

  // Operating system (reported).
  if (/iPhone|iPod/.test(ua)) {
    result.os = 'iOS';
    result.device = DEVICE.MOBILE;
  } else if (/iPad/.test(ua)) {
    result.os = 'iPadOS';
    result.device = DEVICE.TABLET;
  } else if (/Android/.test(ua)) {
    result.os = 'Android';
    result.device = /Mobile/.test(ua) ? DEVICE.MOBILE : DEVICE.TABLET;
  } else if (/Windows NT/.test(ua)) {
    result.os = 'Windows';
    result.device = DEVICE.DESKTOP;
  } else if (/CrOS/.test(ua)) {
    result.os = 'ChromeOS';
    result.device = DEVICE.DESKTOP;
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    result.os = 'macOS-compatible';
    result.device = DEVICE.DESKTOP;
    result.notes.push('iPadOS Safari reports a macOS User-Agent by default');
  } else if (/Linux x86_64/.test(ua)) {
    result.os = 'Linux x86_64';
    result.device = DEVICE.DESKTOP;
  } else if (/Linux|X11/.test(ua)) {
    result.os = 'Linux';
    result.device = DEVICE.DESKTOP;
  }

  // Low-entropy User-Agent Client Hints, sent by Chromium browsers.
  if (hints.mobile === '?1' && result.device === DEVICE.DESKTOP) {
    result.notes.push('Client hint Sec-CH-UA-Mobile=?1 contradicts desktop User-Agent');
  }
  return result;
}

export function isBrowserLike(ua) {
  if (!ua) return false;
  return /^Mozilla\/5\.0 \(/.test(ua) && /(AppleWebKit\/|Gecko\/)/.test(ua) && /(Chrome|Chromium|Firefox|Safari|Edg|OPR|FxiOS|CriOS)\//.test(ua);
}

// Platform label from the Sec-CH-UA-Platform hint compared with the parsed UA.
export function platformHintMismatch(parsedOs, platformHint) {
  if (!platformHint) return false;
  const hint = platformHint.replace(/"/g, '').toLowerCase();
  const map = {
    windows: 'Windows',
    macos: 'macOS-compatible',
    android: 'Android',
    'chrome os': 'ChromeOS',
    chromeos: 'ChromeOS',
    linux: ['Linux', 'Linux x86_64'],
    ios: 'iOS',
  };
  const expected = map[hint];
  if (!expected || parsedOs === 'Unknown') return false;
  return Array.isArray(expected) ? !expected.includes(parsedOs) : expected !== parsedOs;
}

// Human-readable "Browser: X (reported)" lines; used in emails.
export function describeReported(parsed) {
  return {
    browser: `${parsed.browser}${parsed.browser_major ? ` ${parsed.browser_major}` : ''} (reported)`,
    os: `${parsed.os} (reported)`,
    device: parsed.device,
    exact_model: 'Unknown',
  };
}
