/**
 * Property-based tests for the golden comparator, `diffJson`.
 *
 * This is one of the three v1-essential properties, and it is the one that holds
 * the other tests up. Every golden fixture's verdict is `diffJson`'s verdict: a
 * comparator that quietly ignored one leaf would turn all six recorded cases into
 * decoration, and it would do so while the suite stayed green — the failure mode
 * that no amount of additional fixtures can detect, because they all route through
 * the same function. So the comparator is checked against a generator rather than
 * against a handful of documents.
 *
 * ## The two halves, and why each needs a generator
 *
 * **Order-insensitive.** Requirement 14.7 asks for deep equality with field order
 * ignored. A single hand-written permutation checks one key order at one level; the
 * generator permutes every object at every level of an arbitrary document, so
 * "ignored" is quantified rather than sampled. The assertion is the empty
 * difference list, not a boolean — a comparator that returned a difference with a
 * wrong pointer would satisfy `length === 0 ? false : true` reasoning just as well
 * as a correct one, and the list is the thing the report is built from.
 *
 * **Value-exact.** The same requirement asks that all field values match exactly.
 * The mechanical form is: mutate exactly one leaf, and the reported pointer set
 * must contain that leaf's pointer. "Contain", not "equal" — a mutation that
 * changes a leaf's *kind* legitimately produces one difference at that pointer and
 * a mutation that removes a key from an object can also renumber nothing else, but
 * pinning the set to exactly one element would make the property about the
 * comparator's reporting granularity rather than about its exactness. What matters
 * is that the changed leaf is never missing from the report.
 *
 * The three mutations the task names — a changed `confidence` marker, one changed
 * digit in a decimal string, `null` becoming an absent key — are reachable from the
 * generator (it emits confidence markers, decimal-integer strings, and `null`
 * leaves, and the mutation set includes key removal) *and* pinned as targeted
 * examples below, so a seed that happened to miss them cannot leave them unchecked.
 *
 * ## Documents shaped like `Analysis`
 *
 * The generator emits what `Analysis` actually contains: nested objects, arrays of
 * objects, `null`, booleans, safe integers, and decimal-integer strings — the last
 * because every lamport and token amount in the model is a decimal string, and one
 * wrong digit in one of those is precisely the difference a reviewer would never
 * spot by eye. Keys are drawn mostly from real `Analysis` field names, with a few
 * containing `~` and `/` so RFC 6901 escaping is exercised on both sides.
 *
 * A complementary property runs over the real thing: the six recorded fixtures put
 * through `analyzeTransaction` and `canonicalJson`, which is the exact input the
 * comparator sees in production. The synthetic generator explores shapes the
 * fixtures do not have; the fixtures cover the one shape that has to work.
 *
 * Nothing is mocked. `diffJson` and `formatDifferences` are the shipped harness
 * functions, and the real documents come through the real pipeline.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { analyzeTransaction } from '../../src/pipeline.js';
import { canonicalJson } from '../../src/render/json.js';
import { asTransactionResponse } from '../../src/source/index.js';
import { goldenCases } from '../source/support/golden.js';
import { diffJson, formatDifferences, type Difference, type JsonValue } from './harness.js';

// ---------------------------------------------------------------------------
// Pointers and paths
// ---------------------------------------------------------------------------

/**
 * A location inside a document, kept as steps rather than as a pointer string.
 *
 * The steps are what a mutation needs — an object key must be usable as a key —
 * and the pointer is what the comparator reports. Deriving the pointer from the
 * steps rather than parsing it back keeps the escaping one-directional: a test
 * that had to unescape `~1` would share a bug with the code that escaped it.
 */
interface Leaf {
  readonly steps: readonly (string | number)[];
  readonly pointer: string;
  readonly value: JsonValue;
  /** True when the last step is an object key, so the key can be removed. */
  readonly inObject: boolean;
}

/**
 * RFC 6901: `~` is `~0` and `/` is `~1`, in that order.
 *
 * Deliberately a second copy of the harness's private `escapePointer`. Importing
 * it would make the pointer expectations agree with the implementation by
 * construction, which is the one thing this test must not do.
 */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointersOf(differences: readonly Difference[]): readonly string[] {
  return differences.map((difference) => difference.path);
}

/**
 * Every leaf of the document: primitives, `null`, and empty containers, which have
 * no leaves of their own but are still a single comparable value.
 */
function leavesOf(value: JsonValue, steps: readonly (string | number)[] = [], pointer = '', inObject = false): readonly Leaf[] {
  const here: Leaf = { steps, pointer, value, inObject };

  if (value === null || typeof value !== 'object') return [here];

  if (Array.isArray(value)) {
    if (value.length === 0) return [here];
    return value.flatMap((element, index) =>
      leavesOf(element, [...steps, index], `${pointer}/${index}`, false),
    );
  }

  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record);
  if (keys.length === 0) return [here];
  return keys.flatMap((key) =>
    leavesOf(record[key] as JsonValue, [...steps, key], `${pointer}/${escapePointer(key)}`, true),
  );
}

/** The document with the value at `steps` replaced. Structural, never in place. */
function setAt(node: JsonValue, steps: readonly (string | number)[], value: JsonValue): JsonValue {
  const head = steps[0];
  if (head === undefined) return value;
  const rest = steps.slice(1);

  if (typeof head === 'number') {
    const array = node as readonly JsonValue[];
    return array.map((element, index) => (index === head ? setAt(element, rest, value) : element));
  }

  const record = node as { readonly [key: string]: JsonValue };
  return { ...record, [head]: setAt(record[head] as JsonValue, rest, value) };
}

/** The document with the object key at `steps` removed. The last step must be a key. */
function deleteAt(node: JsonValue, steps: readonly (string | number)[]): JsonValue {
  const head = steps[0];
  if (head === undefined) throw new Error('deleteAt needs at least one step');
  const rest = steps.slice(1);

  if (typeof head === 'number') {
    const array = node as readonly JsonValue[];
    return array.map((element, index) => (index === head ? deleteAt(element, rest) : element));
  }

  const record = node as { readonly [key: string]: JsonValue };
  if (rest.length === 0) {
    const remaining: Record<string, JsonValue> = {};
    for (const key of Object.keys(record)) {
      if (key !== head) remaining[key] = record[key] as JsonValue;
    }
    return remaining;
  }
  return { ...record, [head]: deleteAt(record[head] as JsonValue, rest) };
}

// ---------------------------------------------------------------------------
// Key permutation
// ---------------------------------------------------------------------------

/**
 * A Fisher-Yates shuffle driven by a generated stream, so the permutation is
 * arbitrary rather than a fixed reversal. Reversal is one permutation out of `n!`
 * and is already covered by `harness.test.ts`; a comparator keyed on, say, the
 * first key of each object would survive a reversal on a two-key object half the
 * time.
 */
function shuffled<T>(items: readonly T[], next: () => number): readonly T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    const held = out[index] as T;
    out[index] = out[target] as T;
    out[target] = held;
  }
  return out;
}

/** The same document, every object's keys in a generated order, arrays untouched. */
function permuteKeys(value: JsonValue, next: () => number): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((element) => permuteKeys(element, next));

  const record = value as { readonly [key: string]: JsonValue };
  const permuted: Record<string, JsonValue> = {};
  for (const key of shuffled(Object.keys(record), next)) {
    permuted[key] = permuteKeys(record[key] as JsonValue, next);
  }
  return permuted;
}

/** Key order as it stands, level by level, so a no-op permutation is detectable. */
function keyOrderOf(value: JsonValue): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(keyOrderOf);
  const record = value as { readonly [key: string]: JsonValue };
  return Object.keys(record).flatMap((key) => [key, ...keyOrderOf(record[key] as JsonValue)]);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const CONFIDENCE: readonly string[] = ['full', 'partial', 'raw'];

/** A plain signed decimal integer, the shape every lamport and token amount has. */
const DECIMAL = /^-?\d+$/;

const U64_MAX = 2n ** 64n - 1n;

const arbConfidence: fc.Arbitrary<JsonValue> = fc.constantFrom(...CONFIDENCE);

/** Decimal-integer strings across the u64 range, which is why they are strings. */
const arbDecimalString: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.bigInt({ min: -U64_MAX, max: U64_MAX }).map((value) => value.toString()),
  fc.constantFrom('0', '-1', '1', '18446744073709551615', '9007199254740993', '-5000'),
);

const arbSafeInteger: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.constantFrom(0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
);

const arbLeafValue: fc.Arbitrary<JsonValue> = fc.oneof(
  { weight: 3, arbitrary: arbConfidence },
  { weight: 3, arbitrary: arbDecimalString },
  { weight: 2, arbitrary: arbSafeInteger },
  { weight: 2, arbitrary: fc.boolean() as fc.Arbitrary<JsonValue> },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) as fc.Arbitrary<JsonValue> },
);

/**
 * Field names from `Analysis`, plus three that need RFC 6901 escaping. Real names
 * keep the generated documents recognisable in a shrunk counterexample; the
 * escaped ones are here because a pointer bug and a comparison bug look identical
 * in a report.
 */
const KEYS: readonly string[] = [
  'accounts',
  'address',
  'confidence',
  'delta',
  'failed',
  'inner',
  'kind',
  'name',
  'post',
  'pre',
  'programId',
  'a/b',
  'c~d',
  '~1',
];

const arbKey: fc.Arbitrary<string> = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...KEYS) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 6 }) },
);

function arbObject(depth: number): fc.Arbitrary<JsonValue> {
  return fc.dictionary(arbKey, arbNode(depth), { minKeys: 1, maxKeys: 5 }) as fc.Arbitrary<JsonValue>;
}

function arbNode(depth: number): fc.Arbitrary<JsonValue> {
  if (depth <= 0) return arbLeafValue;
  return fc.oneof(
    { weight: 4, arbitrary: arbLeafValue },
    { weight: 3, arbitrary: arbObject(depth - 1) },
    { weight: 2, arbitrary: fc.array(arbNode(depth - 1), { maxLength: 4 }) as fc.Arbitrary<JsonValue> },
    // Arrays of objects explicitly: `instructions`, `accounts`, and
    // `lamportBalances` are all that shape and it should not depend on a draw.
    { weight: 2, arbitrary: fc.array(arbObject(depth - 1), { minLength: 1, maxLength: 3 }) as fc.Arbitrary<JsonValue> },
  );
}

/** Mostly an object, like `Analysis`, occasionally a bare leaf or array root. */
const arbDocument: fc.Arbitrary<JsonValue> = fc.oneof(
  { weight: 6, arbitrary: arbObject(3) },
  { weight: 1, arbitrary: arbNode(2) },
);

/** An unbounded supply of naturals, for the shuffle. */
const arbEntropy: fc.Arbitrary<() => number> = fc
  .array(fc.nat({ max: 1_000_003 }), { minLength: 32, maxLength: 64 })
  .map((draws) => {
    let cursor = 0;
    return () => {
      const value = draws[cursor % draws.length] as number;
      cursor += 1;
      return value;
    };
  });

// ---------------------------------------------------------------------------
// Single-leaf mutations
// ---------------------------------------------------------------------------

type Mutation =
  | { readonly kind: 'replace'; readonly value: JsonValue }
  | { readonly kind: 'remove' };

function changeOneDigit(text: string, pick: number): string {
  const positions = [...text].flatMap((character, index) => (/\d/.test(character) ? [index] : []));
  const at = positions[pick % positions.length] as number;
  const digit = Number(text[at]);
  return `${text.slice(0, at)}${(digit + 1) % 10}${text.slice(at + 1)}`;
}

/**
 * Replacements for one leaf, every one of them a different JSON value.
 *
 * Kind-preserving changes come first for each type, because those are the ones a
 * sloppy comparator misses: a `null` where an object was is visible in almost any
 * traversal, while `'full'` for `'partial'` or `1000` for `1001` is visible only if
 * the leaf is actually compared.
 */
function replacementsFor(leaf: JsonValue): readonly JsonValue[] {
  const candidates: JsonValue[] = [];

  if (leaf === null) {
    candidates.push(false, 0, '', 'null', [], {});
  } else if (typeof leaf === 'boolean') {
    candidates.push(!leaf, String(leaf), leaf ? 1 : 0, null);
  } else if (typeof leaf === 'number') {
    candidates.push(leaf + 1, leaf - 1, String(leaf), null, true);
  } else if (typeof leaf === 'string') {
    if (CONFIDENCE.includes(leaf)) {
      // A changed confidence marker: the mutation the task names first, because a
      // `partial` decode presented as `full` is the product's central lie.
      candidates.push(...CONFIDENCE.filter((marker) => marker !== leaf));
    }
    if (DECIMAL.test(leaf) && /\d/.test(leaf)) {
      candidates.push(changeOneDigit(leaf, 0), changeOneDigit(leaf, 1), `${leaf}0`);
    }
    candidates.push(`${leaf} `, `${leaf}x`, '', null, 0);
  } else {
    // An empty array or object leaf.
    candidates.push(null, 0, '', Array.isArray(leaf) ? {} : []);
  }

  const distinct = candidates.filter((candidate) => candidate !== leaf);
  /* c8 ignore next -- every branch above contributes at least one distinct value. */
  return distinct.length > 0 ? distinct : ['\u0000opsis-sentinel'];
}

function mutationFor(leaf: Leaf, pick: number): Mutation {
  const replacements = replacementsFor(leaf.value);
  // `null` -> absent key is only expressible inside an object, and only there is
  // it the interesting case: dropping an array element renumbers its successors.
  const canRemove = leaf.inObject;
  const options = canRemove ? replacements.length + 1 : replacements.length;
  const chosen = pick % options;
  if (chosen === replacements.length) return { kind: 'remove' };
  return { kind: 'replace', value: replacements[chosen] as JsonValue };
}

function applyMutation(document: JsonValue, leaf: Leaf, mutation: Mutation): JsonValue {
  return mutation.kind === 'remove'
    ? deleteAt(document, leaf.steps)
    : setAt(document, leaf.steps, mutation.value);
}

/**
 * The assertion both halves of the value-exact property share: the mutated leaf's
 * pointer appears in the report, in both comparison directions, and the report
 * text names it.
 */
function expectReported(document: JsonValue, leaf: Leaf, mutation: Mutation): void {
  const mutated = applyMutation(document, leaf, mutation);

  const forward = diffJson(mutated, document);
  const backward = diffJson(document, mutated);

  expect(pointersOf(forward)).toContain(leaf.pointer);
  expect(pointersOf(backward)).toContain(leaf.pointer);
  // Symmetric up to the direction of each pair, which is what a report has to be
  // for "expected" and "actual" to mean anything.
  expect(pointersOf(backward)).toEqual(pointersOf(forward));

  const report = formatDifferences('case', '/tmp/expected.json', forward);
  expect(report).toContain(leaf.pointer === '' ? '<root>' : leaf.pointer);
}

// ---------------------------------------------------------------------------
// Real documents: the six recorded fixtures through the real pipeline
// ---------------------------------------------------------------------------

interface RealDocument {
  readonly name: string;
  readonly document: JsonValue;
}

const REAL_DOCUMENTS: readonly RealDocument[] = goldenCases().map((recorded) => {
  const checked = asTransactionResponse(recorded.document);
  if (!checked.ok) throw new Error(`recorded fixture is not a response: ${checked.detail}`);
  return {
    name: recorded.name,
    document: canonicalJson(analyzeTransaction({ response: checked.response })),
  };
});

// ---------------------------------------------------------------------------
// Property 42
// ---------------------------------------------------------------------------

// Feature: solana-transaction-analyzer, Property 42: The golden comparator is
// order-insensitive and value-exact
//
// **Validates: Requirements 14.7**

describe('Property 42: the golden comparator is order-insensitive and value-exact', () => {
  it('reports no difference for any permutation of object keys', () => {
    let permutationsThatMovedAKey = 0;

    fc.assert(
      fc.property(arbDocument, arbEntropy, (document, next) => {
        const permuted = permuteKeys(document, next);

        // The empty list itself, not its length: the list is what the report is
        // built from, so an entry with a bogus pointer must fail here too.
        expect(diffJson(document, permuted)).toEqual([]);
        expect(diffJson(permuted, document)).toEqual([]);
        // Permuting the actual side rather than the expected side is the same
        // claim, and the harness only ever permutes one of them.
        expect(diffJson(permuted, permuteKeys(document, next))).toEqual([]);

        if (keyOrderOf(permuted).join('\u0000') !== keyOrderOf(document).join('\u0000')) {
          permutationsThatMovedAKey += 1;
        }
      }),
      { numRuns: 100 },
    );

    // Without this the property would pass on a shuffle that never moved
    // anything, which is the vacuous-generator failure.
    expect(permutationsThatMovedAKey).toBeGreaterThan(0);
  });

  it('reports the pointer of any single mutated leaf', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(arbDocument, fc.nat(), fc.nat(), (document, leafPick, mutationPick) => {
        const leaves = leavesOf(document);
        fc.pre(leaves.length > 0);
        const leaf = leaves[leafPick % leaves.length] as Leaf;
        const mutation = mutationFor(leaf, mutationPick);

        expectReported(document, leaf, mutation);

        seen.add(mutation.kind === 'remove' ? 'remove' : `replace:${typeof leaf.value}`);
      }),
      { numRuns: 100 },
    );

    // The three named mutations are pinned as examples below; this only asserts
    // the generator is exercising more than one shape of change.
    expect(seen.has('remove')).toBe(true);
    expect(seen.size).toBeGreaterThan(2);
  });

  it('holds on the real Analysis documents the comparator sees in production', () => {
    expect(REAL_DOCUMENTS.length).toBe(6);

    fc.assert(
      fc.property(
        fc.nat({ max: REAL_DOCUMENTS.length - 1 }),
        arbEntropy,
        fc.nat(),
        fc.nat(),
        (documentPick, next, leafPick, mutationPick) => {
          const { document } = REAL_DOCUMENTS[documentPick] as RealDocument;

          // Order-insensitive on a real document.
          expect(diffJson(canonicalJson(document), permuteKeys(document, next))).toEqual([]);

          // Value-exact on a real leaf.
          const leaves = leavesOf(document);
          expect(leaves.length).toBeGreaterThan(10);
          const leaf = leaves[leafPick % leaves.length] as Leaf;
          expectReported(document, leaf, mutationFor(leaf, mutationPick));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// The three mutations the task names, pinned
// ---------------------------------------------------------------------------

describe('Property 42: the three named mutations, as targeted cases', () => {
  /** Every pointer at which a real fixture's analysis carries a `confidence` key. */
  function confidenceLeaves(document: JsonValue): readonly Leaf[] {
    return leavesOf(document).filter((leaf) => leaf.steps.at(-1) === 'confidence');
  }

  it('rejects a changed confidence marker at every pointer that carries one', () => {
    for (const real of REAL_DOCUMENTS) {
      const markers = confidenceLeaves(real.document);
      expect(markers.length).toBeGreaterThan(0);

      for (const marker of markers) {
        expect(CONFIDENCE).toContain(marker.value);
        for (const other of CONFIDENCE.filter((value) => value !== marker.value)) {
          const differences = diffJson(setAt(real.document, marker.steps, other), real.document);

          expect(pointersOf(differences)).toContain(marker.pointer);
          const reported = differences.find((difference) => difference.path === marker.pointer);
          expect(reported?.expected).toBe(marker.value);
          expect(reported?.actual).toBe(other);
        }
      }
    }
  });

  it('rejects one changed digit in a decimal string, at u64 scale', () => {
    const document: JsonValue = {
      lamportBalances: [{ delta: '-5000', post: '18446744073709546615', pre: '18446744073709551615' }],
    };

    // The digit that a float round trip would be the first to lose.
    const mutated = diffJson(
      { lamportBalances: [{ delta: '-5000', post: '18446744073709546615', pre: '18446744073709551614' }] },
      document,
    );

    expect(pointersOf(mutated)).toEqual(['/lamportBalances/0/pre']);
    expect(mutated[0]?.expected).toBe('18446744073709551615');
    expect(mutated[0]?.actual).toBe('18446744073709551614');

    // And on every decimal leaf of every real document, one digit at a time.
    for (const real of REAL_DOCUMENTS) {
      const decimals = leavesOf(real.document).filter(
        (leaf) => typeof leaf.value === 'string' && DECIMAL.test(leaf.value) && /\d/.test(leaf.value),
      );
      for (const leaf of decimals) {
        const changed = changeOneDigit(leaf.value as string, 0);
        expect(changed).not.toBe(leaf.value);
        expect(pointersOf(diffJson(setAt(real.document, leaf.steps, changed), real.document))).toContain(
          leaf.pointer,
        );
      }
    }
  });

  it('rejects a null value becoming an absent key, in both directions', () => {
    const withNull: JsonValue = { failure: null, signature: 'Sig' };
    const withoutKey: JsonValue = { signature: 'Sig' };

    const dropped = diffJson(withoutKey, withNull);
    const added = diffJson(withNull, withoutKey);

    expect(pointersOf(dropped)).toEqual(['/failure']);
    expect(pointersOf(added)).toEqual(['/failure']);
    // The two are different documents and the report says which side is missing
    // it, rather than reporting an opaque mismatch.
    expect(dropped[0]?.expected).toBe(null);
    expect(added[0]?.actual).toBe(null);
    expect(formatDifferences('case', 'expected.json', dropped)).toContain('<absent>');
    expect(formatDifferences('case', 'expected.json', added)).toContain('<absent>');

    // Nested, and on a real document: every null leaf of every fixture.
    for (const real of REAL_DOCUMENTS) {
      const nulls = leavesOf(real.document).filter((leaf) => leaf.value === null && leaf.inObject);
      expect(nulls.length).toBeGreaterThan(0);
      for (const leaf of nulls) {
        const removed = deleteAt(real.document, leaf.steps);
        expect(pointersOf(diffJson(removed, real.document))).toContain(leaf.pointer);
        expect(pointersOf(diffJson(real.document, removed))).toContain(leaf.pointer);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Arrays, depth, and multiplicity
// ---------------------------------------------------------------------------

describe('Property 42: arrays are ordered, depth is unbounded, and every difference is reported', () => {
  it('reports an array length difference at the absent index', () => {
    expect(pointersOf(diffJson({ inner: [1, 2, 3] }, { inner: [1, 2] }))).toEqual(['/inner/2']);
    expect(pointersOf(diffJson({ inner: [1] }, { inner: [1, 2] }))).toEqual(['/inner/1']);
    expect(pointersOf(diffJson([], [null]))).toEqual(['/0']);
  });

  it('reports a reordered array as a difference, because arrays are ordered', () => {
    // Instruction order is the transaction. A comparator that sorted array
    // elements would call two different execution traces equal.
    expect(pointersOf(diffJson({ instructions: [1, 2] }, { instructions: [2, 1] }))).toEqual([
      '/instructions/0',
      '/instructions/1',
    ]);

    const swapped = diffJson(
      { accounts: [{ index: 0 }, { index: 1 }] },
      { accounts: [{ index: 1 }, { index: 0 }] },
    );
    expect(pointersOf(swapped)).toEqual(['/accounts/0/index', '/accounts/1/index']);

    // A real document with its instruction list reversed is not equal to itself.
    for (const real of REAL_DOCUMENTS) {
      const record = real.document as { readonly instructions?: JsonValue };
      const instructions = record.instructions;
      if (!Array.isArray(instructions) || instructions.length < 2) continue;
      const reversed = { ...(real.document as Record<string, JsonValue>), instructions: [...instructions].reverse() };
      expect(diffJson(reversed, real.document).length).toBeGreaterThan(0);
    }
  });

  it('reports a difference several levels deep with the full pointer', () => {
    const actual: JsonValue = {
      instructions: [{ inner: [{ accounts: [{ name: { label: 'a~b/c' } }] }] }],
    };
    const expectedDocument: JsonValue = {
      instructions: [{ inner: [{ accounts: [{ name: { label: 'a~b/d' } }] }] }],
    };

    expect(pointersOf(diffJson(actual, expectedDocument))).toEqual([
      '/instructions/0/inner/0/accounts/0/name/label',
    ]);
  });

  it('reports both pointers when two leaves differ', () => {
    const differences = diffJson(
      { compute: { total: 1 }, signature: 'A' },
      { compute: { total: 2 }, signature: 'B' },
    );

    expect(pointersOf(differences)).toEqual(['/compute/total', '/signature']);
    const report = formatDifferences('05-two', '/tmp/expected.json', differences);
    expect(report).toContain('/compute/total');
    expect(report).toContain('/signature');
    expect(report).toContain('2 path(s)');
  });

  it('distinguishes values that share a string form', () => {
    // The pairs a stringly comparator would collapse.
    expect(pointersOf(diffJson({ v: 1 }, { v: '1' }))).toEqual(['/v']);
    expect(pointersOf(diffJson({ v: null }, { v: 'null' }))).toEqual(['/v']);
    expect(pointersOf(diffJson({ v: true }, { v: 'true' }))).toEqual(['/v']);
    expect(pointersOf(diffJson({ v: 0 }, { v: false }))).toEqual(['/v']);
    expect(pointersOf(diffJson({ v: [] }, { v: {} }))).toEqual(['/v']);
  });
});
