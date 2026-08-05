import { query } from '../db/pool.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { verifyAccessToken } from '../services/auth.service.js';

/**
 * Role model (PRD §4):
 *   admin        — everything
 *   office_staff — students, enrollment, manual attendance corrections
 *   teacher      — read-only, and only for the classes they are assigned to
 */
export const ROLES = Object.freeze({ ADMIN: 'admin', TEACHER: 'teacher', OFFICE_STAFF: 'office_staff' });

function readBearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/**
 * Verify the access token and load the live user row. Loading from the database
 * on each request (rather than trusting the JWT payload alone) means
 * deactivating an account takes effect immediately instead of when the token
 * happens to expire.
 */
export async function requireAuth(req, _res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) throw new UnauthorizedError('Authentication required');

    const payload = verifyAccessToken(token);
    const { rows } = await query(
      'SELECT id, email, full_name, role, is_active, must_change_password FROM users WHERE id = $1',
      [Number(payload.sub)],
    );
    const user = rows[0];
    if (!user) throw new UnauthorizedError('Account no longer exists');
    if (!user.is_active) throw new UnauthorizedError('This account has been deactivated');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Restrict a route to the given roles. */
export function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!allowed.has(req.user.role)) {
      return next(
        new ForbiddenError(
          `This action requires the ${[...allowed].join(' or ')} role; you are signed in as ${req.user.role}`,
        ),
      );
    }
    return next();
  };
}

/** Convenience guards for the two common combinations. */
export const requireAdmin = requireRole(ROLES.ADMIN);
export const requireStaff = requireRole(ROLES.ADMIN, ROLES.OFFICE_STAFF);

/**
 * Class ids the signed-in user may see. Admins and office staff see everything
 * (returns null, meaning "no restriction"); a teacher sees only their own
 * classes, which is the guarantee behind PRD §4 "view attendance for their own
 * class(es)".
 */
export async function visibleClassIds(user) {
  if (!user) return [];
  if (user.role === ROLES.ADMIN || user.role === ROLES.OFFICE_STAFF) return null;
  const { rows } = await query('SELECT class_id FROM class_teachers WHERE user_id = $1', [user.id]);
  return rows.map((r) => r.class_id);
}

/**
 * Attach `req.classScope` — null for unrestricted users, otherwise the array of
 * class ids the teacher owns. Routes that return class-linked data must apply
 * it; `assertClassAccess` covers the single-class case.
 */
export async function attachClassScope(req, _res, next) {
  try {
    req.classScope = await visibleClassIds(req.user);
    next();
  } catch (err) {
    next(err);
  }
}

export function assertClassAccess(req, classId) {
  if (req.classScope === null || req.classScope === undefined) return;
  if (!req.classScope.includes(Number(classId))) {
    throw new ForbiddenError('You are not assigned to this class');
  }
}

/**
 * Teachers may only look at a student who is currently in one of their classes.
 */
export async function assertStudentAccess(req, studentId) {
  if (req.classScope === null || req.classScope === undefined) return;
  if (req.classScope.length === 0) throw new ForbiddenError('You are not assigned to any classes');
  const { rows } = await query(
    `SELECT 1 FROM enrollments
      WHERE student_id = $1 AND end_date IS NULL AND class_id = ANY($2::bigint[]) LIMIT 1`,
    [studentId, req.classScope],
  );
  if (rows.length === 0) throw new ForbiddenError('This student is not in one of your classes');
}
