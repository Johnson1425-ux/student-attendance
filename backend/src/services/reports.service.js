import { query } from '../db/pool.js';
import { getAttendanceConfig } from './settings.service.js';
import { listSchoolDays } from './calendar.service.js';
import { getDailyRegister, getDailySummary } from './attendance.service.js';
import { NotFoundError } from '../lib/errors.js';
import { toLocalTime, todayInZone } from '../lib/dates.js';

/**
 * Reporting (PRD §7.5).
 *
 * One rule runs through all of it: the denominator is *school days*, not
 * calendar days. Every rate below divides by the number of days the school was
 * actually open in the period, so a term with a week-long break does not make
 * the whole school look like 90% attenders.
 *
 * Rates are computed in SQL where the aggregation is, and rounded once at the
 * edge, so the number in a CSV always matches the number on screen.
 */

const rate = (numerator, denominator) =>
  denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;

/**
 * Reports never count days that have not happened yet.
 *
 * Without this, "this month" on the 5th would measure everyone against all 21
 * of the month's school days and report the whole school at 15% attendance.
 * The requested range is kept in the response so the UI can say what it
 * actually covers.
 */
function clampToToday(to, config) {
  const today = todayInZone(config.timezone);
  return to > today ? today : to;
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

export async function dailyReport({ date, classId = null, classScope = null }) {
  const [summary, rows] = await Promise.all([
    getDailySummary({ date, classId, classScope }),
    getDailyRegister({ date, classId, classScope }),
  ]);

  const config = await getAttendanceConfig();
  const schoolDays = await listSchoolDays(date, date, config);

  return {
    type: 'daily',
    date,
    isSchoolDay: schoolDays.length === 1,
    summary,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Range: per student
// ---------------------------------------------------------------------------

/**
 * Per-student totals across a date range — the backbone of the weekly, monthly
 * and per-term reports, which differ only in the range they pass in.
 *
 * `expected_days` counts the school days the student was actually on roll for,
 * so a child who joined mid-term is not penalised for the weeks before they
 * arrived.
 */
export async function studentSummaryReport({
  from,
  to,
  classId = null,
  classScope = null,
  status = 'active',
  minAttendanceRate = null,
  sort = 'name',
}) {
  const config = await getAttendanceConfig();
  const effectiveTo = clampToToday(to, config);
  const schoolDays = await listSchoolDays(from, effectiveTo, config);

  if (schoolDays.length === 0) {
    return { type: 'student_summary', from, to, effectiveTo, schoolDays: 0, rows: [], totals: emptyTotals() };
  }

  const params = [schoolDays, from, effectiveTo];
  const conditions = [];
  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`s.status = $${params.length}::student_status`);
  }
  if (classId) {
    params.push(classId);
    conditions.push(`e.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`e.class_id = ANY($${params.length}::bigint[])`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  // Sorting happens on the outer query, whose only table alias is `r` (the
  // roster CTE); the tally columns are available there as output aliases.
  // This is interpolated into SQL, so only these exact clauses may reach it.
  const SORTS = {
    name: 'r.last_name, r.first_name',
    rate_asc: 'attendance_rate ASC, r.last_name',
    rate_desc: 'attendance_rate DESC, r.last_name',
    absences: 'absent_days DESC, r.last_name',
    lateness: 'late_days DESC, r.last_name',
  };
  const orderBy = Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.name;

  const { rows } = await query(
    `WITH school_days AS (
       SELECT d::date AS day FROM unnest($1::date[]) AS d
     ),
     roster AS (
       SELECT s.id AS student_id, s.admission_number, s.device_user_pin,
              s.first_name, s.middle_name, s.last_name, s.status,
              s.guardian_name, s.guardian_phone,
              c.id AS class_id, c.name AS class_name,
              -- Only days the student was on roll count towards their total.
              (SELECT COUNT(*) FROM school_days sd
                WHERE sd.day >= s.enrolled_on
                  AND (s.exited_on IS NULL OR sd.day <= s.exited_on))::int AS expected_days
         FROM students s
         LEFT JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
         LEFT JOIN classes c ON c.id = e.class_id
        WHERE TRUE ${where}
     ),
     tallies AS (
       SELECT ar.student_id,
              COUNT(*) FILTER (WHERE ar.status = 'present')::int AS present_days,
              COUNT(*) FILTER (WHERE ar.status = 'late')::int    AS late_days,
              COUNT(*) FILTER (WHERE ar.status = 'absent')::int  AS absent_days,
              COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused_days,
              COALESCE(SUM(ar.minutes_late) FILTER (WHERE ar.status = 'late'), 0)::int AS total_minutes_late
         FROM attendance_records ar
         JOIN school_days sd ON sd.day = ar.attendance_date
        WHERE ar.attendance_date BETWEEN $2::date AND $3::date
        GROUP BY ar.student_id
     )
     SELECT r.*,
            COALESCE(t.present_days, 0) AS present_days,
            COALESCE(t.late_days, 0)    AS late_days,
            COALESCE(t.absent_days, 0)  AS absent_days,
            COALESCE(t.excused_days, 0) AS excused_days,
            COALESCE(t.total_minutes_late, 0) AS total_minutes_late,
            GREATEST(
              r.expected_days - COALESCE(t.present_days,0) - COALESCE(t.late_days,0)
                              - COALESCE(t.absent_days,0) - COALESCE(t.excused_days,0),
              0
            ) AS unrecorded_days,
            CASE WHEN r.expected_days > 0
                 THEN ROUND(((COALESCE(t.present_days,0) + COALESCE(t.late_days,0))::numeric
                             / r.expected_days) * 100, 1)
                 ELSE 0 END AS attendance_rate
       FROM roster r
       LEFT JOIN tallies t ON t.student_id = r.student_id
      ORDER BY ${orderBy}`,
    params,
  );

  const filtered =
    minAttendanceRate === null ? rows : rows.filter((r) => Number(r.attendance_rate) <= Number(minAttendanceRate));

  return {
    type: 'student_summary',
    from,
    to,
    effectiveTo,
    schoolDays: schoolDays.length,
    rows: filtered.map((r) => ({
      ...r,
      full_name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
      attendance_rate: Number(r.attendance_rate),
    })),
    totals: aggregateTotals(filtered),
  };
}

function emptyTotals() {
  return {
    students: 0,
    expected_days: 0,
    present_days: 0,
    late_days: 0,
    absent_days: 0,
    excused_days: 0,
    attendance_rate: 0,
  };
}

function aggregateTotals(rows) {
  const totals = rows.reduce(
    (acc, r) => ({
      students: acc.students + 1,
      expected_days: acc.expected_days + Number(r.expected_days),
      present_days: acc.present_days + Number(r.present_days),
      late_days: acc.late_days + Number(r.late_days),
      absent_days: acc.absent_days + Number(r.absent_days),
      excused_days: acc.excused_days + Number(r.excused_days),
    }),
    { students: 0, expected_days: 0, present_days: 0, late_days: 0, absent_days: 0, excused_days: 0 },
  );
  return { ...totals, attendance_rate: rate(totals.present_days + totals.late_days, totals.expected_days) };
}

// ---------------------------------------------------------------------------
// Range: per class
// ---------------------------------------------------------------------------

export async function classSummaryReport({ from, to, classScope = null, academicYear = null }) {
  const config = await getAttendanceConfig();
  const effectiveTo = clampToToday(to, config);
  const schoolDays = await listSchoolDays(from, effectiveTo, config);

  if (schoolDays.length === 0) {
    return { type: 'class_summary', from, to, effectiveTo, schoolDays: 0, rows: [] };
  }

  const params = [schoolDays, from, effectiveTo];
  const conditions = ['c.is_active'];
  if (classScope) {
    params.push(classScope);
    conditions.push(`c.id = ANY($${params.length}::bigint[])`);
  }
  if (academicYear) {
    params.push(academicYear);
    conditions.push(`c.academic_year = $${params.length}`);
  }

  const { rows } = await query(
    `WITH school_days AS (SELECT d::date AS day FROM unnest($1::date[]) AS d),
     roster AS (
       SELECT c.id AS class_id, c.name AS class_name, c.grade_level, c.academic_year,
              s.id AS student_id,
              (SELECT COUNT(*) FROM school_days sd
                WHERE sd.day >= s.enrolled_on
                  AND (s.exited_on IS NULL OR sd.day <= s.exited_on))::int AS expected_days
         FROM classes c
         LEFT JOIN enrollments e ON e.class_id = c.id AND e.end_date IS NULL
         LEFT JOIN students s ON s.id = e.student_id AND s.status = 'active'
        WHERE ${conditions.join(' AND ')}
     ),
     tallies AS (
       SELECT ar.student_id,
              COUNT(*) FILTER (WHERE ar.status = 'present')::int AS present_days,
              COUNT(*) FILTER (WHERE ar.status = 'late')::int    AS late_days,
              COUNT(*) FILTER (WHERE ar.status = 'absent')::int  AS absent_days,
              COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused_days
         FROM attendance_records ar
         JOIN school_days sd ON sd.day = ar.attendance_date
        WHERE ar.attendance_date BETWEEN $2::date AND $3::date
        GROUP BY ar.student_id
     )
     SELECT r.class_id, r.class_name, r.grade_level, r.academic_year,
            COUNT(r.student_id)::int AS student_count,
            COALESCE(SUM(r.expected_days), 0)::int AS expected_days,
            COALESCE(SUM(t.present_days), 0)::int  AS present_days,
            COALESCE(SUM(t.late_days), 0)::int     AS late_days,
            COALESCE(SUM(t.absent_days), 0)::int   AS absent_days,
            COALESCE(SUM(t.excused_days), 0)::int  AS excused_days
       FROM roster r
       LEFT JOIN tallies t ON t.student_id = r.student_id
      GROUP BY r.class_id, r.class_name, r.grade_level, r.academic_year
      ORDER BY r.class_name`,
    params,
  );

  return {
    type: 'class_summary',
    from,
    to,
    effectiveTo,
    schoolDays: schoolDays.length,
    rows: rows.map((r) => ({
      ...r,
      attendance_rate: rate(r.present_days + r.late_days, r.expected_days),
    })),
  };
}

// ---------------------------------------------------------------------------
// Trend over time (dashboard chart + weekly/monthly views)
// ---------------------------------------------------------------------------

export async function attendanceTrend({ from, to, classId = null, classScope = null }) {
  const config = await getAttendanceConfig();
  const effectiveTo = clampToToday(to, config);
  const schoolDays = await listSchoolDays(from, effectiveTo, config);
  if (schoolDays.length === 0) return { type: 'trend', from, to, effectiveTo, rows: [] };

  const params = [schoolDays];
  const conditions = [];
  if (classId) {
    params.push(classId);
    conditions.push(`ar.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`ar.class_id = ANY($${params.length}::bigint[])`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT sd.day AS date,
            COUNT(ar.id)::int AS recorded,
            COUNT(*) FILTER (WHERE ar.status = 'present')::int AS present,
            COUNT(*) FILTER (WHERE ar.status = 'late')::int    AS late,
            COUNT(*) FILTER (WHERE ar.status = 'absent')::int  AS absent,
            COUNT(*) FILTER (WHERE ar.status = 'excused')::int AS excused
       FROM unnest($1::date[]) AS sd(day)
       LEFT JOIN attendance_records ar ON ar.attendance_date = sd.day ${where}
      GROUP BY sd.day
      ORDER BY sd.day`,
    params,
  );

  return {
    type: 'trend',
    from,
    to,
    effectiveTo,
    rows: rows.map((r) => ({
      ...r,
      attendance_rate: rate(r.present + r.late, r.recorded),
    })),
  };
}

// ---------------------------------------------------------------------------
// Single student
// ---------------------------------------------------------------------------

export async function studentReport({ studentId, from, to }) {
  const { rows: studentRows } = await query(
    `SELECT s.id, s.admission_number, s.device_user_pin, s.first_name, s.middle_name, s.last_name,
            s.status, s.enrolled_on, s.exited_on, s.guardian_name, s.guardian_phone,
            c.name AS class_name
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       LEFT JOIN classes c ON c.id = e.class_id
      WHERE s.id = $1`,
    [studentId],
  );
  const student = studentRows[0];
  if (!student) throw new NotFoundError('Student');

  const config = await getAttendanceConfig();
  const effectiveTo = clampToToday(to, config);
  const schoolDays = await listSchoolDays(from, effectiveTo, config);

  const { rows: records } = await query(
    `SELECT ar.attendance_date, ar.status, ar.source, ar.check_in_at, ar.check_out_at,
            ar.minutes_late, ar.is_manual_override, ar.override_reason,
            u.full_name AS recorded_by_name, d.name AS device_name
       FROM attendance_records ar
       LEFT JOIN users u ON u.id = ar.recorded_by
       LEFT JOIN devices d ON d.id = ar.device_id
      WHERE ar.student_id = $1 AND ar.attendance_date BETWEEN $2::date AND $3::date
      ORDER BY ar.attendance_date`,
    [studentId, from, effectiveTo],
  );

  const byDate = new Map(records.map((r) => [r.attendance_date, r]));
  const onRollDays = schoolDays.filter(
    (day) => day >= student.enrolled_on && (!student.exited_on || day <= student.exited_on),
  );

  const days = onRollDays.map((date) => byDate.get(date) ?? { attendance_date: date, status: 'not_recorded' });

  const counts = days.reduce(
    (acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }),
    { present: 0, late: 0, absent: 0, excused: 0, not_recorded: 0 },
  );
  const attended = counts.present + counts.late;

  return {
    type: 'student_detail',
    from,
    to,
    effectiveTo,
    student: {
      ...student,
      full_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
    },
    schoolDays: onRollDays.length,
    summary: {
      ...counts,
      expected_days: onRollDays.length,
      attendance_rate: rate(attended, onRollDays.length),
      total_minutes_late: records.reduce((sum, r) => sum + (r.minutes_late ?? 0), 0),
    },
    days,
  };
}

// ---------------------------------------------------------------------------
// Follow-up lists
// ---------------------------------------------------------------------------

/** Students below an attendance threshold — the follow-up list for the office. */
export async function chronicAbsenteeReport({ from, to, threshold = 80, classScope = null }) {
  const summary = await studentSummaryReport({ from, to, classScope, sort: 'rate_asc' });
  return {
    ...summary,
    type: 'chronic_absentees',
    threshold,
    rows: summary.rows.filter((r) => r.expected_days > 0 && r.attendance_rate < threshold),
  };
}

/** Students most often late, for punctuality follow-up. */
export async function latenessReport({ from, to, classScope = null, minLateDays = 1 }) {
  const summary = await studentSummaryReport({ from, to, classScope, sort: 'lateness' });
  return {
    ...summary,
    type: 'lateness',
    rows: summary.rows
      .filter((r) => r.late_days >= minLateDays)
      .map((r) => ({
        ...r,
        average_minutes_late: r.late_days > 0 ? Math.round(r.total_minutes_late / r.late_days) : 0,
      })),
  };
}

// ---------------------------------------------------------------------------
// Column definitions shared by the CSV and PDF exporters, so both formats of a
// report always show the same fields in the same order.
// ---------------------------------------------------------------------------

export const REPORT_COLUMNS = {
  daily: [
    { key: 'admission_number', label: 'Admission No.', width: 1.2 },
    { key: 'full_name', label: 'Student', width: 2.2 },
    { key: 'class_name', label: 'Class', width: 1.2 },
    { key: 'status', label: 'Status', width: 1, colorByStatus: true },
    { key: 'check_in_local', label: 'Check-in', width: 1.2 },
    { key: 'check_out_local', label: 'Check-out', width: 1.2 },
    { key: 'minutes_late', label: 'Mins late', width: 0.9, align: 'right', map: (r) => r.minutes_late ?? '' },
    { key: 'source', label: 'Source', width: 0.9 },
    { key: 'override_reason', label: 'Note', width: 1.8 },
  ],
  student_summary: [
    { key: 'admission_number', label: 'Admission No.', width: 1.2 },
    { key: 'full_name', label: 'Student', width: 2.2 },
    { key: 'class_name', label: 'Class', width: 1.2 },
    { key: 'expected_days', label: 'School days', width: 1, align: 'right' },
    { key: 'present_days', label: 'Present', width: 0.9, align: 'right' },
    { key: 'late_days', label: 'Late', width: 0.8, align: 'right' },
    { key: 'absent_days', label: 'Absent', width: 0.9, align: 'right' },
    { key: 'excused_days', label: 'Excused', width: 0.9, align: 'right' },
    { key: 'attendance_rate', label: 'Rate %', width: 0.9, align: 'right' },
  ],
  class_summary: [
    { key: 'class_name', label: 'Class', width: 2 },
    { key: 'grade_level', label: 'Grade', width: 1 },
    { key: 'student_count', label: 'Students', width: 1, align: 'right' },
    { key: 'expected_days', label: 'Student-days', width: 1.2, align: 'right' },
    { key: 'present_days', label: 'Present', width: 1, align: 'right' },
    { key: 'late_days', label: 'Late', width: 0.8, align: 'right' },
    { key: 'absent_days', label: 'Absent', width: 1, align: 'right' },
    { key: 'excused_days', label: 'Excused', width: 1, align: 'right' },
    { key: 'attendance_rate', label: 'Rate %', width: 1, align: 'right' },
  ],
  student_detail: [
    { key: 'attendance_date', label: 'Date', width: 1.2 },
    { key: 'status', label: 'Status', width: 1, colorByStatus: true },
    { key: 'check_in_local', label: 'Check-in', width: 1.2 },
    { key: 'check_out_local', label: 'Check-out', width: 1.2 },
    { key: 'minutes_late', label: 'Mins late', width: 1, align: 'right', map: (r) => r.minutes_late ?? '' },
    { key: 'source', label: 'Source', width: 1 },
    { key: 'override_reason', label: 'Note', width: 2 },
  ],
  trend: [
    { key: 'date', label: 'Date', width: 1.2 },
    { key: 'recorded', label: 'Recorded', width: 1, align: 'right' },
    { key: 'present', label: 'Present', width: 1, align: 'right' },
    { key: 'late', label: 'Late', width: 1, align: 'right' },
    { key: 'absent', label: 'Absent', width: 1, align: 'right' },
    { key: 'excused', label: 'Excused', width: 1, align: 'right' },
    { key: 'attendance_rate', label: 'Rate %', width: 1, align: 'right' },
  ],
  chronic_absentees: [
    { key: 'admission_number', label: 'Admission No.', width: 1.2 },
    { key: 'full_name', label: 'Student', width: 2 },
    { key: 'class_name', label: 'Class', width: 1.2 },
    { key: 'guardian_name', label: 'Guardian', width: 1.6 },
    { key: 'guardian_phone', label: 'Phone', width: 1.3 },
    { key: 'absent_days', label: 'Absent', width: 0.9, align: 'right' },
    { key: 'expected_days', label: 'School days', width: 1, align: 'right' },
    { key: 'attendance_rate', label: 'Rate %', width: 0.9, align: 'right' },
  ],
  lateness: [
    { key: 'admission_number', label: 'Admission No.', width: 1.2 },
    { key: 'full_name', label: 'Student', width: 2 },
    { key: 'class_name', label: 'Class', width: 1.2 },
    { key: 'late_days', label: 'Late days', width: 1, align: 'right' },
    { key: 'total_minutes_late', label: 'Total mins', width: 1, align: 'right' },
    { key: 'average_minutes_late', label: 'Avg mins', width: 1, align: 'right' },
    { key: 'attendance_rate', label: 'Rate %', width: 1, align: 'right' },
  ],
};

/**
 * Timestamps are stored as instants but read by people who think in school
 * wall-clock time, so exports show the local time, not UTC.
 */
function localizeRows(rows, timezone) {
  if (!timezone) return rows;
  return rows.map((row) => ({
    ...row,
    check_in_local: row.check_in_at ? toLocalTime(row.check_in_at, timezone).slice(0, 5) : '',
    check_out_local: row.check_out_at ? toLocalTime(row.check_out_at, timezone).slice(0, 5) : '',
  }));
}

/** Build the header lines and summary tiles shared by both export formats. */
export function describeReport(report, { schoolName, classLabel, timezone } = {}) {
  const titles = {
    daily: 'Daily Attendance Register',
    student_summary: 'Attendance Summary by Student',
    class_summary: 'Attendance Summary by Class',
    student_detail: 'Student Attendance History',
    trend: 'Daily Attendance Trend',
    chronic_absentees: 'Students Below Attendance Threshold',
    lateness: 'Lateness Report',
  };

  // When the requested range ran past today the report only covers up to
  // today; say so rather than implying it measured days that never happened.
  const rangeEnd = report.effectiveTo ?? report.to;
  const period =
    report.type === 'daily'
      ? report.date
      : `${report.from} to ${rangeEnd}${report.effectiveTo && report.effectiveTo < report.to ? ' (to date)' : ''}`;

  const subtitleParts = [period];
  if (classLabel) subtitleParts.push(classLabel);
  if (report.schoolDays !== undefined) subtitleParts.push(`${report.schoolDays} school day(s)`);
  if (report.type === 'student_detail') subtitleParts.push(report.student.full_name);

  const summary = [];
  if (report.type === 'daily') {
    summary.push(
      { label: 'Expected', value: report.summary.expected },
      { label: 'Present', value: report.summary.present },
      { label: 'Late', value: report.summary.late },
      { label: 'Absent', value: report.summary.absent },
      { label: 'Rate', value: `${report.summary.attendanceRate}%` },
    );
  } else if (report.totals) {
    summary.push(
      { label: 'Students', value: report.totals.students },
      { label: 'Present', value: report.totals.present_days },
      { label: 'Late', value: report.totals.late_days },
      { label: 'Absent', value: report.totals.absent_days },
      { label: 'Rate', value: `${report.totals.attendance_rate}%` },
    );
  } else if (report.type === 'student_detail') {
    summary.push(
      { label: 'School days', value: report.summary.expected_days },
      { label: 'Present', value: report.summary.present },
      { label: 'Late', value: report.summary.late },
      { label: 'Absent', value: report.summary.absent },
      { label: 'Rate', value: `${report.summary.attendance_rate}%` },
    );
  }

  return {
    title: titles[report.type] ?? 'Attendance Report',
    subtitle: subtitleParts.filter(Boolean).join('  ·  '),
    schoolName,
    summary,
    columns: REPORT_COLUMNS[report.type] ?? [],
    rows: localizeRows(report.rows ?? report.days ?? [], timezone),
  };
}
