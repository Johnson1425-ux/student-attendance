/**
 * Application error taxonomy. Anything thrown that is an AppError is a
 * deliberate, client-visible outcome; anything else is a bug and is reported
 * as a generic 500 without leaking internals.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request', details) {
    super(message, { status: 400, code: 'bad_request', details });
  }
}

export class ValidationError extends AppError {
  constructor(details, message = 'Validation failed') {
    super(message, { status: 422, code: 'validation_failed', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'unauthorized' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, { status: 403, code: 'forbidden' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { status: 404, code: 'not_found' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicts with existing data', details) {
    super(message, { status: 409, code: 'conflict', details });
  }
}

/**
 * Translate a Postgres integrity violation into the equivalent AppError so
 * callers do not have to duplicate uniqueness checks that the database already
 * enforces atomically.
 */
export function mapDatabaseError(err, mappings = {}) {
  if (err?.code === '23505') {
    const constraint = err.constraint ?? '';
    const message = mappings[constraint];
    return new ConflictError(message ?? 'A record with these details already exists', {
      constraint,
    });
  }
  if (err?.code === '23503') {
    const constraint = err.constraint ?? '';
    return new BadRequestError(
      mappings[constraint] ?? 'Referenced record does not exist or is still in use',
      { constraint },
    );
  }
  if (err?.code === '23514') {
    const constraint = err.constraint ?? '';
    return new BadRequestError(mappings[constraint] ?? 'Value violates a data rule', { constraint });
  }
  return err;
}
