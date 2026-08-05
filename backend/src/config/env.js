import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment contract. The process refuses to boot with an invalid config
 * rather than failing later in an unrelated request — a mistyped DATABASE_URL
 * should be obvious at deploy time, not at 07:30 when the first student scans.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('30m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Comma-separated list, or "*" during local development.
  CORS_ORIGINS: z.string().default('*'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ADMS ingestion
  DEVICE_PUSH_SECRET_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEVICE_AUTO_REGISTER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Background jobs
  ENABLE_SCHEDULER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  FINALIZE_CRON: z.string().default('30 23 * * *'),

  // First-run bootstrap admin (used by `npm run seed`)
  SEED_ADMIN_EMAIL: z.string().email().default('admin@school.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
  SEED_ADMIN_NAME: z.string().default('System Administrator'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins =
  env.CORS_ORIGINS === '*' ? '*' : env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
