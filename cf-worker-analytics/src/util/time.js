// Timestamp formatting. IST is a fixed UTC+05:30 offset (no DST), so we
// compute it directly instead of depending on Intl time-zone data.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function fmt(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export function formatUtc(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${fmt(d)} UTC`;
}

export function formatIst(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${fmt(new Date(d.getTime() + IST_OFFSET_MS))} IST`;
}

export function formatBoth(iso) {
  return `${formatUtc(iso)} / ${formatIst(iso)}`;
}

export function istDate(iso) {
  return formatIst(iso).slice(0, 10);
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function minutesAgoIso(now, minutes) {
  return new Date(now - minutes * 60 * 1000).toISOString();
}

export function daysAgoIso(now, days) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
