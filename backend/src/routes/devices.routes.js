import { Router } from 'express';
import { z, validateBody, validateQuery, validateParams, idParam, trimmedString, dateString } from '../middleware/validate.js';
import { requireAuth, requireAdmin, requireStaff } from '../middleware/auth.js';
import * as devicesService from '../services/devices.service.js';
import { COMMAND_CATALOG } from '../lib/adms/commands.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireStaff, async (_req, res, next) => {
  try {
    res.json(await devicesService.listDevices());
  } catch (err) {
    next(err);
  }
});

/** The command vocabulary, so the dashboard can build its menu from the API. */
router.get('/commands/catalog', requireStaff, (_req, res) => {
  res.json(
    Object.entries(COMMAND_CATALOG).map(([type, entry]) => ({
      type,
      description: entry.description,
      minimumRole: entry.role,
    })),
  );
});

// --- Device users and enrollment linking (PRD §7.2) ------------------------

router.get(
  '/users',
  requireStaff,
  validateQuery(
    z.object({
      deviceId: z.coerce.number().int().positive().optional(),
      unlinkedOnly: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await devicesService.listDeviceUsers(req.query));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/users/:id/link',
  requireStaff,
  validateParams(idParam),
  validateBody(z.object({ studentId: z.coerce.number().int().positive() })),
  async (req, res, next) => {
    try {
      const result = await devicesService.linkDeviceUser({
        deviceUserId: req.params.id,
        studentId: req.body.studentId,
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json({
        message: `Linked PIN ${result.deviceUser.pin} to ${result.student.first_name} ${result.student.last_name}`,
        backfilledDates: result.backfilledDates,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/users/:id/unlink', requireStaff, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(
      await devicesService.unlinkDeviceUser(req.params.id, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --- Registry --------------------------------------------------------------

router.get('/:id', requireStaff, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(await devicesService.getDevice(req.params.id));
  } catch (err) {
    next(err);
  }
});

const deviceBody = z.object({
  serialNumber: trimmedString(64),
  name: trimmedString(80),
  location: trimmedString(120).optional().nullable(),
  model: trimmedString(80).optional().nullable(),
  timezoneOffset: z.coerce.number().int().min(-12).max(14).optional().nullable(),
  ipAllowlist: z.array(z.string().trim().min(1)).optional().nullable(),
  isActive: z.boolean().optional(),
  generateSecret: z.boolean().default(true),
});

/**
 * Registering a terminal returns its push secret exactly once — it goes into
 * the device's ADMS server URL and is not readable afterwards.
 */
router.post('/', requireAdmin, validateBody(deviceBody), async (req, res, next) => {
  try {
    const device = await devicesService.registerDevice(req.body, {
      actor: req.user,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json({
      ...device,
      setupHint: device.pushSecret
        ? 'Copy the push secret now — it cannot be shown again. See docs/DEVICE-INTEGRATION.md for the terminal settings.'
        : undefined,
    });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  requireAdmin,
  validateParams(idParam),
  validateBody(deviceBody.partial().omit({ serialNumber: true, generateSecret: true })),
  async (req, res, next) => {
    try {
      res.json(
        await devicesService.updateDevice(req.params.id, req.body, {
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

router.post('/:id/rotate-secret', requireAdmin, validateParams(idParam), async (req, res, next) => {
  try {
    res.json(
      await devicesService.rotatePushSecret(req.params.id, {
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
      await devicesService.deleteDevice(req.params.id, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --- Commands --------------------------------------------------------------

/**
 * Queue a command for the terminal to pick up on its next poll. Commands are
 * chosen from a fixed catalog rather than passed through as free text, so the
 * API cannot be used to send an arbitrary instruction to hardware.
 */
router.post(
  '/:id/commands',
  requireStaff,
  validateParams(idParam),
  validateBody(
    z.object({
      type: z.enum(Object.keys(COMMAND_CATALOG)),
      args: z
        .object({
          pin: z.string().trim().regex(/^\d{1,20}$/).optional(),
          name: trimmedString(24).optional(),
          fingerIndex: z.coerce.number().int().min(0).max(9).optional(),
          startDate: dateString.optional(),
          endDate: dateString.optional(),
          dateTime: z.string().trim().optional(),
        })
        .default({}),
    }),
  ),
  async (req, res, next) => {
    try {
      // Destructive or device-wide commands stay admin-only.
      if (COMMAND_CATALOG[req.body.type].role === 'admin' && req.user.role !== 'admin') {
        return res.status(403).json({
          error: { code: 'forbidden', message: `The "${req.body.type}" command requires an administrator` },
        });
      }
      const command = await devicesService.queueCommand({
        deviceId: req.params.id,
        type: req.body.type,
        args: req.body.args,
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return res.status(201).json(command);
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
