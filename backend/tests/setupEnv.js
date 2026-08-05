/**
 * Test environment defaults, applied before any module reads config.
 *
 * Integration tests run against a real PostgreSQL database rather than a mock:
 * a large share of this system's logic lives in SQL (the report CTEs, the
 * upsert precedence rules, the uniqueness constraint that guarantees one
 * record per student per day), and a mocked driver would test none of it.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.ENABLE_SCHEDULER = 'false';
process.env.JWT_SECRET ??= 'test-secret-key-for-attendance-suite';
process.env.DATABASE_URL ??= 'postgres://attendance:attendance@127.0.0.1:5432/attendance_test';
process.env.CORS_ORIGINS ??= '*';
