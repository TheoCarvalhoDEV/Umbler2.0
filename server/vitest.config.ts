import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // each test builds a fresh PGlite + argon2 logins while ~30 files run in parallel
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
