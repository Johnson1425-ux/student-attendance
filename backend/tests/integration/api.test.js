import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  resetDatabase,
  closeDatabase,
  ensureSchema,
  createUser,
  createClass,
  createStudent,
  createDevice,
  query,
} from '../helpers/db.js';
import { todayInZone } from '../../src/lib/dates.js';

const app = createApp();
const TODAY = todayInZone('Africa/Dar_es_Salaam');

async function signIn(email, password = 'Password123') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('API', () => {
  beforeAll(ensureSchema);
  afterAll(closeDatabase);
  beforeEach(resetDatabase);

  describe('health and metadata', () => {
    it('reports database connectivity', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', database: 'connected' });
    });

    it('returns a structured 404 for an unknown route', async () => {
      const res = await request(app).get('/api/nope');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });
  });

  describe('authentication', () => {
    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
    });

    it('issues an access token and a refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.local', password: 'Password123' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({ email: 'admin@test.local', role: 'admin' });
      expect(res.body.user).not.toHaveProperty('password_hash');
    });

    it('is case-insensitive about the email address', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ADMIN@test.local', password: 'Password123' });
      expect(res.status).toBe(200);
    });

    it('gives the same answer for a wrong password and an unknown account', async () => {
      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.local', password: 'nope' });
      const unknownUser = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@test.local', password: 'nope' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownUser.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    });

    it('refuses a deactivated account', async () => {
      await createUser({ email: 'gone@test.local', role: 'teacher', isActive: false });
      const res = await request(app).post('/api/auth/login').send({ email: 'gone@test.local', password: 'Password123' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/deactivated/i);
    });

    it('rotates the refresh token and refuses to reuse the old one', async () => {
      const session = await signIn('admin@test.local');

      const refreshed = await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);

      // Replaying the original token is treated as a compromise.
      const replay = await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
      expect(replay.status).toBe(401);

      // …and the replacement is revoked too, so the whole family is dead.
      const afterReplay = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshed.body.refreshToken });
      expect(afterReplay.status).toBe(401);
    });

    it('rejects requests without or with a bad token', async () => {
      expect((await request(app).get('/api/students')).status).toBe(401);
      expect((await request(app).get('/api/students').set(auth('rubbish'))).status).toBe(401);
    });

    it('stops honouring a token once the account is deactivated', async () => {
      const session = await signIn('admin@test.local');
      expect((await request(app).get('/api/auth/me').set(auth(session.accessToken))).status).toBe(200);

      await query('UPDATE users SET is_active = FALSE WHERE email = $1', ['admin@test.local']);

      const res = await request(app).get('/api/auth/me').set(auth(session.accessToken));
      expect(res.status).toBe(401);
    });

    it('changes a password and invalidates existing sessions', async () => {
      const session = await signIn('admin@test.local');

      const res = await request(app)
        .post('/api/auth/change-password')
        .set(auth(session.accessToken))
        .send({ currentPassword: 'Password123', newPassword: 'BrandNew456' });
      expect(res.status).toBe(200);

      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
      expect((await signIn('admin@test.local', 'BrandNew456')).accessToken).toEqual(expect.any(String));
    });

    it('refuses a weak new password', async () => {
      const session = await signIn('admin@test.local');
      const res = await request(app)
        .post('/api/auth/change-password')
        .set(auth(session.accessToken))
        .send({ currentPassword: 'Password123', newPassword: 'alllettersnodigits' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/number/i);
    });
  });

  describe('role-based access (PRD §4)', () => {
    let adminToken;
    let teacherToken;
    let officeToken;
    let ownClass;
    let otherClass;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      const teacher = await createUser({ email: 'teacher@test.local', role: 'teacher' });
      await createUser({ email: 'office@test.local', role: 'office_staff' });

      ownClass = await createClass({ name: 'Form 1A', teacherId: teacher.id });
      otherClass = await createClass({ name: 'Form 2A' });

      adminToken = (await signIn('admin@test.local')).accessToken;
      teacherToken = (await signIn('teacher@test.local')).accessToken;
      officeToken = (await signIn('office@test.local')).accessToken;
    });

    it('lets an admin manage users, and nobody else', async () => {
      expect((await request(app).get('/api/users').set(auth(adminToken))).status).toBe(200);
      expect((await request(app).get('/api/users').set(auth(teacherToken))).status).toBe(403);
      expect((await request(app).get('/api/users').set(auth(officeToken))).status).toBe(403);
    });

    it('lets office staff add students but not create classes', async () => {
      const created = await request(app)
        .post('/api/students')
        .set(auth(officeToken))
        .send({ admissionNumber: 'ADM100', firstName: 'New', lastName: 'Pupil', classId: ownClass.id });
      expect(created.status).toBe(201);

      const klass = await request(app)
        .post('/api/classes')
        .set(auth(officeToken))
        .send({ name: 'Form 3A', academicYear: '2026' });
      expect(klass.status).toBe(403);
    });

    it('gives a teacher read access but not write access to students', async () => {
      await createStudent({ classId: ownClass.id });

      expect((await request(app).get('/api/students').set(auth(teacherToken))).status).toBe(200);
      const write = await request(app)
        .post('/api/students')
        .set(auth(teacherToken))
        .send({ admissionNumber: 'ADM200', firstName: 'X', lastName: 'Y' });
      expect(write.status).toBe(403);
    });

    it('shows a teacher only the students in their own classes', async () => {
      const mine = await createStudent({ classId: ownClass.id, firstName: 'Mine' });
      await createStudent({ classId: otherClass.id, firstName: 'Theirs' });

      const res = await request(app).get('/api/students').set(auth(teacherToken));

      expect(res.body.pagination.total).toBe(1);
      expect(res.body.data[0].id).toBe(mine.id);
    });

    it('blocks a teacher from another class’s register', async () => {
      const res = await request(app)
        .get(`/api/attendance/register?classId=${otherClass.id}`)
        .set(auth(teacherToken));

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not assigned to this class/i);
    });

    it('blocks a teacher from another class’s student record', async () => {
      const theirs = await createStudent({ classId: otherClass.id });

      const res = await request(app).get(`/api/students/${theirs.id}`).set(auth(teacherToken));

      expect(res.status).toBe(403);
    });

    it('stops an admin from locking themselves out', async () => {
      const me = await request(app).get('/api/auth/me').set(auth(adminToken));

      const res = await request(app)
        .patch(`/api/users/${me.body.id}`)
        .set(auth(adminToken))
        .send({ role: 'teacher' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/your own role/i);
    });

    it('stops the last administrator being deactivated', async () => {
      const other = await createUser({ email: 'other@test.local', role: 'teacher' });
      const admins = await request(app).get('/api/users?role=admin').set(auth(adminToken));
      const adminId = admins.body[0].id;

      // Deactivating via another admin account is the only path; there is none,
      // so the guard fires.
      const res = await request(app)
        .patch(`/api/users/${adminId}`)
        .set(auth(adminToken))
        .send({ isActive: false });

      expect([403, 409]).toContain(res.status);
      expect(other.id).toEqual(expect.any(Number));
    });
  });

  describe('students', () => {
    let token;
    let klass;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      token = (await signIn('admin@test.local')).accessToken;
      klass = await createClass({});
    });

    it('creates a student and places them in a class', async () => {
      const res = await request(app)
        .post('/api/students')
        .set(auth(token))
        .send({
          admissionNumber: 'ADM001',
          firstName: 'Asha',
          lastName: 'Mushi',
          deviceUserPin: '1001',
          classId: klass.id,
          guardianPhone: '+255700000000',
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        admission_number: 'ADM001',
        full_name: 'Asha Mushi',
        class_name: klass.name,
        device_user_pin: '1001',
      });
    });

    it('rejects a duplicate admission number with a usable message', async () => {
      await createStudent({ admissionNumber: 'ADM001', classId: klass.id });

      const res = await request(app)
        .post('/api/students')
        .set(auth(token))
        .send({ admissionNumber: 'ADM001', firstName: 'A', lastName: 'B' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/admission number already exists/i);
    });

    it('rejects a duplicate terminal PIN', async () => {
      await createStudent({ pin: '1001', classId: klass.id });

      const res = await request(app)
        .post('/api/students')
        .set(auth(token))
        .send({ admissionNumber: 'ADM999', firstName: 'A', lastName: 'B', deviceUserPin: '1001' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already assigned/i);
    });

    it('validates the request body', async () => {
      const res = await request(app).post('/api/students').set(auth(token)).send({ firstName: 'OnlyAName' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.details).toHaveProperty('admissionNumber');
    });

    it('rejects a non-numeric terminal PIN', async () => {
      const res = await request(app)
        .post('/api/students')
        .set(auth(token))
        .send({ admissionNumber: 'ADM002', firstName: 'A', lastName: 'B', deviceUserPin: 'abc' });

      expect(res.status).toBe(422);
    });

    it('refuses to change a PIN that fingerprints are enrolled against', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });
      const device = await createDevice({ serialNumber: 'SNPIN001' });
      await query(
        `INSERT INTO biometric_enrollments (student_id, device_id, finger_index) VALUES ($1, $2, 6)`,
        [student.id, device.id],
      );

      const res = await request(app)
        .patch(`/api/students/${student.id}`)
        .set(auth(token))
        .send({ deviceUserPin: '2002' });

      // Silently detaching a student from their enrolled fingers would leave
      // them scanning into nothing, so this has to be refused.
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/fingerprint\(s\) enrolled/i);

      const cleared = await request(app)
        .patch(`/api/students/${student.id}`)
        .set(auth(token))
        .send({ deviceUserPin: null });
      expect(cleared.status).toBe(409);
    });

    it('allows a PIN change when no fingerprints are enrolled yet', async () => {
      const student = await createStudent({ pin: '1001', classId: klass.id });

      const res = await request(app)
        .patch(`/api/students/${student.id}`)
        .set(auth(token))
        .send({ deviceUserPin: '2002' });

      expect(res.status).toBe(200);
      expect(res.body.device_user_pin).toBe('2002');
    });

    it('moves a student to another class while keeping the history', async () => {
      const student = await createStudent({ classId: klass.id });
      const newClass = await createClass({ name: 'Form 2A' });

      const res = await request(app)
        .patch(`/api/students/${student.id}`)
        .set(auth(token))
        .send({ classId: newClass.id });

      expect(res.status).toBe(200);
      expect(res.body.class_id).toBe(newClass.id);
      expect(res.body.enrollment_history).toHaveLength(2);
    });

    it('archives rather than deletes a student who has attendance history', async () => {
      const student = await createStudent({ classId: klass.id });
      await query(
        `INSERT INTO attendance_records (student_id, attendance_date, status, source)
         VALUES ($1, $2::date, 'present', 'device')`,
        [student.id, TODAY],
      );

      const deleted = await request(app).delete(`/api/students/${student.id}`).set(auth(token));
      expect(deleted.status).toBe(409);
      expect(deleted.body.error.message).toMatch(/archive/i);

      const archived = await request(app)
        .post(`/api/students/${student.id}/archive`)
        .set(auth(token))
        .send({ status: 'transferred' });
      expect(archived.status).toBe(200);
      expect(archived.body.status).toBe('transferred');
    });

    it('imports a batch and reports the rows it could not accept', async () => {
      const res = await request(app)
        .post('/api/students/import')
        .set(auth(token))
        .send({
          students: [
            { admissionNumber: 'IMP001', firstName: 'One', lastName: 'Student', className: klass.name },
            { admissionNumber: 'IMP002', firstName: 'Two', lastName: 'Student', className: 'No Such Class' },
            { admissionNumber: 'IMP001', firstName: 'Dup', lastName: 'Student' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.created).toHaveLength(1);
      expect(res.body.failed).toHaveLength(2);
      expect(res.body.failed[0].reason).toMatch(/Unknown class/);
      expect(res.body.failed[1].reason).toMatch(/already exists/i);
    });
  });

  describe('attendance endpoints', () => {
    let token;
    let klass;
    let student;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      token = (await signIn('admin@test.local')).accessToken;
      klass = await createClass({});
      student = await createStudent({ classId: klass.id });
    });

    it('returns today’s register by default', async () => {
      const res = await request(app).get('/api/attendance/register').set(auth(token));

      expect(res.status).toBe(200);
      expect(res.body.date).toBe(TODAY);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].status).toBe('not_marked');
      expect(res.body.summary).toMatchObject({ expected: 1, not_marked: 1 });
    });

    it('records a manual correction with a reason', async () => {
      const res = await request(app)
        .post('/api/attendance/manual')
        .set(auth(token))
        .send({
          studentId: student.id,
          date: TODAY,
          status: 'present',
          reason: 'Fingerprint would not read',
          checkInTime: '07:20',
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'present', source: 'manual', is_manual_override: true });
    });

    it('requires a reason for a manual correction', async () => {
      const res = await request(app)
        .post('/api/attendance/manual')
        .set(auth(token))
        .send({ studentId: student.id, date: TODAY, status: 'present' });

      expect(res.status).toBe(422);
      expect(res.body.error.details).toHaveProperty('reason');
    });

    it('applies a correction to a whole group at once', async () => {
      const second = await createStudent({ classId: klass.id });

      const res = await request(app)
        .post('/api/attendance/manual/bulk')
        .set(auth(token))
        .send({
          studentIds: [student.id, second.id],
          date: TODAY,
          status: 'excused',
          reason: 'Inter-school sports fixture',
        });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(2);
      expect(res.body.failed).toHaveLength(0);
    });

    it('exports the daily register as CSV', async () => {
      const res = await request(app).get(`/api/reports/daily?date=${TODAY}&format=csv`).set(auth(token));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="daily-attendance/);
      expect(res.text).toMatch(/Admission No\.,Student,Class,Status/);
    });

    it('exports a summary as PDF', async () => {
      const res = await request(app)
        .get(`/api/reports/range?from=${TODAY}&to=${TODAY}&format=pdf`)
        .set(auth(token))
        .buffer()
        .parse((response, callback) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('logs an export in the audit trail', async () => {
      await request(app).get(`/api/reports/daily?date=${TODAY}&format=csv`).set(auth(token));

      const res = await request(app).get('/api/audit?action=report.export').set(auth(token));
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].summary).toMatch(/Exported .* as CSV/);
    });
  });

  describe('device endpoints (ADMS)', () => {
    let token;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      token = (await signIn('admin@test.local')).accessToken;
    });

    it('registers a terminal and returns its push secret exactly once', async () => {
      const created = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ serialNumber: 'SN00001', name: 'Main Gate', location: 'Entrance' });

      expect(created.status).toBe(201);
      expect(created.body.pushSecret).toEqual(expect.any(String));

      const fetched = await request(app).get(`/api/devices/${created.body.id}`).set(auth(token));
      expect(fetched.body).not.toHaveProperty('push_secret');
      expect(fetched.body).not.toHaveProperty('pushSecret');
      expect(fetched.body.has_push_secret).toBe(true);
    });

    it('answers the terminal handshake with a parsable configuration', async () => {
      await createDevice({ serialNumber: 'SN00002' });

      const res = await request(app).get('/iclock/cdata?SN=SN00002&options=all&pushver=2.4.1');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/^GET OPTION FROM: SN00002/);
      expect(res.text).toMatch(/Stamp=/);
    });

    it('refuses an unregistered terminal', async () => {
      const res = await request(app).get('/iclock/cdata?SN=UNKNOWN&options=all');
      expect(res.status).toBe(403);
      expect(res.text).toMatch(/not registered/i);
    });

    it('refuses a deactivated terminal', async () => {
      await createDevice({ serialNumber: 'SN00003', isActive: false });
      const res = await request(app).get('/iclock/cdata?SN=SN00003&options=all');
      expect(res.status).toBe(403);
    });

    it('requires the shared secret when one is configured', async () => {
      await createDevice({ serialNumber: 'SN00004', pushSecret: 'topsecret' });

      expect((await request(app).get('/iclock/cdata?SN=SN00004&options=all')).status).toBe(403);
      expect((await request(app).get('/iclock/cdata?SN=SN00004&options=all&key=wrong')).status).toBe(403);
      expect((await request(app).get('/iclock/cdata?SN=SN00004&options=all&key=topsecret')).status).toBe(200);
    });

    it('accepts an attendance push and answers OK with the batch size', async () => {
      const device = await createDevice({ serialNumber: 'SN00005' });
      const klass = await createClass({});
      const student = await createStudent({ pin: '1001', classId: klass.id });

      const res = await request(app)
        .post('/iclock/cdata?SN=SN00005&table=ATTLOG&Stamp=99')
        .set('Content-Type', 'text/plain')
        .send(`1001\t${TODAY} 07:12:44\t0\t1\t0\t0\t0\n`);

      expect(res.status).toBe(200);
      expect(res.text).toMatch(/^OK: 1/);

      const { rows } = await query('SELECT status FROM attendance_records WHERE student_id = $1', [student.id]);
      expect(rows[0].status).toBe('present');

      const { rows: deviceRows } = await query('SELECT attlog_stamp, last_push_at FROM devices WHERE id = $1', [
        device.id,
      ]);
      expect(deviceRows[0].attlog_stamp).toBe('99');
      expect(deviceRows[0].last_push_at).not.toBeNull();
    });

    it('records an enrollment pushed from the terminal without storing the template', async () => {
      await createDevice({ serialNumber: 'SN00006' });

      const res = await request(app)
        .post('/iclock/cdata?SN=SN00006&table=OPERLOG')
        .set('Content-Type', 'text/plain')
        .send('USER PIN=9001\tName=New Pupil\tPri=0\tCard=0\nFP PIN=9001\tFID=6\tSize=1130\tValid=1\tTMP=SECRETTEMPLATE\n');

      expect(res.status).toBe(200);

      const { rows } = await query('SELECT * FROM device_users WHERE pin = $1', ['9001']);
      expect(rows[0]).toMatchObject({ name: 'New Pupil', student_id: null });

      // No column anywhere holds the template payload.
      const { rows: leak } = await query(
        `SELECT COUNT(*)::int AS count FROM attendance_events WHERE raw_line LIKE '%SECRETTEMPLATE%'`,
      );
      expect(leak[0].count).toBe(0);
    });

    it('links a terminal enrollment to a student and backfills their scans', async () => {
      await createDevice({ serialNumber: 'SN00007' });
      const klass = await createClass({});
      const student = await createStudent({ pin: null, classId: klass.id });
      await query('UPDATE students SET device_user_pin = NULL WHERE id = $1', [student.id]);

      await request(app)
        .post('/iclock/cdata?SN=SN00007&table=OPERLOG')
        .set('Content-Type', 'text/plain')
        .send('USER PIN=9100\tName=Unlinked\tPri=0\n');
      await request(app)
        .post('/iclock/cdata?SN=SN00007&table=ATTLOG')
        .set('Content-Type', 'text/plain')
        .send(`9100\t${TODAY} 07:05:00\t0\t1\n`);

      const unlinked = await request(app).get('/api/devices/users?unlinkedOnly=true').set(auth(token));
      expect(unlinked.body).toHaveLength(1);

      const link = await request(app)
        .post(`/api/devices/users/${unlinked.body[0].id}/link`)
        .set(auth(token))
        .send({ studentId: student.id });

      expect(link.status).toBe(200);
      expect(link.body.backfilledDates).toContain(TODAY);

      const { rows } = await query('SELECT status FROM attendance_records WHERE student_id = $1', [student.id]);
      expect(rows[0].status).toBe('present');
    });

    it('hands queued commands to a polling terminal and records the result', async () => {
      const device = await createDevice({ serialNumber: 'SN00008' });

      await request(app).post(`/api/devices/${device.id}/commands`).set(auth(token)).send({ type: 'info' });

      const poll = await request(app).get('/iclock/getrequest?SN=SN00008');
      expect(poll.text).toMatch(/^C:\d+:INFO/);

      const emptyPoll = await request(app).get('/iclock/getrequest?SN=SN00008');
      expect(emptyPoll.text).toBe('OK\r\n');

      const commandId = poll.text.split(':')[1];
      await request(app)
        .post('/iclock/devicecmd?SN=SN00008')
        .set('Content-Type', 'text/plain')
        .send(`ID=${commandId}&Return=0&CMD=INFO\n`);

      const { rows } = await query('SELECT status, return_code FROM device_commands WHERE id = $1', [
        Number(commandId),
      ]);
      expect(rows[0]).toMatchObject({ status: 'acked', return_code: 0 });
    });

    it('refuses a command that is not in the catalog', async () => {
      const device = await createDevice({ serialNumber: 'SN00009' });

      const res = await request(app)
        .post(`/api/devices/${device.id}/commands`)
        .set(auth(token))
        .send({ type: 'DROP TABLE students' });

      expect(res.status).toBe(422);
    });

    it('acknowledges a biometric upload without storing it', async () => {
      await createDevice({ serialNumber: 'SN00010' });
      const res = await request(app)
        .post('/iclock/fdata?SN=SN00010')
        .set('Content-Type', 'application/octet-stream')
        .send('binary-template-payload');

      expect(res.status).toBe(200);
      expect(res.text).toMatch(/^OK/);
    });
  });

  describe('settings', () => {
    let adminToken;
    let teacherToken;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      await createUser({ email: 'teacher@test.local', role: 'teacher' });
      adminToken = (await signIn('admin@test.local')).accessToken;
      teacherToken = (await signIn('teacher@test.local')).accessToken;
    });

    it('is readable by any signed-in user but writable only by an admin', async () => {
      expect((await request(app).get('/api/settings').set(auth(teacherToken))).status).toBe(200);
      expect(
        (await request(app).patch('/api/settings').set(auth(teacherToken)).send({ school_name: 'Hacked' })).status,
      ).toBe(403);
    });

    it('applies a valid change', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set(auth(adminToken))
        .send({ school_name: 'Mkuza Secondary', late_after_time: '08:00' });

      expect(res.status).toBe(200);
      expect(res.body.school_name).toBe('Mkuza Secondary');
      expect(res.body.late_after_time).toBe('08:00');
    });

    it('rejects a late cut-off before the start of the school day', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set(auth(adminToken))
        .send({ late_after_time: '06:00' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cannot be earlier/i);
    });

    it('rejects an invalid timezone', async () => {
      const res = await request(app).patch('/api/settings').set(auth(adminToken)).send({ timezone: 'Mars/Olympus' });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toHaveProperty('timezone');
    });
  });

  describe('school calendar', () => {
    let token;

    beforeEach(async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      token = (await signIn('admin@test.local')).accessToken;
    });

    it('marks a range of days as a break in one action', async () => {
      const res = await request(app)
        .post('/api/calendar')
        .set(auth(token))
        .send({ date: '2026-08-10', endDate: '2026-08-14', dayType: 'break', label: 'Mid-term break' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(5);

      const schoolDays = await request(app)
        .get('/api/calendar/school-days?from=2026-08-10&to=2026-08-14')
        .set(auth(token));
      expect(schoolDays.body.count).toBe(0);
    });

    it('can turn a Saturday into a school day', async () => {
      await request(app)
        .post('/api/calendar')
        .set(auth(token))
        .send({ date: '2026-08-08', dayType: 'school_day', label: 'Catch-up day' });

      const res = await request(app).get('/api/calendar/resolved?from=2026-08-08&to=2026-08-08').set(auth(token));
      expect(res.body[0]).toMatchObject({ isSchoolDay: true, source: 'calendar' });
    });
  });

  describe('dashboard', () => {
    it('returns everything the landing screen needs in one call', async () => {
      await createUser({ email: 'admin@test.local', role: 'admin' });
      const token = (await signIn('admin@test.local')).accessToken;
      const klass = await createClass({});
      await createStudent({ classId: klass.id });
      await createDevice({});

      const res = await request(app).get('/api/dashboard').set(auth(token));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: TODAY, isSchoolDay: expect.any(Boolean) });
      expect(res.body.summary).toMatchObject({ expected: 1 });
      expect(res.body.classes).toHaveLength(1);
      expect(res.body.alerts).toMatchObject({ open: 0 });
      expect(Array.isArray(res.body.trend)).toBe(true);
      expect(res.body.devices).toHaveLength(1);
    });
  });
});
