#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Every .sql file in ./migrations is applied once, in filename order, inside a
 * transaction, and recorded in schema_migrations with a checksum. If a file
 * that has already been applied is edited afterwards the runner refuses to
 * continue — silent drift between environments is far more expensive than a
 * loud failure.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { logger } from '../config/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Checksums for one migration file.
 *
 * The canonical checksum is taken over LF-normalised text, because the same
 * committed file arrives with different bytes depending on the platform that
 * checked it out — Git on Windows hands out CRLF by default. Hashing the raw
 * bytes made a Linux-applied migration look "modified" when re-read on Windows,
 * which is a false alarm about the one thing this check exists to catch.
 *
 * `accepted` also carries the raw and CRLF hashes so databases stamped by the
 * older, byte-sensitive runner are recognised rather than rejected.
 */
function checksumsFor(sql) {
  const lf = sql.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const checksum = sha256(lf);
  return { checksum, accepted: new Set([checksum, sha256(sql), sha256(crlf)]) };
}

async function loadMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, ...checksumsFor(sql) };
    }),
  );
}

async function appliedMigrations() {
  const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

export async function runMigrations({ silent = false } = {}) {
  await ensureMigrationsTable();
  const files = await loadMigrationFiles();
  const applied = await appliedMigrations();
  const executed = [];

  for (const { filename, sql, checksum, accepted } of files) {
    const previous = applied.get(filename);
    if (previous) {
      if (!accepted.has(previous)) {
        throw new Error(
          `Migration ${filename} was modified after it was applied. ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      if (previous !== checksum) {
        // Same file, stamped by the byte-sensitive runner. Restamp it so the
        // healing only ever happens once.
        await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
          checksum,
          filename,
        ]);
        if (!silent) logger.info({ filename }, 'Normalised a stored migration checksum');
      }
      continue;
    }

    const startedAt = Date.now();
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
        [filename, checksum, Date.now() - startedAt],
      );
    });
    executed.push(filename);
    if (!silent) logger.info({ filename, ms: Date.now() - startedAt }, 'Applied migration');
  }

  if (!silent && executed.length === 0) logger.info('Database already up to date');
  return executed;
}

export async function migrationStatus() {
  await ensureMigrationsTable();
  const files = await loadMigrationFiles();
  const applied = await appliedMigrations();
  return files.map(({ filename }) => ({ filename, applied: applied.has(filename) }));
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const command = process.argv[2] ?? 'up';
  try {
    if (command === 'status') {
      const status = await migrationStatus();
      for (const { filename, applied } of status) {
        process.stdout.write(`${applied ? '  applied' : '  PENDING'}  ${filename}\n`);
      }
    } else if (command === 'up') {
      const executed = await runMigrations();
      process.stdout.write(
        executed.length ? `Applied ${executed.length} migration(s).\n` : 'Nothing to apply.\n',
      );
    } else {
      process.stderr.write(`Unknown command "${command}". Use "up" or "status".\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
