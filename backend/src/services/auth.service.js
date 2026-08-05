import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../lib/errors.js';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  validatePasswordStrength,
} from '../lib/password.js';

/**
 * Authentication: short-lived JWT access tokens plus rotating refresh tokens.
 *
 * Refresh tokens are stored hashed and single-use — presenting one issues a
 * replacement and revokes the original. If a stolen token is replayed after the
 * legitimate holder has rotated, the reuse is detectable (the row is already
 * revoked) and the whole token family is dropped.
 */

const PUBLIC_USER_FIELDS = `
  id, email, full_name, role, phone, is_active, must_change_password, last_login_at, created_at
`;

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, email: user.email, name: user.full_name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL, issuer: 'student-attendance' },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'student-attendance' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new UnauthorizedError('Session expired, please sign in again');
    throw new UnauthorizedError('Invalid authentication token');
  }
}

async function issueRefreshToken(userId, { userAgent, ip, replacesId } = {}, client) {
  const runner = client ?? { query };
  const token = generateToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await runner.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, hashToken(token), expiresAt, userAgent ?? null, ip ?? null],
  );
  if (replacesId) {
    await runner.query('UPDATE refresh_tokens SET replaced_by = $1 WHERE id = $2', [rows[0].id, replacesId]);
  }
  return { token, expiresAt };
}

export async function login({ email, password, userAgent, ip }) {
  const { rows } = await query(
    `SELECT id, email, full_name, role, phone, is_active, must_change_password, password_hash
       FROM users WHERE lower(email) = lower($1)`,
    [String(email ?? '').trim()],
  );
  const user = rows[0];

  // Always run a comparison so a missing account and a wrong password take the
  // same amount of time and cannot be told apart by an attacker.
  const passwordOk = await verifyPassword(password ?? '', user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');

  if (!user || !passwordOk) throw new UnauthorizedError('Incorrect email or password');
  if (!user.is_active) throw new UnauthorizedError('This account has been deactivated');

  const { token: refreshToken, expiresAt } = await issueRefreshToken(user.id, { userAgent, ip });
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  const { password_hash, ...safeUser } = user;
  return {
    user: { ...safeUser, last_login_at: new Date().toISOString() },
    accessToken: signAccessToken(user),
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

/**
 * Signals that an already-rotated refresh token was presented again. Carried
 * out of the transaction so the response to a detected replay — revoking every
 * session for that account — is not rolled back along with it.
 */
class TokenReuseDetected extends Error {
  constructor(userId) {
    super('Refresh token reuse detected');
    this.userId = userId;
  }
}

export async function refreshSession({ refreshToken, userAgent, ip }) {
  if (!refreshToken) throw new UnauthorizedError('Refresh token required');
  const tokenHash = hashToken(refreshToken);

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT rt.*, u.email, u.full_name, u.role, u.is_active
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt`,
        [tokenHash],
      );
      const stored = rows[0];
      if (!stored) throw new UnauthorizedError('Invalid refresh token');

      // Replay of an already-rotated token means the token was captured
      // somewhere. Both the thief and the legitimate holder are signed out —
      // handled after the transaction, since this one is about to roll back.
      if (stored.revoked_at) throw new TokenReuseDetected(stored.user_id);

      if (new Date(stored.expires_at) < new Date()) throw new UnauthorizedError('Refresh token expired');
      if (!stored.is_active) throw new UnauthorizedError('This account has been deactivated');

      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
      const { token, expiresAt } = await issueRefreshToken(
        stored.user_id,
        { userAgent, ip, replacesId: stored.id },
        client,
      );

      const user = {
        id: stored.user_id,
        email: stored.email,
        full_name: stored.full_name,
        role: stored.role,
      };
      return { accessToken: signAccessToken(user), refreshToken: token, refreshTokenExpiresAt: expiresAt, user };
    });
  } catch (err) {
    if (err instanceof TokenReuseDetected) {
      await logoutAllSessions(err.userId);
      throw new UnauthorizedError('Refresh token has already been used, please sign in again');
    }
    throw err;
  }
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    hashToken(refreshToken),
  ]);
}

export async function logoutAllSessions(userId) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function getCurrentUser(userId) {
  const { rows } = await query(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw new NotFoundError('User');
  return rows[0];
}

export async function changeOwnPassword(userId, { currentPassword, newPassword }) {
  const { rows } = await query('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw new NotFoundError('User');

  if (!(await verifyPassword(currentPassword ?? '', user.password_hash))) {
    throw new UnauthorizedError('Current password is incorrect');
  }
  const problems = validatePasswordStrength(newPassword);
  if (problems.length) throw new BadRequestError(`Password ${problems.join(', ')}`, { newPassword: problems });
  if (currentPassword === newPassword) {
    throw new BadRequestError('The new password must be different from the current one');
  }

  await query(
    'UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1',
    [userId, await hashPassword(newPassword)],
  );
  // Force other devices to re-authenticate with the new credential.
  await logoutAllSessions(userId);
}

/** Remove refresh tokens that expired or were revoked long ago. */
export async function pruneExpiredRefreshTokens() {
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - INTERVAL '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days')`,
  );
  return rowCount;
}
