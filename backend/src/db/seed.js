#!/usr/bin/env node
/**
 * Database seeding.
 *
 *   npm run seed         → bootstrap only: the first administrator account.
 *   npm run seed:demo    → bootstrap plus a realistic demo school (classes,
 *                          students, a terminal, and six weeks of attendance)
 *                          so the dashboard and reports can be reviewed with
 *                          data in them before the real hardware arrives.
 *
 * Both modes are idempotent — re-running will not duplicate anything.
 */
import { pool, query } from './pool.js';
import { runMigrations } from './migrate.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { hashPassword } from '../lib/password.js';
import { eachDateInclusive, isoWeekday, addDays, todayInZone } from '../lib/dates.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { rebuildDailyRecord, finalizeDay } from '../services/attendance.service.js';
import { refreshAllAlerts } from '../services/alerts.service.js';
import { eventDedupeHash } from '../services/attendance.service.js';

async function ensureAdmin() {
  const { rows } = await query('SELECT id, email FROM users WHERE role = $1 LIMIT 1', ['admin']);
  if (rows[0]) {
    logger.info({ email: rows[0].email }, 'Administrator account already exists');
    return rows[0];
  }

  const { rows: created } = await query(
    `INSERT INTO users (email, password_hash, full_name, role, must_change_password)
     VALUES ($1, $2, $3, 'admin', TRUE) RETURNING id, email`,
    [env.SEED_ADMIN_EMAIL.toLowerCase(), await hashPassword(env.SEED_ADMIN_PASSWORD), env.SEED_ADMIN_NAME],
  );

  logger.info({ email: created[0].email }, 'Created the first administrator account');
  process.stdout.write(
    `\n  Administrator account created\n` +
      `    email:    ${env.SEED_ADMIN_EMAIL}\n` +
      `    password: ${env.SEED_ADMIN_PASSWORD}\n` +
      `  Change this password at first sign-in.\n\n`,
  );
  return created[0];
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Asha', 'Baraka', 'Neema', 'Juma', 'Zawadi', 'Hamisi', 'Amina', 'Rashid', 'Furaha', 'Salma',
  'Emmanuel', 'Grace', 'Joseph', 'Rehema', 'Daniel', 'Upendo', 'Frank', 'Halima', 'Ibrahim', 'Mariam',
  'Peter', 'Tumaini', 'Said', 'Anna', 'Godfrey', 'Zainab', 'Elias', 'Happiness', 'Musa', 'Doreen',
];
const LAST_NAMES = [
  'Mushi', 'Kimaro', 'Mwakasege', 'Shirima', 'Massawe', 'Ngowi', 'Mrema', 'Lyimo', 'Swai', 'Mbwana',
  'Kileo', 'Macha', 'Temu', 'Urio', 'Nkya', 'Msuya', 'Chuwa', 'Moshi', 'Kessy', 'Mlay',
];

function pick(list, index) {
  return list[index % list.length];
}

async function seedDemo(adminId) {
  const config = await getAttendanceConfig();
  const today = todayInZone(config.timezone);

  const { rows: existing } = await query("SELECT COUNT(*)::int AS count FROM students");
  if (existing[0].count > 0) {
    logger.info('Students already present; skipping demo data');
    return;
  }

  logger.info('Seeding demo school data…');

  // --- Term ---------------------------------------------------------------
  await query(
    `INSERT INTO academic_terms (name, academic_year, start_date, end_date, is_current)
     VALUES ('Term 2', $1, $2::date, $3::date, TRUE)
     ON CONFLICT (name, academic_year) DO NOTHING`,
    [today.slice(0, 4), addDays(today, -75), addDays(today, 45)],
  );

  // --- Staff --------------------------------------------------------------
  const staff = [
    { email: 'office@school.local', name: 'Neema Office', role: 'office_staff' },
    { email: 'teacher.form1@school.local', name: 'Mr. Baraka Mushi', role: 'teacher' },
    { email: 'teacher.form2@school.local', name: 'Ms. Amina Kimaro', role: 'teacher' },
  ];
  const staffIds = {};
  for (const person of staff) {
    // Uniqueness on users is enforced by an index over lower(email), so the
    // simplest safe upsert here is a lookup followed by an insert.
    const { rows: found } = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [person.email]);
    if (found[0]) {
      staffIds[person.email] = found[0].id;
      continue;
    }
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, full_name, role, must_change_password)
       VALUES ($1,$2,$3,$4::user_role, TRUE) RETURNING id`,
      [person.email, await hashPassword('Password123'), person.name, person.role],
    );
    staffIds[person.email] = rows[0].id;
  }

  // --- Classes ------------------------------------------------------------
  const classDefs = [
    { name: 'Form 1A', grade: 'Form 1', teacher: 'teacher.form1@school.local' },
    { name: 'Form 1B', grade: 'Form 1', teacher: 'teacher.form1@school.local' },
    { name: 'Form 2A', grade: 'Form 2', teacher: 'teacher.form2@school.local' },
    { name: 'Form 3A', grade: 'Form 3', teacher: null },
  ];
  const classIds = [];
  for (const def of classDefs) {
    const { rows } = await query(
      `INSERT INTO classes (name, grade_level, academic_year) VALUES ($1,$2,$3) RETURNING id`,
      [def.name, def.grade, today.slice(0, 4)],
    );
    classIds.push(rows[0].id);
    if (def.teacher) {
      await query('INSERT INTO class_teachers (class_id, user_id, is_primary) VALUES ($1,$2,TRUE)', [
        rows[0].id,
        staffIds[def.teacher],
      ]);
    }
  }

  // --- Terminal -----------------------------------------------------------
  const { rows: deviceRows } = await query(
    `INSERT INTO devices (serial_number, name, location, model, timezone_offset, is_active)
     VALUES ('DEMO0000001', 'Main Gate Terminal', 'Main entrance', 'ZKTeco IN01-A', 3, TRUE)
     RETURNING id, serial_number`,
  );
  const device = deviceRows[0];

  // --- Students -----------------------------------------------------------
  const studentIds = [];
  const enrolledOn = addDays(today, -60);
  for (let i = 0; i < 96; i += 1) {
    const admissionNumber = `ADM${String(2000 + i).padStart(5, '0')}`;
    const pin = String(1001 + i);
    const { rows } = await query(
      `INSERT INTO students
         (admission_number, device_user_pin, first_name, last_name, gender, guardian_name,
          guardian_phone, status, enrolled_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::date)
       RETURNING id`,
      [
        admissionNumber,
        pin,
        pick(FIRST_NAMES, i * 7 + 3),
        pick(LAST_NAMES, i * 3),
        i % 2 === 0 ? 'female' : 'male',
        `${pick(FIRST_NAMES, i * 5)} ${pick(LAST_NAMES, i * 3)}`,
        `+2557${String(10_000_000 + i * 137).slice(0, 8)}`,
        enrolledOn,
      ],
    );
    const studentId = rows[0].id;
    studentIds.push({ id: studentId, pin });

    const classId = classIds[i % classIds.length];
    await query('INSERT INTO enrollments (student_id, class_id, start_date) VALUES ($1,$2,$3::date)', [
      studentId,
      classId,
      enrolledOn,
    ]);

    await query(
      `INSERT INTO device_users (device_id, pin, name, student_id, linked_at, fingerprint_count)
       VALUES ($1,$2,$3,$4, now(), 2)`,
      [device.id, pin, `Student ${admissionNumber}`, studentId],
    );
    for (const fingerIndex of [1, 6]) {
      await query(
        `INSERT INTO biometric_enrollments (student_id, device_id, finger_index, template_size)
         VALUES ($1,$2,$3,1130) ON CONFLICT DO NOTHING`,
        [studentId, device.id, fingerIndex],
      );
    }
  }

  // --- A holiday, so the calendar logic is visibly exercised ---------------
  const holiday = addDays(today, -14);
  await query(
    `INSERT INTO school_calendar (calendar_date, day_type, label, created_by)
     VALUES ($1::date, 'holiday', 'Public holiday', $2)
     ON CONFLICT (calendar_date) DO NOTHING`,
    [holiday, adminId],
  );

  // --- Six weeks of attendance events -------------------------------------
  // Deterministic pseudo-randomness keeps the demo reproducible: the same seed
  // always produces the same school, so screenshots and tests stay stable.
  let rngState = 42;
  const rand = () => {
    rngState = (rngState * 1_103_515_245 + 12_345) % 2_147_483_648;
    return rngState / 2_147_483_648;
  };

  const days = eachDateInclusive(addDays(today, -41), today).filter(
    (d) => isoWeekday(d) <= 5 && d !== holiday,
  );

  logger.info({ days: days.length, students: studentIds.length }, 'Generating attendance events…');

  // The last few closed days, used to plant a live absence streak.
  const recentDays = new Set(days.slice(-5, -1));

  const touched = new Set();
  for (const date of days) {
    for (const [index, student] of studentIds.entries()) {
      const roll = rand();
      // A handful of students are deliberately poor attenders so the chronic
      // absentee report and the alert engine have something to find.
      const chronic = index % 23 === 0;
      // Two of them stop coming altogether at the end of the period, which is
      // what raises a consecutive-absence alert on the demo dashboard.
      if (chronic && index % 46 === 0 && recentDays.has(date)) continue;
      const absenceChance = chronic ? 0.45 : 0.05;
      if (roll < absenceChance) continue;

      // Arrival times are generated in minutes-since-midnight against the
      // default 07:45 late cut-off: on time lands in 06:45–07:44, late in
      // 07:46–08:45.
      const late = rand() < (chronic ? 0.3 : 0.08);
      const arrivalMinutes = late
        ? 466 + Math.floor(rand() * 60)
        : 405 + Math.floor(rand() * 59);
      const clock =
        `${String(Math.floor(arrivalMinutes / 60)).padStart(2, '0')}:` +
        `${String(arrivalMinutes % 60).padStart(2, '0')}:` +
        `${String(Math.floor(rand() * 60)).padStart(2, '0')}`;
      const timestamp = `${date} ${clock}`;

      await query(
        `INSERT INTO attendance_events
           (device_id, device_serial, device_user_pin, student_id, event_time, local_date, local_time,
            punch_state, verify_mode, raw_line, dedupe_hash, applied)
         VALUES ($1,$2,$3,$4, ($5 || ' ' || $6)::timestamptz, $5::date, $6::time, 0, 1, $7, $8, FALSE)
         ON CONFLICT (dedupe_hash) DO NOTHING`,
        [
          device.id,
          device.serial_number,
          student.pin,
          student.id,
          date,
          timestamp.slice(11),
          `${student.pin}\t${timestamp}\t0\t1`,
          eventDedupeHash({
            serialNumber: device.serial_number,
            pin: student.pin,
            timestamp,
            punchState: 0,
          }),
        ],
      );
      touched.add(`${student.id}:${date}`);
    }
  }

  logger.info('Building daily attendance records…');
  const attendanceConfig = await getAttendanceConfig();
  for (const key of touched) {
    const [studentId, date] = key.split(':');
    await rebuildDailyRecord(Number(studentId), date, attendanceConfig);
  }

  // Today is deliberately left open: the dashboard should show a day in
  // progress, with students still arriving, rather than a closed register.
  logger.info('Finalising past days…');
  const finalizedDays = days.slice(0, -1);
  for (const date of finalizedDays) {
    await finalizeDay(date, { actorId: adminId, force: false });
  }

  // Streaks are only meaningful up to the last day that was actually closed.
  // Most alerts have already been raised by finalizeDay as each day closed;
  // this sweep is the safety net, so report the resulting total, not the delta.
  await refreshAllAlerts(finalizedDays[finalizedDays.length - 1] ?? days[0]);
  const { rows: alertCount } = await query(
    "SELECT COUNT(*)::int AS open FROM absentee_alerts WHERE status = 'open'",
  );
  logger.info({ openAlerts: alertCount[0].open }, 'Absentee alerts computed');

  process.stdout.write(
    `\n  Demo data ready\n` +
      `    students:  ${studentIds.length}\n` +
      `    classes:   ${classIds.length}\n` +
      `    days:      ${days.length}\n` +
      `    terminal:  ${device.serial_number}\n` +
      `    staff logins (password "Password123"):\n` +
      staff.map((s) => `      ${s.role.padEnd(13)} ${s.email}\n`).join('') +
      '\n',
  );
}

async function main() {
  await runMigrations({ silent: true });
  const admin = await ensureAdmin();
  if (process.argv.includes('--demo')) await seedDemo(admin.id);
}

main()
  .catch((err) => {
    logger.error({ err }, 'Seeding failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
