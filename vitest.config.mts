import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (AD-25). Only test/ is searched, so the demo
// folders at the repo root are never scanned.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
