import { describe, it, expect } from '@jest/globals';
import { toCsv, escapeCsvValue, csvFilename } from '../../src/lib/csv.js';

describe('escapeCsvValue', () => {
  it('quotes values containing separators or newlines', () => {
    expect(escapeCsvValue('Mushi, Asha')).toBe('"Mushi, Asha"');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvValue('He said "hello"')).toBe('"He said ""hello"""');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A value beginning with = would be evaluated by Excel on open; prefixing
    // it with an apostrophe makes the cell inert.
    expect(escapeCsvValue('=1+1')).toBe("'=1+1");
    expect(escapeCsvValue('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(escapeCsvValue('-2')).toBe("'-2");
    expect(escapeCsvValue('@import')).toBe("'@import");
  });

  it('renders empty values as blank cells', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
    expect(escapeCsvValue(0)).toBe('0');
  });
});

describe('toCsv', () => {
  const columns = [
    { key: 'name', label: 'Student' },
    { key: 'status', label: 'Status' },
    { key: 'rate', label: 'Rate %', map: (r) => `${r.rate}%` },
  ];

  it('writes a header row and mapped values', () => {
    const csv = toCsv(columns, [{ name: 'Asha', status: 'present', rate: 96.4 }], { withBom: false });
    expect(csv).toBe('Student,Status,Rate %\r\nAsha,present,96.4%\r\n');
  });

  it('prefixes a BOM so Excel reads UTF-8 correctly', () => {
    const csv = toCsv(columns, []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('includes title lines above the header when given', () => {
    const csv = toCsv(columns, [], { withBom: false, title: ['My School', 'Daily Register'] });
    expect(csv.split('\r\n').slice(0, 4)).toEqual(['My School', 'Daily Register', '', 'Student,Status,Rate %']);
  });

  it('emits a header-only file for an empty result set', () => {
    expect(toCsv(columns, [], { withBom: false })).toBe('Student,Status,Rate %\r\n');
  });
});

describe('csvFilename', () => {
  it('builds a safe slug', () => {
    expect(csvFilename(['Daily Attendance', '2026-08-05'])).toBe('daily-attendance-2026-08-05.csv');
    expect(csvFilename(['Form 1A / Term 2'])).toBe('form-1a-term-2.csv');
    expect(csvFilename([null, undefined, ''])).toBe('report.csv');
  });
});
