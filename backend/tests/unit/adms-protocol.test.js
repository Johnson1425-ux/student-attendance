import { describe, it, expect } from '@jest/globals';
import {
  isBiometricVerification,
  describeVerifyMode,
  parseAttlog,
  parseOperlog,
  parseDeviceOptions,
  parseCommandAck,
  buildHandshakeResponse,
  buildCommandResponse,
  okResponse,
} from '../../src/lib/adms/protocol.js';

/**
 * These payloads are written in the exact shape a ZKTeco terminal sends,
 * including the CRLF line endings and trailing reserved columns, so the parser
 * is exercised against the wire format rather than a tidied-up version of it.
 */

describe('parseAttlog', () => {
  it('parses a standard punch batch', () => {
    const body =
      '1001\t2026-08-05 07:12:44\t0\t1\t0\t0\t0\r\n' +
      '1002\t2026-08-05 07:51:02\t1\t15\t0\t0\t0\r\n';

    const { records, errors } = parseAttlog(body);

    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      pin: '1001',
      timestamp: '2026-08-05 07:12:44',
      punchState: 0,
      verifyMode: 1,
    });
    expect(records[1]).toMatchObject({ pin: '1002', punchState: 1, verifyMode: 15 });
  });

  it('keeps good rows when one line is malformed', () => {
    const body = '1001\t2026-08-05 07:12:44\t0\t1\nGARBAGE\n1002\t2026-08-05 07:20:00\t0\t1\n';

    const { records, errors } = parseAttlog(body);

    expect(records.map((r) => r.pin)).toEqual(['1001', '1002']);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/missing PIN or timestamp/);
  });

  it('rejects a non-numeric PIN rather than inventing a student', () => {
    const { records, errors } = parseAttlog('ABC\t2026-08-05 07:12:44\t0\t1\n');

    expect(records).toHaveLength(0);
    expect(errors[0].reason).toMatch(/non-numeric PIN/);
  });

  it('treats an empty body as an empty batch', () => {
    expect(parseAttlog('').records).toHaveLength(0);
    expect(parseAttlog(undefined).records).toHaveLength(0);
  });

  it('tolerates missing optional trailing fields', () => {
    const { records } = parseAttlog('1001\t2026-08-05 07:12:44\n');
    expect(records[0]).toMatchObject({ pin: '1001', punchState: null, verifyMode: null, workCode: null });
  });
});

describe('parseOperlog', () => {
  it('extracts user records', () => {
    const body =
      'USER PIN=9001\tName=Asha Mushi\tPri=0\tPasswd=\tCard=12345\tGrp=1\tTZ=0000000000000000\r\n';

    const { users } = parseOperlog(body);

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ pin: '9001', name: 'Asha Mushi', privilege: 0, cardNumber: '12345' });
  });

  it('records fingerprint metadata but never the template itself', () => {
    const body = 'FP PIN=9001\tFID=6\tSize=1130\tValid=1\tTMP=QUJDREVGR0hJSktMTU5PUFFSU1Q=\r\n';

    const { fingerprints } = parseOperlog(body);

    expect(fingerprints[0]).toMatchObject({ pin: '9001', fingerIndex: 6, templateSize: 1130, valid: 1 });
    // The security requirement in PRD §8: no template data is carried forward.
    expect(JSON.stringify(fingerprints)).not.toMatch(/QUJDREVG/);
    expect(fingerprints[0]).not.toHaveProperty('tmp');
    expect(fingerprints[0]).not.toHaveProperty('template');
  });

  it('flags a duress finger', () => {
    const { fingerprints } = parseOperlog('FP PIN=9001\tFID=0\tSize=900\tValid=3\tTMP=xx\n');
    expect(fingerprints[0].isDuress).toBe(true);
  });

  it('separates operation log lines from user lines', () => {
    const body = 'OPLOG 4\t1\t2026-08-05 07:00:00\t9001\r\nUSER PIN=9002\tName=Juma\tPri=0\r\n';

    const { operations, users } = parseOperlog(body);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ operationCode: 4, operatorPin: '1' });
    expect(users).toHaveLength(1);
  });

  it('notes unrecognised tables without failing', () => {
    const { unknown, users } = parseOperlog('USERPIC PIN=9001\tSize=4096\tContent=abc\n');
    expect(users).toHaveLength(0);
    expect(unknown).toContain('USERPIC PIN=9001');
  });
});

describe('parseDeviceOptions', () => {
  it('reads the device info block', () => {
    const body = '~DeviceName=IN01-A\r\nFWVersion=Ver 6.60\r\nUserCount=320\tFPCount=640\r\n';

    const options = parseDeviceOptions(body);

    expect(options.devicename).toBe('IN01-A');
    expect(options.fwversion).toBe('Ver 6.60');
    expect(options.usercount).toBe('320');
    expect(options.fpcount).toBe('640');
  });
});

describe('parseCommandAck', () => {
  it('reads success and failure codes', () => {
    const acks = parseCommandAck('ID=12&Return=0&CMD=DATA\r\nID=13&Return=-1&CMD=INFO\r\n');

    expect(acks).toEqual([
      { commandId: 12, returnCode: 0, command: 'DATA', raw: 'ID=12&Return=0&CMD=DATA' },
      { commandId: 13, returnCode: -1, command: 'INFO', raw: 'ID=13&Return=-1&CMD=INFO' },
    ]);
  });

  it('ignores lines without an ID', () => {
    expect(parseCommandAck('Return=0&CMD=DATA\n')).toHaveLength(0);
  });
});

describe('response builders', () => {
  it('produces a handshake the terminal can parse', () => {
    const response = buildHandshakeResponse({ serialNumber: 'ABC123', attlogStamp: '55', timezoneOffsetHours: 3 });

    expect(response.startsWith('GET OPTION FROM: ABC123')).toBe(true);
    expect(response).toMatch(/\r\nStamp=55\r\n/);
    expect(response).toMatch(/\r\nTimeZone=3\r\n/);
    expect(response.endsWith('\r\n')).toBe(true);
  });

  it('serialises the command queue, and answers OK when it is empty', () => {
    expect(buildCommandResponse([])).toBe('OK\r\n');
    expect(buildCommandResponse([{ id: 7, command: 'INFO' }])).toBe('C:7:INFO\r\n');
    expect(buildCommandResponse([{ id: 1, command: 'A' }, { id: 2, command: 'B' }])).toBe('C:1:A\r\nC:2:B\r\n');
  });

  it('acknowledges a batch with its count', () => {
    expect(okResponse(12)).toBe('OK: 12\r\n');
    expect(okResponse()).toBe('OK\r\n');
  });
});

describe('isBiometricVerification', () => {
  // The distinction PRD §2 rests on: a terminal that accepts a typed PIN or a
  // card lets one student mark another present, which is the proxy attendance
  // the biometric system exists to stop.
  it('treats fingerprint, face and palm as biometric', () => {
    expect(isBiometricVerification(1)).toBe(true);   // fingerprint
    expect(isBiometricVerification(15)).toBe(true);  // face
    expect(isBiometricVerification(25)).toBe(true);  // palm
  });

  it('treats password and card as not biometric', () => {
    expect(isBiometricVerification(0)).toBe(false);  // password
    expect(isBiometricVerification(3)).toBe(false);  // password
    expect(isBiometricVerification(2)).toBe(false);  // card
    expect(isBiometricVerification(4)).toBe(false);  // card
  });

  it('answers null when there is no information, rather than guessing', () => {
    // Distinguishing "we know it was not biometric" from "we do not know"
    // matters: only the former is worth flagging to staff.
    expect(isBiometricVerification(null)).toBeNull();
    expect(isBiometricVerification(undefined)).toBeNull();
    expect(isBiometricVerification(99)).toBeNull();
  });

  it('names each mode for display', () => {
    expect(describeVerifyMode(1)).toBe('fingerprint');
    expect(describeVerifyMode(2)).toBe('card');
    expect(describeVerifyMode(0)).toBe('password');
    expect(describeVerifyMode(99)).toBe('unknown');
  });
});
