import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);

export const DATE_FORMAT = 'YYYY-MM-DD';

/**
 * Everything in this module answers one question: which *school day* does a
 * given instant belong to, and what does the clock on the wall say?
 *
 * The server may run in UTC on Render while the school lives in UTC+3. Getting
 * this wrong shifts every 07:30 arrival onto the previous day, so all
 * conversions go through an explicit IANA timezone rather than the host clock.
 */

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The current calendar date at the school, as 'YYYY-MM-DD'. */
export function todayInZone(tz) {
  return dayjs().tz(tz).format(DATE_FORMAT);
}

/** The calendar date an instant falls on at the school. */
export function toLocalDate(instant, tz) {
  return dayjs(instant).tz(tz).format(DATE_FORMAT);
}

/** The wall-clock time (HH:mm:ss) an instant falls on at the school. */
export function toLocalTime(instant, tz) {
  return dayjs(instant).tz(tz).format('HH:mm:ss');
}

/** Combine a local date and local time into an absolute instant. */
export function localToInstant(dateStr, timeStr, tz) {
  const normalized = `${dateStr} ${padTime(timeStr)}`;
  // Same guard as parseDeviceTimestamp: check validity before handing the
  // string to the timezone plugin, which throws rather than returning invalid.
  if (!dayjs(normalized, 'YYYY-MM-DD HH:mm:ss', true).isValid()) {
    throw new Error(`Cannot interpret "${normalized}" in timezone ${tz}`);
  }
  return dayjs.tz(normalized, 'YYYY-MM-DD HH:mm:ss', tz).toDate();
}

/** Normalise 'H:m', 'HH:mm' or 'HH:mm:ss' to 'HH:mm:ss'. */
export function padTime(timeStr) {
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2 || parts.length > 3) throw new Error(`Invalid time "${timeStr}"`);
  const [h, m, s = '0'] = parts;
  const pad = (v) => String(Number(v)).padStart(2, '0');
  if ([h, m, s].some((v) => Number.isNaN(Number(v)))) throw new Error(`Invalid time "${timeStr}"`);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Minutes since local midnight, e.g. '07:45' → 465. */
export function minutesSinceMidnight(timeStr) {
  const [h, m, s] = padTime(timeStr).split(':').map(Number);
  return h * 60 + m + Math.floor(s / 60);
}

/**
 * Parse a timestamp exactly as a ZKTeco terminal writes it ("YYYY-MM-DD
 * HH:mm:ss", occasionally with 'T' or a trailing fraction) and anchor it to the
 * school timezone. Terminals send wall-clock time with no offset, so the
 * timezone must come from configuration.
 */
export function parseDeviceTimestamp(raw, tz) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace('T', ' ').replace(/\.\d+$/, '');
  const formats = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY/MM/DD HH:mm:ss'];

  for (const format of formats) {
    // Validate with the plain parser first. dayjs.tz() throws a RangeError on
    // input it cannot interpret rather than returning an invalid instance, so
    // a corrupt line from the terminal would otherwise take down the batch.
    const naive = dayjs(cleaned, format, true);
    if (!naive.isValid() || naive.format(format) !== cleaned) continue;
    return dayjs.tz(cleaned, format, tz).toDate();
  }
  return null;
}

/** Inclusive list of 'YYYY-MM-DD' strings between two dates. */
export function eachDateInclusive(fromDate, toDate) {
  const start = dayjs(fromDate, DATE_FORMAT, true);
  const end = dayjs(toDate, DATE_FORMAT, true);
  if (!start.isValid() || !end.isValid()) throw new Error('Invalid date range');
  if (end.isBefore(start)) return [];
  const out = [];
  for (let d = start; !d.isAfter(end); d = d.add(1, 'day')) out.push(d.format(DATE_FORMAT));
  return out;
}

/** ISO weekday for a date string: 1 = Monday … 7 = Sunday. */
export function isoWeekday(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).isoWeekday();
}

export function addDays(dateStr, days) {
  return dayjs(dateStr, DATE_FORMAT, true).add(days, 'day').format(DATE_FORMAT);
}

export function startOfIsoWeek(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).isoWeekday(1).format(DATE_FORMAT);
}

export function endOfIsoWeek(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).isoWeekday(7).format(DATE_FORMAT);
}

export function startOfMonth(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).startOf('month').format(DATE_FORMAT);
}

export function endOfMonth(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).endOf('month').format(DATE_FORMAT);
}

export function isValidDateString(value) {
  return typeof value === 'string' && dayjs(value, DATE_FORMAT, true).isValid();
}

/** Human-readable label used in report headers, e.g. "Mon, 05 Aug 2026". */
export function formatDateLong(dateStr) {
  return dayjs(dateStr, DATE_FORMAT, true).format('ddd, DD MMM YYYY');
}

export { dayjs };
