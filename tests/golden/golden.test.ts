/**
 * The golden suite. Requirements 14.1–14.11.
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
 * Every fixture is compared. Six responses are recorded, all six are pinned in
 * `PINNED_FIXTURES`, and all six carry a hand-reviewed `expected.json`, so the run
 * reports `6 discovered: 6 compared, 0 pending, 0 failed`. Nothing here is
 * `pending`, and for a pinned directory nothing can be: a missing `expected.json`
 * is a failure. `pending` remains reachable for a directory recorded later and not
 * yet hand-reviewed — see `PINNED_FIXTURES` for why both states are load-bearing.
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

import {
  EXPECTED_FILE,
  GOLDEN_TIME_BUDGET_MS,
  PINNED_FIXTURES,
  pendingReport,
  runGolden,
  summaryLine,
} from './harness.js';

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

  it(`compares all ${PINNED_FIXTURES.length} pinned fixtures`, () => {
    // The check that keeps the pinned list honest. A pinned name with no
    // directory on disk is invisible to discovery, so without this the list
    // could name six fixtures while enforcing four — the exact shape an earlier
    // revision had. Comparing name-to-outcome strings rather than booleans so a
    // failure prints which fixture and what happened to it instead of
    // `false !== true`.
    const outcomes = new Map(run.results.map((result) => [result.name, result.outcome]));
    expect(
      PINNED_FIXTURES.map((name) => `${name}: ${outcomes.get(name) ?? 'not discovered'}`),
    ).toEqual(PINNED_FIXTURES.map((name) => `${name}: pass`));
  });

  it(`reports ${run.passed} compared, ${run.pending} pending, 0 failed`, () => {
    expect(run.failed).toBe(0);
    expect(run.passed + run.pending + run.failed).toBe(run.results.length);
  });

  it(`completes in under ${GOLDEN_TIME_BUDGET_MS} ms (Req 14.10)`, () => {
    // Measured around the fixture loop, so it covers discovery, every file read,
    // every pipeline run, and every comparison — not the test runner's own
    // startup, which is not what 14.10 budgets. Typical figure is two orders of
    // magnitude under, because there is no network, no spawn, no compile, and no
    // sleep in the suite.
    expect(run.elapsedMs).toBeLessThan(GOLDEN_TIME_BUDGET_MS);
  });

  afterAll(() => {
    // Unconditional, and on the passing run too: `6 discovered: 6 compared, 0
    // pending, 0 failed` is what tells a reader the comparisons happened.
    process.stdout.write(
      `\n${summaryLine(run)} in ${run.elapsedMs.toFixed(0)} ms ` +
        `(Req 14.10 budget ${GOLDEN_TIME_BUDGET_MS} ms)\n`,
    );
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
