/**
 * Presentation helpers.
 *
 * Timestamps arrive as UTC instants; they are rendered in the school's
 * timezone, which the API reports in /api/settings. Formatting anywhere else
 * would silently fall back to the viewer's own timezone and show a 07:12
 * arrival as 04:12 to anyone travelling.
 */

export const STATUS_LABELS = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  excused: 'Excused',
  not_marked: 'Not marked',
  not_recorded: 'No record',
};

export const STATUS_COLORS = {
  present: 'var(--present)',
  late: 'var(--late)',
  absent: 'var(--absent)',
  excused: 'var(--excused)',
  not_marked: 'var(--unmarked)',
  not_recorded: 'var(--unmarked)',
};

export function formatTime(instant, timezone) {
  if (!instant) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(instant));
}

export function formatDateTime(instant, timezone) {
  if (!instant) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(instant));
}

/** Format a plain 'YYYY-MM-DD' without letting it drift across timezones. */
export function formatDate(dateString, { weekday = false } = {}) {
  if (!dateString) return '—';
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-GB', {
    weekday: weekday ? 'short' : undefined,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatShortDate(dateString) {
  if (!dateString) return '';
  const [year, month, day] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

export function formatRelative(minutes) {
  if (minutes === null || minutes === undefined) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatPercent(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
}

export function initials(name) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/** Colour band for an attendance rate, used by meters and rate cells. */
export function rateTone(rate) {
  if (rate >= 90) return 'good';
  if (rate >= 75) return 'warn';
  return 'poor';
}

// --- Date arithmetic for the report pickers (all in plain YYYY-MM-DD) -----

export function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function startOfWeek(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return addDays(dateString, 1 - isoDay);
}

export function startOfMonth(dateString) {
  return `${dateString.slice(0, 7)}-01`;
}
