import { query, withTransaction } from '../db/pool.js';
import { NotFoundError, ConflictError, BadRequestError, mapDatabaseError } from '../lib/errors.js';
import { recordAudit } from './audit.service.js';
import { backfillEventsForPin } from './attendance.service.js';

/**
 * Student records and their class placement (PRD §7.1).
 *
 * Class membership lives in `enrollments` with start/end dates rather than a
 * column on the student, so moving a child between classes mid-year does not
 * rewrite last term's reports.
 */

const CONSTRAINT_MESSAGES = {
  students_admission_number_unique: 'A student with this admission number already exists',
  students_device_pin_unique: 'This terminal PIN is already assigned to another student',
  students_pin_format: 'The terminal PIN must be digits only',
  enrollments_one_active_per_student: 'This student is already assigned to a class',
};

const STUDENT_COLUMNS = [
  'id', 'admission_number', 'device_user_pin', 'first_name', 'middle_name', 'last_name',
  'date_of_birth', 'gender', 'guardian_name', 'guardian_phone', 'guardian_email',
  'address', 'status', 'enrolled_on', 'exited_on', 'notes', 'created_at', 'updated_at',
];

/** Column list qualified with the `students s` alias, for joined queries. */
const STUDENT_SELECT = STUDENT_COLUMNS.map((c) => `s.${c}`).join(', ');
/** Same list unqualified, for RETURNING clauses on single-table statements. */
const STUDENT_RETURNING = STUDENT_COLUMNS.join(', ');

function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    full_name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
  };
}

export async function listStudents({
  page = 1,
  pageSize = 50,
  search,
  classId,
  status = 'active',
  hasBiometrics,
  classScope = null,
  sort = 'name',
} = {}) {
  const params = [];
  const conditions = [];

  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`s.status = $${params.length}::student_status`);
  }
  if (search) {
    params.push(`%${String(search).toLowerCase().trim()}%`);
    conditions.push(
      `(lower(s.first_name || ' ' || COALESCE(s.middle_name || ' ', '') || s.last_name) LIKE $${params.length}
        OR lower(s.admission_number) LIKE $${params.length}
        OR s.device_user_pin LIKE $${params.length}
        OR lower(COALESCE(s.guardian_name, '')) LIKE $${params.length})`,
    );
  }
  if (classId) {
    params.push(classId);
    conditions.push(`e.class_id = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`e.class_id = ANY($${params.length}::bigint[])`);
  }
  if (hasBiometrics === true) conditions.push('bio.finger_count > 0');
  if (hasBiometrics === false) conditions.push('COALESCE(bio.finger_count, 0) = 0');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  // Interpolated into SQL, so the value must come from this map and nowhere
  // else. Object.hasOwn stops a key like "constructor" resolving through the
  // prototype chain to something that is not a sort clause at all.
  const SORTS = {
    name: 's.last_name, s.first_name',
    admission: 's.admission_number',
    newest: 's.created_at DESC',
    class: 'c.name NULLS LAST, s.last_name',
  };
  const orderBy = Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.name;

  const { rows } = await query(
    `SELECT ${STUDENT_SELECT},
            c.id AS class_id, c.name AS class_name, c.grade_level,
            COALESCE(bio.finger_count, 0)::int AS fingerprints_enrolled,
            COUNT(*) OVER () AS total_count
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN (
         SELECT student_id, COUNT(*) AS finger_count
           FROM biometric_enrollments GROUP BY student_id
       ) bio ON bio.student_id = s.id
       ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    data: rows.map(({ total_count, ...row }) => decorate(row)),
    pagination: { page: Math.max(Number(page) || 1, 1), pageSize: limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getStudent(id) {
  const { rows } = await query(
    `SELECT ${STUDENT_SELECT},
            c.id AS class_id, c.name AS class_name, c.grade_level, c.academic_year
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       LEFT JOIN classes c ON c.id = e.class_id
      WHERE s.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Student');

  const [{ rows: biometrics }, { rows: history }] = await Promise.all([
    query(
      `SELECT b.id, b.finger_index, b.enrolled_at, b.quality, d.name AS device_name, d.serial_number
         FROM biometric_enrollments b
         JOIN devices d ON d.id = b.device_id
        WHERE b.student_id = $1
        ORDER BY b.finger_index`,
      [id],
    ),
    query(
      `SELECT e.id, e.class_id, c.name AS class_name, e.start_date, e.end_date
         FROM enrollments e JOIN classes c ON c.id = e.class_id
        WHERE e.student_id = $1
        ORDER BY e.start_date DESC`,
      [id],
    ),
  ]);

  return { ...decorate(rows[0]), biometrics, enrollment_history: history };
}

export async function createStudent(data, { actor, ip, userAgent } = {}) {
  const { classId, ...student } = data;

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO students
           (admission_number, device_user_pin, first_name, middle_name, last_name, date_of_birth,
            gender, guardian_name, guardian_phone, guardian_email, address, status, enrolled_on, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::student_status,'active'),COALESCE($13::date, CURRENT_DATE),$14)
         RETURNING ${STUDENT_RETURNING}`,
        [
          student.admissionNumber,
          student.deviceUserPin ?? null,
          student.firstName,
          student.middleName ?? null,
          student.lastName,
          student.dateOfBirth ?? null,
          student.gender ?? null,
          student.guardianName ?? null,
          student.guardianPhone ?? null,
          student.guardianEmail ?? null,
          student.address ?? null,
          student.status ?? null,
          student.enrolledOn ?? null,
          student.notes ?? null,
        ],
      );
      const created = rows[0];

      if (classId) {
        await client.query(
          'INSERT INTO enrollments (student_id, class_id, start_date) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE))',
          [created.id, classId, student.enrolledOn ?? null],
        );
      }

      await recordAudit(
        {
          actorId: actor?.id,
          actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
          action: 'student.create',
          entityType: 'student',
          entityId: created.id,
          summary: `Added student ${created.first_name} ${created.last_name} (${created.admission_number})`,
          after: created,
          ip,
          userAgent,
        },
        client,
      );

      return created;
    }).then(async (created) => {
      // A PIN may already have punches from before the record existed
      // (enrolled at the terminal first). Claim that history now.
      if (created.device_user_pin) await backfillEventsForPin(created.device_user_pin, created.id);
      return getStudent(created.id);
    });
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

const UPDATABLE_COLUMNS = {
  admissionNumber: 'admission_number',
  deviceUserPin: 'device_user_pin',
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  guardianName: 'guardian_name',
  guardianPhone: 'guardian_phone',
  guardianEmail: 'guardian_email',
  address: 'address',
  status: 'status',
  enrolledOn: 'enrolled_on',
  exitedOn: 'exited_on',
  notes: 'notes',
};

export async function updateStudent(id, patch, { actor, ip, userAgent } = {}) {
  const { rows: existingRows } = await query(`SELECT ${STUDENT_SELECT} FROM students s WHERE s.id = $1`, [id]);
  const before = existingRows[0];
  if (!before) throw new NotFoundError('Student');

  const assignments = [];
  const params = [id];
  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    const cast = column === 'status' ? '::student_status' : '';
    assignments.push(`${column} = $${params.length}${cast}`);
  }

  if (assignments.length === 0 && patch.classId === undefined) {
    throw new BadRequestError('No changes supplied');
  }

  // The terminal knows this student by their PIN, not by their database id.
  // Changing or clearing the PIN while fingerprints are enrolled against the
  // old one silently detaches them: the student keeps scanning, the device
  // keeps accepting, and nothing lands against their record. Block it and say
  // what to do instead.
  if (patch.deviceUserPin !== undefined && patch.deviceUserPin !== before.device_user_pin) {
    const { rows: bio } = await query(
      'SELECT COUNT(*)::int AS count FROM biometric_enrollments WHERE student_id = $1',
      [id],
    );
    if (bio[0].count > 0) {
      throw new ConflictError(
        `This student has ${bio[0].count} fingerprint(s) enrolled on a terminal under PIN ${before.device_user_pin}. ` +
          'Remove the fingerprints from the terminal first, then change the PIN and re-enrol.',
      );
    }
  }

  try {
    const updated = await withTransaction(async (client) => {
      let after = before;
      if (assignments.length > 0) {
        const { rows } = await client.query(
          `UPDATE students SET ${assignments.join(', ')} WHERE id = $1 RETURNING ${STUDENT_RETURNING}`,
          params,
        );
        after = rows[0];
      }

      if (patch.classId !== undefined) {
        await moveToClass(client, id, patch.classId, patch.transferDate);
      }

      await recordAudit(
        {
          actorId: actor?.id,
          actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
          action: 'student.update',
          entityType: 'student',
          entityId: id,
          summary: `Updated student ${after.first_name} ${after.last_name}`,
          before,
          after,
          ip,
          userAgent,
        },
        client,
      );
      return after;
    });

    if (patch.deviceUserPin && patch.deviceUserPin !== before.device_user_pin) {
      await backfillEventsForPin(patch.deviceUserPin, id);
    }
    return getStudent(updated.id ?? id);
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

/** Close the current enrollment and open a new one, preserving history. */
async function moveToClass(client, studentId, classId, transferDate) {
  const effectiveDate = transferDate ?? null;

  const { rows: current } = await client.query(
    'SELECT id, class_id, start_date FROM enrollments WHERE student_id = $1 AND end_date IS NULL',
    [studentId],
  );
  if (current[0]?.class_id === classId) return;

  if (current[0]) {
    // End the old placement the day before the new one begins, unless that
    // would precede its own start (same-day correction).
    await client.query(
      `UPDATE enrollments
          SET end_date = GREATEST(start_date, COALESCE($2::date, CURRENT_DATE) - 1)
        WHERE id = $1`,
      [current[0].id, effectiveDate],
    );
  }

  if (classId !== null) {
    await client.query(
      'INSERT INTO enrollments (student_id, class_id, start_date) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE))',
      [studentId, classId, effectiveDate],
    );
  }
}

/**
 * Students are archived, never deleted: their attendance history is part of the
 * school's record. Deletion is only offered for a student with no attendance at
 * all, which is how a data-entry mistake gets cleaned up.
 */
export async function archiveStudent(id, { status = 'inactive', exitedOn, actor, ip, userAgent } = {}) {
  const { rows } = await query(
    `UPDATE students
        SET status = $2::student_status, exited_on = COALESCE($3::date, CURRENT_DATE)
      WHERE id = $1
      RETURNING ${STUDENT_RETURNING}`,
    [id, status, exitedOn ?? null],
  );
  if (!rows[0]) throw new NotFoundError('Student');

  await query('UPDATE enrollments SET end_date = COALESCE($2::date, CURRENT_DATE) WHERE student_id = $1 AND end_date IS NULL', [
    id,
    exitedOn ?? null,
  ]);
  await query(
    `UPDATE absentee_alerts SET status = 'resolved', resolved_at = now()
      WHERE student_id = $1 AND status IN ('open','acknowledged')`,
    [id],
  );

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'student.archive',
    entityType: 'student',
    entityId: id,
    summary: `Archived student ${rows[0].first_name} ${rows[0].last_name} as ${status}`,
    after: rows[0],
    ip,
    userAgent,
  });

  return decorate(rows[0]);
}

export async function deleteStudent(id, { actor, ip, userAgent } = {}) {
  const { rows: counts } = await query(
    'SELECT COUNT(*)::int AS records FROM attendance_records WHERE student_id = $1',
    [id],
  );
  if (counts[0].records > 0) {
    throw new ConflictError(
      'This student has attendance history and cannot be deleted. Archive them instead to keep the record intact.',
    );
  }

  const { rows } = await query('DELETE FROM students WHERE id = $1 RETURNING id, first_name, last_name, admission_number', [id]);
  if (!rows[0]) throw new NotFoundError('Student');

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'student.delete',
    entityType: 'student',
    entityId: id,
    summary: `Deleted student ${rows[0].first_name} ${rows[0].last_name} (${rows[0].admission_number})`,
    before: rows[0],
    ip,
    userAgent,
  });
  return rows[0];
}

/**
 * Bulk import from a CSV upload. Rows are validated individually and a failure
 * on row 40 does not roll back the first 39 — a partially imported list with a
 * clear error report is more useful to office staff than an all-or-nothing
 * rejection of a 600-row spreadsheet.
 */
export async function importStudents(rows, { actor, ip, userAgent } = {}) {
  const created = [];
  const failed = [];

  for (const [index, row] of rows.entries()) {
    try {
      if (!row.admissionNumber || !row.firstName || !row.lastName) {
        throw new BadRequestError('admissionNumber, firstName and lastName are required');
      }
      let classId = row.classId ?? null;
      if (!classId && row.className) {
        const { rows: classRows } = await query('SELECT id FROM classes WHERE lower(name) = lower($1) LIMIT 1', [
          row.className,
        ]);
        if (!classRows[0]) throw new BadRequestError(`Unknown class "${row.className}"`);
        classId = classRows[0].id;
      }
      const student = await createStudent({ ...row, classId }, { actor, ip, userAgent });
      created.push({ row: index + 1, id: student.id, admissionNumber: student.admission_number });
    } catch (err) {
      failed.push({ row: index + 1, admissionNumber: row.admissionNumber ?? null, reason: err.message });
    }
  }

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'student.import',
    entityType: 'student',
    summary: `Imported ${created.length} student(s), ${failed.length} row(s) rejected`,
    ip,
    userAgent,
  });

  return { created, failed, total: rows.length };
}

/** Roster for a class on a given day — the list a teacher works from. */
export async function listClassRoster(classId) {
  const { rows } = await query(
    `SELECT ${STUDENT_SELECT}, COALESCE(bio.finger_count, 0)::int AS fingerprints_enrolled
       FROM students s
       JOIN enrollments e ON e.student_id = s.id AND e.end_date IS NULL
       LEFT JOIN (
         SELECT student_id, COUNT(*) AS finger_count FROM biometric_enrollments GROUP BY student_id
       ) bio ON bio.student_id = s.id
      WHERE e.class_id = $1 AND s.status = 'active'
      ORDER BY s.last_name, s.first_name`,
    [classId],
  );
  return rows.map(decorate);
}
