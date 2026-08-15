/**
 * Property-based tests for `analyzeLamportBalances`.
 *
 * This is one of the three v1-essential properties. The decimal-string
 * representation of `LamportAmount` exists specifically to survive values above
 * 2^53, and no recorded fixture is guaranteed to contain one. A float regression
 * is invisible on screen — a rounded lamport balance has the right shape and the
 * right magnitude and the wrong digits — so this is the mechanical check that the
 * central data-representation decision works across the range it was chosen for.
 *
 * ## What "exact" can mean here, stated precisely
 *
 * `RawMeta.preBalances` is `readonly number[]`, because that is what the RPC
 * sends and what `JSON.parse` produces. A balance above 2^53 has therefore
 * *already* lost precision before `analyzeLamportBalances` is called, and no code
 * in `src/analyze/balances.ts` can recover it. The property that actually holds —
 * and the only one worth asserting — is exactness **with respect to the values as
 * received**.
 *
 * The generator handles that honestly instead of dodging it. `arbLamports` draws
 * over the whole `u64` range as `bigint`, then maps each draw to the nearest
 * double-representable integer via `Number(...)` and uses *that* value as both the
 * wire input and the expected operand. So `2**53 + 1` is generated, arrives as
 * `2**53`, and is compared against `2**53`. That is deliberate: what is under test
 * is that the module's arithmetic and its decimal-string narrowing are exact, not
 * that JSON can carry a `u64`. Narrowing the generator to below 2^53 would defeat
 * the property — the point is that operands of full `u64` magnitude, which is
 * where a `Number` subtraction or a `toFixed`/locale narrowing goes wrong, are
 * carried digit for digit.
 *
 * Nothing about the round trip weakens the check on the *output*: every emitted
 * amount is asserted to be a plain signed decimal integer string, and a `bigint`
 * widening of an integer-valued double is exact at every magnitude, so a `Number`
 * regression inside the module would still show up as wrong digits.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  analyzeLamportBalances,
  type LamportBalanceAnalysis,
} from '../../src/analyze/balances.js';
import type { EffectiveKeys } from '../../src/decode/accountKeys.js';
import type { AccountEntry } from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';

// ---------------------------------------------------------------------------
// The lamport generator — design.md's `arbLamports`
// ---------------------------------------------------------------------------

const TWO_53 = 2n ** 53n;
const U64_MAX = 2n ** 64n - 1n;

/**
 * The six values design.md names for extra weight, so that any implementation
 * touching a float fails: `0`, `1`, `2**53 - 1`, `2**53`, `2**53 + 1`, and
 * `2**64 - 1`.
 */
const NAMED_LAMPORTS: readonly bigint[] = [0n, 1n, TWO_53 - 1n, TWO_53, TWO_53 + 1n, U64_MAX];

/** A plain signed decimal integer, per Requirements 7.10, 9.2, 13.8. */
const DECIMAL_INTEGER = /^-?(0|[1-9][0-9]*)$/;

interface WireLamports {
  /** What the generator drew, before the wire had its say. */
  readonly requested: bigint;
  /** The value as it reaches `RawMeta.preBalances`: a JSON number. */
  readonly wire: number;
  /** The same value as an exact integer. The expectation operand. */
  readonly exact: bigint;
}

/**
 * Put one drawn value through the `bigint` -> `number` -> `bigint` round trip the
 * RPC surface imposes.
 *
 * `Number(bigint)` rounds to the nearest double, which for any value in
 * `[0, 2**64)` is an integer-valued double (below 2^53 it is the value itself;
 * above, a multiple of the local power of two). `BigInt(...)` of that double is
 * therefore exact, and `exact` is the value the module will actually see.
 */
function onWire(requested: bigint): WireLamports {
  const wire = Number(requested);
  return { requested, wire, exact: BigInt(wire) };
}

const arbLamports: fc.Arbitrary<WireLamports> = fc
  .oneof(
    { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: U64_MAX }) },
    { weight: 2, arbitrary: fc.constantFrom(...NAMED_LAMPORTS) },
  )
  .map(onWire);

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Kept local rather than imported from `balances.test.ts`: importing a test file
 * from another test file would re-register its suites here. Only the two builders
 * this property needs are reproduced, and only the balance-carrying fields of the
 * response matter — the instruction list is empty throughout, since `referencedBy`
 * attribution is keyed on the tree and not on the balance arrays.
 */
function effectiveKeys(count: number): EffectiveKeys {
  const entries: AccountEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      index,
      address: `Account${index}`,
      signer: false,
      role: 'readonly',
      origin: { kind: 'static' },
      referencedBy: [],
      name: null,
      confidence: 'full',
    });
  }
  return { messageVersion: 'legacy', staticCount: count, entries, loadedAddressesAvailable: false };
}

function response(pre: readonly number[], post: readonly number[]): RawTransactionResponse {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      message: {
        accountKeys: [],
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions: [],
        recentBlockhash: 'Blockhash11111111111111111111111111111111111',
      },
      signatures: ['Signature1111111111111111111111111111111111'],
    },
    meta: { err: null, fee: 5000, preBalances: pre, postBalances: post },
  };
}

function balancesOf(pre: readonly number[], post: readonly number[]): LamportBalanceAnalysis {
  const keys = effectiveKeys(Math.max(pre.length, post.length));
  return analyzeLamportBalances(response(pre, post), keys, []);
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Every matched pair yields the `delta` variant whose three amounts are exact
 * decimal integers and whose delta is `post - pre` in `bigint`.
 */
function expectExactDeltas(pairs: readonly (readonly [WireLamports, WireLamports])[]): void {
  const analysis = balancesOf(
    pairs.map(([pre]) => pre.wire),
    pairs.map(([, post]) => post.wire),
  );

  expect(analysis.unrepresented).toEqual([]);
  expect(analysis.balances).toHaveLength(pairs.length);

  for (const [index, pair] of pairs.entries()) {
    const [pre, post] = pair;
    const change = analysis.balances[index];

    expect(change).toBeDefined();
    if (change === undefined || change.kind !== 'delta') {
      throw new Error(`expected a delta variant at index ${index}`);
    }

    expect(change.accountIndex).toBe(index);

    // Requirement 7.8, the property itself. Operands are the post-round-trip
    // values, which is what the module received.
    expect(BigInt(change.delta)).toBe(BigInt(change.post) - BigInt(change.pre));
    expect(BigInt(change.delta)).toBe(post.exact - pre.exact);

    // The operands themselves survived digit for digit, which is what a float
    // narrowing would break even where the subtraction happened to come out right.
    expect(change.pre).toBe(pre.exact.toString());
    expect(change.post).toBe(post.exact.toString());

    // A negative delta carries its sign; a non-negative one carries none, and
    // zero is "0" rather than "-0".
    expect(change.delta.startsWith('-')).toBe(post.exact < pre.exact);

    // No exponential notation, no locale separator, no decimal point.
    for (const amount of [change.pre, change.post, change.delta]) {
      expect(amount).toMatch(DECIMAL_INTEGER);
    }

    // The generator only ever rounds where the wire forces it: at or below 2^53
    // the drawn value reaches the module untouched.
    expect(Number.isInteger(pre.wire)).toBe(true);
    if (pre.requested <= TWO_53) expect(pre.exact).toBe(pre.requested);
    if (post.requested <= TWO_53) expect(post.exact).toBe(post.requested);
  }
}

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

// Feature: solana-transaction-analyzer, Property 25: Lamport deltas are exact
// across the full u64 range
//
// **Validates: Requirements 7.8, 7.9**

describe('Property 25: lamport deltas are exact across the full u64 range', () => {
  it('records post minus pre exactly for every matched pair', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbLamports, arbLamports), { minLength: 1, maxLength: 8 }),
        (pairs) => {
          expectExactDeltas(pairs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('records post minus pre exactly for every pair of the six named boundary values', () => {
    // The weighted generator above reaches these often; this sweep pins all
    // thirty-six combinations of them unconditionally, so the boundaries are
    // covered by construction rather than by the luck of a seed.
    const pairs: (readonly [WireLamports, WireLamports])[] = [];
    for (const pre of NAMED_LAMPORTS) {
      for (const post of NAMED_LAMPORTS) pairs.push([onWire(pre), onWire(post)]);
    }

    expectExactDeltas(pairs);
  });

  it('emits the post-only variant, with no delta key at all, when pre is absent', () => {
    fc.assert(
      fc.property(fc.array(arbLamports, { minLength: 1, maxLength: 8 }), (posts) => {
        const analysis = balancesOf(
          [],
          posts.map((post) => post.wire),
        );

        expect(analysis.unrepresented).toEqual([]);
        expect(analysis.balances).toHaveLength(posts.length);

        for (const [index, post] of posts.entries()) {
          const change = analysis.balances[index];

          expect(change).toBeDefined();
          if (change === undefined || change.kind !== 'post-only') {
            throw new Error(`expected a post-only variant at index ${index}`);
          }

          // Requirement 7.9: no delta, rather than a delta against an assumed
          // pre-balance of zero. Checked on the object *and* on its serialized
          // form, because `delta === undefined` would also hold for a variant
          // that carried the key with an undefined value.
          expect(Object.hasOwn(change, 'delta')).toBe(false);
          expect(Object.hasOwn(change, 'pre')).toBe(false);

          const serialized = JSON.parse(JSON.stringify(change)) as Record<string, unknown>;
          expect(Object.hasOwn(serialized, 'delta')).toBe(false);
          expect(Object.hasOwn(serialized, 'pre')).toBe(false);

          expect(change.post).toBe(post.exact.toString());
          expect(change.post).toMatch(DECIMAL_INTEGER);
          expect(change.confidence).toBe('partial');
        }
      }),
      { numRuns: 100 },
    );
  });
});
