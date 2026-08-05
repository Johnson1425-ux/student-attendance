import { Router } from 'express';
import {
  z,
  validateBody,
  validateQuery,
  validateParams,
  idParam,
  dateString,
  timeString,
  trimmedString,
} from '../middleware/validate.js';
import {
  requireAuth,
  requireStaff,
  requireAdmin,
  attachClassScope,
  assertClassAccess,
  assertStudentAccess,
} from '../middleware/auth.js';
import * as attendanceService from '../services/attendance.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { todayInZone } from '../lib/dates.js';
import { auditFromRequest } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, attachClassScope);

/** Resolve the requested date, defaulting to today in the school's timezone. */
async function resolveDate(req) {
  if (req.query.date) return req.query.date;
  const config = await getAttendanceConfig();
  return todayInZone(config.timezone);
}

const registerQuery = z.object({
  date: dateString.optional(),
  classId: z.coerce.number().int().positive().optional(),
  status: z.enum(['present', 'late', 'absent', 'excused', 'not_marked']).optional(),
  search: z.string().trim().optional(),
});

/** The daily register — the working view for marking and correcting. */
router.get('/register', validateQuery(registerQuery), async (req, res, next) => {
  try {
    if (req.query.classId) assertClassAccess(req, req.query.classId);
    const date = await resolveDate(req);
    const [rows, summary] = await Promise.all([
      attendanceService.getDailyRegister({
        date,
        classId: req.query.classId ?? null,
        classScope: req.classScope,
        status: req.query.status ?? null,
        search: req.query.search ?? null,
      }),
      attendanceService.getDailySummary({
        date,
        classId: req.query.classId ?? null,
        classScope: req.classScope,
      }),
    ]);
    res.json({ date, summary, rows });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/summary',
  validateQuery(z.object({ date: dateString.optional(), classId: z.coerce.number().int().positive().optional() })),
  async (req, res, next) => {
    try {
      if (req.query.classId) assertClassAccess(req, req.query.classId);
      const date = await resolveDate(req);
      res.json(
        await attendanceService.getDailySummary({
          date,
          classId: req.query.classId ?? null,
          classScope: req.classScope,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.get('/by-class', validateQuery(z.object({ date: dateString.optional() })), async (req, res, next) => {
  try {
    const date = await resolveDate(req);
    res.json({ date, classes: await attendanceService.getClassBreakdown({ date, classScope: req.classScope }) });
  } catch (err) {
    next(err);
  }
});

/** Live arrivals feed. */
router.get(
  '/events',
  validateQuery(z.object({ limit: z.coerce.number().int().positive().max(200).default(25), date: dateString.optional() })),
  async (req, res, next) => {
    try {
      res.json(
        await attendanceService.getRecentEvents({
          limit: req.query.limit,
          date: req.query.date ?? null,
          classScope: req.classScope,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

/** Scans that matched no student — an enrollment gap, not an attendance one. */
router.get('/unmatched', requireStaff, async (_req, res, next) => {
  try {
    res.json(await attendanceService.getUnmatchedEvents({}));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Manual override (PRD §7.6)
// ---------------------------------------------------------------------------

const overrideBody = z.object({
  studentId: z.coerce.number().int().positive(),
  date: dateString,
  status: z.enum(['present', 'late', 'absent', 'excused']),
  reason: trimmedString(500),
  checkInTime: timeString.optional(),
});

router.post('/manual', requireStaff, validateBody(overrideBody), async (req, res, next) => {
  try {
    const record = await attendanceService.setAttendanceManually({
      ...req.body,
      actor: req.user,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

/** Same status for many students at once — a class trip, or a device outage. */
router.post(
  '/manual/bulk',
  requireStaff,
  validateBody(
    z.object({
      studentIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
      date: dateString,
      status: z.enum(['present', 'late', 'absent', 'excused']),
      reason: trimmedString(500),
    }),
  ),
  async (req, res, next) => {
    try {
      const result = await attendanceService.bulkSetAttendance({
        ...req.body,
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json({ updated: result.updated.length, failed: result.failed });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/manual/:studentId/:date',
  requireStaff,
  validateParams(z.object({ studentId: z.coerce.number().int().positive(), date: dateString })),
  async (req, res, next) => {
    try {
      const record = await attendanceService.clearManualOverride({
        studentId: req.params.studentId,
        date: req.params.date,
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json({ record });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Day finalisation
// ---------------------------------------------------------------------------

/**
 * Close a day: everyone still unmarked becomes an explicit absence. Normally
 * the nightly job does this; the endpoint exists so staff can close a day early
 * or catch up after the server was down.
 */
router.post(
  '/finalize',
  requireAdmin,
  validateBody(
    z.object({
      date: dateString.optional(),
      from: dateString.optional(),
      to: dateString.optional(),
      force: z.boolean().default(false),
    }),
  ),
  async (req, res, next) => {
    try {
      const { from, to, force } = req.body;
      let result;
      if (from && to) {
        result = await attendanceService.finalizeRange(from, to, { actorId: req.user.id, force });
      } else {
        const date = req.body.date ?? (await resolveDate(req));
        result = await attendanceService.finalizeDay(date, { actorId: req.user.id, force });
      }
      await auditFromRequest(req, {
        action: 'attendance.finalize',
        entityType: 'attendance_record',
        summary: from && to ? `Finalised ${from} to ${to}` : `Finalised ${req.body.date ?? 'today'}`,
        after: result,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/student/:id',
  validateParams(idParam),
  validateQuery(z.object({ from: dateString, to: dateString })),
  async (req, res, next) => {
    try {
      await assertStudentAccess(req, req.params.id);
      res.json(
        await attendanceService.getStudentHistory({
          studentId: req.params.id,
          from: req.query.from,
          to: req.query.to,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

export default router;
