import { defineProject } from 'vitest/config';

export default defineProject({
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 120_000 },
});
