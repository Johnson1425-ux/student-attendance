/**
 * RFC 4180 CSV serialisation.
 *
 * Two details matter for this system:
 *  - Excel on a Windows machine at the school opens UTF-8 correctly only with a
 *    byte-order mark, so exports are prefixed with one.
 *  - Admission numbers and PINs look like formulas to a spreadsheet if they
 *    begin with =, +, - or @. Those values are prefixed with a single quote to
 *    neutralise CSV injection.
 */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_PREFIX.test(str)) str = `'${str}`;
  if (NEEDS_QUOTING.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * @param {Array<{key: string, label: string, map?: (row: any) => any}>} columns
 * @param {Array<object>} rows
 * @param {{ withBom?: boolean, title?: string[] }} options
 */
export function toCsv(columns, rows, { withBom = true, title = [] } = {}) {
  const lines = [];
  for (const line of title) lines.push(escapeCsvValue(line));
  if (title.length) lines.push('');

  lines.push(columns.map((c) => escapeCsvValue(c.label)).join(','));
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => escapeCsvValue(c.map ? c.map(row) : row[c.key]))
        .join(','),
    );
  }
  return `${withBom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}

/** Build a safe, descriptive download filename. */
export function csvFilename(parts) {
  const slug = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'report'}.csv`;
}
