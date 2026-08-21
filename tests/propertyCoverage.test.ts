/**
 * The property coverage table: one row per v1-essential correctness property,
 * checked against the files that actually implement them.
 *
 * design.md ships three of its forty-five properties in v1 — numbers 25, 34, and
 * 42 — and tasks.md maps each to exactly one task: 25 to 8.2, 34 to 13.2, 42 to
 * 13.7. Three test files in three different directories is exactly the shape from
 * which one can quietly disappear: delete the file, or rename it, and the suite
 * still reports a full green run because nothing was ever asserting that it ran.
 * This file closes that hole. It scans `tests/` as text, finds each property's
 * marker comment, and fails if a property is claimed by zero files or by two.
 *
 * ## Why the table has three rows and not forty-five
 *
 * The other forty-two properties are Phase 2, nine of them carrying an explicit
 * **Phase 2** marker in design.md because they were promoted into the v1 set and
 * then deferred. They are not gaps in v1 and they are not listed here as missing:
 * design.md remains the record of what they specify, and adding them as absent
 * rows would turn a specification into a permanent failure. Only what v1 claims
 * is checked, and v1 claims three.
 *
 * ## Two shapes of "iterations", not one
 *
 * Numbers 25 and 42 are sampled properties driven by `fast-check`, and design.md
 * requires a minimum of 100 iterations each. That is checked by parsing the two
 * files and reading the `numRuns` option off every `fc.assert` call, so an edit
 * lowering one of them — or dropping the option, which would fall back to
 * `fast-check`'s own default rather than to a stated number — fails here.
 *
 * Number 34 has no iteration count, and that is correct rather than a gap. It
 * quantifies over the source files of `src/`, a finite enumerable set, so
 * `tests/guard/readonly.test.ts` walks every one of them deterministically; its
 * own header sets out why 100 samples would be strictly weaker than visiting all
 * of them. The `iterations` column therefore carries a discriminated union:
 * `sampled` with a minimum run count, or `exhaustive` with the domain walked. The
 * exhaustive row is asserted rather than skipped — `fast-check` must be absent
 * from that file, it must enumerate a non-empty `src/` tree, and no `fc.assert`
 * may appear in it, so the property cannot be silently downgraded to sampling.
 *
 * Note for a reader comparing this against design.md: its reviewer-path section
 * says the reviewer sees "the three v1-essential properties passing at 100
 * iterations each", which is not true of number 34 and was never meant to be.
 * The table below is the accurate statement of the three shapes. design.md is
 * left as it stands; the discrepancy is prose, not behavior.
 *
 * ## Non-vacuity
 *
 * A scanner that finds nothing reports a clean table, so the scan is asserted
 * before anything is concluded from it: the file count under `tests/`, the
 * presence of each row's file by name, and a positive-control run of both readers
 * over synthetic input — one marker with its description wrapped across two
 * lines, and one `fc.assert` carrying a deliberately low `numRuns` — so a marker
 * pattern or an option reader that had stopped matching anything fails loudly
 * here instead of certifying an empty tree. `tests/guard/readonly.test.ts` and
 * `tests/decode/programNames.test.ts` do the same for their own source walks.
 *
 * This file only ever reads. It never writes to the files it asserts about.
 *
 * **Validates: Requirements 9.1**
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * How a property's input domain is covered.
 *
 * `sampled` is a `fast-check` property with a stated minimum number of runs.
 * `exhaustive` is a deterministic walk over a finite enumerable domain, which
 * admits no run count because it visits the whole of it.
 */
type IterationRule =
  | { readonly kind: 'sampled'; readonly minimumRuns: number }
  | { readonly kind: 'exhaustive'; readonly domain: string };

interface CoverageRow {
  /** The property number as design.md numbers it. */
  readonly property: number;
  /** The property title, which the marker comment must repeat verbatim. */
  readonly title: string;
  /** The implementing file, relative to `tests/`. */
  readonly file: string;
  /** The tasks.md task that wrote it, per the Notes section's mapping. */
  readonly task: string;
  readonly iterations: IterationRule;
}

/** design.md's minimum for a sampled property. */
const MINIMUM_RUNS = 100;

/**
 * The three v1-essential properties, their implementing files, and the shape of
 * their coverage. Exactly the set design.md marks **v1-essential**.
 */
export const V1_PROPERTY_COVERAGE: readonly CoverageRow[] = [
  {
    property: 25,
    title: 'Lamport deltas are exact across the full u64 range',
    file: 'analyze/balances.property.test.ts',
    task: '8.2',
    iterations: { kind: 'sampled', minimumRuns: MINIMUM_RUNS },
  },
  {
    property: 34,
    title: 'No forbidden call site exists anywhere in the source',
    file: 'guard/readonly.test.ts',
    task: '13.2',
    // Not a sampled property: every `.ts` file under `src/` is visited, which is
    // strictly stronger than any number of samples over the same domain.
    iterations: { kind: 'exhaustive', domain: 'src/' },
  },
  {
    property: 42,
    title: 'The golden comparator is order-insensitive and value-exact',
    file: 'golden/comparator.property.test.ts',
    task: '13.7',
    iterations: { kind: 'sampled', minimumRuns: MINIMUM_RUNS },
  },
];

// ---------------------------------------------------------------------------
// Scanning `tests/`
// ---------------------------------------------------------------------------

const TESTS_ROOT = fileURLToPath(new URL('./', import.meta.url));
const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/** Every `.ts` file under a root, sorted, so the scan is order-independent. */
function typescriptFiles(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/** Path relative to `tests/`, with forward slashes, for readable assertions. */
function label(path: string): string {
  return relative(TESTS_ROOT, path).split('\\').join('/');
}

const TEST_SOURCES: ReadonlyMap<string, string> = new Map(
  typescriptFiles(TESTS_ROOT).map((path) => [label(path), readFileSync(path, 'utf8')]),
);

/**
 * Well below the current tree — 35 files — so ordinary additions do not trip it,
 * and far above zero, so a moved `tests/` or a bad walk cannot pass.
 */
const MIN_TEST_FILES = 20;

// ---------------------------------------------------------------------------
// The marker comment
// ---------------------------------------------------------------------------

/**
 * The marker each property test carries, up to but not including the number.
 *
 * Held as a constant and composed into the pattern at run time on purpose: were
 * the whole marker written out as a literal anywhere in this file, this file
 * would itself claim that property and the exactly-one assertions would report a
 * duplicate against their own scanner.
 */
const MARKER_PREFIX = '// Feature: solana-transaction-analyzer, Property ';

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The marker line: the prefix, the number, a colon, then the description head. */
const MARKER_PATTERN = new RegExp(`^\\s*${escapeForRegExp(MARKER_PREFIX)}(\\d+):\\s*(.*)$`);

/** Any `//` comment line, for the description's continuation. */
const COMMENT_PATTERN = /^\s*\/\/\s?(.*)$/;

interface Marker {
  readonly file: string;
  /** 1-based, so a failure message points at a line an editor can jump to. */
  readonly line: number;
  readonly property: number;
  /** The description, rejoined across however many lines it wrapped over. */
  readonly description: string;
}

/**
 * Every marker in one file.
 *
 * The 80-column limit means a description almost always wraps, so the number is
 * read off the marker line and the description is gathered from it plus the
 * following comment lines. Gathering stops at the first line that is not a
 * comment, at a comment with no text — the blank `//` that separates the marker
 * from its `**Validates:**` line — and at a `**` line, in case that separator is
 * ever dropped.
 */
function markersIn(file: string, source: string): readonly Marker[] {
  const lines = source.split('\n');
  const found: Marker[] = [];

  for (const [index, line] of lines.entries()) {
    const match = MARKER_PATTERN.exec(line);
    if (match === null) continue;

    const digits = match[1];
    const head = match[2];
    if (digits === undefined || head === undefined) continue;

    const parts: string[] = [];
    if (head.trim().length > 0) parts.push(head.trim());

    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = COMMENT_PATTERN.exec(lines[next] ?? '');
      if (continuation === null) break;
      const text = (continuation[1] ?? '').trim();
      if (text.length === 0 || text.startsWith('**')) break;
      parts.push(text);
    }

    found.push({
      file,
      line: index + 1,
      property: Number(digits),
      description: parts.join(' '),
    });
  }

  return found;
}

const ALL_MARKERS: readonly Marker[] = [...TEST_SOURCES].flatMap(([file, source]) =>
  markersIn(file, source),
);

// ---------------------------------------------------------------------------
// The run count
// ---------------------------------------------------------------------------

interface AssertCall {
  readonly file: string;
  /** 1-based line of the `fc.assert` call. */
  readonly line: number;
  /**
   * The `numRuns` literal, or null when the call carries no options object, no
   * `numRuns` key, or a value that is not a numeric literal. Null fails: a run
   * count that cannot be read from the source is a run count a later edit can
   * lower without this file noticing.
   */
  readonly numRuns: number | null;
}

/** The local binding `fast-check` was imported under, default or namespace. */
function fastCheckBinding(file: ts.SourceFile): string | null {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(specifier) || specifier.text !== 'fast-check') continue;

    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) return clause.name.text;

    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) return bindings.name.text;
  }
  return null;
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/**
 * Every `fc.assert(...)` call in one file, with the run count it states.
 *
 * A syntactic parse is enough here — no `ts.Program`, no type checker — because
 * the question is which call expressions are written as `<fast-check>.assert` and
 * what literal sits under their `numRuns` key. Parsing rather than searching for
 * text matters for the same reason it matters in `tests/guard/readonly.test.ts`:
 * `numRuns` appears in this file's own comments, and a text search cannot tell a
 * comment from a call.
 */
function assertCallsIn(file: string, source: string): readonly AssertCall[] {
  const parsed = parse(file, source);
  const binding = fastCheckBinding(parsed);
  if (binding === null) return [];

  const calls: AssertCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'assert' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === binding
      ) {
        calls.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          numRuns: numRunsOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return calls;
}

function numRunsOf(call: ts.CallExpression): number | null {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return null;

  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (key !== 'numRuns') continue;
    return ts.isNumericLiteral(property.initializer) ? Number(property.initializer.text) : null;
  }

  return null;
}

function sourceOf(file: string): string {
  const source = TEST_SOURCES.get(file);
  if (source === undefined) throw new Error(`no such test file: ${file}`);
  return source;
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe('the v1 property coverage table', () => {
  it('lists exactly the three properties design.md marks v1-essential', () => {
    // Three rows, not forty-five. The nine properties design.md carries a Phase 2
    // marker on, and the thirty-three that were never in the v1 set, are absent
    // by design rather than missing: design.md specifies them, Phase 2 implements
    // them, and listing them here as gaps would make this test permanently red.
    expect(V1_PROPERTY_COVERAGE.map((row) => row.property)).toEqual([25, 34, 42]);

    // The tasks.md Notes mapping, so a row cannot lose its provenance.
    expect(V1_PROPERTY_COVERAGE.map((row) => row.task)).toEqual(['8.2', '13.2', '13.7']);

    // One file per property and one property per file.
    const files = V1_PROPERTY_COVERAGE.map((row) => row.file);
    expect(new Set(files).size).toBe(files.length);
    for (const row of V1_PROPERTY_COVERAGE) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.file.endsWith('.test.ts')).toBe(true);
    }

    // Both shapes are represented, which is the point of the union: a table that
    // only knew how to say "100 iterations" could not describe number 34 at all.
    expect(V1_PROPERTY_COVERAGE.filter((row) => row.iterations.kind === 'sampled')).toHaveLength(2);
    expect(V1_PROPERTY_COVERAGE.filter((row) => row.iterations.kind === 'exhaustive')).toHaveLength(
      1,
    );
  });

  it('found the tests/ tree it is asserting about', () => {
    // Without this, a moved `tests/`, a renamed directory, or a walk that threw
    // its results away would report a clean table over an empty set.
    expect(TEST_SOURCES.size).toBeGreaterThanOrEqual(MIN_TEST_FILES);

    for (const row of V1_PROPERTY_COVERAGE) {
      expect([...TEST_SOURCES.keys()]).toContain(row.file);
      expect(sourceOf(row.file).length).toBeGreaterThan(0);
    }

    // At least the three markers were seen. The per-property assertions below
    // pin the count exactly; this one fails first, and more legibly, if the
    // pattern stopped matching anything at all.
    expect(ALL_MARKERS.length).toBeGreaterThanOrEqual(V1_PROPERTY_COVERAGE.length);
  });

  it('has a marker reader and a run-count reader that both bite', () => {
    // Positive controls. Every assertion in this file is of the form "the scan
    // found exactly what the table says", which a reader returning nothing could
    // never satisfy — but a reader that silently stopped seeing *wrapped*
    // descriptions, or *some* options objects, would still pass while checking
    // less than it claims. These two probes are the check on the checkers.
    const probe = [
      '// ---------------------------------------------------------------',
      `${MARKER_PREFIX}99: A synthetic property whose description`,
      '// wraps across two lines',
      '//',
      '// **Validates: Requirements 0.0**',
    ].join('\n');

    expect(markersIn('probe.ts', probe)).toEqual([
      {
        file: 'probe.ts',
        line: 2,
        property: 99,
        description: 'A synthetic property whose description wraps across two lines',
      },
    ]);

    // A marker-shaped sentence that is not a marker: prose naming a property, and
    // the same words inside a string. Neither is a claim on a property.
    const decoys = [
      '// Property 99: prose about a property, without the marker prefix',
      "const claim = 'Property 99: the same words in a string';",
    ].join('\n');
    expect(markersIn('decoy.ts', decoys)).toEqual([]);

    // The option reader, on a call whose count is below the minimum, so the probe
    // proves it reads the number rather than merely finding the key.
    const withOptions = [
      "import fc from 'fast-check';",
      'fc.assert(fc.property(fc.nat(), () => true), { numRuns: 7 });',
      'fc.assert(fc.property(fc.nat(), () => true));',
      'notFc.assert(somethingElse, { numRuns: 1 });',
    ].join('\n');

    expect(assertCallsIn('probe.ts', withOptions)).toEqual([
      { file: 'probe.ts', line: 2, numRuns: 7 },
      { file: 'probe.ts', line: 3, numRuns: null },
    ]);

    // No `fast-check` import means no sampled property, whatever the text says.
    expect(assertCallsIn('probe.ts', 'fc.assert(x, { numRuns: 100 });')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One file per property
// ---------------------------------------------------------------------------

describe('each v1-essential property is implemented exactly once', () => {
  for (const row of V1_PROPERTY_COVERAGE) {
    it(`Property ${row.property} is claimed by ${row.file} and by nothing else`, () => {
      const claims = ALL_MARKERS.filter((marker) => marker.property === row.property);

      // Zero claims means the property was dropped; two means two files disagree
      // about who implements it and neither can be trusted as the one that must
      // pass. Both are failures, and the message names the files either way.
      expect(claims.map((claim) => `${claim.file}:${claim.line}`)).toHaveLength(1);
      expect(claims.map((claim) => claim.file)).toEqual([row.file]);

      // The marker names the property design.md names, rejoined across the wrap
      // the 80-column limit forces, so a file cannot carry the right number over
      // the wrong property.
      expect(claims[0]?.description).toBe(row.title);
    });
  }

  it('claims exactly three of the v1-essential property numbers, no more', () => {
    // The other direction of the same count, stated over the set rather than per
    // row: three markers in the whole tree belong to the v1 set. Markers for
    // other property numbers are deliberately unconstrained — Phase 2 adds them,
    // and this test must not have to change when it does.
    const v1 = new Set(V1_PROPERTY_COVERAGE.map((row) => row.property));
    const claimed = ALL_MARKERS.filter((marker) => v1.has(marker.property));

    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((marker) => marker.file)).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The iteration count, and the one property that has none
// ---------------------------------------------------------------------------

describe('each v1-essential property covers its domain as the table states', () => {
  for (const row of V1_PROPERTY_COVERAGE) {
    if (row.iterations.kind !== 'sampled') continue;
    const minimum = row.iterations.minimumRuns;

    it(`Property ${row.property}: every fc.assert in ${row.file} runs at least ${minimum} times`, () => {
      const calls = assertCallsIn(row.file, sourceOf(row.file));

      // A sampled property with no `fc.assert` is not a sampled property.
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        // Named in the failure message with its line, so an edit that lowers one
        // of several calls points at the one that changed. `null` fails too: an
        // absent option means `fast-check`'s default rather than a stated number,
        // and a computed one cannot be checked by reading the source.
        expect(call.numRuns, `${row.file}:${call.line} states no readable numRuns`).not.toBeNull();
        expect(
          call.numRuns ?? 0,
          `${row.file}:${call.line} runs fewer than ${minimum} iterations`,
        ).toBeGreaterThanOrEqual(minimum);
      }
    });
  }

  for (const row of V1_PROPERTY_COVERAGE) {
    if (row.iterations.kind !== 'exhaustive') continue;
    const domain = row.iterations.domain;

    it(`Property ${row.property}: ${row.file} walks all of ${domain} instead of sampling it`, () => {
      // This row is asserted, not skipped. The property quantifies over a finite
      // enumerable domain, so visiting all of it is strictly stronger than any
      // number of samples — which means the check is not "does it run 100 times"
      // but "is it still exhaustive".
      const source = sourceOf(row.file);
      const parsed = parse(row.file, source);

      // `fast-check` is deliberately absent, and no `fc.assert` exists to lower a
      // run count on. If either appears, the guard has been turned into a sampler
      // and this row's shape is wrong.
      expect(fastCheckBinding(parsed)).toBeNull();
      expect(assertCallsIn(row.file, source)).toEqual([]);

      // It enumerates the domain rather than naming a handful of files: a
      // directory read, and the domain itself in the path it reads.
      expect(source).toContain('readdirSync');
      expect(source).toContain(domain);

      // And the domain is not empty, so "every file under it" is not a claim
      // about nothing. A moved or emptied `src/` fails here.
      expect(typescriptFiles(SRC_ROOT).length).toBeGreaterThan(10);
    });
  }
});
