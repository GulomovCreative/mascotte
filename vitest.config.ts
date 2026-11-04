import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'reference/test/**/*.test.ts'],
    environment: 'node',
  },
});
