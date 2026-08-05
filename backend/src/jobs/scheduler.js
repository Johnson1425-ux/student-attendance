import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { finalizeDay, finalizeRange } from '../services/attendance.service.js';
import { refreshAllAlerts } from '../services/alerts.service.js';
import { expireStaleCommands } from '../services/devices.service.js';
import { pruneExpiredRefreshTokens } from '../services/auth.service.js';
import { todayInZone, addDays } from '../lib/dates.js';

/**
 * Scheduled maintenance.
 *
 * The important one is nightly finalisation: until a day is closed, "absent"
 * and "has not arrived yet" are the same thing in the database. Closing the day
 * turns the second into the first, which is what makes absence reports and
 * consecutive-absence alerts meaningful.
 */

const tasks = [];

export function startScheduler() {
  if (!env.ENABLE_SCHEDULER) {
    logger.info('Scheduler disabled (ENABLE_SCHEDULER=false)');
    return { stop: () => {} };
  }

  const finalizeTask = cron.schedule(env.FINALIZE_CRON, runNightlyFinalization, { timezone: 'UTC' });
  tasks.push(finalizeTask);

  // Hourly housekeeping: abandon commands no terminal ever collected and drop
  // long-dead refresh tokens.
  const housekeepingTask = cron.schedule('17 * * * *', async () => {
    try {
      const expired = await expireStaleCommands(24);
      const pruned = await pruneExpiredRefreshTokens();
      if (expired || pruned) logger.info({ expired, pruned }, 'Housekeeping complete');
    } catch (err) {
      logger.error({ err }, 'Housekeeping job failed');
    }
  });
  tasks.push(housekeepingTask);

  logger.info({ finalizeCron: env.FINALIZE_CRON }, 'Scheduler started');
  return { stop: stopScheduler };
}

export function stopScheduler() {
  for (const task of tasks.splice(0)) task.stop();
}

/**
 * Close yesterday (and today, if the configured cut-off has passed), then
 * recompute absentee alerts.
 *
 * Finalising a short trailing window rather than only the current day makes the
 * job self-healing: if the server was asleep for two nights, the next run still
 * closes the days it missed.
 */
export async function runNightlyFinalization() {
  try {
    const config = await getAttendanceConfig();
    if (!config.autoFinalizeEnabled) {
      logger.info('Automatic finalisation is switched off in settings; skipping');
      return;
    }

    const today = todayInZone(config.timezone);
    const from = addDays(today, -3);

    const results = await finalizeRange(from, today, { force: false });
    const totalAbsences = results.reduce((sum, r) => sum + (r.markedAbsent ?? 0), 0);

    const alerts = await refreshAllAlerts(today);

    logger.info(
      { from, to: today, days: results.length, totalAbsences, ...alerts },
      'Nightly attendance finalisation complete',
    );
  } catch (err) {
    logger.error({ err }, 'Nightly finalisation failed');
  }
}

/** Exposed for the CLI / tests: finalise one specific day. */
export async function finalizeSingleDay(date) {
  const result = await finalizeDay(date, { force: false });
  logger.info(result, 'Finalised day');
  return result;
}
