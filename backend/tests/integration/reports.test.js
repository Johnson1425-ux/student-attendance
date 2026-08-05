import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import {
  resetDatabase,
  closeDatabase,
  ensureSchema,
  createClass,
  createStudent,
  createAttendanceRecord,
  query,
} from '../helpers/db.js';
import {
  studentSummaryReport,
  classSummaryReport,
  attendanceTrend,
  studentReport,
  chronicAbsenteeReport,
  latenessReport,
  describeReport,
} from '../../src/services/reports.service.js';
import { listSchoolDays, countSchoolDays } from '../../src/services/calendar.service.js';
import { addDays, startOfIsoWeek, todayInZone } from '../../src/lib/dates.js';

/**
 * Tests run against the most recent *completed* Monday-to-Friday week.
 *
 * Anchoring to the calendar rather than to hard-coded dates keeps the suite
 * honest: reports refuse to count days that have not happened yet, so a fixed
 * date range would start failing the moment the system clock passed it.
 */
const LAST_MONDAY = addDays(startOfIsoWeek(todayInZone('Africa/Dar_es_Salaam')), -7);
const DAYS = [0, 1, 2, 3, 4].map((offset) => addDays(LAST_MONDAY, offset));
const WEEK = { from: DAYS[0], to: DAYS[4] };
const HOLIDAY = DAYS[2];
const WORKING_SATURDAY = addDays(LAST_MONDAY, 5);

describe('reports', () => {
  let klass;

  beforeAll(ensureSchema);
  afterAll(closeDatabase);

  beforeEach(async () => {
    await resetDatabase();
    klass = await createClass({});
  });

  const markWeek = async (studentId, statuses) => {
    for (const [i, status] of statuses.entries()) {
      if (!status) continue;
      await createAttendanceRecord({ studentId, classId: klass.id, date: DAYS[i], status });
    }
  };

  describe('school-day denominators', () => {
    it('excludes weekends', async () => {
      expect(await listSchoolDays(DAYS[0], addDays(LAST_MONDAY, 6))).toEqual(DAYS);
    });

    it('excludes a holiday and includes a working Saturday', async () => {
      await query(
        `INSERT INTO school_calendar (calendar_date, day_type, label) VALUES
           ($1::date, 'holiday', 'Public holiday'),
           ($2::date, 'school_day', 'Catch-up Saturday')`,
        [HOLIDAY, WORKING_SATURDAY],
      );

      const days = await listSchoolDays(DAYS[0], addDays(LAST_MONDAY, 6));

      expect(days).not.toContain(HOLIDAY);
      expect(days).toContain(WORKING_SATURDAY);
      expect(await countSchoolDays(DAYS[0], addDays(LAST_MONDAY, 6))).toBe(5);
    });
  });

  describe('studentSummaryReport', () => {
    it('totals each status and computes the rate against school days', async () => {
      const student = await createStudent({ classId: klass.id, firstName: 'Asha', lastName: 'Mushi' });
      await markWeek(student.id, ['present', 'present', 'late', 'absent', 'present']);

      const report = await studentSummaryReport(WEEK);

      expect(report.schoolDays).toBe(5);
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        full_name: 'Asha Mushi',
        expected_days: 5,
        present_days: 3,
        late_days: 1,
        absent_days: 1,
        // Late still counts as attending: 4 of 5 days in school.
        attendance_rate: 80,
      });
    });

    it('does not penalise a student for days before they joined', async () => {
      const student = await createStudent({ classId: klass.id, enrolledOn: DAYS[3] });
      await markWeek(student.id, [null, null, null, 'present', 'present']);

      const report = await studentSummaryReport(WEEK);

      expect(report.rows[0]).toMatchObject({ expected_days: 2, present_days: 2, attendance_rate: 100 });
    });

    it('does not count days after a student left', async () => {
      const student = await createStudent({ classId: klass.id });
      await query('UPDATE students SET exited_on = $2::date WHERE id = $1', [student.id, DAYS[1]]);
      await markWeek(student.id, ['present', 'present', null, null, null]);

      expect((await studentSummaryReport(WEEK)).rows[0]).toMatchObject({
        expected_days: 2,
        attendance_rate: 100,
      });
    });

    it('never counts days that have not happened yet', async () => {
      const student = await createStudent({ classId: klass.id });
      await markWeek(student.id, ['present', 'present', 'present', 'present', 'present']);
      const today = todayInZone('Africa/Dar_es_Salaam');

      // Asking for a range that runs years into the future must give exactly
      // the same answer as asking for the same range up to today.
      const openEnded = await studentSummaryReport({ from: WEEK.from, to: '2099-12-31' });
      const bounded = await studentSummaryReport({ from: WEEK.from, to: today });

      expect(openEnded.effectiveTo).toBe(today);
      expect(openEnded.schoolDays).toBe(bounded.schoolDays);
      expect(openEnded.rows[0].expected_days).toBe(bounded.rows[0].expected_days);
      expect(openEnded.rows[0].attendance_rate).toBe(bounded.rows[0].attendance_rate);
    });

    it('rolls the per-student figures up into totals', async () => {
      const a = await createStudent({ classId: klass.id });
      const b = await createStudent({ classId: klass.id });
      await markWeek(a.id, ['present', 'present', 'present', 'present', 'present']);
      await markWeek(b.id, ['absent', 'absent', 'absent', 'absent', 'absent']);

      const report = await studentSummaryReport(WEEK);

      expect(report.totals).toMatchObject({
        students: 2,
        expected_days: 10,
        present_days: 5,
        absent_days: 5,
        attendance_rate: 50,
      });
    });

    it('sorts by attendance rate when asked', async () => {
      const good = await createStudent({ classId: klass.id, lastName: 'Aaa' });
      const poor = await createStudent({ classId: klass.id, lastName: 'Zzz' });
      await markWeek(good.id, ['present', 'present', 'present', 'present', 'present']);
      await markWeek(poor.id, ['absent', 'absent', 'absent', 'absent', 'present']);

      const report = await studentSummaryReport({ ...WEEK, sort: 'rate_asc' });

      expect(report.rows.map((r) => r.student_id)).toEqual([poor.id, good.id]);
    });

    it('restricts a teacher to their own classes', async () => {
      const other = await createClass({ name: 'Form 2A' });
      const mine = await createStudent({ classId: klass.id });
      const theirs = await createStudent({ classId: other.id });
      await markWeek(mine.id, ['present']);
      await markWeek(theirs.id, ['present']);

      const report = await studentSummaryReport({ ...WEEK, classScope: [klass.id] });

      expect(report.rows.map((r) => r.student_id)).toEqual([mine.id]);
    });
  });

  describe('classSummaryReport', () => {
    it('aggregates per class', async () => {
      const other = await createClass({ name: 'Form 2A' });
      const a = await createStudent({ classId: klass.id });
      const b = await createStudent({ classId: other.id });
      await markWeek(a.id, ['present', 'present', 'present', 'present', 'absent']);
      await markWeek(b.id, ['absent', 'absent', 'present', 'present', 'present']);

      const report = await classSummaryReport(WEEK);

      const first = report.rows.find((r) => r.class_id === klass.id);
      const second = report.rows.find((r) => r.class_id === other.id);
      expect(first).toMatchObject({ student_count: 1, present_days: 4, absent_days: 1, attendance_rate: 80 });
      expect(second).toMatchObject({ student_count: 1, present_days: 3, absent_days: 2, attendance_rate: 60 });
    });

    it('reports an empty class without dividing by zero', async () => {
      const report = await classSummaryReport(WEEK);
      expect(report.rows[0]).toMatchObject({ student_count: 0, attendance_rate: 0 });
    });
  });

  describe('attendanceTrend', () => {
    it('returns one row per school day', async () => {
      const student = await createStudent({ classId: klass.id });
      await markWeek(student.id, ['present', 'late', 'absent', 'present', 'present']);

      const report = await attendanceTrend(WEEK);

      expect(report.rows).toHaveLength(5);
      expect(report.rows.map((r) => r.date)).toEqual(DAYS);
      expect(report.rows[2]).toMatchObject({ absent: 1, present: 0, attendance_rate: 0 });
    });
  });

  describe('studentReport', () => {
    it('lists every school day, including ones with no record', async () => {
      const student = await createStudent({ classId: klass.id });
      await markWeek(student.id, ['present', 'present', null, 'absent', 'present']);

      const report = await studentReport({ studentId: student.id, ...WEEK });

      expect(report.days).toHaveLength(5);
      expect(report.days[2].status).toBe('not_recorded');
      expect(report.summary).toMatchObject({ present: 3, absent: 1, not_recorded: 1, expected_days: 5 });
      expect(report.summary.attendance_rate).toBe(60);
    });

    it('rejects an unknown student', async () => {
      await expect(studentReport({ studentId: 999_999, ...WEEK })).rejects.toThrow(/not found/i);
    });
  });

  describe('follow-up lists', () => {
    it('lists only students below the threshold', async () => {
      const good = await createStudent({ classId: klass.id });
      const poor = await createStudent({ classId: klass.id });
      await markWeek(good.id, ['present', 'present', 'present', 'present', 'present']);
      await markWeek(poor.id, ['absent', 'absent', 'absent', 'present', 'present']);

      const report = await chronicAbsenteeReport({ ...WEEK, threshold: 80 });

      expect(report.rows.map((r) => r.student_id)).toEqual([poor.id]);
      expect(report.rows[0].attendance_rate).toBe(40);
    });

    it('ranks lateness and reports the average delay', async () => {
      const student = await createStudent({ classId: klass.id });
      await markWeek(student.id, ['late', 'late', 'present', 'present', 'present']);
      await query(
        "UPDATE attendance_records SET minutes_late = 20 WHERE student_id = $1 AND status = 'late'",
        [student.id],
      );

      const report = await latenessReport(WEEK);

      expect(report.rows[0]).toMatchObject({ late_days: 2, total_minutes_late: 40, average_minutes_late: 20 });
    });
  });

  describe('describeReport', () => {
    it('produces matching headers, columns and rows for the exporters', async () => {
      const student = await createStudent({ classId: klass.id, firstName: 'Asha', lastName: 'Mushi' });
      await markWeek(student.id, ['present', 'present', 'present', 'present', 'absent']);
      const report = await studentSummaryReport(WEEK);

      const described = describeReport(report, { schoolName: 'Test School', timezone: 'Africa/Dar_es_Salaam' });

      expect(described.title).toBe('Attendance Summary by Student');
      expect(described.subtitle).toContain(`${WEEK.from} to ${WEEK.to}`);
      expect(described.subtitle).toContain('5 school day(s)');
      expect(described.columns.map((c) => c.key)).toContain('attendance_rate');
      expect(described.rows).toHaveLength(1);
      expect(described.summary.find((s) => s.label === 'Rate').value).toBe('80%');
    });

    it('flags a range that was cut short at today', async () => {
      await createStudent({ classId: klass.id });
      const report = await studentSummaryReport({ from: WEEK.from, to: '2099-12-31' });

      expect(describeReport(report, {}).subtitle).toContain('(to date)');
    });
  });
});
