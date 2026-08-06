import { createHash } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { getAttendanceConfig } from './settings.service.js';
import { isSchoolDay, listSchoolDays } from './calendar.service.js';
import { recordAudit } from './audit.service.js';
import { evaluateStudentStreak } from './alerts.service.js';
import { describeVerifyMode, isBiometricVerification } from '../lib/adms/protocol.js';
import {
  parseDeviceTimestamp,
  toLocalDate,
  toLocalTime,
  todayInZone,
  minutesSinceMidnight,
  localToInstant,
} from '../lib/dates.js';
import { BadRequestError, NotFoundError, ConflictError } from '../lib/errors.js';
import { logger } from '../config/logger.js';

/**
 * The attendance engine.
 *
 * Data flows in one direction:
 *
 *   raw punch  →  attendance_events (immutable, deduplicated)
 *              →  attendance_records (one row per student per day)
 *              →  dashboard / reports / alerts
 *
 * attendance_records is a derived, correctable view of the ledger. A manual
 * override edits the record but never the events, so "what the terminal
 * actually saw" stays recoverable — that is the audit trail the PRD asks for.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Decide present vs late from the arrival time. Anything at or before the
 * configured cut-off is on time; after it the record also carries how many
 * minutes late, which is what the "chronic lateness" report ranks on.
 */
export function classifyArrival(localTime, config) {
  const arrivalMinutes = minutesSinceMidnight(localTime);
  if (arrivalMinutes <= config.lateAfterMinutes) {
    return { status: 'present', minutesLate: 0 };
  }
  return { status: 'late', minutesLate: arrivalMinutes - config.startMinutes };
}

/**
 * Stable identity for a punch. The same physical scan re-sent by the terminal
 * after a network retry produces the same hash and is silently ignored, which
 * is what makes ingestion safe to repeat (PRD §8 reliability).
 */
export function eventDedupeHash({ serialNumber, pin, timestamp, punchState }) {
  return createHash('sha256')
    .update(`${serialNumber}|${pin}|${timestamp}|${punchState ?? ''}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Persist a batch of parsed ATTLOG records and fold them into daily records.
 *
 * Returns a per-batch summary: how many events were new, how many were repeats,
 * and how many referred to a PIN with no matching student (which surfaces in
 * the dashboard as "unlinked scans" needing office staff attention).
 */
export async function ingestPunches({ device, records }) {
  const config = await getAttendanceConfig();
  const summary = { received: records.length, stored: 0, duplicates: 0, unmatched: 0, invalid: 0, applied: 0 };
  if (records.length === 0) return summary;

  const pins = [...new Set(records.map((r) => r.pin))];
  const { rows: studentRows } = await query(
    `SELECT s.id, s.device_user_pin, s.status,
            (SELECT e.class_id FROM enrollments e WHERE e.student_id = s.id AND e.end_date IS NULL LIMIT 1) AS class_id
       FROM students s
      WHERE s.device_user_pin = ANY($1::text[])`,
    [pins],
  );
  const studentByPin = new Map(studentRows.map((r) => [r.device_user_pin, r]));

  const touched = new Map(); // `${studentId}:${date}` → { studentId, date }

  for (const record of records) {
    const eventTime = parseDeviceTimestamp(record.timestamp, config.timezone);
    if (!eventTime) {
      summary.invalid += 1;
      logger.warn({ raw: record.raw, serial: device.serial_number }, 'Unparseable punch timestamp');
      continue;
    }

    const student = studentByPin.get(record.pin) ?? null;
    if (!student) summary.unmatched += 1;

    const localDate = toLocalDate(eventTime, config.timezone);
    const localTime = toLocalTime(eventTime, config.timezone);
    const dedupeHash = eventDedupeHash({
      serialNumber: device.serial_number,
      pin: record.pin,
      timestamp: record.timestamp,
      punchState: record.punchState,
    });

    const { rows } = await query(
      `INSERT INTO attendance_events
         (device_id, device_serial, device_user_pin, student_id, event_time, local_date, local_time,
          punch_state, verify_mode, work_code, raw_line, dedupe_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (dedupe_hash) DO NOTHING
       RETURNING id`,
      [
        device.id,
        device.serial_number,
        record.pin,
        student?.id ?? null,
        eventTime,
        localDate,
        localTime,
        record.punchState,
        record.verifyMode,
        record.workCode,
        record.raw?.slice(0, 500) ?? null,
        dedupeHash,
      ],
    );

    if (rows.length === 0) {
      summary.duplicates += 1;
      continue;
    }
    summary.stored += 1;

    // Only students who exist and are still on roll affect the daily register.
    if (student && student.status === 'active') {
      touched.set(`${student.id}:${localDate}`, { studentId: student.id, date: localDate });
    }
  }

  for (const { studentId, date } of touched.values()) {
    await rebuildDailyRecord(studentId, date, config);
    summary.applied += 1;
  }

  await query('UPDATE devices SET last_push_at = now(), last_seen_at = now() WHERE id = $1', [device.id]);
  return summary;
}

/**
 * Recompute one student's record for one day from the event ledger.
 *
 * Idempotent by construction: it always derives from the full set of events for
 * that day, so replaying a batch or re-running the nightly job converges on the
 * same answer. A manual override is never clobbered — staff correction wins
 * over the device until an operator explicitly clears it.
 */
export async function rebuildDailyRecord(studentId, date, config) {
  const cfg = config ?? (await getAttendanceConfig());

  return withTransaction(async (client) => {
    const { rows: events } = await client.query(
      `SELECT id, event_time, local_time, device_id
         FROM attendance_events
        WHERE student_id = $1 AND local_date = $2::date
        ORDER BY event_time ASC`,
      [studentId, date],
    );
    if (events.length === 0) return null;

    const first = events[0];
    // A check-out only counts once the student has actually been in school for
    // a while; two scans a minute apart are a retried finger, not a departure.
    const gapMs = cfg.minimumCheckoutGapMinutes * 60_000;
    const last = [...events]
      .reverse()
      .find((e) => new Date(e.event_time).getTime() - new Date(first.event_time).getTime() >= gapMs);

    const { status, minutesLate } = classifyArrival(first.local_time, cfg);

    const { rows: classRows } = await client.query(
      `SELECT class_id FROM enrollments WHERE student_id = $1 AND end_date IS NULL LIMIT 1`,
      [studentId],
    );
    const classId = classRows[0]?.class_id ?? null;

    const { rows } = await client.query(
      `INSERT INTO attendance_records
         (student_id, class_id, attendance_date, status, source, check_in_at, check_out_at,
          minutes_late, device_id, first_event_id, last_event_id)
       VALUES ($1,$2,$3::date,$4,'device',$5,$6,$7,$8,$9,$10)
       ON CONFLICT (student_id, attendance_date) DO UPDATE SET
         -- Manual corrections are authoritative; device data only refreshes the
         -- underlying timestamps beneath them.
         status        = CASE WHEN attendance_records.is_manual_override THEN attendance_records.status ELSE EXCLUDED.status END,
         source        = CASE WHEN attendance_records.is_manual_override THEN attendance_records.source ELSE 'device'::attendance_source END,
         minutes_late  = CASE WHEN attendance_records.is_manual_override THEN attendance_records.minutes_late ELSE EXCLUDED.minutes_late END,
         class_id      = COALESCE(EXCLUDED.class_id, attendance_records.class_id),
         check_in_at   = EXCLUDED.check_in_at,
         check_out_at  = EXCLUDED.check_out_at,
         device_id     = EXCLUDED.device_id,
         first_event_id = EXCLUDED.first_event_id,
         last_event_id  = EXCLUDED.last_event_id
       RETURNING *`,
      [
        studentId,
        classId,
        date,
        status,
        first.event_time,
        last ? last.event_time : null,
        minutesLate,
        first.device_id,
        first.id,
        last ? last.id : first.id,
      ],
    );

    await client.query(
      'UPDATE attendance_events SET applied = TRUE WHERE student_id = $1 AND local_date = $2::date',
      [studentId, date],
    );

    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Day finalisation — turning "no scan" into an explicit absence
// ---------------------------------------------------------------------------

/**
 * Mark every enrolled student without a record for `date` as absent.
 *
 * Absence is the absence of evidence, so it is only meaningful once the day is
 * over and only on an actual school day. Running this twice is harmless: the
 * insert skips students who already have a record.
 */
export async function finalizeDay(date, { actorId = null, force = false } = {}) {
  const config = await getAttendanceConfig();

  if (!force && !(await isSchoolDay(date, config))) {
    return { date, skipped: true, reason: 'not_a_school_day', markedAbsent: 0 };
  }
  if (!force && date > todayInZone(config.timezone)) {
    return { date, skipped: true, reason: 'future_date', markedAbsent: 0 };
  }

  const { rows } = await query(
    `INSERT INTO attendance_records
       (student_id, class_id, attendance_date, status, source, finalized_at, recorded_by)
     SELECT s.id, e.class_id, $1::date, 'absent', 'system', now(), $2
       FROM students s
       JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
      WHERE s.status = 'active'
        AND s.enrolled_on <= $1::date
        AND (s.exited_on IS NULL OR s.exited_on >= $1::date)
     ON CONFLICT (student_id, attendance_date) DO NOTHING
     RETURNING student_id`,
    [date, actorId],
  );

  await query(
    `UPDATE attendance_records SET finalized_at = now()
      WHERE attendance_date = $1::date AND finalized_at IS NULL`,
    [date],
  );

  const alerts = await refreshAlertsForDate(date, config);

  return { date, skipped: false, markedAbsent: rows.length, alertsRaised: alerts.raised, alertsResolved: alerts.resolved };
}

/** Re-evaluate absence streaks for everyone touched by `date`. */
async function refreshAlertsForDate(date, config) {
  const { rows } = await query(
    `SELECT DISTINCT student_id FROM attendance_records WHERE attendance_date = $1::date`,
    [date],
  );
  let raised = 0;
  let resolved = 0;
  for (const { student_id: studentId } of rows) {
    const result = await evaluateStudentStreak(studentId, date, config);
    if (result.raised) raised += 1;
    if (result.resolved) resolved += 1;
  }
  return { raised, resolved };
}

/** Finalise every unfinalised school day in a range (catch-up after downtime). */
export async function finalizeRange(fromDate, toDate, options = {}) {
  const config = await getAttendanceConfig();
  const days = await listSchoolDays(fromDate, toDate, config);
  const results = [];
  for (const day of days) {
    results.push(await finalizeDay(day, options));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Manual override (PRD §7.6)
// ---------------------------------------------------------------------------

const OVERRIDE_STATUSES = new Set(['present', 'late', 'absent', 'excused']);

/**
 * Staff correction of a single student-day. Every override is attributed and
 * requires a reason, because "why is this marked present with no scan?" is the
 * first question an audit asks.
 */
export async function setAttendanceManually({
  studentId,
  date,
  status,
  reason,
  checkInTime,
  actor,
  ip,
  userAgent,
}) {
  if (!OVERRIDE_STATUSES.has(status)) throw new BadRequestError(`Unsupported status "${status}"`);
  const config = await getAttendanceConfig();

  if (date > todayInZone(config.timezone)) {
    throw new BadRequestError('Attendance cannot be recorded for a future date');
  }

  const { rows: studentRows } = await query(
    `SELECT s.id, s.status, s.first_name, s.last_name,
            (SELECT e.class_id FROM enrollments e WHERE e.student_id = s.id AND e.end_date IS NULL LIMIT 1) AS class_id
       FROM students s WHERE s.id = $1`,
    [studentId],
  );
  const student = studentRows[0];
  if (!student) throw new NotFoundError('Student');
  if (student.status !== 'active') {
    throw new ConflictError('Attendance can only be recorded for students who are currently on roll');
  }

  const checkInAt =
    status === 'absent'
      ? null
      : checkInTime
        ? localToInstant(date, checkInTime, config.timezone)
        : null;

  const minutesLate =
    status === 'late' && checkInTime
      ? Math.max(minutesSinceMidnight(checkInTime) - config.startMinutes, 0)
      : status === 'late'
        ? null
        : 0;

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      'SELECT * FROM attendance_records WHERE student_id = $1 AND attendance_date = $2::date',
      [studentId, date],
    );
    const before = existingRows[0] ?? null;

    const { rows } = await client.query(
      `INSERT INTO attendance_records
         (student_id, class_id, attendance_date, status, source, check_in_at, minutes_late,
          is_manual_override, override_reason, recorded_by)
       VALUES ($1,$2,$3::date,$4,'manual',$5,$6,TRUE,$7,$8)
       ON CONFLICT (student_id, attendance_date) DO UPDATE SET
         status             = EXCLUDED.status,
         source             = 'manual'::attendance_source,
         check_in_at        = COALESCE(EXCLUDED.check_in_at, attendance_records.check_in_at),
         minutes_late       = COALESCE(EXCLUDED.minutes_late, attendance_records.minutes_late),
         is_manual_override = TRUE,
         override_reason    = EXCLUDED.override_reason,
         recorded_by        = EXCLUDED.recorded_by,
         class_id           = COALESCE(EXCLUDED.class_id, attendance_records.class_id)
       RETURNING *`,
      [studentId, student.class_id, date, status, checkInAt, minutesLate, reason ?? null, actor?.id ?? null],
    );

    await recordAudit(
      {
        actorId: actor?.id,
        actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
        action: before ? 'attendance.override' : 'attendance.manual_create',
        entityType: 'attendance_record',
        entityId: rows[0].id,
        summary: `${student.first_name} ${student.last_name} on ${date}: ${before?.status ?? 'no record'} → ${status}`,
        before,
        after: rows[0],
        ip,
        userAgent,
      },
      client,
    );

    return rows[0];
  }).then(async (record) => {
    await evaluateStudentStreak(studentId, date, config);
    return record;
  });
}

/**
 * Drop a manual override and fall back to whatever the terminal recorded. If
 * there are no events for that day the record is removed entirely, so the
 * nightly finalisation can decide afresh.
 */
export async function clearManualOverride({ studentId, date, actor, ip, userAgent }) {
  const config = await getAttendanceConfig();
  const { rows: existing } = await query(
    'SELECT * FROM attendance_records WHERE student_id = $1 AND attendance_date = $2::date',
    [studentId, date],
  );
  const record = existing[0];
  if (!record) throw new NotFoundError('Attendance record');
  if (!record.is_manual_override) throw new BadRequestError('This record is not a manual override');

  await query(
    'UPDATE attendance_records SET is_manual_override = FALSE, override_reason = NULL WHERE id = $1',
    [record.id],
  );

  const rebuilt = await rebuildDailyRecord(studentId, date, config);
  if (!rebuilt) {
    await query('DELETE FROM attendance_records WHERE id = $1', [record.id]);
  }

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'attendance.override_cleared',
    entityType: 'attendance_record',
    entityId: record.id,
    summary: `Cleared manual override for student ${studentId} on ${date}`,
    before: record,
    after: rebuilt,
    ip,
    userAgent,
  });

  await evaluateStudentStreak(studentId, date, config);
  return rebuilt;
}

/**
 * Apply the same status to many students at once — the practical way to record
 * a class trip or to correct a morning when the terminal was offline.
 */
export async function bulkSetAttendance({ studentIds, date, status, reason, actor, ip, userAgent }) {
  const results = { updated: [], failed: [] };
  for (const studentId of studentIds) {
    try {
      const record = await setAttendanceManually({ studentId, date, status, reason, actor, ip, userAgent });
      results.updated.push(record);
    } catch (err) {
      results.failed.push({ studentId, reason: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The daily register: every student expected on `date` with their status.
 *
 * Built with a LEFT JOIN from the roster rather than from attendance_records,
 * so a student who has not scanned yet appears as "not yet arrived" instead of
 * silently vanishing from the list.
 */
export async function getDailyRegister({ date, classId = null, classScope = null, status = null, search = null }) {
  const params = [date];
  const conditions = [];

  if (classId) {
    params.push(classId);
    conditions.push(`e.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`e.class_id = ANY($${params.length}::bigint[])`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(
      `(lower(s.first_name || ' ' || s.last_name) LIKE $${params.length} OR lower(s.admission_number) LIKE $${params.length})`,
    );
  }
  if (status === 'not_marked') {
    conditions.push('ar.id IS NULL');
  } else if (status) {
    params.push(status);
    conditions.push(`ar.status = $${params.length}::attendance_status`);
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT s.id AS student_id, s.admission_number, s.device_user_pin,
            s.first_name, s.middle_name, s.last_name,
            s.guardian_name, s.guardian_phone,
            c.id AS class_id, c.name AS class_name,
            ar.id AS record_id, ar.status, ar.source, ar.check_in_at, ar.check_out_at,
            ar.minutes_late, ar.is_manual_override, ar.override_reason, ar.finalized_at,
            u.full_name AS recorded_by_name,
            d.name AS device_name,
            fev.verify_mode
       FROM students s
       JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       JOIN classes c ON c.id = e.class_id
       LEFT JOIN attendance_records ar
              ON ar.student_id = s.id AND ar.attendance_date = $1::date
       LEFT JOIN users u ON u.id = ar.recorded_by
       LEFT JOIN devices d ON d.id = ar.device_id
       -- The arrival punch is what the status was derived from, so its
       -- verification method is the one worth reporting.
       LEFT JOIN attendance_events fev ON fev.id = ar.first_event_id
      WHERE s.status = 'active'
        AND s.enrolled_on <= $1::date
        AND (s.exited_on IS NULL OR s.exited_on >= $1::date)
        ${where}
      ORDER BY c.name, s.last_name, s.first_name`,
    params,
  );

  return rows.map((row) => ({
    ...row,
    status: row.status ?? 'not_marked',
    full_name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
    ...describeVerification(row.verify_mode),
  }));
}

/**
 * Turn the raw ADMS verify mode into something a screen can render.
 *
 * `verified_biometrically` is deliberately three-valued: false means the
 * terminal accepted a PIN or a card, which is a proxy-attendance risk worth
 * flagging; null means we simply have no record of how they were verified
 * (a manual correction, or a day with no punch at all).
 */
function describeVerification(mode) {
  if (mode === null || mode === undefined) {
    return { verify_method: null, verified_biometrically: null };
  }
  return {
    verify_method: describeVerifyMode(mode),
    verified_biometrically: isBiometricVerification(mode),
  };
}

/** Headline counts for a date, optionally narrowed to one class. */
export async function getDailySummary({ date, classId = null, classScope = null }) {
  const params = [date];
  const conditions = [];
  if (classId) {
    params.push(classId);
    conditions.push(`e.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`e.class_id = ANY($${params.length}::bigint[])`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS expected,
       COUNT(*) FILTER (WHERE ar.status = 'present')::int AS present,
       COUNT(*) FILTER (WHERE ar.status = 'late')::int    AS late,
       COUNT(*) FILTER (WHERE ar.status = 'absent')::int  AS absent,
       COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused,
       COUNT(*) FILTER (WHERE ar.id IS NULL)::int         AS not_marked
     FROM students s
     JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
     LEFT JOIN attendance_records ar ON ar.student_id = s.id AND ar.attendance_date = $1::date
    WHERE s.status = 'active'
      AND s.enrolled_on <= $1::date
      AND (s.exited_on IS NULL OR s.exited_on >= $1::date)
      ${where}`,
    params,
  );

  const summary = rows[0];
  const inSchool = summary.present + summary.late;
  return {
    date,
    ...summary,
    inSchool,
    attendanceRate: summary.expected > 0 ? Number(((inSchool / summary.expected) * 100).toFixed(1)) : 0,
  };
}

/** Per-class breakdown for the dashboard. */
export async function getClassBreakdown({ date, classScope = null }) {
  const params = [date];
  let where = '';
  if (classScope) {
    params.push(classScope);
    where = `AND c.id = ANY($${params.length}::bigint[])`;
  }

  const { rows } = await query(
    `SELECT c.id AS class_id, c.name AS class_name, c.grade_level,
            COUNT(s.id)::int AS expected,
            COUNT(*) FILTER (WHERE ar.status = 'present')::int AS present,
            COUNT(*) FILTER (WHERE ar.status = 'late')::int    AS late,
            COUNT(*) FILTER (WHERE ar.status = 'absent')::int  AS absent,
            COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused,
            COUNT(*) FILTER (WHERE ar.id IS NULL)::int         AS not_marked
       FROM classes c
       LEFT JOIN enrollments e ON e.class_id = c.id AND e.end_date IS NULL
       LEFT JOIN students s ON s.id = e.student_id
                           AND s.status = 'active'
                           AND s.enrolled_on <= $1::date
                           AND (s.exited_on IS NULL OR s.exited_on >= $1::date)
       LEFT JOIN attendance_records ar ON ar.student_id = s.id AND ar.attendance_date = $1::date
      WHERE c.is_active ${where}
      GROUP BY c.id, c.name, c.grade_level
      ORDER BY c.name`,
    params,
  );

  return rows.map((r) => ({
    ...r,
    inSchool: r.present + r.late,
    attendanceRate: r.expected > 0 ? Number((((r.present + r.late) / r.expected) * 100).toFixed(1)) : 0,
  }));
}

/** Most recent scans, for the dashboard's live arrivals feed. */
export async function getRecentEvents({ limit = 25, classScope = null, date = null } = {}) {
  const params = [Math.min(Number(limit) || 25, 200)];
  const conditions = [];
  if (date) {
    params.push(date);
    conditions.push(`ev.local_date = $${params.length}::date`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(
      `EXISTS (SELECT 1 FROM enrollments en WHERE en.student_id = ev.student_id AND en.end_date IS NULL AND en.class_id = ANY($${params.length}::bigint[]))`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT ev.id, ev.event_time, ev.local_date, ev.local_time, ev.device_user_pin,
            ev.verify_mode, ev.punch_state,
            s.id AS student_id, s.first_name, s.last_name, s.admission_number,
            c.name AS class_name, d.name AS device_name,
            ar.status
       FROM attendance_events ev
       LEFT JOIN students s ON s.id = ev.student_id
       LEFT JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN devices d ON d.id = ev.device_id
       LEFT JOIN attendance_records ar ON ar.student_id = ev.student_id AND ar.attendance_date = ev.local_date
       ${where}
      ORDER BY ev.event_time DESC
      LIMIT $1`,
    params,
  );
  return rows.map((row) => ({ ...row, ...describeVerification(row.verify_mode) }));
}

/** Scans whose PIN matches no student — enrollment gaps needing office action. */
export async function getUnmatchedEvents({ limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT ev.device_user_pin, d.name AS device_name, d.serial_number,
            COUNT(*)::int AS scan_count,
            MIN(ev.event_time) AS first_seen,
            MAX(ev.event_time) AS last_seen
       FROM attendance_events ev
       LEFT JOIN devices d ON d.id = ev.device_id
      WHERE ev.student_id IS NULL
      GROUP BY ev.device_user_pin, d.name, d.serial_number
      ORDER BY MAX(ev.event_time) DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

/**
 * Attach previously unmatched events to a student. Used after office staff link
 * a device PIN to a record, so the student's history is not left with a hole.
 */
export async function backfillEventsForPin(pin, studentId) {
  const { rows } = await query(
    `WITH claimed AS (
       UPDATE attendance_events SET student_id = $2
        WHERE device_user_pin = $1 AND student_id IS NULL
        RETURNING local_date
     )
     SELECT DISTINCT local_date FROM claimed`,
    [pin, studentId],
  );
  const config = await getAttendanceConfig();
  for (const { local_date: date } of rows) {
    await rebuildDailyRecord(studentId, date, config);
  }
  return rows.map((r) => r.local_date);
}

/** One student's day-by-day history over a range. */
export async function getStudentHistory({ studentId, from, to }) {
  const { rows } = await query(
    `SELECT ar.attendance_date, ar.status, ar.source, ar.check_in_at, ar.check_out_at,
            ar.minutes_late, ar.is_manual_override, ar.override_reason,
            c.name AS class_name, u.full_name AS recorded_by_name, d.name AS device_name
       FROM attendance_records ar
       LEFT JOIN classes c ON c.id = ar.class_id
       LEFT JOIN users u ON u.id = ar.recorded_by
       LEFT JOIN devices d ON d.id = ar.device_id
      WHERE ar.student_id = $1 AND ar.attendance_date BETWEEN $2::date AND $3::date
      ORDER BY ar.attendance_date DESC`,
    [studentId, from, to],
  );
  return rows;
}

export async function getAttendanceRecord(studentId, date) {
  const { rows } = await query(
    'SELECT * FROM attendance_records WHERE student_id = $1 AND attendance_date = $2::date',
    [studentId, date],
  );
  return rows[0] ?? null;
}
