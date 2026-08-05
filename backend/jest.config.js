export default {
  testEnvironment: 'node',
  // The project is native ESM; Jest runs it through --experimental-vm-modules
  // (see the "test" script) rather than a transpiler.
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setupEnv.js'],
  testTimeout: 30_000,
  collectCoverageFrom: ['src/**/*.js', '!src/db/migrate.js', '!src/db/seed.js', '!src/index.js'],
  verbose: false,
};
