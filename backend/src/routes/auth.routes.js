import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z, validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as authService from '../services/auth.service.js';
import { auditFromRequest } from '../services/audit.service.js';
import { isTest } from '../config/env.js';

const router = Router();

/**
 * Sign-in is the one unauthenticated write endpoint, so it gets its own limiter.
 * The window is generous enough for a member of staff mistyping a password on a
 * shared office machine, but closes the door on credential stuffing.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { code: 'too_many_requests', message: 'Too many sign-in attempts. Try again in a few minutes.' } },
});

const loginSchema = z.object({
  email: z.string().trim().email('must be a valid email address'),
  password: z.string().min(1, 'is required'),
});

router.post('/login', loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login({
      ...req.body,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    await auditFromRequest(req, {
      actorId: result.user.id,
      actorLabel: `${result.user.full_name} (${result.user.email})`,
      action: 'auth.login',
      entityType: 'user',
      entityId: result.user.id,
      summary: `${result.user.full_name} signed in`,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/refresh',
  validateBody(z.object({ refreshToken: z.string().min(1) })),
  async (req, res, next) => {
    try {
      res.json(
        await authService.refreshSession({
          refreshToken: req.body.refreshToken,
          userAgent: req.get('user-agent'),
          ip: req.ip,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.post('/logout', validateBody(z.object({ refreshToken: z.string().optional() })), async (req, res, next) => {
  try {
    await authService.logout(req.body.refreshToken);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json(await authService.getCurrentUser(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.post(
  '/change-password',
  requireAuth,
  validateBody(
    z.object({
      currentPassword: z.string().min(1, 'is required'),
      newPassword: z.string().min(8, 'must be at least 8 characters'),
    }),
  ),
  async (req, res, next) => {
    try {
      await authService.changeOwnPassword(req.user.id, req.body);
      await auditFromRequest(req, {
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: req.user.id,
        summary: `${req.user.full_name} changed their password`,
      });
      res.json({ message: 'Password updated. Please sign in again.' });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await authService.logoutAllSessions(req.user.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
