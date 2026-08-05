import { Router } from 'express';
import { z, validateQuery, validateParams, idParam, dateString } from '../middleware/validate.js';
import { requireAuth, attachClassScope, assertClassAccess, assertStudentAccess } from '../middleware/auth.js';
import * as reportsService from '../services/reports.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { getClass } from '../services/classes.service.js';
import { toCsv, csvFilename } from '../lib/csv.js';
import { renderTablePdf, pdfFilename } from '../lib/pdf.js';
import {
  todayInZone,
  startOfIsoWeek,
  endOfIsoWeek,
  startOfMonth,
  endOfMonth,
  formatDateLong,
} from '../lib/dates.js';
import { auditFromRequest } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, attachClassScope);

/**
 * Every report endpoint answers in whichever of JSON, CSV or PDF the caller
 * asks for (PRD §7.5). The three formats share one report object and one column
 * definition, so a figure can never differ between the screen and the export.
 */
async function respond(req, res, report, { filenameParts, orientation = 'portrait', classLabel } = {}) {
  const format = req.query.format ?? 'json';
  if (format === 'json') return res.json(report);

  const config = await getAttendanceConfig();
  const described = reportsService.describeReport(report, {
    schoolName: config.schoolName,
    classLabel,
    timezone: config.timezone,
  });

  await auditFromRequest(req, {
    action: 'report.export',
    entityType: 'report',
    entityId: report.type,
    summary: `Exported ${described.title} as ${format.toUpperCase()}`,
  });

  if (format === 'csv') {
    const csv = toCsv(described.columns, described.rows, {
      title: [config.schoolName, described.title, described.subtitle],
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(filenameParts)}"`);
    return res.send(csv);
  }

  const pdf = await renderTablePdf({
    title: described.title,
    subtitle: described.subtitle,
    schoolName: described.schoolName,
    summary: described.summary,
    columns: described.columns,
    rows: described.rows,
    footerNote: config.reportFooterNote,
    orientation,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename(filenameParts)}"`);
  return res.send(pdf);
}

const formatQuery = { format: z.enum(['json', 'csv', 'pdf']).default('json') };
const classQuery = { classId: z.coerce.number().int().positive().optional() };

async function classLabelFor(classId) {
  if (!classId) return null;
  const cls = await getClass(classId);
  return `Class: ${cls.name}`;
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

router.get(
  '/daily',
  validateQuery(z.object({ date: dateString.optional(), ...classQuery, ...formatQuery })),
  async (req, res, next) => {
    try {
      if (req.query.classId) assertClassAccess(req, req.query.classId);
      const config = await getAttendanceConfig();
      const date = req.query.date ?? todayInZone(config.timezone);
      const report = await reportsService.dailyReport({
        date,
        classId: req.query.classId ?? null,
        classScope: req.classScope,
      });
      await respond(req, res, report, {
        filenameParts: ['daily-attendance', date],
        orientation: 'landscape',
        classLabel: await classLabelFor(req.query.classId),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Weekly / monthly / arbitrary range — one query shape, three convenience
// endpoints so the dashboard does not have to compute period boundaries.
// ---------------------------------------------------------------------------

const rangeQuery = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  ...classQuery,
  ...formatQuery,
  sort: z.enum(['name', 'rate_asc', 'rate_desc', 'absences', 'lateness']).default('name'),
});

async function resolveRange(req, mode) {
  const config = await getAttendanceConfig();
  const today = todayInZone(config.timezone);
  if (mode === 'week') {
    const anchor = req.query.from ?? today;
    return { from: startOfIsoWeek(anchor), to: endOfIsoWeek(anchor) };
  }
  if (mode === 'month') {
    const anchor = req.query.from ?? today;
    return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }
  return { from: req.query.from ?? startOfMonth(today), to: req.query.to ?? today };
}

for (const [path, mode] of [
  ['/weekly', 'week'],
  ['/monthly', 'month'],
  ['/range', 'range'],
]) {
  router.get(path, validateQuery(rangeQuery), async (req, res, next) => {
    try {
      if (req.query.classId) assertClassAccess(req, req.query.classId);
      const { from, to } = await resolveRange(req, mode);
      const report = await reportsService.studentSummaryReport({
        from,
        to,
        classId: req.query.classId ?? null,
        classScope: req.classScope,
        sort: req.query.sort,
      });
      await respond(req, res, report, {
        filenameParts: ['attendance-summary', from, to],
        orientation: 'landscape',
        classLabel: await classLabelFor(req.query.classId),
      });
    } catch (err) {
      next(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Per class
// ---------------------------------------------------------------------------

router.get(
  '/by-class',
  validateQuery(
    z.object({ from: dateString, to: dateString, academicYear: z.string().trim().optional(), ...formatQuery }),
  ),
  async (req, res, next) => {
    try {
      const report = await reportsService.classSummaryReport({
        from: req.query.from,
        to: req.query.to,
        academicYear: req.query.academicYear ?? null,
        classScope: req.classScope,
      });
      await respond(req, res, report, { filenameParts: ['class-attendance', req.query.from, req.query.to] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Trend (dashboard chart)
// ---------------------------------------------------------------------------

router.get(
  '/trend',
  validateQuery(z.object({ from: dateString, to: dateString, ...classQuery, ...formatQuery })),
  async (req, res, next) => {
    try {
      if (req.query.classId) assertClassAccess(req, req.query.classId);
      const report = await reportsService.attendanceTrend({
        from: req.query.from,
        to: req.query.to,
        classId: req.query.classId ?? null,
        classScope: req.classScope,
      });
      await respond(req, res, report, { filenameParts: ['attendance-trend', req.query.from, req.query.to] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Follow-up lists
// ---------------------------------------------------------------------------

router.get(
  '/chronic-absentees',
  validateQuery(
    z.object({
      from: dateString,
      to: dateString,
      threshold: z.coerce.number().min(0).max(100).default(80),
      ...formatQuery,
    }),
  ),
  async (req, res, next) => {
    try {
      const report = await reportsService.chronicAbsenteeReport({
        from: req.query.from,
        to: req.query.to,
        threshold: req.query.threshold,
        classScope: req.classScope,
      });
      await respond(req, res, report, {
        filenameParts: ['chronic-absentees', req.query.from, req.query.to],
        orientation: 'landscape',
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/lateness',
  validateQuery(
    z.object({
      from: dateString,
      to: dateString,
      minLateDays: z.coerce.number().int().min(1).default(1),
      ...formatQuery,
    }),
  ),
  async (req, res, next) => {
    try {
      const report = await reportsService.latenessReport({
        from: req.query.from,
        to: req.query.to,
        minLateDays: req.query.minLateDays,
        classScope: req.classScope,
      });
      await respond(req, res, report, { filenameParts: ['lateness', req.query.from, req.query.to] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Single student
// ---------------------------------------------------------------------------

router.get(
  '/student/:id',
  validateParams(idParam),
  validateQuery(z.object({ from: dateString, to: dateString, ...formatQuery })),
  async (req, res, next) => {
    try {
      await assertStudentAccess(req, req.params.id);
      const report = await reportsService.studentReport({
        studentId: req.params.id,
        from: req.query.from,
        to: req.query.to,
      });
      await respond(req, res, report, {
        filenameParts: ['attendance', report.student.full_name, req.query.from, req.query.to],
        classLabel: report.student.class_name ? `Class: ${report.student.class_name}` : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Human-friendly label used by the frontend's report header. */
router.get('/meta', async (_req, res, next) => {
  try {
    const config = await getAttendanceConfig();
    const today = todayInZone(config.timezone);
    res.json({
      today,
      todayLabel: formatDateLong(today),
      timezone: config.timezone,
      schoolName: config.schoolName,
      thisWeek: { from: startOfIsoWeek(today), to: endOfIsoWeek(today) },
      thisMonth: { from: startOfMonth(today), to: endOfMonth(today) },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
