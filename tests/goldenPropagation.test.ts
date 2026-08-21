/**
 * Overall-failure propagation across the golden run. Requirement 14.11.
 *
 * `golden/harness.test.ts` establishes each failure reason on its own through
 * `runFixture`, and tallies a run holding one failure. What is left unpinned by
 * that, and is what 14.11 actually asks for, is the aggregate over *every*
 * reason at once: a missing `input.json`, an unparseable `input.json`, an
 * `input.json` that is not a `getTransaction` response, an unparseable
 * `expected.json`, and an output mismatch each have to raise the run-level
 * failure count, and none of them may abort the run and cost the remaining
 * fixtures their result.
 *
 * `golden/golden.test.ts` turns a non-zero count into a red suite with
 * `expect(run.failed).toBe(0)`, so the count is the propagation mechanism, and
 * the count is what is asserted here.
 *
 * Temp directories only. Nothing here reads or writes `tests/golden/`, apart
 * from borrowing one recorded response as valid `input.json` content.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeTransaction } from '../src/pipeline.js';
import { asTransactionResponse } from '../src/source/index.js';
import { canonicalize, runGolden, type JsonValue } from './golden/harness.js';
import { firstGoldenCase } from './source/support/golden.js';

const RECORDED = firstGoldenCase();

/** The analysis of that response — what a correct `expected.json` holds. */
const CORRECT_EXPECTED: JsonValue = (() => {
  const checked = asTransactionResponse(RECORDED.document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  return canonicalize(analyzeTransaction({ response: checked.response }));
})();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opsis-golden-propagation-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCase(
  name: string,
  files: { readonly input?: string; readonly expected?: string },
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (files.input !== undefined) await writeFile(join(dir, 'input.json'), files.input);
  if (files.expected !== undefined) await writeFile(join(dir, 'expected.json'), files.expected);
}

describe('runGolden failure propagation', () => {
  it('counts a failure from every reason, without losing the healthy fixtures', async () => {
    await writeCase('01-pass', {
      input: RECORDED.text,
      expected: JSON.stringify(CORRECT_EXPECTED),
    });
    await writeCase('02-missing-input', { expected: '{}' });
    await writeCase('03-unparseable-input', { input: '{ "slot": ', expected: '{}' });
    await writeCase('04-not-a-response', { input: '{"slot": "nope"}', expected: '{}' });
    await writeCase('05-unparseable-expected', { input: RECORDED.text, expected: '{ "sig": ' });
    await writeCase('06-mismatch', {
      input: RECORDED.text,
      expected: JSON.stringify({
        ...(CORRECT_EXPECTED as Record<string, JsonValue>),
        signature: 'WRONG',
      }),
    });
    await writeCase('07-pending', { input: RECORDED.text });

    const run = await runGolden(root);

    // Every fixture still has a result: the first failure did not end the run.
    expect(run.results.map((result) => [result.name, result.outcome])).toEqual([
      ['01-pass', 'pass'],
      ['02-missing-input', 'fail'],
      ['03-unparseable-input', 'fail'],
      ['04-not-a-response', 'fail'],
      ['05-unparseable-expected', 'fail'],
      ['06-mismatch', 'fail'],
      ['07-pending', 'pending'],
    ]);

    // And the run-level count is what `golden.test.ts` asserts is zero, so each
    // of the five reasons on its own is enough to make the suite red.
    expect({ passed: run.passed, pending: run.pending, failed: run.failed }).toEqual({
      passed: 1,
      pending: 1,
      failed: 5,
    });
  });

  it('raises the count for a lone failure among otherwise healthy fixtures', async () => {
    // The minimal case behind 14.11: one broken fixture in a directory that is
    // otherwise entirely fine still fails the run.
    await writeCase('01-pass', {
      input: RECORDED.text,
      expected: JSON.stringify(CORRECT_EXPECTED),
    });
    await writeCase('02-pass-too', {
      input: RECORDED.text,
      expected: JSON.stringify(CORRECT_EXPECTED),
    });
    await writeCase('03-mismatch', {
      input: RECORDED.text,
      expected: JSON.stringify({
        ...(CORRECT_EXPECTED as Record<string, JsonValue>),
        slot: -1,
      }),
    });

    const run = await runGolden(root);

    expect(run.failed).toBe(1);
    expect(run.passed).toBe(2);
  });
});
