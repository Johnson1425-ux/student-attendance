import { describe, it, expect } from '@jest/globals';
import {
  toLocalDate,
  toLocalTime,
  parseDeviceTimestamp,
  localToInstant,
  minutesSinceMidnight,
  padTime,
  eachDateInclusive,
  isoWeekday,
  addDays,
  startOfIsoWeek,
  endOfIsoWeek,
  startOfMonth,
  endOfMonth,
  isValidDateString,
  isValidTimezone,
} from '../../src/lib/dates.js';

const TZ = 'Africa/Dar_es_Salaam'; // UTC+3, no daylight saving

describe('school-day resolution across the UTC boundary', () => {
  it('assigns an early-morning arrival to the correct local day', () => {
    // 04:12 UTC is 07:12 at the school — the same day, not the previous one.
    const instant = new Date('2026-08-05T04:12:44Z');
    expect(toLocalDate(instant, TZ)).toBe('2026-08-05');
    expect(toLocalTime(instant, TZ)).toBe('07:12:44');
  });

  it('keeps a late-evening instant on the local day it belongs to', () => {
    // 22:30 UTC is already 01:30 the next morning at the school.
    const instant = new Date('2026-08-05T22:30:00Z');
    expect(toLocalDate(instant, TZ)).toBe('2026-08-06');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-08-05');
  });

  it('round-trips a local wall-clock time through an instant', () => {
    const instant = localToInstant('2026-08-05', '07:30', TZ);
    expect(instant.toISOString()).toBe('2026-08-05T04:30:00.000Z');
    expect(toLocalTime(instant, TZ)).toBe('07:30:00');
  });

  it('handles a timezone with daylight saving correctly', () => {
    // London is UTC+1 in August.
    const summer = localToInstant('2026-08-05', '09:00', 'Europe/London');
    expect(summer.toISOString()).toBe('2026-08-05T08:00:00.000Z');
    // …and UTC+0 in January.
    const winter = localToInstant('2026-01-05', '09:00', 'Europe/London');
    expect(winter.toISOString()).toBe('2026-01-05T09:00:00.000Z');
  });
});

describe('parseDeviceTimestamp', () => {
  it('reads the terminal format and anchors it to the school timezone', () => {
    const instant = parseDeviceTimestamp('2026-08-05 07:12:44', TZ);
    expect(instant.toISOString()).toBe('2026-08-05T04:12:44.000Z');
  });

  it('accepts the ISO-ish variants terminals sometimes emit', () => {
    expect(parseDeviceTimestamp('2026-08-05T07:12:44', TZ).toISOString()).toBe('2026-08-05T04:12:44.000Z');
    expect(parseDeviceTimestamp('2026-08-05 07:12:44.000', TZ).toISOString()).toBe('2026-08-05T04:12:44.000Z');
  });

  it('returns null for junk rather than a wrong date', () => {
    expect(parseDeviceTimestamp('not-a-time', TZ)).toBeNull();
    expect(parseDeviceTimestamp('', TZ)).toBeNull();
    expect(parseDeviceTimestamp('2026-13-45 99:99:99', TZ)).toBeNull();
  });
});

describe('time helpers', () => {
  it('normalises time strings', () => {
    expect(padTime('7:5')).toBe('07:05:00');
    expect(padTime('07:45')).toBe('07:45:00');
    expect(padTime('23:59:59')).toBe('23:59:59');
  });

  it('rejects nonsense', () => {
    expect(() => padTime('midday')).toThrow();
    expect(() => padTime('7')).toThrow();
  });

  it('converts to minutes since midnight', () => {
    expect(minutesSinceMidnight('00:00')).toBe(0);
    expect(minutesSinceMidnight('07:45')).toBe(465);
    expect(minutesSinceMidnight('23:59')).toBe(1439);
  });
});

describe('range helpers', () => {
  it('lists dates inclusively', () => {
    expect(eachDateInclusive('2026-08-03', '2026-08-06')).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
  });

  it('returns nothing for a reversed range', () => {
    expect(eachDateInclusive('2026-08-06', '2026-08-03')).toEqual([]);
  });

  it('crosses month and year boundaries', () => {
    expect(eachDateInclusive('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('handles a leap day', () => {
    expect(eachDateInclusive('2028-02-27', '2028-03-01')).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('reports ISO weekdays with Monday as 1', () => {
    expect(isoWeekday('2026-08-03')).toBe(1); // Monday
    expect(isoWeekday('2026-08-08')).toBe(6); // Saturday
    expect(isoWeekday('2026-08-09')).toBe(7); // Sunday
  });

  it('computes week and month boundaries', () => {
    expect(startOfIsoWeek('2026-08-05')).toBe('2026-08-03');
    expect(endOfIsoWeek('2026-08-05')).toBe('2026-08-09');
    expect(startOfMonth('2026-08-05')).toBe('2026-08-01');
    expect(endOfMonth('2026-08-05')).toBe('2026-08-31');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
  });

  it('adds and subtracts days across boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('validators', () => {
  it('validates date strings strictly', () => {
    expect(isValidDateString('2026-08-05')).toBe(true);
    expect(isValidDateString('2026-8-5')).toBe(false);
    expect(isValidDateString('05/08/2026')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
  });

  it('validates IANA timezones', () => {
    expect(isValidTimezone('Africa/Dar_es_Salaam')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
