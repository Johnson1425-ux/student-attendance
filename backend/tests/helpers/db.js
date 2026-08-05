import { pool, query } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { invalidateSettingsCache } from '../../src/services/settings.service.js';

/**
 * Shared fixtures for integration tests.
 *
 * Each test file starts from an empty schema (`resetDatabase`) and builds only
 * the rows it needs, so a failure points at one behaviour rather than at a
 * shared fixture nobody wants to touch.
 */

let migrated = false;

export async function ensureSchema() {
  if (migrated) return;
  await runMigrations({ silent: true });
  migrated = true;
}

const TABLES = [
  'audit_logs',
  'absentee_alerts',
  'device_commands',
  'attendance_records',
  'attendance_events',
  'biometric_enrollments',
  'device_users',
  'devices',
  'enrollments',
  'class_teachers',
  'students',
  'classes',
  'academic_terms',
  'school_calendar',
  'refresh_tokens',
  'users',
];

export async function resetDatabase() {
  await ensureSchema();
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // Settings survive truncation (they are configuration, not test data) but the
  // in-process cache must be dropped so per-test overrides take effect.
  await query(
    `UPDATE settings SET value = d.value FROM (VALUES
       ('timezone', '"Africa/Dar_es_Salaam"'::jsonb),
       ('school_start_time', '"07:30"'::jsonb),
       ('late_after_time', '"07:45"'::jsonb),
       ('school_days_of_week', '[1,2,3,4,5]'::jsonb),
       ('consecutive_absence_threshold', '3'::jsonb),
       ('minimum_checkout_gap_minutes', '60'::jsonb),
       ('auto_finalize_enabled', 'true'::jsonb)
     ) AS d(key, value) WHERE settings.key = d.key`,
  );
  invalidateSettingsCache();
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
  invalidateSettingsCache();
}

export async function closeDatabase() {
  await pool.end();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export async function createUser({
  email = 'admin@test.local',
  password = 'Password123',
  fullName = 'Test Admin',
  role = 'admin',
  isActive = true,
} = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, role, is_active)
     VALUES ($1,$2,$3,$4::user_role,$5) RETURNING id, email, full_name, role`,
    [email, await hashPassword(password), fullName, role, isActive],
  );
  return { ...rows[0], password };
}

export async function createClass({ name = 'Form 1A', academicYear = '2026', teacherId = null } = {}) {
  const { rows } = await query(
    'INSERT INTO classes (name, academic_year, grade_level) VALUES ($1,$2,$3) RETURNING *',
    [name, academicYear, name.split(' ').slice(0, 2).join(' ')],
  );
  if (teacherId) {
    await query('INSERT INTO class_teachers (class_id, user_id, is_primary) VALUES ($1,$2,TRUE)', [
      rows[0].id,
      teacherId,
    ]);
  }
  return rows[0];
}

let studentCounter = 0;

export async function createStudent({
  admissionNumber,
  pin,
  firstName = 'Test',
  lastName = 'Student',
  classId = null,
  enrolledOn = '2026-01-01',
  status = 'active',
} = {}) {
  studentCounter += 1;
  const { rows } = await query(
    `INSERT INTO students (admission_number, device_user_pin, first_name, last_name, enrolled_on, status)
     VALUES ($1,$2,$3,$4,$5::date,$6::student_status) RETURNING *`,
    [
      admissionNumber ?? `ADM${String(studentCounter).padStart(4, '0')}`,
      pin ?? String(1000 + studentCounter),
      firstName,
      lastName,
      enrolledOn,
      status,
    ],
  );
  if (classId) {
    await query('INSERT INTO enrollments (student_id, class_id, start_date) VALUES ($1,$2,$3::date)', [
      rows[0].id,
      classId,
      enrolledOn,
    ]);
  }
  return rows[0];
}

export async function createDevice({
  serialNumber = 'TESTDEV001',
  name = 'Test Terminal',
  pushSecret = null,
  isActive = true,
} = {}) {
  const { rows } = await query(
    `INSERT INTO devices (serial_number, name, push_secret, is_active, timezone_offset)
     VALUES ($1,$2,$3,$4,3) RETURNING *`,
    [serialNumber, name, pushSecret, isActive],
  );
  return rows[0];
}

export async function createAttendanceRecord({ studentId, classId = null, date, status, source = 'device' }) {
  const { rows } = await query(
    `INSERT INTO attendance_records (student_id, class_id, attendance_date, status, source)
     VALUES ($1,$2,$3::date,$4::attendance_status,$5::attendance_source)
     ON CONFLICT (student_id, attendance_date) DO UPDATE SET status = EXCLUDED.status
     RETURNING *`,
    [studentId, classId, date, status, source],
  );
  return rows[0];
}

export { query };
