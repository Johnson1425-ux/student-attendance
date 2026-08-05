import { query } from '../db/pool.js';
import { getAttendanceConfig } from './settings.service.js';
import { listSchoolDays } from './calendar.service.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';
import { addDays } from '../lib/dates.js';

/**
 * Absentee alerts (PRD §7.8): flag a student who has been absent for X
 * consecutive school days.
 *
 * "Consecutive" is counted in *school* days, walking backwards and skipping
 * weekends and holidays. Counting calendar days instead would let a Friday
 * absence plus a Monday absence look like a three-day streak, and a genuine
 * three-day streak over a mid-term break would never fire.
 */

/**
 * Walk backwards from `throughDate` over school days and return the length of
 * the current unbroken absence run, plus the date it started.
 *
 * Only 'absent' breaks the run — an excused absence is a known, explained
 * absence and staff have already handled it, so it stops the alert rather than
 * feeding it. A day with no record at all (not yet finalised) also stops the
 * walk, because we do not know yet whether the student turned up.
 */
export async function computeAbsenceStreak(studentId, throughDate, config) {
  const cfg = config ?? (await getAttendanceConfig());
  // 90 days back is far more than any alert threshold and bounds the scan.
  const windowStart = addDays(throughDate, -90);
  const schoolDays = await listSchoolDays(windowStart, throughDate, cfg);
  if (schoolDays.length === 0) return { days: 0, firstDate: null, lastDate: null };

  const { rows } = await query(
    `SELECT attendance_date, status FROM attendance_records
      WHERE student_id = $1 AND attendance_date BETWEEN $2::date AND $3::date`,
    [studentId, windowStart, throughDate],
  );
  const statusByDate = new Map(rows.map((r) => [r.attendance_date, r.status]));

  let days = 0;
  let firstDate = null;
  let lastDate = null;

  for (let i = schoolDays.length - 1; i >= 0; i -= 1) {
    const date = schoolDays[i];
    const status = statusByDate.get(date);
    if (status !== 'absent') break;
    days += 1;
    firstDate = date;
    if (!lastDate) lastDate = date;
  }

  return { days, firstDate, lastDate };
}

/**
 * Re-evaluate one student's alert state after their attendance changed.
 *
 * Idempotent: an existing open alert for the same streak is extended rather
 * than duplicated, and a streak that has been broken (or corrected away by a
 * manual override) resolves the alert automatically.
 */
export async function evaluateStudentStreak(studentId, throughDate, config) {
  const cfg = config ?? (await getAttendanceConfig());
  const threshold = cfg.consecutiveAbsenceThreshold;
  const streak = await computeAbsenceStreak(studentId, throughDate, cfg);

  if (streak.days < threshold) {
    // The student has attended since — close anything still open for them.
    const { rowCount } = await query(
      `UPDATE absentee_alerts
          SET status = 'resolved', resolved_at = now()
        WHERE student_id = $1 AND status IN ('open', 'acknowledged')`,
      [studentId],
    );
    return { raised: false, resolved: rowCount > 0, streak: streak.days };
  }

  const { rows: classRows } = await query(
    'SELECT class_id FROM enrollments WHERE student_id = $1 AND end_date IS NULL LIMIT 1',
    [studentId],
  );

  const { rows } = await query(
    `INSERT INTO absentee_alerts
       (student_id, class_id, consecutive_days, first_absent_date, last_absent_date)
     VALUES ($1, $2, $3, $4::date, $5::date)
     ON CONFLICT (student_id, first_absent_date) DO UPDATE SET
       consecutive_days = EXCLUDED.consecutive_days,
       last_absent_date = EXCLUDED.last_absent_date,
       class_id         = EXCLUDED.class_id,
       -- A streak that grows again after being resolved is a live problem.
       status           = CASE WHEN absentee_alerts.status = 'resolved' THEN 'open'::alert_status ELSE absentee_alerts.status END,
       resolved_at      = CASE WHEN absentee_alerts.status = 'resolved' THEN NULL ELSE absentee_alerts.resolved_at END
     RETURNING id, (xmax = 0) AS is_new`,
    [studentId, classRows[0]?.class_id ?? null, streak.days, streak.firstDate, streak.lastDate],
  );

  // Any older streak for this student is superseded.
  await query(
    `UPDATE absentee_alerts SET status = 'resolved', resolved_at = now()
      WHERE student_id = $1 AND id <> $2 AND status IN ('open', 'acknowledged')`,
    [studentId, rows[0].id],
  );

  return { raised: rows[0].is_new, resolved: false, streak: streak.days, alertId: rows[0].id };
}

/**
 * Full sweep across all active students. Run nightly after finalisation and
 * available on demand, so an admin who changes the threshold sees it applied
 * without waiting for the next scheduled run.
 */
export async function refreshAllAlerts(throughDate) {
  const config = await getAttendanceConfig();
  const { rows: students } = await query(
    `SELECT s.id FROM students s
       JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
      WHERE s.status = 'active'`,
  );

  let raised = 0;
  let resolved = 0;
  for (const { id } of students) {
    const result = await evaluateStudentStreak(id, throughDate, config);
    if (result.raised) raised += 1;
    if (result.resolved) resolved += 1;
  }
  return { evaluated: students.length, raised, resolved, throughDate };
}

export async function listAlerts({ status = 'open', classScope = null, classId = null, page = 1, pageSize = 50 } = {}) {
  const params = [];
  const conditions = [];

  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`a.status = $${params.length}::alert_status`);
  }
  if (classId) {
    params.push(classId);
    conditions.push(`a.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`a.class_id = ANY($${params.length}::bigint[])`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const { rows } = await query(
    `SELECT a.*, s.first_name, s.last_name, s.admission_number,
            s.guardian_name, s.guardian_phone,
            c.name AS class_name, u.full_name AS acknowledged_by_name,
            COUNT(*) OVER () AS total_count
       FROM absentee_alerts a
       JOIN students s ON s.id = a.student_id
       LEFT JOIN classes c ON c.id = a.class_id
       LEFT JOIN users u ON u.id = a.acknowledged_by
       ${where}
      ORDER BY a.consecutive_days DESC, a.last_absent_date DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    data: rows.map(({ total_count, ...row }) => ({
      ...row,
      full_name: `${row.first_name} ${row.last_name}`,
    })),
    pagination: { page: Math.max(Number(page) || 1, 1), pageSize: limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function countOpenAlerts(classScope = null) {
  const params = [];
  let scope = '';
  if (classScope) {
    params.push(classScope);
    scope = `AND class_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM absentee_alerts WHERE status = 'open' ${scope}`,
    params,
  );
  return rows[0].count;
}

const ALERT_TRANSITIONS = {
  acknowledged: `status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()`,
  resolved: `status = 'resolved', resolved_at = now(), acknowledged_by = COALESCE(acknowledged_by, $2)`,
  open: `status = 'open', acknowledged_by = NULL, acknowledged_at = NULL, resolved_at = NULL`,
};

export async function updateAlertStatus(alertId, { status, notes, actorId }) {
  const assignment = ALERT_TRANSITIONS[status];
  if (!assignment) throw new BadRequestError(`Unsupported alert status "${status}"`);

  const { rows } = await query(
    `UPDATE absentee_alerts
        SET ${assignment}, notes = COALESCE($3, notes)
      WHERE id = $1
      RETURNING *`,
    [alertId, actorId ?? null, notes ?? null],
  );
  if (!rows[0]) throw new NotFoundError('Alert');
  return rows[0];
}
