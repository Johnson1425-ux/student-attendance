import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../src/db/migrate.js';
import { pool, query } from '../../src/db/pool.js';
import { ensureSchema } from '../helpers/db.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations',
);
const FIRST = '001_init.sql';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function storedChecksum(filename) {
  const { rows } = await query('SELECT checksum FROM schema_migrations WHERE filename = $1', [
    filename,
  ]);
  return rows[0]?.checksum ?? null;
}

describe('migration checksums', () => {
  let canonical;
  let crlfChecksum;

  beforeAll(async () => {
    await ensureSchema();
    const sql = await readFile(join(MIGRATIONS_DIR, FIRST), 'utf8');
    const lf = sql.replace(/\r\n/g, '\n');
    canonical = sha256(lf);
    crlfChecksum = sha256(lf.replace(/\n/g, '\r\n'));
  });

  afterAll(async () => {
    await query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
      canonical,
      FIRST,
    ]);
    await pool.end();
  });

  it('records the LF-normalised checksum, whatever the checkout produced', async () => {
    expect(await storedChecksum(FIRST)).toBe(canonical);
    expect(crlfChecksum).not.toBe(canonical);
  });

  // The failure this guards against: the service applies migrations on Linux
  // (LF), then someone seeds from a Windows checkout (CRLF) and the runner
  // refuses to start because the file "was modified".
  it('accepts a database stamped from a CRLF checkout, and restamps it', async () => {
    await query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
      crlfChecksum,
      FIRST,
    ]);

    await expect(runMigrations({ silent: true })).resolves.toEqual([]);
    expect(await storedChecksum(FIRST)).toBe(canonical);
  });

  it('still refuses a migration whose contents genuinely changed', async () => {
    await query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
      sha256('-- something else entirely'),
      FIRST,
    ]);

    await expect(runMigrations({ silent: true })).rejects.toThrow(
      /001_init\.sql was modified after it was applied/,
    );
  });
});
