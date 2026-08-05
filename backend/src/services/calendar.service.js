import { query } from '../db/pool.js';
import { getAttendanceConfig } from './settings.service.js';
import { eachDateInclusive, isoWeekday, isValidDateString } from '../lib/dates.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

/**
 * The school calendar decides which dates attendance is expected on.
 *
 * Two layers, in priority order:
 *   1. An explicit school_calendar row for the date (holiday, break, or a
 *      Saturday deliberately marked as a school day).
 *   2. Otherwise the weekly pattern from settings.school_days_of_week.
 *
 * Getting this right matters for every rate the system reports: counting the
 * mid-term break as absence would make a 95% attender look like a truant.
 */

export async function getCalendarOverrides(fromDate, toDate) {
  const { rows } = await query(
    `SELECT calendar_date, day_type, label FROM school_calendar
      WHERE calendar_date BETWEEN $1::date AND $2::date`,
    [fromDate, toDate],
  );
  return new Map(rows.map((r) => [r.calendar_date, r]));
}

/**
 * School days within an inclusive range, as 'YYYY-MM-DD' strings.
 */
export async function listSchoolDays(fromDate, toDate, config) {
  const cfg = config ?? (await getAttendanceConfig());
  const overrides = await getCalendarOverrides(fromDate, toDate);
  const weeklyPattern = new Set(cfg.schoolDaysOfWeek);

  return eachDateInclusive(fromDate, toDate).filter((date) => {
    const override = overrides.get(date);
    if (override) return override.day_type === 'school_day';
    return weeklyPattern.has(isoWeekday(date));
  });
}

/** Whether a single date is a school day. */
export async function isSchoolDay(date, config) {
  const days = await listSchoolDays(date, date, config);
  return days.length === 1;
}

/** Count of school days in a range — the denominator of every attendance rate. */
export async function countSchoolDays(fromDate, toDate, config) {
  return (await listSchoolDays(fromDate, toDate, config)).length;
}

/**
 * Calendar view for the dashboard: every date in the range with its resolved
 * type and the reason, so staff can see why a day was skipped.
 */
export async function describeRange(fromDate, toDate) {
  const cfg = await getAttendanceConfig();
  const overrides = await getCalendarOverrides(fromDate, toDate);
  const weeklyPattern = new Set(cfg.schoolDaysOfWeek);

  return eachDateInclusive(fromDate, toDate).map((date) => {
    const override = overrides.get(date);
    if (override) {
      return {
        date,
        dayType: override.day_type,
        label: override.label,
        isSchoolDay: override.day_type === 'school_day',
        source: 'calendar',
      };
    }
    const inPattern = weeklyPattern.has(isoWeekday(date));
    return {
      date,
      dayType: inPattern ? 'school_day' : 'weekend',
      label: null,
      isSchoolDay: inPattern,
      source: 'weekly_pattern',
    };
  });
}

export async function listCalendarEntries({ from, to } = {}) {
  const conditions = [];
  const params = [];
  if (from) {
    params.push(from);
    conditions.push(`calendar_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    conditions.push(`calendar_date <= $${params.length}::date`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT c.calendar_date, c.day_type, c.label, c.created_at, u.full_name AS created_by_name
       FROM school_calendar c
       LEFT JOIN users u ON u.id = c.created_by
       ${where}
      ORDER BY c.calendar_date`,
    params,
  );
  return rows;
}

/**
 * Create or replace calendar entries. Accepts a single date or an inclusive
 * range, which is how a week-long break is entered in one action.
 */
export async function upsertCalendarEntry({ date, endDate, dayType, label }, actorId) {
  if (!isValidDateString(date)) throw new BadRequestError('date must be YYYY-MM-DD');
  const last = endDate ?? date;
  if (!isValidDateString(last)) throw new BadRequestError('endDate must be YYYY-MM-DD');
  if (last < date) throw new BadRequestError('endDate cannot be before date');

  const dates = eachDateInclusive(date, last);
  if (dates.length > 400) throw new BadRequestError('Cannot set more than 400 days in one request');

  const { rows } = await query(
    `INSERT INTO school_calendar (calendar_date, day_type, label, created_by)
     SELECT d::date, $2::day_type, $3, $4 FROM unnest($1::date[]) AS d
     ON CONFLICT (calendar_date)
       DO UPDATE SET day_type = EXCLUDED.day_type, label = EXCLUDED.label, created_by = EXCLUDED.created_by
     RETURNING calendar_date, day_type, label`,
    [dates, dayType, label ?? null, actorId ?? null],
  );
  return rows;
}

export async function deleteCalendarEntry(date) {
  const { rowCount } = await query('DELETE FROM school_calendar WHERE calendar_date = $1::date', [date]);
  if (rowCount === 0) throw new NotFoundError('Calendar entry');
}
