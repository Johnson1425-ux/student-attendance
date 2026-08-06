import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import {
  resetDatabase,
  closeDatabase,
  ensureSchema,
  setSetting,
  createUser,
  createClass,
  createStudent,
  createDevice,
  query,
} from '../helpers/db.js';
import {
  ingestPunches,
  classifyArrival,
  eventDedupeHash,
  finalizeDay,
  setAttendanceManually,
  clearManualOverride,
  getDailyRegister,
  getDailySummary,
  rebuildDailyRecord,
} from '../../src/services/attendance.service.js';
import { getAttendanceConfig } from '../../src/services/settings.service.js';

const DATE = '2026-08-05'; // a Wednesday
const punch = (pin, time, extra = {}) => ({
  pin,
  timestamp: `${DATE} ${time}`,
  punchState: 0,
  verifyMode: 1,
  raw: `${pin}\t${DATE} ${time}\t0\t1`,
  ...extra,
});

describe('attendance engine', () => {
  let device;
  let klass;

  beforeAll(ensureSchema);
  afterAll(closeDatabase);

  beforeEach(async () => {
    await resetDatabase();
    device = await createDevice({});
    klass = await createClass({});
  });

  describe('classifyArrival', () => {
    it('marks an arrival at or before the cut-off as present', async () => {
      const config = await getAttendanceConfig();
      expect(classifyArrival('07:00:00', config)).toEqual({ status: 'present', minutesLate: 0 });
      // Exactly on the cut-off is still on time — the boundary belongs to the
      // student, not the machine.
      expect(classifyArrival('07:45:00', config)).toEqual({ status: 'present', minutesLate: 0 });
    });

    it('marks a later arrival as late, counted from the start of the school day', async () => {
      const config = await getAttendanceConfig();
      expect(classifyArrival('07:46:00', config)).toEqual({ status: 'late', minutesLate: 16 });
      expect(classifyArrival('08:30:00', config)).toEqual({ status: 'late', minutesLate: 60 });
    });

    it('judges lateness by the minute, not the second', async () => {
      const config = await getAttendanceConfig();
      // The cut-off is a bell time, not a stopwatch: anyone who scans during
      // the 07:45 minute is on time.
      expect(classifyArrival('07:45:59', config).status).toBe('present');
    });
  });

  describe('ingestPunches', () => {
    it('records a punch and derives the daily record', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      const summary = await ingestPunches({ device, records: [punch('1001', '07:12:44')] });

      expect(summary).toMatchObject({ received: 1, stored: 1, duplicates: 0, unmatched: 0 });

      const { rows } = await query('SELECT * FROM attendance_records WHERE student_id = $1', [student.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        attendance_date: DATE,
        status: 'present',
        source: 'device',
        class_id: klass.id,
      });
      expect(new Date(rows[0].check_in_at).toISOString()).toBe('2026-08-05T04:12:44.000Z');
    });

    it('never creates a second record for the same student on the same day', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      await ingestPunches({
        device,
        records: [punch('1001', '07:12:44'), punch('1001', '07:13:10'), punch('1001', '12:40:00')],
      });

      const { rows } = await query('SELECT COUNT(*)::int AS count FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      expect(rows[0].count).toBe(1);
    });

    it('ignores a replayed batch, so a retry after a network failure is safe', async () => {
      await createStudent({ pin: '1001', classId: klass.id });
      const batch = [punch('1001', '07:12:44'), punch('1001', '07:20:00')];

      const first = await ingestPunches({ device, records: batch });
      const second = await ingestPunches({ device, records: batch });

      expect(first).toMatchObject({ stored: 2, duplicates: 0 });
      expect(second).toMatchObject({ stored: 0, duplicates: 2 });

      const { rows } = await query('SELECT COUNT(*)::int AS count FROM attendance_events');
      expect(rows[0].count).toBe(2);
    });

    it('takes the earliest punch as check-in even when they arrive out of order', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      await ingestPunches({
        device,
        records: [punch('1001', '09:30:00'), punch('1001', '07:05:00')],
      });

      const { rows } = await query('SELECT check_in_at, status FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      expect(new Date(rows[0].check_in_at).toISOString()).toBe('2026-08-05T04:05:00.000Z');
      expect(rows[0].status).toBe('present');
    });

    it('treats a second scan long after arrival as a check-out', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      await ingestPunches({ device, records: [punch('1001', '07:10:00'), punch('1001', '15:40:00')] });

      const { rows } = await query('SELECT check_in_at, check_out_at FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      expect(new Date(rows[0].check_out_at).toISOString()).toBe('2026-08-05T12:40:00.000Z');
    });

    it('does not treat a re-scanned finger a minute later as leaving', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      await ingestPunches({ device, records: [punch('1001', '07:10:00'), punch('1001', '07:11:20')] });

      const { rows } = await query('SELECT check_out_at FROM attendance_records WHERE student_id = $1', [student.id]);
      expect(rows[0].check_out_at).toBeNull();
    });

    it('stores a punch from an unknown PIN without inventing a student', async () => {
      const summary = await ingestPunches({ device, records: [punch('9999', '07:12:44')] });

      expect(summary).toMatchObject({ stored: 1, unmatched: 1, applied: 0 });
      const { rows } = await query('SELECT student_id FROM attendance_events WHERE device_user_pin = $1', ['9999']);
      expect(rows[0].student_id).toBeNull();
    });

    it('counts an unparseable timestamp as invalid instead of failing the batch', async () => {
      await createStudent({ pin: '1001', classId: klass.id });

      const summary = await ingestPunches({
        device,
        records: [
          { pin: '1001', timestamp: 'garbage', punchState: 0, verifyMode: 1, raw: 'x' },
          punch('1001', '07:12:44'),
        ],
      });

      expect(summary).toMatchObject({ received: 2, invalid: 1, stored: 1 });
    });

    it('ignores punches for a student who has left the school', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id, status: 'transferred' });

      await ingestPunches({ device, records: [punch('1001', '07:12:44')] });

      const { rows } = await query('SELECT COUNT(*)::int AS count FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      expect(rows[0].count).toBe(0);
    });

    it('gives the same dedupe hash for identical punches and different ones otherwise', () => {
      const base = { serialNumber: 'SN1', pin: '1001', timestamp: `${DATE} 07:00:00`, punchState: 0 };
      expect(eventDedupeHash(base)).toBe(eventDedupeHash({ ...base }));
      expect(eventDedupeHash(base)).not.toBe(eventDedupeHash({ ...base, pin: '1002' }));
      expect(eventDedupeHash(base)).not.toBe(eventDedupeHash({ ...base, serialNumber: 'SN2' }));
      expect(eventDedupeHash(base)).not.toBe(eventDedupeHash({ ...base, timestamp: `${DATE} 07:00:01` }));
    });
  });

  describe('finalizeDay', () => {
    it('marks students with no scan as absent', async () => {
      const present = await createStudent({ pin: '1001', classId: klass.id });
      const missing = await createStudent({ pin: '1002', classId: klass.id });
      await ingestPunches({ device, records: [punch('1001', '07:12:44')] });

      const result = await finalizeDay(DATE);

      expect(result.markedAbsent).toBe(1);
      const { rows } = await query(
        'SELECT student_id, status, source FROM attendance_records WHERE attendance_date = $1 ORDER BY student_id',
        [DATE],
      );
      expect(rows).toEqual([
        expect.objectContaining({ student_id: present.id, status: 'present' }),
        expect.objectContaining({ student_id: missing.id, status: 'absent', source: 'system' }),
      ]);
    });

    it('is safe to run twice', async () => {
      await createStudent({ pin: '1001', classId: klass.id });

      const first = await finalizeDay(DATE);
      const second = await finalizeDay(DATE);

      expect(first.markedAbsent).toBe(1);
      expect(second.markedAbsent).toBe(0);
    });

    it('skips a day the school was closed', async () => {
      await createStudent({ pin: '1001', classId: klass.id });

      const saturday = await finalizeDay('2026-08-08');

      expect(saturday).toMatchObject({ skipped: true, reason: 'not_a_school_day', markedAbsent: 0 });
    });

    it('skips a public holiday recorded in the school calendar', async () => {
      await createStudent({ pin: '1001', classId: klass.id });
      await query(
        "INSERT INTO school_calendar (calendar_date, day_type, label) VALUES ($1::date, 'holiday', 'Union Day')",
        [DATE],
      );

      expect(await finalizeDay(DATE)).toMatchObject({ skipped: true, reason: 'not_a_school_day' });
    });

    it('does not mark a student absent before they joined the school', async () => {
      await createStudent({ pin: '1001', classId: klass.id, enrolledOn: '2026-09-01' });

      const result = await finalizeDay(DATE);

      expect(result.markedAbsent).toBe(0);
    });

    it('refuses to close a future day', async () => {
      await createStudent({ pin: '1001', classId: klass.id });
      expect(await finalizeDay('2099-01-05')).toMatchObject({ skipped: true, reason: 'future_date' });
    });
  });

  describe('manual override (PRD §7.6)', () => {
    let actor;
    let student;

    beforeEach(async () => {
      actor = await createUser({ email: 'office@test.local', role: 'office_staff' });
      student = await createStudent({ pin: '1001', classId: klass.id });
    });

    it('creates a record where the terminal saw nothing', async () => {
      const record = await setAttendanceManually({
        studentId: student.id,
        date: DATE,
        status: 'present',
        reason: 'Injured finger, verified at the office',
        actor,
      });

      expect(record).toMatchObject({
        status: 'present',
        source: 'manual',
        is_manual_override: true,
        override_reason: 'Injured finger, verified at the office',
        recorded_by: actor.id,
      });
    });

    it('survives a later device push for the same day', async () => {
      await setAttendanceManually({
        studentId: student.id,
        date: DATE,
        status: 'excused',
        reason: 'Medical appointment',
        actor,
      });

      await ingestPunches({ device, records: [punch('1001', '10:30:00')] });

      const { rows } = await query('SELECT status, source, check_in_at FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      // The correction stands, but the observed arrival is still recorded.
      expect(rows[0]).toMatchObject({ status: 'excused', source: 'manual' });
      expect(rows[0].check_in_at).not.toBeNull();
    });

    it('writes an attributable audit entry', async () => {
      await setAttendanceManually({
        studentId: student.id,
        date: DATE,
        status: 'present',
        reason: 'Device was offline',
        actor,
      });

      const { rows } = await query("SELECT * FROM audit_logs WHERE action LIKE 'attendance.%'");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(actor.id);
      expect(rows[0].summary).toMatch(/no record → present/);
    });

    it('reverts to the device record when the override is cleared', async () => {
      await ingestPunches({ device, records: [punch('1001', '08:30:00')] });
      await setAttendanceManually({
        studentId: student.id,
        date: DATE,
        status: 'present',
        reason: 'Bus was delayed, not the student’s fault',
        actor,
      });

      const reverted = await clearManualOverride({ studentId: student.id, date: DATE, actor });

      expect(reverted).toMatchObject({ status: 'late', source: 'device', is_manual_override: false });
    });

    it('removes the record entirely when there was no device data behind it', async () => {
      await setAttendanceManually({
        studentId: student.id,
        date: DATE,
        status: 'present',
        reason: 'Typed in by mistake',
        actor,
      });

      const reverted = await clearManualOverride({ studentId: student.id, date: DATE, actor });

      expect(reverted).toBeNull();
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM attendance_records WHERE student_id = $1', [
        student.id,
      ]);
      expect(rows[0].count).toBe(0);
    });

    it('refuses a future date', async () => {
      await expect(
        setAttendanceManually({ studentId: student.id, date: '2099-01-01', status: 'present', reason: 'x', actor }),
      ).rejects.toThrow(/future date/i);
    });

    it('refuses a student who is no longer on roll', async () => {
      const gone = await createStudent({ pin: '1009', classId: klass.id, status: 'graduated' });
      await expect(
        setAttendanceManually({ studentId: gone.id, date: DATE, status: 'present', reason: 'x', actor }),
      ).rejects.toThrow(/currently on roll/i);
    });
  });

  describe('daily register', () => {
    it('lists every expected student, including those who have not arrived', async () => {
      const arrived = await createStudent({ pin: '1001', firstName: 'Asha', classId: klass.id });
      await createStudent({ pin: '1002', firstName: 'Juma', classId: klass.id });
      await ingestPunches({ device, records: [punch('1001', '07:12:44')] });

      const register = await getDailyRegister({ date: DATE });

      expect(register).toHaveLength(2);
      expect(register.find((r) => r.student_id === arrived.id).status).toBe('present');
      expect(register.find((r) => r.first_name === 'Juma').status).toBe('not_marked');
    });

    it('reports how each arrival was verified', async () => {
      const byFinger = await createStudent({ pin: '1001', firstName: 'Finger', classId: klass.id });
      const byKeypad = await createStudent({ pin: '1002', firstName: 'Keypad', classId: klass.id });
      const byCard = await createStudent({ pin: '1003', firstName: 'Card', classId: klass.id });

      await ingestPunches({
        device,
        records: [
          punch('1001', '07:10:00', { verifyMode: 1 }),
          punch('1002', '07:11:00', { verifyMode: 0 }),
          punch('1003', '07:12:00', { verifyMode: 2 }),
        ],
      });

      const register = await getDailyRegister({ date: DATE });
      const find = (id) => register.find((r) => r.student_id === id);

      expect(find(byFinger.id)).toMatchObject({
        verify_method: 'fingerprint',
        verified_biometrically: true,
      });
      // A typed PIN or a card is how proxy attendance gets in, so the register
      // has to be able to say so.
      expect(find(byKeypad.id)).toMatchObject({ verify_method: 'password', verified_biometrically: false });
      expect(find(byCard.id)).toMatchObject({ verify_method: 'card', verified_biometrically: false });
    });

    it('reports nothing about verification when there was no punch', async () => {
      await createStudent({ pin: '1009', classId: klass.id });

      const [row] = await getDailyRegister({ date: DATE });

      expect(row.status).toBe('not_marked');
      expect(row.verify_method).toBeNull();
      expect(row.verified_biometrically).toBeNull();
    });

    it('summarises the day', async () => {
      await createStudent({ pin: '1001', classId: klass.id });
      await createStudent({ pin: '1002', classId: klass.id });
      await createStudent({ pin: '1003', classId: klass.id });
      await ingestPunches({
        device,
        records: [punch('1001', '07:00:00'), punch('1002', '08:15:00')],
      });

      const summary = await getDailySummary({ date: DATE });

      expect(summary).toMatchObject({
        expected: 3,
        present: 1,
        late: 1,
        absent: 0,
        not_marked: 1,
        inSchool: 2,
      });
      expect(summary.attendanceRate).toBeCloseTo(66.7, 1);
    });

    it('respects a changed late cut-off', async () => {
      await setSetting('late_after_time', '08:30');
      await createStudent({ pin: '1001', classId: klass.id });

      await ingestPunches({ device, records: [punch('1001', '08:15:00')] });

      const summary = await getDailySummary({ date: DATE });
      expect(summary).toMatchObject({ present: 1, late: 0 });
    });
  });

  describe('rebuildDailyRecord', () => {
    it('returns null when there is nothing to rebuild from', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });
      expect(await rebuildDailyRecord(student.id, DATE)).toBeNull();
    });

    it('converges on the same answer however many times it runs', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });
      await ingestPunches({ device, records: [punch('1001', '07:12:44'), punch('1001', '16:00:00')] });

      const first = await rebuildDailyRecord(student.id, DATE);
      const second = await rebuildDailyRecord(student.id, DATE);

      expect(second.status).toBe(first.status);
      expect(second.check_in_at).toEqual(first.check_in_at);
      expect(second.check_out_at).toEqual(first.check_out_at);
    });
  });
});
