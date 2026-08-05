import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import {
  resetDatabase,
  closeDatabase,
  ensureSchema,
  setSetting,
  createClass,
  createStudent,
  createAttendanceRecord,
  createUser,
  query,
} from '../helpers/db.js';
import {
  computeAbsenceStreak,
  evaluateStudentStreak,
  refreshAllAlerts,
  listAlerts,
  updateAlertStatus,
} from '../../src/services/alerts.service.js';

/**
 * Reference week for these tests:
 *   Mon 2026-08-03, Tue 04, Wed 05, Thu 06, Fri 07, Sat 08, Sun 09,
 *   Mon 2026-08-10, Tue 11, Wed 12.
 */
describe('absentee alerts (PRD §7.8)', () => {
  let klass;

  beforeAll(ensureSchema);
  afterAll(closeDatabase);

  beforeEach(async () => {
    await resetDatabase();
    klass = await createClass({});
  });

  const markDays = async (studentId, entries) => {
    for (const [date, status] of Object.entries(entries)) {
      await createAttendanceRecord({ studentId, classId: klass.id, date, status });
    }
  };

  describe('computeAbsenceStreak', () => {
    it('counts consecutive absences ending on the given day', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-03': 'present',
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });

      const streak = await computeAbsenceStreak(student.id, '2026-08-06');

      expect(streak).toMatchObject({ days: 3, firstDate: '2026-08-04', lastDate: '2026-08-06' });
    });

    it('counts school days, so a weekend does not break the run', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-06': 'absent', // Thu
        '2026-08-07': 'absent', // Fri
        '2026-08-10': 'absent', // Mon — Sat/Sun are not school days
      });

      const streak = await computeAbsenceStreak(student.id, '2026-08-10');

      expect(streak.days).toBe(3);
      expect(streak.firstDate).toBe('2026-08-06');
    });

    it('skips a holiday in the middle of a run', async () => {
      const student = await createStudent({ classId: klass.id });
      await query(
        "INSERT INTO school_calendar (calendar_date, day_type, label) VALUES ('2026-08-05'::date, 'holiday', 'Public holiday')",
      );
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-06': 'absent',
        '2026-08-07': 'absent',
      });

      expect((await computeAbsenceStreak(student.id, '2026-08-07')).days).toBe(3);
    });

    it('stops at the most recent day the student attended', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-03': 'absent',
        '2026-08-04': 'absent',
        '2026-08-05': 'late',
        '2026-08-06': 'absent',
      });

      expect((await computeAbsenceStreak(student.id, '2026-08-06')).days).toBe(1);
    });

    it('treats an excused absence as handled, not as part of a streak', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'excused',
      });

      // Staff already know about the 6th, so it does not extend the streak.
      expect((await computeAbsenceStreak(student.id, '2026-08-06')).days).toBe(0);
    });

    it('stops at a day that has not been closed yet', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, { '2026-08-04': 'absent', '2026-08-05': 'absent' });

      // The 6th has no record at all — we do not yet know if they came in.
      expect((await computeAbsenceStreak(student.id, '2026-08-06')).days).toBe(0);
    });
  });

  describe('evaluateStudentStreak', () => {
    it('raises an alert once the threshold is reached', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });

      const result = await evaluateStudentStreak(student.id, '2026-08-06');

      expect(result).toMatchObject({ raised: true, streak: 3 });
      const { rows } = await query('SELECT * FROM absentee_alerts');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        student_id: student.id,
        class_id: klass.id,
        consecutive_days: 3,
        first_absent_date: '2026-08-04',
        status: 'open',
      });
    });

    it('does not raise below the threshold', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, { '2026-08-05': 'absent', '2026-08-06': 'absent' });

      expect(await evaluateStudentStreak(student.id, '2026-08-06')).toMatchObject({ raised: false, streak: 2 });
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM absentee_alerts');
      expect(rows[0].count).toBe(0);
    });

    it('extends the existing alert instead of creating a second one', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      await evaluateStudentStreak(student.id, '2026-08-06');

      await markDays(student.id, { '2026-08-07': 'absent' });
      const second = await evaluateStudentStreak(student.id, '2026-08-07');

      expect(second.raised).toBe(false);
      const { rows } = await query('SELECT * FROM absentee_alerts');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ consecutive_days: 4, last_absent_date: '2026-08-07' });
    });

    it('resolves the alert when the student comes back', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      await evaluateStudentStreak(student.id, '2026-08-06');

      await markDays(student.id, { '2026-08-07': 'present' });
      const result = await evaluateStudentStreak(student.id, '2026-08-07');

      expect(result.resolved).toBe(true);
      const { rows } = await query('SELECT status FROM absentee_alerts');
      expect(rows[0].status).toBe('resolved');
    });

    it('resolves when a manual correction turns the absence into an excused day', async () => {
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      await evaluateStudentStreak(student.id, '2026-08-06');

      await createAttendanceRecord({ studentId: student.id, date: '2026-08-06', status: 'excused' });
      const result = await evaluateStudentStreak(student.id, '2026-08-06');

      expect(result.resolved).toBe(true);
    });

    it('honours a changed threshold', async () => {
      await setSetting('consecutive_absence_threshold', 2);
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, { '2026-08-05': 'absent', '2026-08-06': 'absent' });

      expect(await evaluateStudentStreak(student.id, '2026-08-06')).toMatchObject({ raised: true, streak: 2 });
    });
  });

  describe('refreshAllAlerts', () => {
    it('evaluates every enrolled student', async () => {
      const absent = await createStudent({ classId: klass.id, firstName: 'Gone' });
      const here = await createStudent({ classId: klass.id, firstName: 'Here' });
      await markDays(absent.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      await markDays(here.id, { '2026-08-06': 'present' });

      const result = await refreshAllAlerts('2026-08-06');

      expect(result).toMatchObject({ evaluated: 2, raised: 1 });
    });
  });

  describe('alert workflow', () => {
    it('records who acknowledged an alert and when', async () => {
      const staff = await createUser({ email: 'office@test.local', role: 'office_staff' });
      const student = await createStudent({ classId: klass.id });
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      const { alertId } = await evaluateStudentStreak(student.id, '2026-08-06');

      const updated = await updateAlertStatus(alertId, {
        status: 'acknowledged',
        notes: 'Called the guardian, student is unwell',
        actorId: staff.id,
      });

      expect(updated).toMatchObject({ status: 'acknowledged', acknowledged_by: staff.id });
      expect(updated.acknowledged_at).not.toBeNull();
      expect(updated.notes).toMatch(/Called the guardian/);
    });

    it('lists open alerts with the guardian contact staff need to follow up', async () => {
      const student = await createStudent({ classId: klass.id, firstName: 'Neema', lastName: 'Mushi' });
      await query('UPDATE students SET guardian_name = $2, guardian_phone = $3 WHERE id = $1', [
        student.id,
        'Mama Neema',
        '+255700111222',
      ]);
      await markDays(student.id, {
        '2026-08-04': 'absent',
        '2026-08-05': 'absent',
        '2026-08-06': 'absent',
      });
      await evaluateStudentStreak(student.id, '2026-08-06');

      const { data } = await listAlerts({ status: 'open' });

      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        full_name: 'Neema Mushi',
        guardian_name: 'Mama Neema',
        guardian_phone: '+255700111222',
        class_name: klass.name,
        consecutive_days: 3,
      });
    });

    it('scopes the list to a teacher’s own classes', async () => {
      const otherClass = await createClass({ name: 'Form 2A' });
      const mine = await createStudent({ classId: klass.id });
      const theirs = await createStudent({ classId: otherClass.id });
      for (const student of [mine, theirs]) {
        await markDays(student.id, {
          '2026-08-04': 'absent',
          '2026-08-05': 'absent',
          '2026-08-06': 'absent',
        });
        await evaluateStudentStreak(student.id, '2026-08-06');
      }

      const { data } = await listAlerts({ status: 'open', classScope: [klass.id] });

      expect(data).toHaveLength(1);
      expect(data[0].student_id).toBe(mine.id);
    });
  });
});
