import { defineConfig } from 'vitest/config';

// One non-watch run: `npm test` is `vitest run`, so the reviewer path is
// `npm install && npm test` with nothing left running afterwards.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Runs before every test file: throws on any outbound request except to
    // 127.0.0.1, so the offline guarantee is enforced rather than assumed.
    setupFiles: ['tests/setup/noNetwork.ts'],
    watch: false,
    // Wave 1 has no test files yet; later waves fill tests/ in. Without this,
    // vitest exits non-zero on an empty suite and `npm test` fails for a
    // reason that has nothing to do with correctness.
    passWithNoTests: true,
  },
});
