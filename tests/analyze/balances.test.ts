/**
 * Unit tests for `analyzeLamportBalances`.
 *
 * Two things are checked here that nothing else can check: the exact digits of a
 * delta, and the *shape* of the `post-only` variant. The digit cases are written
 * as literal strings rather than computed expectations, so a float regression
 * cannot be reproduced by the test's own arithmetic and pass. The absent-`delta`
 * case is asserted on the serialized form, because `delta === undefined` would
 * also hold for a variant that carried the key with an undefined value, and
 * Requirement 7.9 asks for no key at all.
 *
 * The full-range sweep across `u64` belongs to task 8.2's property test; these
 * cases pin the boundaries a reader would want to see by name.
 */

import { describe, expect, it } from 'vitest';

import {
  analyzeLamportBalances,
  type LamportBalanceAnalysis,
} from '../../src/analyze/balances.js';
import type { EffectiveKeys } from '../../src/decode/accountKeys.js';
import type {
  AccountEntry,
  AccountRef,
  InstructionDecode,
  InstructionNode,
} from '../../src/model/analysis.js';
import type { RawMeta, RawTransactionResponse } from '../../src/model/rawResponse.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DECODE: InstructionDecode = {
  kind: 'full',
  name: 'transfer',
  source: 'builtin',
  fields: [],
  confidence: 'full',
};

function entry(index: number): AccountEntry {
  return {
    index,
    address: `Account${index}`,
    signer: false,
    role: 'readonly',
    origin: { kind: 'static' },
    referencedBy: [],
    name: null,
    confidence: 'full',
  };
}

/** An effective key list of `count` static entries, addressed `Account0..n`. */
function effectiveKeys(count: number): EffectiveKeys {
  const entries: AccountEntry[] = [];
  for (let index = 0; index < count; index += 1) entries.push(entry(index));
  return {
    messageVersion: 'legacy',
    staticCount: count,
    entries,
    loadedAddressesAvailable: false,
  };
}

function resolved(index: number): AccountRef {
  return {
    kind: 'resolved',
    index,
    address: `Account${index}`,
    signer: false,
    role: 'readonly',
    origin: { kind: 'static' },
    name: null,
    confidence: 'full',
  };
}

function unresolved(index: number): AccountRef {
  return { kind: 'unresolved', index, reason: 'out of range', confidence: 'raw' };
}

function node(overrides: Partial<InstructionNode> & { readonly order: number }): InstructionNode {
  return {
    depth: 0,
    parentOrder: null,
    programId: 'Program1111111111111111111111111111111111111',
    programName: null,
    decode: DECODE,
    accounts: [],
    failed: false,
    valid: true,
    invalidReason: null,
    computeUnits: { available: false, confidence: 'raw' },
    logs: [],
    inner: [],
    confidence: 'full',
    ...overrides,
  };
}

function response(
  pre: readonly number[],
  post: readonly number[],
  meta: Partial<RawMeta> = {},
): RawTransactionResponse {
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
    meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, ...meta },
  };
}

/** Balances only, for the arithmetic cases: one key per balance, no instructions. */
function balancesOf(
  pre: readonly number[],
  post: readonly number[],
): LamportBalanceAnalysis {
  const keys = effectiveKeys(Math.max(pre.length, post.length));
  return analyzeLamportBalances(response(pre, post), keys, []);
}

// ---------------------------------------------------------------------------
// Deltas — Requirement 7.8
// ---------------------------------------------------------------------------

describe('analyzeLamportBalances deltas', () => {
  it('records post minus pre as a decimal string', () => {
    const { balances } = balancesOf([1_000_000], [1_500_000]);

    expect(balances).toEqual([
      {
        kind: 'delta',
        accountIndex: 0,
        address: 'Account0',
        pre: '1000000',
        post: '1500000',
        delta: '500000',
        confidence: 'full',
      },
    ]);
  });

  it('records a negative delta with a leading minus sign', () => {
    const { balances } = balancesOf([1_000_000], [994_995]);

    expect(balances[0]).toMatchObject({ kind: 'delta', delta: '-5005' });
  });

  it('records an unchanged balance as a delta of "0", never "-0"', () => {
    const { balances } = balancesOf([2_039_280], [2_039_280]);

    expect(balances[0]).toMatchObject({ kind: 'delta', delta: '0' });
  });

  it('keeps every digit of values above 2^53', () => {
    // 2**53 and 2**53 + 2, both exactly representable as doubles, so the wire
    // value is exact and the delta must be too. A float subtraction would still
    // get this pair right; the digits of the operands are what would not survive
    // a `toFixed` or a locale-formatted narrowing.
    const { balances } = balancesOf([9_007_199_254_740_992], [9_007_199_254_740_994]);

    expect(balances[0]).toMatchObject({
      kind: 'delta',
      pre: '9007199254740992',
      post: '9007199254740994',
      delta: '2',
    });
  });

  it('spells a near-u64-maximum balance in full decimal, not exponential', () => {
    const { balances } = balancesOf([18_446_744_073_709_551_615], [18_446_744_073_709_551_615]);

    // The double nearest 2**64 - 1 is 2**64; the point of the case is that the
    // value is carried as every one of its digits rather than as "1.8446744e19".
    expect(balances[0]).toMatchObject({
      kind: 'delta',
      pre: '18446744073709551616',
      post: '18446744073709551616',
      delta: '0',
    });
  });
});

// ---------------------------------------------------------------------------
// post-only — Requirement 7.9
// ---------------------------------------------------------------------------

describe('analyzeLamportBalances post-only', () => {
  it('emits the post-only variant when a pre balance is absent', () => {
    const { balances } = balancesOf([], [2_039_280]);

    expect(balances).toEqual([
      {
        kind: 'post-only',
        accountIndex: 0,
        address: 'Account0',
        post: '2039280',
        confidence: 'partial',
      },
    ]);
  });

  it('serializes the post-only variant with no delta key at all', () => {
    const { balances } = balancesOf([], [7]);

    const serialized = JSON.parse(JSON.stringify(balances[0])) as Record<string, unknown>;

    expect(Object.keys(serialized).includes('delta')).toBe(false);
    expect(Object.keys(serialized).includes('pre')).toBe(false);
  });

  it('emits nothing when both balance arrays are empty', () => {
    const analysis = balancesOf([], []);

    expect(analysis.balances).toEqual([]);
    expect(analysis.unrepresented).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shapes the model cannot express
// ---------------------------------------------------------------------------

describe('analyzeLamportBalances unrepresentable inputs', () => {
  it('names a pre balance with no post balance instead of inventing a delta', () => {
    const analysis = balancesOf([1_000_000, 42], [1_000_000]);

    expect(analysis.balances.map((change) => change.accountIndex)).toEqual([0]);
    expect(analysis.unrepresented).toEqual([
      {
        accountIndex: 1,
        reason: 'post-balance-absent',
        detail: expect.stringContaining('account index 1'),
      },
    ]);
  });

  it('names a balance whose index has no address', () => {
    // Two balances, one key: the second index belongs to no account this
    // response could resolve, and no variant can carry a nameless address.
    const analysis = analyzeLamportBalances(response([1, 2], [3, 4]), effectiveKeys(1), []);

    expect(analysis.balances.map((change) => change.accountIndex)).toEqual([0]);
    expect(analysis.unrepresented).toEqual([
      {
        accountIndex: 1,
        reason: 'address-unresolved',
        detail: expect.stringContaining('account index 1'),
      },
    ]);
  });

  it('reports no balances when metadata is absent', () => {
    const withoutMeta: RawTransactionResponse = { ...response([1], [2]), meta: null };

    const analysis = analyzeLamportBalances(withoutMeta, effectiveKeys(1), []);

    expect(analysis.balances).toEqual([]);
    expect(analysis.unrepresented).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering — Requirements 9.1, 9.6
// ---------------------------------------------------------------------------

describe('analyzeLamportBalances ordering', () => {
  it('emits balances ascending by account index', () => {
    const { balances } = balancesOf([10, 20, 30, 40], [11, 22, 33, 44]);

    expect(balances.map((change) => change.accountIndex)).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Instruction attribution — Requirement 7.11
// ---------------------------------------------------------------------------

describe('analyzeLamportBalances instruction attribution', () => {
  /**
   * order 0 (depth 0) → accounts 0, 1
   *   order 1 (depth 1) → accounts 1
   *     order 2 (depth 2) → accounts 0, 3 (3 is unresolved)
   * order 3 (depth 0) → accounts 1, 1 (the same account twice)
   */
  function tree(): readonly InstructionNode[] {
    return [
      node({
        order: 0,
        accounts: [resolved(0), resolved(1)],
        inner: [
          node({
            order: 1,
            depth: 1,
            parentOrder: 0,
            accounts: [resolved(1)],
            inner: [
              node({
                order: 2,
                depth: 2,
                parentOrder: 1,
                accounts: [resolved(0), unresolved(3)],
              }),
            ],
          }),
        ],
      }),
      node({ order: 3, accounts: [resolved(1), resolved(1)] }),
    ];
  }

  it('collects orders from every depth, ascending and deduplicated', () => {
    const { accountKeys } = analyzeLamportBalances(response([], []), effectiveKeys(4), tree());

    // Account 0: top-level order 0 and the depth-2 order 2.
    expect(accountKeys[0]?.referencedBy).toEqual([0, 2]);
    // Account 1: named twice by order 3, recorded once.
    expect(accountKeys[1]?.referencedBy).toEqual([0, 1, 3]);
  });

  it('leaves an account no instruction referenced empty', () => {
    const { accountKeys } = analyzeLamportBalances(response([], []), effectiveKeys(4), tree());

    expect(accountKeys[2]?.referencedBy).toEqual([]);
  });

  it('attributes nothing to an unresolved account reference', () => {
    const { accountKeys } = analyzeLamportBalances(response([], []), effectiveKeys(4), tree());

    // Index 3 appears only as the `unresolved` ref inside order 2. That ref
    // named no entry, so entry 3 keeps no reference from it.
    expect(accountKeys[3]?.referencedBy).toEqual([]);
  });

  it('carries every other field of an account entry through untouched', () => {
    const keys = effectiveKeys(2);
    const { accountKeys } = analyzeLamportBalances(response([], []), keys, tree());

    expect(accountKeys[1]).toEqual({ ...entry(1), referencedBy: [0, 1, 3] });
    // The input list is not mutated.
    expect(keys.entries[1]?.referencedBy).toEqual([]);
  });
});
