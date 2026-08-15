/**
 * The golden suite. Requirements 14.1–14.9, 14.11.
 *
 * This file is deliberately thin: `./harness.ts` does the work and returns
 * values, and this file turns each value into one vitest test so that a fixture
 * appears by name in the output and a single failure fails the suite.
 *
 * The run happens once, at module evaluation, before the tests are declared.
 * That is what lets a pending fixture carry `[pending]` in its own test name
 * rather than in an assertion message, which is the difference between an
 * omission a reader sees and one they have to go looking for.
 *
 * Today every fixture is pending: six responses are recorded and no
 * `expected.json` exists yet (task 9 authors them). The suite passes, and it says
 * so in a way that cannot be mistaken for six passing comparisons.
 *
 * Property 42 — the comparator is order-insensitive and value-exact — is task
 * 13.7's, not this file's. The harness's own failure paths are covered by
 * `./harness.test.ts`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { EXPECTED_FILE, pendingReport, runGolden } from './harness.js';

const GOLDEN_ROOT = fileURLToPath(new URL('.', import.meta.url));

// Top-level await: the fixtures must be run before the tests are named.
const run = await runGolden(GOLDEN_ROOT);

describe('golden fixtures', () => {
  it('discovers at least one fixture directory', () => {
    // An empty discovery would make every other test in this file vacuous, which
    // is the silent-green failure the whole pending mechanism exists to prevent.
    expect(run.results.length).toBeGreaterThan(0);
  });

  for (const result of run.results) {
    const label =
      result.outcome === 'pending'
        ? `${result.name} [pending: no ${EXPECTED_FILE}]`
        : result.name;

    it(label, () => {
      if (result.outcome === 'fail') {
        // The report already names the fixture, the paths, and both values.
        throw new Error(result.report);
      }
      // Both remaining outcomes assert the file state they claim, so a bug in
      // the harness that mislabelled one would fail here rather than read as a
      // clean result.
      expect(existsSync(join(result.dir, EXPECTED_FILE))).toBe(result.outcome === 'pass');
    });
  }

  it(`reports ${run.passed} compared, ${run.pending} pending, 0 failed`, () => {
    expect(run.failed).toBe(0);
    expect(run.passed + run.pending + run.failed).toBe(run.results.length);
  });

  afterAll(() => {
    if (run.pending > 0) {
      // `process.stdout.write`, not `console.log`: vitest intercepts console
      // output and attaches it to the task, and the reporter withholds it on a
      // passing non-TTY run — exactly the run where a pending fixture most needs
      // to be seen. Writing to the stream directly is what makes the banner
      // unconditional, which is the whole point of counting pending at all.
      process.stdout.write(`\n${pendingReport(run)}\n\n`);
    }
  });
});
