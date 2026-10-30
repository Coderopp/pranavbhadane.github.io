// IP address helpers: CIDR matching (IPv4 and IPv6), reverse-DNS names and
// salted hashing for pseudonymous rate-limit keys.

function parseIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

export function expandIPv6(ip) {
  if (!ip.includes(':')) return null;
  let addr = ip.split('%')[0];
  // IPv4-mapped tail, e.g. ::ffff:1.2.3.4
  const v4tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const v4 = parseIPv4(v4tail[1]);
    if (v4 === null) return null;
    const hi = Number(v4 >> 16n).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    addr = addr.slice(0, -v4tail[1].length) + `${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.toLowerCase().padStart(4, '0'));
}

function parseIPv6(ip) {
  const groups = expandIPv6(ip);
  if (!groups) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function parseIP(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    const v = parseIPv6(ip);
    return v === null ? null : { version: 6, value: v };
  }
  const v = parseIPv4(ip);
  return v === null ? null : { version: 4, value: v };
}

export function ipInCidr(ip, cidr) {
  const parsed = typeof ip === 'string' ? parseIP(ip) : ip;
  if (!parsed) return false;
  const [base, bitsStr] = cidr.split('/');
  const net = parseIP(base);
  if (!net || net.version !== parsed.version) return false;
  const width = parsed.version === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? width : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  if (bits === 0) return true;
  const shift = BigInt(width - bits);
  return parsed.value >> shift === net.value >> shift;
}

export function reverseDnsName(ip) {
  const parsed = parseIP(ip);
  if (!parsed) return null;
  if (parsed.version === 4) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  return `${expandIPv6(ip).join('').split('').reverse().join('.')}.ip6.arpa`;
}

export async function hashIp(ip, salt) {
  if (!ip) return null;
  const data = new TextEncoder().encode(`${salt || 'unsalted'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
