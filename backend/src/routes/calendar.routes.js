import { Router } from 'express';
import { z, validateBody, validateQuery, validateParams, dateString, trimmedString } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as calendarService from '../services/calendar.service.js';
import { auditFromRequest } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validateQuery(z.object({ from: dateString.optional(), to: dateString.optional() })),
  async (req, res, next) => {
    try {
      res.json(await calendarService.listCalendarEntries(req.query));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Resolved view: for each date in the range, whether it counts as a school day
 * and why (explicit calendar entry vs the weekly pattern).
 */
router.get('/resolved', validateQuery(z.object({ from: dateString, to: dateString })), async (req, res, next) => {
  try {
    res.json(await calendarService.describeRange(req.query.from, req.query.to));
  } catch (err) {
    next(err);
  }
});

router.get('/school-days', validateQuery(z.object({ from: dateString, to: dateString })), async (req, res, next) => {
  try {
    const days = await calendarService.listSchoolDays(req.query.from, req.query.to);
    res.json({ from: req.query.from, to: req.query.to, count: days.length, days });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireAdmin,
  validateBody(
    z.object({
      date: dateString,
      endDate: dateString.optional(),
      dayType: z.enum(['school_day', 'weekend', 'holiday', 'break']),
      label: trimmedString(120).optional().nullable(),
    }),
  ),
  async (req, res, next) => {
    try {
      const entries = await calendarService.upsertCalendarEntry(req.body, req.user.id);
      await auditFromRequest(req, {
        action: 'calendar.upsert',
        entityType: 'school_calendar',
        entityId: req.body.date,
        summary: `Marked ${entries.length} day(s) as ${req.body.dayType}${req.body.label ? ` (${req.body.label})` : ''}`,
        after: { count: entries.length, ...req.body },
      });
      res.status(201).json(entries);
    } catch (err) {
      next(err);
    }
  },
);

router.delete('/:date', requireAdmin, validateParams(z.object({ date: dateString })), async (req, res, next) => {
  try {
    await calendarService.deleteCalendarEntry(req.params.date);
    await auditFromRequest(req, {
      action: 'calendar.delete',
      entityType: 'school_calendar',
      entityId: req.params.date,
      summary: `Removed calendar entry for ${req.params.date}`,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
