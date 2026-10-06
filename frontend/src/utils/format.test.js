import { describe, it, expect } from 'vitest';
import { addDays, startOfWeek, startOfMonth, formatPercent, formatRelative, initials, rateTone } from './format.js';

describe('date arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('starts the week on Monday', () => {
    expect(startOfWeek('2026-10-06')).toBe('2026-10-05'); // Tuesday
    expect(startOfWeek('2026-10-05')).toBe('2026-10-05'); // Monday
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday
  });

  it('finds the first of the month', () => {
    expect(startOfMonth('2026-10-06')).toBe('2026-10-01');
  });
});

describe('formatting', () => {
  it('formats percentages without a trailing .0', () => {
    expect(formatPercent(95)).toBe('95%');
    expect(formatPercent(87.25)).toBe('87.3%');
    expect(formatPercent(null)).toBe('—');
  });

  it('describes how long ago a terminal was seen', () => {
    expect(formatRelative(null)).toBe('never');
    expect(formatRelative(0)).toBe('just now');
    expect(formatRelative(5)).toBe('5 min ago');
    expect(formatRelative(60)).toBe('1 hr ago');
    expect(formatRelative(3 * 24 * 60)).toBe('3 days ago');
  });

  it('takes initials from the first two names', () => {
    expect(initials('amina  juma hassan')).toBe('AJ');
    expect(initials('')).toBe('?');
  });

  it('bands attendance rates', () => {
    expect(rateTone(90)).toBe('good');
    expect(rateTone(75)).toBe('warn');
    expect(rateTone(74.9)).toBe('poor');
  });
});
