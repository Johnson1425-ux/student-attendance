import bcrypt from 'bcryptjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
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
