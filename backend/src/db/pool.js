import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool, types } = pg;

// Postgres DATE (OID 1082) arrives as a JS Date in the server's timezone by
// default, which silently shifts attendance days across the UTC boundary.
// Keep DATE columns as plain 'YYYY-MM-DD' strings — the application decides
// what a calendar day means, using the school timezone.
types.setTypeParser(1082, (value) => value);
// BIGINT (OID 20) → Number. Row counts here are school-sized, far below 2^53.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
// NUMERIC (OID 1700) → Number, so computed rates serialise as JSON numbers.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

/**
 * Run a single query on a pooled connection.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction, rolling back on any thrown error.
 * The callback receives a dedicated client; every statement it issues must use
 * that client to stay inside the transaction.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
