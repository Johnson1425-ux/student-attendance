import { describe, it, expect } from '@jest/globals';
import { redactUrlSecrets, redactQuerySecrets } from '../../src/lib/redact.js';

describe('redactUrlSecrets', () => {
  it('hides the device secret and keeps the other parameters', () => {
    const out = redactUrlSecrets('/iclock/cdata?SN=ABC123&key=topsecret&table=ATTLOG');
    expect(out).not.toContain('topsecret');
    expect(out).toContain('SN=ABC123');
    expect(out).toContain('table=ATTLOG');
  });

  it('matches the parameter name case-insensitively', () => {
    expect(redactUrlSecrets('/iclock/ping?SN=1&Secret=abc')).not.toContain('abc');
  });

  it('leaves URLs without a secret untouched', () => {
    expect(redactUrlSecrets('/api/students?page=2')).toBe('/api/students?page=2');
    expect(redactUrlSecrets('/health')).toBe('/health');
  });
});

describe('redactQuerySecrets', () => {
  it('returns a copy with the secret hidden', () => {
    const query = { SN: 'ABC', key: 'topsecret' };
    expect(redactQuerySecrets(query)).toEqual({ SN: 'ABC', key: '[redacted]' });
    expect(query.key).toBe('topsecret');
  });
});
