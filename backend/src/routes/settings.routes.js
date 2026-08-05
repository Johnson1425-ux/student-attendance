import { Router } from 'express';
import { z, validateBody } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as settingsService from '../services/settings.service.js';
import { auditFromRequest } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

/**
 * Every signed-in user reads settings (the frontend needs the timezone and the
 * school name to render dates correctly); only an admin may change them.
 */
router.get('/', async (_req, res, next) => {
  try {
    res.json(await settingsService.getSettings({ force: true }));
  } catch (err) {
    next(err);
  }
});

router.get('/detailed', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await settingsService.listSettings());
  } catch (err) {
    next(err);
  }
});

const settingsPatch = z
  .object({
    school_name: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1),
    school_start_time: z.string().trim(),
    late_after_time: z.string().trim(),
    school_end_time: z.string().trim(),
    attendance_cutoff_time: z.string().trim(),
    school_days_of_week: z.array(z.number().int().min(1).max(7)).min(1),
    consecutive_absence_threshold: z.number().int().min(1).max(60),
    duplicate_punch_window_minutes: z.number().int().min(0).max(240),
    minimum_checkout_gap_minutes: z.number().int().min(0).max(1440),
    auto_finalize_enabled: z.boolean(),
    report_footer_note: z.string().max(200),
  })
  .partial();

router.patch('/', requireAdmin, validateBody(settingsPatch), async (req, res, next) => {
  try {
    const before = await settingsService.getSettings({ force: true });
    const after = await settingsService.updateSettings(req.body, req.user.id);
    await auditFromRequest(req, {
      action: 'settings.update',
      entityType: 'settings',
      summary: `Updated settings: ${Object.keys(req.body).join(', ')}`,
      before: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k]])),
      after: Object.fromEntries(Object.keys(req.body).map((k) => [k, after[k]])),
    });
    res.json(after);
  } catch (err) {
    next(err);
  }
});

export default router;
