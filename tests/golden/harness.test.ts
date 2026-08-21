/**
 * The harness's own failure paths, over temp directories.
 *
 * `./golden.test.ts` runs the harness against the committed fixtures, where every
 * case passes — which means the paths that matter most (a mismatch report, an
 * unparseable file, a missing `input.json`, a missing `expected.json`) are never
 * taken there, and cannot be without breaking a committed fixture. A harness whose
 * failure reporting is itself untested is a harness that can pass a broken fixture
 * silently, so those paths are exercised here on directories built for the purpose.
 *
 * Temp directories, never `tests/golden/`: these tests write and delete
 * fixture-shaped trees, and nothing here may touch the committed ones.
 *
 * `input.json` content is a real recorded response rather than a hand-written
 * stub, so the pipeline runs on something it will genuinely see. Property 42 (the
 * comparator over arbitrary `Analysis` values) belongs to task 13.7; what is
 * checked here is the harness's plumbing around it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeTransaction } from '../../src/pipeline.js';
import { asTransactionResponse } from '../../src/source/index.js';
import { firstGoldenCase } from '../source/support/golden.js';
import {
  canonicalize,
  diffJson,
  discoverFixtures,
  isPinned,
  PINNED_FIXTURES,
  runFixture,
  runGolden,
  type GoldenResult,
  type JsonValue,
} from './harness.js';

/** A genuine recorded response, reused as valid `input.json` content. */
const RECORDED = firstGoldenCase();

/** The canonical analysis of that response — what a correct `expected.json` holds. */
const CORRECT_EXPECTED: JsonValue = (() => {
  const checked = asTransactionResponse(RECORDED.document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  return canonicalize(analyzeTransaction({ response: checked.response }));
})();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opsis-golden-harness-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface CaseFiles {
  readonly input?: string;
  readonly expected?: string;
}

/** Build one fixture-shaped directory, writing only the files named. */
async function writeCase(name: string, files: CaseFiles): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (files.input !== undefined) await writeFile(join(dir, 'input.json'), files.input);
  if (files.expected !== undefined) await writeFile(join(dir, 'expected.json'), files.expected);
  return dir;
}

/** Narrow to a failure and hand back its report, or fail with what came instead. */
function reportOf(result: GoldenResult): string {
  if (result.outcome !== 'fail') {
    throw new Error(`expected ${result.name} to fail, it was ${result.outcome}`);
  }
  return result.report;
}

describe('discoverFixtures', () => {
  it('returns subdirectories sorted by name regardless of creation order', async () => {
    await writeCase('20-late', {});
    await writeCase('03-middle', {});
    await writeCase('01-early', {});
    await writeFile(join(root, 'notes.md'), 'not a fixture');

    expect(await discoverFixtures(root)).toEqual(['01-early', '03-middle', '20-late']);
  });
});

describe('runFixture: input.json', () => {
  it('fails a directory with no input.json, naming the path', async () => {
    const dir = await writeCase('01-no-input', { expected: '{}' });

    const report = reportOf(await runFixture(root, '01-no-input'));

    expect(report).toContain('01-no-input');
    expect(report).toContain(join(dir, 'input.json'));
    expect(report).toContain('missing');
  });

  it('fails an unparseable input.json, naming the path and the parse error', async () => {
    const dir = await writeCase('02-bad-input', { input: '{ "slot": ', expected: '{}' });

    const report = reportOf(await runFixture(root, '02-bad-input'));

    expect(report).toContain(join(dir, 'input.json'));
    expect(report).toContain('not valid JSON');
  });

  it('fails an input.json that parses but is not a getTransaction response', async () => {
    await writeCase('03-not-a-response', { input: '{"slot": "nope"}', expected: '{}' });

    const report = reportOf(await runFixture(root, '03-not-a-response'));

    expect(report).toContain('not a getTransaction response');
  });
});

describe('runFixture: expected.json', () => {
  it('reports pending, not pass, when expected.json is absent', async () => {
    await writeCase('04-pending', { input: RECORDED.text });

    const result = await runFixture(root, '04-pending');

    expect(result.outcome).toBe('pending');
    if (result.outcome !== 'pending') throw new Error('unreachable');
    expect(result.expectedPath).toBe(join(root, '04-pending', 'expected.json'));
  });

  it('fails an unparseable expected.json, naming the path and the parse error', async () => {
    const dir = await writeCase('05-bad-expected', {
      input: RECORDED.text,
      expected: '{ "signature": ',
    });

    const report = reportOf(await runFixture(root, '05-bad-expected'));

    expect(report).toContain(join(dir, 'expected.json'));
    expect(report).toContain('not valid JSON');
  });
});

describe('the pinned list', () => {
  it('fails a pinned directory with no expected.json, where a non-pinned one is pending', async () => {
    // The contrast is the whole reason `PINNED_FIXTURES` exists. Both directories
    // are in the identical file state — a valid `input.json`, no `expected.json` —
    // and the only thing separating a hard failure from a `pending` report is
    // membership in the list. Run through `runGolden` so the tally is checked
    // alongside the two outcomes.
    const pinned = PINNED_FIXTURES[0];
    if (pinned === undefined) throw new Error('PINNED_FIXTURES is empty');
    expect(isPinned('99-recorded-later')).toBe(false);

    await writeCase(pinned, { input: RECORDED.text });
    await writeCase('99-recorded-later', { input: RECORDED.text });

    const run = await runGolden(root);
    const outcomes = new Map(run.results.map((result) => [result.name, result.outcome]));

    expect(outcomes.get(pinned)).toBe('fail');
    expect(outcomes.get('99-recorded-later')).toBe('pending');
    expect({ passed: run.passed, pending: run.pending, failed: run.failed }).toEqual({
      passed: 0,
      pending: 1,
      failed: 1,
    });

    // Req 14.5: the report names the file path, and says why this one is not
    // pending, so nobody has to guess which list to look at.
    const pinnedResult = run.results.find((result) => result.name === pinned);
    if (pinnedResult === undefined) throw new Error(`${pinned} was not discovered`);
    const report = reportOf(pinnedResult);
    expect(report).toContain(join(root, pinned, 'expected.json'));
    expect(report).toContain('pinned');
  });

  it('matches names exactly, so a copied directory is not pinned', async () => {
    const pinned = PINNED_FIXTURES[0];
    if (pinned === undefined) throw new Error('PINNED_FIXTURES is empty');
    expect(isPinned(pinned)).toBe(true);
    expect(isPinned(`${pinned}-copy`)).toBe(false);

    await writeCase(`${pinned}-copy`, { input: RECORDED.text });

    expect((await runFixture(root, `${pinned}-copy`)).outcome).toBe('pending');
  });
});

describe('runFixture: comparison', () => {
  it('passes when the analysis matches expected.json exactly', async () => {
    await writeCase('06-match', {
      input: RECORDED.text,
      expected: JSON.stringify(CORRECT_EXPECTED, null, 2),
    });

    const result = await runFixture(root, '06-match');

    expect(result.outcome).toBe('pass');
  });

  it('passes when expected.json carries the same values under permuted keys', async () => {
    // Key order is ignored (Req 14.7): the same document with every object's keys
    // reversed must still compare equal.
    await writeCase('07-permuted', {
      input: RECORDED.text,
      expected: JSON.stringify(reverseKeys(CORRECT_EXPECTED)),
    });

    const result = await runFixture(root, '07-permuted');

    expect(result.outcome).toBe('pass');
  });

  it('fails a single changed leaf, reporting the JSON pointer and both values', async () => {
    const mutated = { ...(CORRECT_EXPECTED as Record<string, JsonValue>), signature: 'WRONG' };
    await writeCase('08-mismatch', {
      input: RECORDED.text,
      expected: JSON.stringify(mutated),
    });

    const report = reportOf(await runFixture(root, '08-mismatch'));

    expect(report).toContain('08-mismatch');
    expect(report).toContain('/signature');
    expect(report).toContain('"WRONG"');
    expect(report).toContain(JSON.stringify(RECORDED.signature));
  });

  it('fails when a null-valued key is absent from expected.json', async () => {
    // `null` and an absent key are different documents, and `Analysis` uses both.
    const withoutFailure = { ...(CORRECT_EXPECTED as Record<string, JsonValue>) };
    delete withoutFailure['failure'];
    await writeCase('09-absent-key', {
      input: RECORDED.text,
      expected: JSON.stringify(withoutFailure),
    });

    const report = reportOf(await runFixture(root, '09-absent-key'));

    expect(report).toContain('/failure');
    expect(report).toContain('<absent>');
  });
});

describe('runGolden', () => {
  it('tallies pass, pending, and fail across a directory tree', async () => {
    await writeCase('01-pass', {
      input: RECORDED.text,
      expected: JSON.stringify(CORRECT_EXPECTED),
    });
    await writeCase('02-pending', { input: RECORDED.text });
    await writeCase('03-pending-too', { input: RECORDED.text });
    await writeCase('04-fail', { input: 'nope', expected: '{}' });

    const run = await runGolden(root);

    expect(run.results.map((result) => result.name)).toEqual([
      '01-pass',
      '02-pending',
      '03-pending-too',
      '04-fail',
    ]);
    expect({ passed: run.passed, pending: run.pending, failed: run.failed }).toEqual({
      passed: 1,
      pending: 2,
      failed: 1,
    });
  });
});

describe('canonicalize', () => {
  it('sorts keys, omits undefined, and preserves null', () => {
    const canonical = canonicalize({
      zebra: 1,
      absent: undefined,
      nullish: null,
      nested: { b: [1, undefined, { d: 2, c: 3 }], a: true },
    });

    expect(JSON.stringify(canonical)).toBe(
      '{"nested":{"a":true,"b":[1,null,{"c":3,"d":2}]},"nullish":null,"zebra":1}',
    );
  });
});

describe('diffJson', () => {
  it('escapes ~ and / in pointer segments per RFC 6901', () => {
    const differences = diffJson({ 'a/b': { 'c~d': 1 } }, { 'a/b': { 'c~d': 2 } });

    expect(differences.map((difference) => difference.path)).toEqual(['/a~1b/c~0d']);
  });

  it('reports a length difference as an absent element, not as a shape change', () => {
    const differences = diffJson({ list: [1, 2] }, { list: [1] });

    expect(differences).toHaveLength(1);
    expect(differences[0]?.path).toBe('/list/1');
  });
});

/** The same document with every object's keys in reverse order. */
function reverseKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  const source = value as { readonly [key: string]: JsonValue };
  const reversed: Record<string, JsonValue> = {};
  for (const key of Object.keys(source).reverse()) {
    reversed[key] = reverseKeys(source[key] as JsonValue);
  }
  return reversed;
}
