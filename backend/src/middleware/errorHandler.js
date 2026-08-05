import { ZodError } from 'zod';
import { AppError, NotFoundError } from '../lib/errors.js';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

/**
 * Terminal error handler. Deliberate AppErrors are reported verbatim; anything
 * else is logged in full and reduced to a generic message so stack traces and
 * SQL fragments never reach the browser.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const fieldErrors = {};
    for (const issue of err.issues) {
      const path = issue.path.join('.') || '_';
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return res.status(422).json({
      error: { code: 'validation_failed', message: 'Some fields need attention', details: fieldErrors },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, path: req.originalUrl }, 'Request failed');
    else logger.debug({ code: err.code, path: req.originalUrl, message: err.message }, 'Request rejected');
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
  }

  logger.error({ err, path: req.originalUrl, method: req.method }, 'Unhandled error');
  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. Please try again.',
      ...(isProduction ? {} : { debug: err?.message }),
    },
  });
}
