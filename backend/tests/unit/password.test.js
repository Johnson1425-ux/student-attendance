import { describe, it, expect } from '@jest/globals';
import {
  generateTemporaryPassword,
  validatePasswordStrength,
  generateToken,
  hashPassword,
  verifyPassword,
  safeEqual,
} from '../../src/lib/password.js';

describe('validatePasswordStrength', () => {
  it('accepts a reasonable password', () => {
    expect(validatePasswordStrength('SchoolPass99')).toEqual([]);
  });

  it('reports every problem at once, so the user is not corrected twice', () => {
    expect(validatePasswordStrength('abc')).toEqual([
      'must be at least 8 characters long',
      'must contain a number',
    ]);
  });

  it('rejects a password with no letter and one with no digit', () => {
    expect(validatePasswordStrength('12345678')).toContain('must contain a letter');
    expect(validatePasswordStrength('abcdefgh')).toContain('must contain a number');
  });

  it('does not throw on a missing value', () => {
    expect(validatePasswordStrength(undefined).length).toBeGreaterThan(0);
    expect(validatePasswordStrength(null).length).toBeGreaterThan(0);
  });
});

describe('generateTemporaryPassword', () => {
  // The generator previously produced a raw base64url token, which had no
  // guaranteed digit — so roughly one in eight was rejected by the policy
  // above, surfacing to an admin as "Password must contain a number" about a
  // password they never typed. It must now satisfy the policy by construction.
  it('always satisfies our own password policy', () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateTemporaryPassword();
      expect(validatePasswordStrength(password)).toEqual([]);
    }
  });

  it('avoids characters that are misread when typed from a screen', () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateTemporaryPassword();
      // Each excluded character is half of a look-alike pair: 0/O and 1/l/I.
      // Lowercase i and o stay in — with 1 and 0 gone there is nothing left to
      // confuse them with.
      expect(password).not.toMatch(/[0O1lI]/);
      // Alphanumeric only: punctuation is garbled when read out over a phone.
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('is 12 characters by default and honours a requested length', () => {
    expect(generateTemporaryPassword()).toHaveLength(12);
    expect(generateTemporaryPassword(16)).toHaveLength(16);
  });

  it('does not put the guaranteed digits in fixed positions', () => {
    // If the shuffle were missing, digits would always be at index 0 and 1.
    const firstCharIsDigit = Array.from({ length: 200 }, () =>
      /[0-9]/.test(generateTemporaryPassword()[0]),
    );
    expect(firstCharIsDigit.some(Boolean)).toBe(true);
    expect(firstCharIsDigit.every(Boolean)).toBe(false);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(500);
  });
});

describe('hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('SchoolPass99');
    expect(hash).not.toContain('SchoolPass99');
    expect(await verifyPassword('SchoolPass99', hash)).toBe(true);
    expect(await verifyPassword('SchoolPass98', hash)).toBe(false);
  });

  it('produces a different hash each time, so equal passwords are not detectable', async () => {
    expect(await hashPassword('SchoolPass99')).not.toBe(await hashPassword('SchoolPass99'));
  });

  it('treats a missing hash as a failed comparison rather than throwing', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal secrets', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    expect(safeEqual('short', 'much-longer-value')).toBe(false);
    expect(safeEqual(undefined, 'x')).toBe(false);
  });
});

describe('generateToken', () => {
  it('is URL-safe, so it can be put in a device push URL', () => {
    expect(generateToken(18)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
