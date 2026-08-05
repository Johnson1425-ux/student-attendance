import { Router } from 'express';
import {
  z,
  validateBody,
  validateQuery,
  validateParams,
  idParam,
  dateString,
  trimmedString,
} from '../middleware/validate.js';
import { requireAuth, requireStaff, attachClassScope, assertStudentAccess, assertClassAccess } from '../middleware/auth.js';
import * as studentsService from '../services/students.service.js';
import * as reportsService from '../services/reports.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { todayInZone, addDays } from '../lib/dates.js';

const router = Router();
router.use(requireAuth, attachClassScope);

const studentBody = z.object({
  admissionNumber: trimmedString(50),
  deviceUserPin: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, 'must be digits only')
    .optional()
    .nullable(),
  firstName: trimmedString(80),
  middleName: trimmedString(80).optional().nullable(),
  lastName: trimmedString(80),
  dateOfBirth: dateString.optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  guardianName: trimmedString(120).optional().nullable(),
  guardianPhone: trimmedString(40).optional().nullable(),
  guardianEmail: z.string().trim().email().optional().nullable().or(z.literal('').transform(() => null)),
  address: trimmedString(300).optional().nullable(),
  status: z.enum(['active', 'inactive', 'graduated', 'transferred']).optional(),
  enrolledOn: dateString.optional(),
  notes: trimmedString(2000).optional().nullable(),
  classId: z.coerce.number().int().positive().optional().nullable(),
});

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  search: z.string().trim().optional(),
  classId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'inactive', 'graduated', 'transferred', 'all']).default('active'),
  hasBiometrics: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  sort: z.enum(['name', 'admission', 'newest', 'class']).default('name'),
});

router.get('/', validateQuery(listQuery), async (req, res, next) => {
  try {
    res.json(await studentsService.listStudents({ ...req.query, classScope: req.classScope }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', validateParams(idParam), async (req, res, next) => {
  try {
    await assertStudentAccess(req, req.params.id);
    res.json(await studentsService.getStudent(req.params.id));
  } catch (err) {
    next(err);
  }
});

/**
 * A student's own attendance history. Defaults to the last 30 days, which is
 * what a member of staff pulling up a record almost always wants to see first.
 */
router.get(
  '/:id/attendance',
  validateParams(idParam),
  validateQuery(z.object({ from: dateString.optional(), to: dateString.optional() })),
  async (req, res, next) => {
    try {
      await assertStudentAccess(req, req.params.id);
      const config = await getAttendanceConfig();
      const to = req.query.to ?? todayInZone(config.timezone);
      const from = req.query.from ?? addDays(to, -30);
      res.json(await reportsService.studentReport({ studentId: req.params.id, from, to }));
    } catch (err) {
      next(err);
    }
  },
);

router.post('/', requireStaff, validateBody(studentBody), async (req, res, next) => {
  try {
    const student = await studentsService.createStudent(req.body, {
      actor: req.user,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json(student);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  requireStaff,
  validateParams(idParam),
  validateBody(studentBody.partial().extend({ transferDate: dateString.optional() })),
  async (req, res, next) => {
    try {
      const student = await studentsService.updateStudent(req.params.id, req.body, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json(student);
    } catch (err) {
      next(err);
    }
  },
);

/** Archiving keeps the attendance history; see the service for why. */
router.post(
  '/:id/archive',
  requireStaff,
  validateParams(idParam),
  validateBody(
    z.object({
      status: z.enum(['inactive', 'graduated', 'transferred']).default('inactive'),
      exitedOn: dateString.optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(
        await studentsService.archiveStudent(req.params.id, {
          ...req.body,
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

router.delete('/:id', requireStaff, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(
      await studentsService.deleteStudent(req.params.id, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Bulk import, used by the dashboard's CSV upload. */
router.post(
  '/import',
  requireStaff,
  validateBody(
    z.object({
      students: z
        .array(
          studentBody.partial().extend({
            admissionNumber: trimmedString(50),
            firstName: trimmedString(80),
            lastName: trimmedString(80),
            className: z.string().trim().optional(),
          }),
        )
        .min(1, 'at least one row is required')
        .max(1000, 'import at most 1000 rows at a time'),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(
        await studentsService.importStudents(req.body.students, {
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

/** Class roster — the list a teacher checks against. */
router.get('/class/:id/roster', validateParams(idParam), async (req, res, next) => {
  try {
    assertClassAccess(req, req.params.id);
    res.json(await studentsService.listClassRoster(req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
