import { Router } from 'express';
import { z, validateBody, validateQuery, validateParams, idParam, dateString, trimmedString } from '../middleware/validate.js';
import { requireAuth, requireStaff, attachClassScope } from '../middleware/auth.js';
import * as alertsService from '../services/alerts.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { todayInZone } from '../lib/dates.js';
import { auditFromRequest } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, attachClassScope);

router.get(
  '/',
  validateQuery(
    z.object({
      status: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'),
      classId: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(200).default(50),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await alertsService.listAlerts({ ...req.query, classScope: req.classScope }));
    } catch (err) {
      next(err);
    }
  },
);

router.get('/count', async (req, res, next) => {
  try {
    res.json({ open: await alertsService.countOpenAlerts(req.classScope) });
  } catch (err) {
    next(err);
  }
});

/**
 * Acknowledge means "we have seen this and are following up"; resolve means
 * "handled". Both are recorded against the member of staff who did it so the
 * head teacher can see the follow-up actually happened.
 */
router.patch(
  '/:id',
  requireStaff,
  validateParams(idParam),
  validateBody(
    z.object({
      status: z.enum(['open', 'acknowledged', 'resolved']),
      notes: trimmedString(1000).optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      const alert = await alertsService.updateAlertStatus(req.params.id, {
        ...req.body,
        actorId: req.user.id,
      });
      await auditFromRequest(req, {
        action: `alert.${req.body.status}`,
        entityType: 'absentee_alert',
        entityId: alert.id,
        summary: `Alert for student ${alert.student_id} marked ${req.body.status}`,
        after: alert,
      });
      res.json(alert);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Recompute every student's streak. Needed after the threshold changes, or
 * after a bulk correction, so the alert list matches the corrected data
 * immediately instead of at the next nightly run.
 */
router.post(
  '/refresh',
  requireStaff,
  validateBody(z.object({ throughDate: dateString.optional() })),
  async (req, res, next) => {
    try {
      const config = await getAttendanceConfig();
      const throughDate = req.body.throughDate ?? todayInZone(config.timezone);
      const result = await alertsService.refreshAllAlerts(throughDate);
      await auditFromRequest(req, {
        action: 'alert.refresh',
        entityType: 'absentee_alert',
        summary: `Recalculated absentee alerts through ${throughDate}`,
        after: result,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
