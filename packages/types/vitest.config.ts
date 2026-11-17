import { defineConfig } from 'vitest/config';

// Domain unit tests (CI-05): pure functions, no database, no network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
