import { Router } from 'express';
import { z, validateQuery, dateString } from '../middleware/validate.js';
import { requireAuth, attachClassScope, ROLES } from '../middleware/auth.js';
import * as attendanceService from '../services/attendance.service.js';
import * as reportsService from '../services/reports.service.js';
import { countOpenAlerts, listAlerts } from '../services/alerts.service.js';
import { listDevices } from '../services/devices.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { isSchoolDay } from '../services/calendar.service.js';
import { todayInZone, addDays, formatDateLong } from '../lib/dates.js';

const router = Router();
router.use(requireAuth, attachClassScope);

/**
 * One request backs the whole landing screen (PRD §7.4).
 *
 * The queries run concurrently and every one of them is index-backed, which is
 * what keeps the page inside the two-second budget in PRD §8 rather than
 * issuing a dozen round-trips from the browser.
 */
router.get('/', validateQuery(z.object({ date: dateString.optional() })), async (req, res, next) => {
  try {
    const config = await getAttendanceConfig();
    const date = req.query.date ?? todayInZone(config.timezone);
    const scope = req.classScope;
    const canSeeDevices = req.user.role === ROLES.ADMIN || req.user.role === ROLES.OFFICE_STAFF;

    const [summary, classes, recentEvents, openAlerts, topAlerts, trend, schoolDay, devices] = await Promise.all([
      attendanceService.getDailySummary({ date, classScope: scope }),
      attendanceService.getClassBreakdown({ date, classScope: scope }),
      attendanceService.getRecentEvents({ limit: 12, date, classScope: scope }),
      countOpenAlerts(scope),
      listAlerts({ status: 'open', classScope: scope, pageSize: 5 }),
      reportsService.attendanceTrend({ from: addDays(date, -13), to: date, classScope: scope }),
      isSchoolDay(date, config),
      canSeeDevices ? listDevices() : Promise.resolve([]),
    ]);

    res.json({
      date,
      dateLabel: formatDateLong(date),
      isSchoolDay: schoolDay,
      schoolName: config.schoolName,
      timezone: config.timezone,
      summary,
      classes,
      recentEvents,
      alerts: { open: openAlerts, latest: topAlerts.data },
      trend: trend.rows,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        location: d.location,
        health: d.health,
        minutes_since_seen: d.minutes_since_seen,
        last_seen_at: d.last_seen_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
