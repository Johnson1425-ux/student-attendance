import { Router } from 'express';
import { z, validateBody, validateQuery, validateParams, idParam, dateString, trimmedString } from '../middleware/validate.js';
import { requireAuth, requireAdmin, attachClassScope, assertClassAccess } from '../middleware/auth.js';
import * as classesService from '../services/classes.service.js';

const router = Router();
router.use(requireAuth, attachClassScope);

const classBody = z.object({
  name: trimmedString(80),
  gradeLevel: trimmedString(40).optional().nullable(),
  stream: trimmedString(40).optional().nullable(),
  academicYear: trimmedString(20),
  room: trimmedString(40).optional().nullable(),
  isActive: z.boolean().optional(),
  teacherIds: z.array(z.coerce.number().int().positive()).optional(),
});

router.get(
  '/',
  validateQuery(
    z.object({
      includeInactive: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      academicYear: z.string().trim().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await classesService.listClasses({ ...req.query, classScope: req.classScope }));
    } catch (err) {
      next(err);
    }
  },
);

// --- Academic terms --------------------------------------------------------

router.get('/terms/all', async (_req, res, next) => {
  try {
    res.json(await classesService.listAcademicTerms());
  } catch (err) {
    next(err);
  }
});

router.get('/terms/current', async (_req, res, next) => {
  try {
    res.json(await classesService.getCurrentTerm());
  } catch (err) {
    next(err);
  }
});

router.post(
  '/terms',
  requireAdmin,
  validateBody(
    z
      .object({
        name: trimmedString(60),
        academicYear: trimmedString(20),
        startDate: dateString,
        endDate: dateString,
        isCurrent: z.boolean().optional(),
      })
      .refine((v) => v.endDate >= v.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] }),
  ),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await classesService.upsertAcademicTerm(req.body, {
          actor: req.user,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.delete('/terms/:id', requireAdmin, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(await classesService.deleteAcademicTerm(req.params.id));
  } catch (err) {
    next(err);
  }
});

// --- Classes by id ---------------------------------------------------------

router.get('/:id', validateParams(idParam), async (req, res, next) => {
  try {
    assertClassAccess(req, req.params.id);
    res.json(await classesService.getClass(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, validateBody(classBody), async (req, res, next) => {
  try {
    res.status(201).json(
      await classesService.createClass(req.body, { actor: req.user, ip: req.ip, userAgent: req.get('user-agent') }),
    );
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireAdmin, validateParams(idParam), validateBody(classBody.partial()), async (req, res, next) => {
  try {
    res.json(
      await classesService.updateClass(req.params.id, req.body, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(
      await classesService.deleteClass(req.params.id, { actor: req.user, ip: req.ip, userAgent: req.get('user-agent') }),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
