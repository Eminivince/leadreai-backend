import { defineConfig } from 'vitest/config';

/**
 * Vitest config — Node test environment, ESM-aware module resolution.
 *
 * We deliberately exclude integration suites by default; `pnpm test` runs
 * pure-unit tests only so CI stays fast (< 60s target). Integration tests
 * that require live Mongo + Redis live under `**\/*.integration.test.ts`
 * and are run separately by `vitest run --testNamePattern=integration`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', 'node_modules', 'dist'],
    pool: 'forks',
    testTimeout: 10_000,
  },
});
