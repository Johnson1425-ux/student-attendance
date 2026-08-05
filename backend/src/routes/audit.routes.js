import { Router } from 'express';
import { z, validateQuery, dateString } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as auditService from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  validateQuery(
    z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(200).default(50),
      action: z.string().trim().optional(),
      entityType: z.string().trim().optional(),
      entityId: z.string().trim().optional(),
      actorId: z.coerce.number().int().positive().optional(),
      from: dateString.optional(),
      to: dateString.optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await auditService.listAuditLogs(req.query));
    } catch (err) {
      next(err);
    }
  },
);

router.get('/actions', async (_req, res, next) => {
  try {
    res.json(await auditService.listAuditActions());
  } catch (err) {
    next(err);
  }
});

export default router;
