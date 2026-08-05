import { z } from 'zod';
import { isValidDateString } from '../lib/dates.js';

/**
 * Zod-based request validation. Each helper replaces the raw input with the
 * parsed value, so handlers receive coerced, trimmed, typed data and never have
 * to re-check it.
 */
export const validateBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) return next(result.error);
  req.body = result.data;
  return next();
};

export const validateQuery = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) return next(result.error);
  // Express 5 exposes req.query via a getter; keep parsed output beside it.
  req.validatedQuery = result.data;
  Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
  return next();
};

export const validateParams = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.params ?? {});
  if (!result.success) return next(result.error);
  req.params = result.data;
  return next();
};

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const dateString = z
  .string()
  .refine(isValidDateString, { message: 'must be a date in YYYY-MM-DD format' });

export const optionalDateString = dateString.optional();

export const timeString = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be a time like 07:30');

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export const exportFormat = z.enum(['json', 'csv', 'pdf']).default('json');

/** Trim strings and turn empty ones into undefined, so blank form fields clear. */
export const trimmedString = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v));

export const optionalText = (max = 2000) => trimmedString(max).optional().nullable();

/** A date range where `to` may not precede `from`. */
export const dateRange = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export { z };
