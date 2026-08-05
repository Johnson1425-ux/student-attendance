import { query, withTransaction } from '../db/pool.js';
import { NotFoundError, ConflictError, BadRequestError, mapDatabaseError } from '../lib/errors.js';
import { recordAudit } from './audit.service.js';

const CONSTRAINT_MESSAGES = {
  classes_name_year_unique: 'A class with this name already exists for that academic year',
};

/**
 * Classes and the teachers assigned to them. The assignment table is what the
 * teacher role's data scoping reads from, so changing it immediately changes
 * what a teacher can see.
 */

export async function listClasses({ includeInactive = false, classScope = null, academicYear } = {}) {
  const params = [];
  const conditions = [];
  if (!includeInactive) conditions.push('c.is_active');
  if (academicYear) {
    params.push(academicYear);
    conditions.push(`c.academic_year = $${params.length}`);
  }
  if (classScope) {
    params.push(classScope);
    conditions.push(`c.id = ANY($${params.length}::bigint[])`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT c.*,
            COALESCE(roster.student_count, 0)::int AS student_count,
            COALESCE(teachers.names, ARRAY[]::text[]) AS teacher_names,
            COALESCE(teachers.ids, ARRAY[]::bigint[]) AS teacher_ids
       FROM classes c
       LEFT JOIN (
         SELECT e.class_id, COUNT(*) AS student_count
           FROM enrollments e
           JOIN students s ON s.id = e.student_id AND s.status = 'active'
          WHERE e.end_date IS NULL
          GROUP BY e.class_id
       ) roster ON roster.class_id = c.id
       LEFT JOIN (
         SELECT ct.class_id,
                array_agg(u.full_name ORDER BY ct.is_primary DESC, u.full_name) AS names,
                array_agg(u.id ORDER BY ct.is_primary DESC, u.full_name) AS ids
           FROM class_teachers ct
           JOIN users u ON u.id = ct.user_id
          GROUP BY ct.class_id
       ) teachers ON teachers.class_id = c.id
       ${where}
      ORDER BY c.academic_year DESC, c.name`,
    params,
  );
  return rows;
}

export async function getClass(id) {
  const { rows } = await query('SELECT * FROM classes WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Class');

  const { rows: teachers } = await query(
    `SELECT u.id, u.full_name, u.email, u.role, ct.is_primary
       FROM class_teachers ct JOIN users u ON u.id = ct.user_id
      WHERE ct.class_id = $1
      ORDER BY ct.is_primary DESC, u.full_name`,
    [id],
  );

  const { rows: counts } = await query(
    `SELECT COUNT(*)::int AS student_count
       FROM enrollments e JOIN students s ON s.id = e.student_id AND s.status = 'active'
      WHERE e.class_id = $1 AND e.end_date IS NULL`,
    [id],
  );

  return { ...rows[0], teachers, student_count: counts[0].student_count };
}

export async function createClass(data, { actor, ip, userAgent } = {}) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO classes (name, grade_level, stream, academic_year, room, is_active)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, TRUE)) RETURNING *`,
        [data.name, data.gradeLevel ?? null, data.stream ?? null, data.academicYear, data.room ?? null, data.isActive],
      );
      const created = rows[0];

      if (data.teacherIds?.length) {
        await assignTeachers(client, created.id, data.teacherIds);
      }

      await recordAudit(
        {
          actorId: actor?.id,
          actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
          action: 'class.create',
          entityType: 'class',
          entityId: created.id,
          summary: `Created class ${created.name} (${created.academic_year})`,
          after: created,
          ip,
          userAgent,
        },
        client,
      );
      return created;
    }).then((created) => getClass(created.id));
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

const UPDATABLE = {
  name: 'name',
  gradeLevel: 'grade_level',
  stream: 'stream',
  academicYear: 'academic_year',
  room: 'room',
  isActive: 'is_active',
};

export async function updateClass(id, patch, { actor, ip, userAgent } = {}) {
  const { rows: existing } = await query('SELECT * FROM classes WHERE id = $1', [id]);
  const before = existing[0];
  if (!before) throw new NotFoundError('Class');

  const assignments = [];
  const params = [id];
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    assignments.push(`${column} = $${params.length}`);
  }
  if (assignments.length === 0 && patch.teacherIds === undefined) {
    throw new BadRequestError('No changes supplied');
  }

  try {
    await withTransaction(async (client) => {
      let after = before;
      if (assignments.length) {
        const { rows } = await client.query(
          `UPDATE classes SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
          params,
        );
        after = rows[0];
      }
      if (patch.teacherIds !== undefined) {
        await client.query('DELETE FROM class_teachers WHERE class_id = $1', [id]);
        if (patch.teacherIds.length) await assignTeachers(client, id, patch.teacherIds);
      }
      await recordAudit(
        {
          actorId: actor?.id,
          actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
          action: 'class.update',
          entityType: 'class',
          entityId: id,
          summary: `Updated class ${after.name}`,
          before,
          after,
          ip,
          userAgent,
        },
        client,
      );
    });
    return getClass(id);
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

async function assignTeachers(client, classId, teacherIds) {
  const { rows } = await client.query(
    `SELECT id, role FROM users WHERE id = ANY($1::bigint[]) AND is_active`,
    [teacherIds],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = teacherIds.filter((id) => !found.has(Number(id)));
  if (missing.length) throw new BadRequestError(`Unknown or inactive user id(s): ${missing.join(', ')}`);

  await client.query(
    `INSERT INTO class_teachers (class_id, user_id, is_primary)
     SELECT $1, u, (u = $2) FROM unnest($3::bigint[]) AS u
     ON CONFLICT (class_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
    [classId, teacherIds[0], teacherIds],
  );
}

/**
 * Classes hold attendance history, so they are deactivated rather than deleted
 * once anyone has been enrolled in them.
 */
export async function deleteClass(id, { actor, ip, userAgent } = {}) {
  const { rows: usage } = await query('SELECT COUNT(*)::int AS count FROM enrollments WHERE class_id = $1', [id]);
  if (usage[0].count > 0) {
    throw new ConflictError(
      'This class has students enrolled (now or in the past). Deactivate it instead so its attendance history is kept.',
    );
  }
  const { rows } = await query('DELETE FROM classes WHERE id = $1 RETURNING id, name', [id]);
  if (!rows[0]) throw new NotFoundError('Class');

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'class.delete',
    entityType: 'class',
    entityId: id,
    summary: `Deleted class ${rows[0].name}`,
    before: rows[0],
    ip,
    userAgent,
  });
  return rows[0];
}

export async function listAcademicTerms() {
  const { rows } = await query('SELECT * FROM academic_terms ORDER BY start_date DESC');
  return rows;
}

export async function getCurrentTerm() {
  const { rows } = await query('SELECT * FROM academic_terms WHERE is_current LIMIT 1');
  return rows[0] ?? null;
}

export async function upsertAcademicTerm(data, { actor, ip, userAgent } = {}) {
  return withTransaction(async (client) => {
    if (data.isCurrent) {
      await client.query('UPDATE academic_terms SET is_current = FALSE WHERE is_current');
    }
    const { rows } = await client.query(
      `INSERT INTO academic_terms (name, academic_year, start_date, end_date, is_current)
       VALUES ($1,$2,$3::date,$4::date,COALESCE($5, FALSE))
       ON CONFLICT (name, academic_year) DO UPDATE SET
         start_date = EXCLUDED.start_date,
         end_date   = EXCLUDED.end_date,
         is_current = EXCLUDED.is_current
       RETURNING *`,
      [data.name, data.academicYear, data.startDate, data.endDate, data.isCurrent],
    );
    await recordAudit(
      {
        actorId: actor?.id,
        actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
        action: 'term.upsert',
        entityType: 'academic_term',
        entityId: rows[0].id,
        summary: `Saved term ${rows[0].name} ${rows[0].academic_year}`,
        after: rows[0],
        ip,
        userAgent,
      },
      client,
    );
    return rows[0];
  });
}

export async function deleteAcademicTerm(id) {
  const { rows } = await query('DELETE FROM academic_terms WHERE id = $1 RETURNING id, name', [id]);
  if (!rows[0]) throw new NotFoundError('Academic term');
  return rows[0];
}
