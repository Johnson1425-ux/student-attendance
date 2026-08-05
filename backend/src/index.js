import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool, closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

/**
 * Server bootstrap.
 *
 * Migrations run at start-up so a deploy to Render brings the schema forward
 * without a separate release step — the alternative, on a single-instance
 * hobby-tier deployment, is a schema that silently lags the code.
 */
async function main() {
  await pool.query('SELECT 1');
  logger.info('Database connection established');

  const applied = await runMigrations();
  if (applied.length) logger.info({ applied }, 'Database schema updated');

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Attendance API listening');
  });

  startScheduler();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Do not let a hung connection block a redeploy indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception, exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
