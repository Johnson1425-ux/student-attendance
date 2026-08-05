import bcrypt from 'bcryptjs';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { isTest } from '../config/env.js';

// 12 rounds is the cost target for production. Tests use the minimum so the
// suite is not dominated by deliberate key stretching.
const SALT_ROUNDS = isTest ? 4 : 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

/** Opaque, high-entropy token for refresh tokens and device push secrets. */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// Deliberately excludes 0/O and 1/l/I, and any punctuation. These passwords are
// read off a screen and typed in by hand, often by somebody being told them
// across a desk, so characters that look alike cost real support calls.
const TEMP_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TEMP_DIGITS = '23456789';

function pick(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * A temporary password for a new or reset staff account.
 *
 * Built to satisfy validatePasswordStrength *by construction* rather than by
 * luck: a plain random token has no guaranteed digit, so roughly one in eight
 * was rejected by our own policy — surfacing to an admin as "Password must
 * contain a number" about a password they never typed.
 *
 * 12 characters over a 57-character alphabet is ~70 bits, far more than a
 * credential that is meant to be replaced at first sign-in needs.
 */
export function generateTemporaryPassword(length = 12) {
  const chars = [pick(TEMP_DIGITS), pick(TEMP_DIGITS), pick(TEMP_LETTERS), pick(TEMP_LETTERS)];
  while (chars.length < length) chars.push(pick(TEMP_LETTERS + TEMP_DIGITS));

  // Fisher-Yates with a CSPRNG, so the guaranteed characters are not always in
  // the first four positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Refresh tokens are stored only as a hash, so a DB leak is not a session leak. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for shared secrets sent by devices. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Password policy for staff accounts. Deliberately modest — the users are
 * school office staff, and a rule they cannot satisfy leads to shared logins.
 */
export function validatePasswordStrength(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 8) {
    problems.push('must be at least 8 characters long');
  }
  if (!/[A-Za-z]/.test(password ?? '')) problems.push('must contain a letter');
  if (!/[0-9]/.test(password ?? '')) problems.push('must contain a number');
  return problems;
}
