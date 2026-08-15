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
    // `passWithNoTests` was wave-1 scaffolding and is deliberately absent now
    // that real test files exist (task 4.4). With it set, a config that
    // discovers nothing exits green, so a broken `include` glob, a renamed test
    // directory, or a vitest upgrade that changes discovery would all produce a
    // passing run with nothing executed. Leaving it would plant exactly the
    // silent-green failure the golden harness `pending` state exists to prevent.
  },
});
