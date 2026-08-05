import { query } from '../db/pool.js';
import { NotFoundError, BadRequestError, ConflictError, mapDatabaseError } from '../lib/errors.js';
import { hashPassword, validatePasswordStrength, generateTemporaryPassword } from '../lib/password.js';
import { recordAudit } from './audit.service.js';
import { logoutAllSessions } from './auth.service.js';

const CONSTRAINT_MESSAGES = {
  users_email_unique: 'An account with this email address already exists',
};

const PUBLIC_FIELDS = `
  u.id, u.email, u.full_name, u.role, u.phone, u.is_active,
  u.must_change_password, u.last_login_at, u.created_at, u.updated_at
`;

export async function listUsers({ includeInactive = true, role } = {}) {
  const params = [];
  const conditions = [];
  if (!includeInactive) conditions.push('u.is_active');
  if (role) {
    params.push(role);
    conditions.push(`u.role = $${params.length}::user_role`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT ${PUBLIC_FIELDS},
            COALESCE(cls.names, ARRAY[]::text[]) AS class_names,
            COALESCE(cls.ids, ARRAY[]::bigint[]) AS class_ids
       FROM users u
       LEFT JOIN (
         SELECT ct.user_id,
                array_agg(c.name ORDER BY c.name) AS names,
                array_agg(c.id ORDER BY c.name) AS ids
           FROM class_teachers ct JOIN classes c ON c.id = ct.class_id
          GROUP BY ct.user_id
       ) cls ON cls.user_id = u.id
       ${where}
      ORDER BY u.full_name`,
    params,
  );
  return rows;
}

export async function getUser(id) {
  const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM users u WHERE u.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('User');

  const { rows: classes } = await query(
    `SELECT c.id, c.name, c.academic_year, ct.is_primary
       FROM class_teachers ct JOIN classes c ON c.id = ct.class_id
      WHERE ct.user_id = $1 ORDER BY c.name`,
    [id],
  );
  return { ...rows[0], classes };
}

/**
 * Create a staff account. If no password is supplied a random one is generated
 * and returned once, so an admin can hand it over in person — the account is
 * then flagged to force a change at first sign-in.
 */
export async function createUser(data, { actor, ip, userAgent } = {}) {
  const generatedPassword = data.password ? null : generateTemporaryPassword();
  const password = data.password ?? generatedPassword;

  const problems = validatePasswordStrength(password);
  if (problems.length) throw new BadRequestError(`Password ${problems.join(', ')}`, { password: problems });

  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, full_name, role, phone, is_active, must_change_password)
       VALUES ($1,$2,$3,$4::user_role,$5,COALESCE($6, TRUE),$7)
       RETURNING id, email, full_name, role, phone, is_active, must_change_password, created_at`,
      [
        data.email.trim().toLowerCase(),
        await hashPassword(password),
        data.fullName,
        data.role,
        data.phone ?? null,
        data.isActive,
        Boolean(generatedPassword) || Boolean(data.mustChangePassword),
      ],
    );
    const created = rows[0];

    if (data.classIds?.length) await setUserClasses(created.id, data.classIds);

    await recordAudit({
      actorId: actor?.id,
      actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      summary: `Created ${created.role} account for ${created.full_name}`,
      after: created,
      ip,
      userAgent,
    });

    return { ...created, generatedPassword };
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

const UPDATABLE = { email: 'email', fullName: 'full_name', role: 'role', phone: 'phone', isActive: 'is_active' };

export async function updateUser(id, patch, { actor, ip, userAgent } = {}) {
  const { rows: existing } = await query(`SELECT ${PUBLIC_FIELDS} FROM users u WHERE u.id = $1`, [id]);
  const before = existing[0];
  if (!before) throw new NotFoundError('User');

  // Locking out the last administrator would leave nobody able to fix it.
  if ((patch.isActive === false || (patch.role && patch.role !== 'admin')) && before.role === 'admin') {
    await assertNotLastAdmin(id);
  }

  const assignments = [];
  const params = [id];
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (patch[field] === undefined) continue;
    params.push(field === 'email' ? String(patch[field]).trim().toLowerCase() : patch[field]);
    assignments.push(`${column} = $${params.length}${column === 'role' ? '::user_role' : ''}`);
  }

  if (assignments.length === 0 && patch.classIds === undefined) throw new BadRequestError('No changes supplied');

  try {
    let after = before;
    if (assignments.length) {
      const { rows } = await query(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = $1
         RETURNING id, email, full_name, role, phone, is_active, must_change_password, last_login_at, created_at, updated_at`,
        params,
      );
      after = rows[0];
    }
    if (patch.classIds !== undefined) await setUserClasses(id, patch.classIds);

    // A deactivated account must lose its live sessions immediately.
    if (patch.isActive === false) await logoutAllSessions(id);

    await recordAudit({
      actorId: actor?.id,
      actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      summary: `Updated account ${after.full_name}`,
      before,
      after,
      ip,
      userAgent,
    });
    return getUser(id);
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

export async function setUserClasses(userId, classIds) {
  await query('DELETE FROM class_teachers WHERE user_id = $1', [userId]);
  if (!classIds?.length) return;
  const { rows } = await query('SELECT id FROM classes WHERE id = ANY($1::bigint[])', [classIds]);
  const found = new Set(rows.map((r) => r.id));
  const missing = classIds.filter((id) => !found.has(Number(id)));
  if (missing.length) throw new BadRequestError(`Unknown class id(s): ${missing.join(', ')}`);

  await query(
    `INSERT INTO class_teachers (class_id, user_id) SELECT c, $1 FROM unnest($2::bigint[]) AS c
     ON CONFLICT DO NOTHING`,
    [userId, classIds],
  );
}

/** Admin-initiated reset. Returns the temporary password exactly once. */
export async function resetUserPassword(id, { newPassword, actor, ip, userAgent } = {}) {
  const generated = newPassword ? null : generateTemporaryPassword();
  const password = newPassword ?? generated;
  const problems = validatePasswordStrength(password);
  if (problems.length) throw new BadRequestError(`Password ${problems.join(', ')}`, { password: problems });

  const { rows } = await query(
    'UPDATE users SET password_hash = $2, must_change_password = TRUE WHERE id = $1 RETURNING id, full_name, email',
    [id, await hashPassword(password)],
  );
  if (!rows[0]) throw new NotFoundError('User');

  await logoutAllSessions(id);
  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'user.password_reset',
    entityType: 'user',
    entityId: id,
    summary: `Reset password for ${rows[0].full_name}`,
    ip,
    userAgent,
  });

  return { ...rows[0], temporaryPassword: generated ?? undefined };
}

export async function deleteUser(id, { actor, ip, userAgent } = {}) {
  const { rows: existing } = await query('SELECT id, role, full_name, email FROM users WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('User');
  if (existing[0].role === 'admin') await assertNotLastAdmin(id);

  const { rows } = await query('DELETE FROM users WHERE id = $1 RETURNING id, full_name, email', [id]);

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'user.delete',
    entityType: 'user',
    entityId: id,
    summary: `Deleted account ${rows[0].full_name} (${rows[0].email})`,
    before: existing[0],
    ip,
    userAgent,
  });
  return rows[0];
}

async function assertNotLastAdmin(excludingId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active AND id <> $1`,
    [excludingId],
  );
  if (rows[0].count === 0) {
    throw new ConflictError('This is the last active administrator account — promote another admin first');
  }
}
