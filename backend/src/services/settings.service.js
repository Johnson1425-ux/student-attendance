import { query } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { isValidTimezone, padTime, minutesSinceMidnight } from '../lib/dates.js';

/**
 * School configuration. Almost every attendance decision (which timezone, when
 * "late" starts, how many absences raise an alert) reads from here, so values
 * are cached in memory for a few seconds and invalidated on write. Without the
 * cache a single dashboard load would issue a settings query per student.
 */

const CACHE_TTL_MS = 15_000;
let cache = null;
let cacheExpiresAt = 0;

export function invalidateSettingsCache() {
  cache = null;
  cacheExpiresAt = 0;
}

const DEFAULTS = {
  school_name: 'School',
  timezone: 'Africa/Dar_es_Salaam',
  school_start_time: '07:30',
  late_after_time: '07:45',
  school_end_time: '15:30',
  attendance_cutoff_time: '23:59',
  school_days_of_week: [1, 2, 3, 4, 5],
  consecutive_absence_threshold: 3,
  duplicate_punch_window_minutes: 2,
  minimum_checkout_gap_minutes: 60,
  auto_finalize_enabled: true,
  report_footer_note: '',
};

/** All settings as a plain object, with defaults filled in for missing keys. */
export async function getSettings({ force = false } = {}) {
  if (!force && cache && Date.now() < cacheExpiresAt) return cache;
  const { rows } = await query('SELECT key, value FROM settings');
  const values = { ...DEFAULTS };
  for (const row of rows) values[row.key] = row.value;
  cache = Object.freeze(values);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cache;
}

/** Settings plus derived values used across the attendance engine. */
export async function getAttendanceConfig() {
  const s = await getSettings();
  return {
    timezone: s.timezone,
    schoolName: s.school_name,
    startTime: padTime(s.school_start_time),
    lateAfterTime: padTime(s.late_after_time),
    lateAfterMinutes: minutesSinceMidnight(s.late_after_time),
    startMinutes: minutesSinceMidnight(s.school_start_time),
    endTime: padTime(s.school_end_time),
    schoolDaysOfWeek: s.school_days_of_week,
    consecutiveAbsenceThreshold: Number(s.consecutive_absence_threshold),
    duplicateWindowMinutes: Number(s.duplicate_punch_window_minutes),
    minimumCheckoutGapMinutes: Number(s.minimum_checkout_gap_minutes),
    autoFinalizeEnabled: Boolean(s.auto_finalize_enabled),
    reportFooterNote: s.report_footer_note,
  };
}

export async function listSettings() {
  const { rows } = await query(
    `SELECT s.key, s.value, s.description, s.updated_at, u.full_name AS updated_by_name
       FROM settings s
       LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY s.key`,
  );
  return rows;
}

/**
 * Validators keyed by setting. A bad timezone or an end time before the start
 * time would corrupt every subsequent attendance calculation, so these are
 * rejected at the boundary rather than defended against downstream.
 */
const VALIDATORS = {
  school_name: (v) => (typeof v === 'string' && v.trim().length > 0 ? null : 'must be a non-empty name'),
  timezone: (v) => (typeof v === 'string' && isValidTimezone(v) ? null : 'must be a valid IANA timezone'),
  school_start_time: validTime,
  late_after_time: validTime,
  school_end_time: validTime,
  attendance_cutoff_time: validTime,
  school_days_of_week: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      ? null
      : 'must be a non-empty array of ISO weekdays (1-7)',
  consecutive_absence_threshold: (v) =>
    Number.isInteger(v) && v >= 1 && v <= 60 ? null : 'must be a whole number between 1 and 60',
  duplicate_punch_window_minutes: (v) =>
    Number.isInteger(v) && v >= 0 && v <= 240 ? null : 'must be a whole number between 0 and 240',
  minimum_checkout_gap_minutes: (v) =>
    Number.isInteger(v) && v >= 0 && v <= 1440 ? null : 'must be a whole number between 0 and 1440',
  auto_finalize_enabled: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  report_footer_note: (v) => (typeof v === 'string' ? null : 'must be text'),
};

function validTime(v) {
  if (typeof v !== 'string') return 'must be a time string like "07:30"';
  try {
    padTime(v);
    return null;
  } catch {
    return 'must be a time string like "07:30"';
  }
}

/**
 * Apply a partial settings update. Validated as a whole so cross-field rules
 * (late-after must not precede the start of day) see the post-update state.
 */
export async function updateSettings(patch, actorId) {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new BadRequestError('No settings provided');

  const unknown = keys.filter((k) => !(k in VALIDATORS));
  if (unknown.length) throw new BadRequestError(`Unknown setting(s): ${unknown.join(', ')}`);

  const fieldErrors = {};
  for (const key of keys) {
    const problem = VALIDATORS[key](patch[key]);
    if (problem) fieldErrors[key] = problem;
  }
  if (Object.keys(fieldErrors).length) {
    throw new BadRequestError('One or more settings are invalid', fieldErrors);
  }

  const merged = { ...(await getSettings({ force: true })), ...patch };
  if (minutesSinceMidnight(merged.late_after_time) < minutesSinceMidnight(merged.school_start_time)) {
    throw new BadRequestError('The late cut-off cannot be earlier than the school start time', {
      late_after_time: 'must be at or after school_start_time',
    });
  }
  if (minutesSinceMidnight(merged.school_end_time) <= minutesSinceMidnight(merged.school_start_time)) {
    throw new BadRequestError('The school end time must be after the start time', {
      school_end_time: 'must be after school_start_time',
    });
  }

  for (const key of keys) {
    const { rowCount } = await query(
      `UPDATE settings SET value = $2::jsonb, updated_at = now(), updated_by = $3 WHERE key = $1`,
      [key, JSON.stringify(patch[key]), actorId ?? null],
    );
    if (rowCount === 0) {
      await query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(patch[key]), actorId ?? null],
      );
    }
  }

  invalidateSettingsCache();
  return getSettings({ force: true });
}

export async function getSetting(key) {
  const settings = await getSettings();
  if (!(key in settings)) throw new NotFoundError('Setting');
  return settings[key];
}
