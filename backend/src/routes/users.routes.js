import { Router } from 'express';
import { z, validateBody, validateQuery, validateParams, idParam, trimmedString } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as usersService from '../services/users.service.js';
import { ForbiddenError } from '../lib/errors.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  validateQuery(
    z.object({
      role: z.enum(['admin', 'teacher', 'office_staff']).optional(),
      includeInactive: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await usersService.listUsers(req.query));
    } catch (err) {
      next(err);
    }
  },
);

router.get('/:id', validateParams(idParam), async (req, res, next) => {
  try {
    res.json(await usersService.getUser(req.params.id));
  } catch (err) {
    next(err);
  }
});

const userBody = z.object({
  email: z.string().trim().email('must be a valid email address'),
  fullName: trimmedString(120),
  role: z.enum(['admin', 'teacher', 'office_staff']),
  phone: trimmedString(40).optional().nullable(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
  classIds: z.array(z.coerce.number().int().positive()).optional(),
});

router.post('/', validateBody(userBody), async (req, res, next) => {
  try {
    const user = await usersService.createUser(req.body, {
      actor: req.user,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  validateParams(idParam),
  validateBody(userBody.partial().omit({ password: true })),
  async (req, res, next) => {
    try {
      // Removing your own admin rights locks you out of the screen you are on.
      if (Number(req.params.id) === req.user.id && (req.body.role !== undefined || req.body.isActive === false)) {
        throw new ForbiddenError('You cannot change your own role or deactivate your own account');
      }
      res.json(
        await usersService.updateUser(req.params.id, req.body, {
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

/** Admin password reset. Returns a temporary password when none was supplied. */
router.post(
  '/:id/reset-password',
  validateParams(idParam),
  validateBody(z.object({ newPassword: z.string().min(8).optional() })),
  async (req, res, next) => {
    try {
      res.json(
        await usersService.resetUserPassword(req.params.id, {
          newPassword: req.body.newPassword,
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

router.delete('/:id', validateParams(idParam), async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) throw new ForbiddenError('You cannot delete your own account');
    res.json(
      await usersService.deleteUser(req.params.id, {
        actor: req.user,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
