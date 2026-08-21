/**
 * The golden harness. Requirements 14.1–14.11.
 *
 * One fixture directory in, one `GoldenResult` out. Nothing here throws for a
 * broken fixture and nothing here prints: every outcome — pass, pending, fail —
 * is a value, and the vitest entry (`./golden.test.ts`) is what turns those
 * values into assertions and into the pending banner. That split is what lets
 * the harness's own failure paths be tested (`./harness.test.ts`) over temp
 * directories without a broken fixture aborting the run.
 *
 * ## What is substituted and what is not
 *
 * **No internal module is mocked.** The single substitution is at the outermost
 * seam: `FixtureSource` stands in for `RpcSource`, both implementing
 * `TransactionSource`. `decode`, `resolve`, `analyze`, and `assemble` run
 * exactly as they do in production, reached through `analyzeTransaction` — the
 * same entry point the CLI will call (task 11.5), so a golden pass is a
 * statement about the shipped pipeline and not about a parallel composition
 * assembled for testing.
 *
 * Reading `input.json` through the real `FixtureSource` rather than through a
 * local `readFile` is deliberate: strict UTF-8 decoding, JSON parsing, and the
 * `asTransactionResponse` guard are production behaviour, and Requirement 14.3's
 * "missing or invalid `input.json`" is then reported by the same code that
 * reports a corrupt fixture to a user. The signature handed to it is the literal
 * `input`, because `FixtureSource` composes `<dir>/<signature>.json` and the
 * fixture layout names the file `input.json`. `input` is a well-formed base58
 * string, so nothing about that path is a special case inside `FixtureSource`.
 *
 * `meta.json` is never read here. It is documentation for the next maintainer,
 * and a harness that read it could let a hand-written note influence a
 * comparison.
 *
 * ## Zero network calls
 *
 * There is no code path from here to a socket: `FixtureSource` reads a file and
 * `analyzeTransaction` performs no I/O of any kind. The task 1.3 interceptor is
 * active during this suite and would fail it loudly if that ever stopped being
 * true (Req 14.9).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Base58Signature } from '../../src/model/analysis.js';
import { analyzeTransaction } from '../../src/pipeline.js';
import { canonicalJson, type JsonValue } from '../../src/render/json.js';
import { FixtureSource } from '../../src/source/fixture.js';
import type { TransactionSource } from '../../src/source/index.js';

/** The verbatim recorded `getTransaction` result. */
export const INPUT_FILE = 'input.json';

/** The canonical serialization of the expected `Analysis`. */
export const EXPECTED_FILE = 'expected.json';

/**
 * The Requirement 14.10 budget for the whole golden suite, in milliseconds.
 *
 * It holds with room to spare because there is nothing slow in the suite to
 * begin with: each fixture is one JSON parse, a few thousand pure function
 * calls, and one string comparison. No network, no process spawn, no compile
 * step, and no sleep anywhere. If this ever trips, something structural has
 * changed — an accidental I/O path, a quadratic walk — and that is worth failing
 * over rather than raising.
 */
export const GOLDEN_TIME_BUDGET_MS = 10_000;

/**
 * The fixture directories whose `expected.json` is mandatory.
 *
 * Transcribed from what is on disk, deliberately: **there is no `05`**, and `06`
 * and `07` are real. An earlier revision of this list named `03-spl-token-error`,
 * `04-anchor-framework-error`, and `05-v0-lookup-tables` — none of which exist —
 * and omitted `07-unknown-program`, which does. That is the worst shape this
 * check can take: a list of names matching nothing enforces nothing while reading
 * as though it covers six cases. `./golden.test.ts` asserts every name here was
 * discovered and compared, so the list cannot drift away from the directory tree
 * again without a red test.
 *
 * **Why a list at all, when in v1 it is exactly the recorded set.** The list is
 * what turns a *missing* `expected.json` into a failure instead of a `pending`
 * report. `pending` stays for the opposite case: a directory recorded later and
 * not yet hand-reviewed, which is how the partial-decode fixture will arrive.
 * Reporting an unreviewed fixture as a pass is the dishonesty `pending` exists to
 * prevent, and deleting the list would mean a hand-reviewed file could vanish and
 * the suite would still be green.
 *
 * Deleting this list — so discovery alone requires an `expected.json` and
 * `pending` goes with it — is Phase 2. In v1 that flip is indistinguishable from
 * this one, because the pinned set *is* the recorded set; it becomes a real change
 * the moment a seventh case is recorded.
 */
export const PINNED_FIXTURES: readonly string[] = [
  '01-success-cpi-heavy',
  '02-anchor-user-error',
  '03-program-table-error',
  '04-unattested-band-collision',
  '06-nested-cpi-failure',
  '07-unknown-program',
];

const PINNED = new Set(PINNED_FIXTURES);

/**
 * Whether a fixture directory name is pinned.
 *
 * Keyed on the name alone, not on the name plus the root. That is what lets
 * `./harness.test.ts` exercise the pinned branch over a temp directory carrying
 * a pinned name, and it costs nothing in production, where there is one golden
 * root. Exact match: `01-success-cpi-heavy-copy` is not pinned.
 */
export function isPinned(name: string): boolean {
  return PINNED.has(name);
}

/**
 * The stem `FixtureSource` turns into `input.json`.
 *
 * Typed as a `Base58Signature` because that is what `fetch` takes, and honestly
 * so: every character is in the base58 alphabet.
 */
const INPUT_STEM: Base58Signature = 'input';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * What running one fixture directory established.
 *
 * Three outcomes, not two, and `pending` is neither of the other two. A skipped
 * directory would be indistinguishable from an absent one, so a forgotten or
 * misnamed `expected.json` would look exactly like a case that was never
 * recorded. Counting `pending` separately is what makes that omission visible in
 * every run.
 *
 * `pending` is reachable only for a directory outside `PINNED_FIXTURES`. For a
 * pinned one the same file state is a `fail`, because a hand-reviewed
 * `expected.json` disappearing is a regression and not an unfinished case.
 */
export type GoldenResult =
  | { readonly name: string; readonly dir: string; readonly outcome: 'pass' }
  | {
      readonly name: string;
      readonly dir: string;
      readonly outcome: 'pending';
      /** The file whose absence made this pending, so the reader can go write it. */
      readonly expectedPath: string;
    }
  | {
      readonly name: string;
      readonly dir: string;
      readonly outcome: 'fail';
      /** Ready to print: names the fixture, the path, and what went wrong. */
      readonly report: string;
    };

export interface GoldenRun {
  readonly root: string;
  readonly results: readonly GoldenResult[];
  readonly passed: number;
  readonly pending: number;
  readonly failed: number;
  /**
   * Wall-clock milliseconds for the whole run, measured around the fixture loop
   * so it covers discovery, every file read, every pipeline run, and every
   * comparison — what Requirement 14.10 budgets. Monotonic (`performance.now`),
   * so a clock adjustment mid-run cannot produce a negative or a wild figure.
   */
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every subdirectory of `root`, sorted by name.
 *
 * Sorted by code point rather than by `localeCompare`, because collation is
 * locale-dependent and Requirement 9.7 asks for behaviour that does not shift
 * with `LANG`. For the fixture names in use the two agree; the difference is
 * that this one cannot stop agreeing.
 *
 * **Discovery keys on being a directory, not on holding an `input.json`.**
 * design.md phrases discovery as "every subdirectory that contains an
 * `input.json`", but that phrasing and Requirement 14.3 cannot both hold
 * literally: a directory filtered out at discovery can never fail for a missing
 * `input.json`, and 14.3 says it must. So the filter is the weaker one and the
 * missing file is a failure, which is the reading that leaves 14.3 reachable.
 * The consequence is that a non-fixture subdirectory placed under
 * `tests/golden/` fails the suite instead of being ignored. That is the intended
 * pressure: this directory holds fixtures, and support code lives in files
 * (`harness.ts`) or elsewhere (`tests/source/support/`).
 */
export async function discoverFixtures(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byCodePoint);
}

function byCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  /* c8 ignore next */
  return 0;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Run every discovered fixture, in discovery order, and tally the outcomes. */
export async function runGolden(root: string): Promise<GoldenRun> {
  const startedAt = performance.now();
  const results: GoldenResult[] = [];
  for (const name of await discoverFixtures(root)) {
    results.push(await runFixture(root, name));
  }
  return {
    root,
    results,
    passed: results.filter((result) => result.outcome === 'pass').length,
    pending: results.filter((result) => result.outcome === 'pending').length,
    failed: results.filter((result) => result.outcome === 'fail').length,
    elapsedMs: performance.now() - startedAt,
  };
}

/**
 * Run one fixture directory.
 *
 * The order of the four steps is the order in which they can fail: a missing or
 * invalid `input.json` (Req 14.2, 14.3), then a missing `expected.json` — a
 * failure for a pinned fixture, `pending` otherwise — or an unparseable one
 * (Req 14.4, 14.5), then the pipeline (Req 14.6), then the comparison
 * (Req 14.7, 14.8).
 */
export async function runFixture(root: string, name: string): Promise<GoldenResult> {
  const dir = join(root, name);
  const inputPath = join(dir, INPUT_FILE);
  const expectedPath = join(dir, EXPECTED_FILE);

  const fail = (report: string): GoldenResult => ({ name, dir, outcome: 'fail', report });

  // input.json, through the production loader ---------------------------
  const source: TransactionSource = new FixtureSource(dir);
  const fetched = await source.fetch(INPUT_STEM);
  if (!fetched.ok) {
    const error = fetched.error;
    if (error.kind === 'not-found') {
      return fail(`${name}: ${INPUT_FILE} is missing at ${inputPath}`);
    }
    /* c8 ignore next 3 -- FixtureSource returns only these two kinds. */
    if (error.kind !== 'fixture-unreadable') {
      return fail(`${name}: ${INPUT_FILE} could not be loaded (${error.kind})`);
    }
    return fail(`${name}: ${INPUT_FILE} could not be loaded at ${error.path}: ${error.detail}`);
  }

  // expected.json -------------------------------------------------------
  const expected = await readExpected(expectedPath);
  switch (expected.kind) {
    case 'absent':
      // A pinned fixture's ground truth is hand-reviewed and committed, so its
      // absence is a regression rather than an unfinished case (Req 14.5, 14.11).
      if (isPinned(name)) {
        return fail(
          `${name}: ${EXPECTED_FILE} is missing at ${expectedPath}, and ${name} is pinned — ` +
            'a pinned fixture must carry a hand-reviewed expected.json',
        );
      }
      return { name, dir, outcome: 'pending', expectedPath };
    case 'unreadable':
      return fail(`${name}: ${EXPECTED_FILE} could not be read at ${expectedPath}: ${expected.detail}`);
    case 'loaded':
      break;
  }

  // the real pipeline ---------------------------------------------------
  let actual: JsonValue;
  try {
    actual = canonicalJson(analyzeTransaction({ response: fetched.response }));
  } catch (cause) {
    // A pipeline throw is this fixture's failure rather than the suite's crash,
    // so the remaining fixtures still report (Req 14.11). `canonicalJson` throws
    // a `JsonSerializationError` — an `Error` subclass whose message already
    // names the failure and the JSON pointer — so `messageOf` reports it as this
    // fixture's failure with no special case, the same as any pipeline throw.
    return fail(`${name}: the pipeline threw on ${inputPath}: ${messageOf(cause)}`);
  }

  // comparison ----------------------------------------------------------
  const differences = diffJson(actual, expected.document);
  if (differences.length > 0) {
    return fail(formatDifferences(name, expectedPath, differences));
  }
  return { name, dir, outcome: 'pass' };
}

type ExpectedRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly document: JsonValue }
  | { readonly kind: 'unreadable'; readonly detail: string };

/**
 * Strict UTF-8, matching `FixtureSource`. The lenient decoder substitutes U+FFFD
 * for invalid bytes, which can leave a corrupt file parsing as well-formed JSON
 * with silently mangled strings — in a golden file that is a mangled
 * expectation, which is worse than a read error.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * errno codes meaning "no such file", as opposed to "there is one and it cannot
 * be read". Absence is `pending`; everything else is a failure.
 */
const ABSENCE_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

async function readExpected(path: string): Promise<ExpectedRead> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    const code = errnoOf(cause);
    if (code !== null && ABSENCE_CODES.includes(code)) return { kind: 'absent' };
    return { kind: 'unreadable', detail: messageOf(cause) };
  }

  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (cause) {
    return { kind: 'unreadable', detail: `the file is not valid UTF-8: ${messageOf(cause)}` };
  }

  try {
    return { kind: 'loaded', document: JSON.parse(text) as JsonValue };
  } catch (cause) {
    return { kind: 'unreadable', detail: `the file is not valid JSON: ${messageOf(cause)}` };
  }
}

function errnoOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * `JsonValue` is `src/render/json.ts`'s type, re-exported rather than redeclared.
 *
 * Re-exported because `./harness.test.ts` imports it from here and there is no
 * reason to make that import move; one definition, two spellings of where to get
 * it. A structurally identical local alias would have compiled just as well and
 * would have been a second definition of the same thing.
 */
export type { JsonValue };

/**
 * **The stand-in is gone.** Until task 11.1 landed, this section held a local
 * `canonicalize`: sorted keys at every level, `undefined` omitted, `null`
 * preserved. Its comment said the shipped serializer would own that behaviour and
 * that the migration would be a deletion, and that is what happened — the harness
 * now calls `canonicalJson` from `src/render/json.ts`, so the shape a fixture pins
 * and the shape `opsis --json` prints cannot drift apart. `tests/render/json.test.ts`
 * checked the two agreed on a synthetic `Analysis` and on all six recorded
 * fixtures before the deletion, so this is a substitution of equals on every value
 * the harness feeds it.
 *
 * The claim is recorded rather than erased because "why does the harness import a
 * serializer from `src/`?" is a question worth an answer, and the answer is that
 * it used to have its own and having two definitions of "canonical" was the
 * hazard.
 *
 * Two differences from the deleted stand-in, neither of which the harness has to
 * handle specially:
 *
 * - `canonicalJson` throws a typed `JsonSerializationError` where the stand-in
 *   threw a bare `TypeError`. Both are `Error`s, so `runFixture`'s `catch` and
 *   `messageOf` report either as that fixture's failure.
 * - Its guard is strictly wider: non-finite numbers, non-plain objects (a `Date`,
 *   a `Map`, a class instance), and reference cycles are named with a JSON pointer
 *   instead of silently becoming `null`, `{}`, or a stack overflow. Wider is the
 *   direction a golden harness wants — every one of those would otherwise be
 *   compared as a fabricated value.
 *
 * Key order still does not affect the comparison below, which walks keys by name.
 * Canonicalizing anyway is what keeps `expected.json` files authored against the
 * renderer comparable without adjustment.
 *
 * @deprecated Prefer `canonicalJson` from `src/render/json.js` directly. This
 * alias exists because `./harness.test.ts` imports the old name; it is one
 * binding, not a second implementation.
 */
export { canonicalJson as canonicalize };

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** A key or index present on one side and not the other. */
const ABSENT = Symbol('absent');

type Side = JsonValue | typeof ABSENT;

export interface Difference {
  /** RFC 6901 JSON pointer. `""` is the document root. */
  readonly path: string;
  readonly expected: Side;
  readonly actual: Side;
}

/**
 * Every leaf at which `actual` and `expected` differ, as JSON pointers.
 *
 * Deep equality with key order ignored and every leaf exact (Req 14.7): keys are
 * matched by name, so a permuted `expected.json` compares equal, and `null`
 * against an absent key is a difference rather than a match — the two are
 * distinct in JSON and `Analysis` uses both, so collapsing them would let a
 * dropped field pass as a null one.
 *
 * Recursion is bounded by the document, which is finite and acyclic: `actual`
 * comes from `canonicalJson`, which rejects a cycle rather than returning one,
 * and `expected` from `JSON.parse`.
 */
export function diffJson(actual: JsonValue, expected: JsonValue): readonly Difference[] {
  const differences: Difference[] = [];
  walk(actual, expected, '', differences);
  return differences;
}

type Kind = 'null' | 'array' | 'object' | 'primitive';

function kindOf(value: JsonValue): Kind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'primitive';
}

function walk(actual: Side, expected: Side, path: string, out: Difference[]): void {
  if (actual === ABSENT || expected === ABSENT) {
    if (actual !== expected) out.push({ path, expected, actual });
    return;
  }

  const actualKind = kindOf(actual);
  if (actualKind !== kindOf(expected)) {
    out.push({ path, expected, actual });
    return;
  }

  switch (actualKind) {
    case 'null':
      return;

    case 'object': {
      const left = actual as { readonly [key: string]: JsonValue };
      const right = expected as { readonly [key: string]: JsonValue };
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(byCodePoint);
      for (const key of keys) {
        walk(at(left, key), at(right, key), `${path}/${escapePointer(key)}`, out);
      }
      return;
    }

    case 'array': {
      const left = actual as readonly JsonValue[];
      const right = expected as readonly JsonValue[];
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        walk(atIndex(left, index), atIndex(right, index), `${path}/${index}`, out);
      }
      return;
    }

    case 'primitive':
      if (actual !== expected) out.push({ path, expected, actual });
      return;
  }
}

function at(record: { readonly [key: string]: JsonValue }, key: string): Side {
  return key in record ? (record[key] as JsonValue) : ABSENT;
}

function atIndex(array: readonly JsonValue[], index: number): Side {
  if (index >= array.length) return ABSENT;
  return array[index] as JsonValue;
}

/** RFC 6901: `~` is `~0` and `/` is `~1`, in that order. */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** How many differences a report spells out before summarizing the rest. */
const MAX_REPORTED = 20;

/** How much of one value a report prints. Long arrays are the reason for a cap. */
const MAX_VALUE_CHARS = 300;

function show(value: Side): string {
  if (value === ABSENT) return '<absent>';
  const text = JSON.stringify(value);
  if (text.length <= MAX_VALUE_CHARS) return text;
  return `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length} chars)`;
}

/**
 * The fixture name, the differing JSON pointer paths, and both values
 * (Req 14.8).
 */
export function formatDifferences(
  name: string,
  expectedPath: string,
  differences: readonly Difference[],
): string {
  const lines = [
    `${name}: the analysis differs from ${expectedPath} at ${differences.length} path(s)`,
  ];
  for (const difference of differences.slice(0, MAX_REPORTED)) {
    lines.push(`  ${difference.path === '' ? '<root>' : difference.path}`);
    lines.push(`    expected: ${show(difference.expected)}`);
    lines.push(`    actual:   ${show(difference.actual)}`);
  }
  if (differences.length > MAX_REPORTED) {
    lines.push(`  … and ${differences.length - MAX_REPORTED} more path(s)`);
  }
  return lines.join('\n');
}

/**
 * The one-line tally, printed on every run.
 *
 * Printed unconditionally, including on the all-green run. `6 discovered: 6
 * compared, 0 pending, 0 failed` is the sentence that distinguishes six real
 * comparisons from six directories nobody looked at, and a suite that only speaks
 * up when something is wrong cannot make that distinction.
 */
export function summaryLine(run: GoldenRun): string {
  return `${run.results.length} discovered: ${run.passed} compared, ${run.pending} pending, ${run.failed} failed`;
}

/**
 * The pending banner, printed on every run that has one.
 *
 * Loud on purpose. A pending fixture is a recorded case whose ground truth has
 * not been pinned, and the whole reason `pending` exists as an outcome is that
 * silence here would be indistinguishable from a passing suite.
 *
 * In v1 no run reaches this: the six recorded directories are the six pinned
 * ones, so a missing `expected.json` fails instead. It stays because the next
 * recorded case — the partial-decode fixture — arrives unreviewed, and this is
 * what the harness owes the reader between recording it and pinning it.
 */
export function pendingReport(run: GoldenRun): string {
  const pending = run.results.filter((result) => result.outcome === 'pending');
  const rule = '='.repeat(72);
  const lines = [
    rule,
    `GOLDEN FIXTURES: ${pending.length} PENDING — recorded but not pinned`,
    rule,
    `A pending fixture has ${INPUT_FILE} and no ${EXPECTED_FILE}, so nothing was`,
    'compared. Pending is not a pass and not a skip. Hand-review the analysis,',
    `write ${EXPECTED_FILE}, then add the directory to PINNED_FIXTURES so its`,
    'absence can never again read as anything but a failure.',
    '',
  ];
  for (const result of pending) {
    lines.push(`  pending  ${result.name}/${EXPECTED_FILE}  (not written yet)`);
  }
  lines.push('', summaryLine(run), rule);
  return lines.join('\n');
}
