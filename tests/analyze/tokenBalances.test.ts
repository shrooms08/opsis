/**
 * Unit tests for `deriveTokenBalances` — Requirement 20.
 *
 * The cases are chosen around the two things that are easy to get wrong and
 * invisible when wrong: the composite key (a join on `accountIndex` alone or on
 * `mint` alone passes every single-mint transaction and silently merges rows on
 * a real swap) and exactness (a delta computed in `number` is right for every
 * amount below 2^53 and wrong above it, which is where real u64 balances live).
 * Both are exercised with values that distinguish the correct implementation
 * from the plausible wrong one, not with round numbers.
 */

import { describe, expect, it } from 'vitest';

import { deriveTokenBalances } from '../../src/analyze/tokenBalances.js';
import { resolveAccountKeys } from '../../src/decode/accountKeys.js';
import type { TokenBalanceChange } from '../../src/model/analysis.js';
import type {
  RawMeta,
  RawTokenBalance,
  RawTransactionResponse,
} from '../../src/model/rawResponse.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const MINT_A = 'Amint111111111111111111111111111111111111111';
const MINT_B = 'Bmint111111111111111111111111111111111111111';
const MINT_Z = 'Zmint111111111111111111111111111111111111111';

/** Sixteen static keys, so every `accountIndex` used below resolves. */
const ACCOUNT_KEYS = Array.from({ length: 16 }, (_, index) => `Account${index}`);

interface EntryOptions {
  readonly decimals?: number;
  /** A float, present in the input purely so the output can be checked for it. */
  readonly uiAmount?: number | null;
}

function entry(
  accountIndex: number,
  mint: string,
  amount: string,
  options: EntryOptions = {},
): RawTokenBalance {
  return {
    accountIndex,
    mint,
    owner: `Owner${accountIndex}`,
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    uiTokenAmount: {
      amount,
      decimals: options.decimals ?? 6,
      uiAmount: options.uiAmount ?? null,
      uiAmountString: amount,
    },
  };
}

/**
 * An entry with no `decimals` key at all.
 *
 * `RawUiTokenAmount.decimals` is typed as required, so the omission needs a cast
 * — and that is the point: the input is untrusted JSON, and this is the runtime
 * shape the compile-time type cannot rule out.
 */
function entryWithoutDecimals(
  accountIndex: number,
  mint: string,
  amount: string,
): RawTokenBalance {
  return {
    accountIndex,
    mint,
    uiTokenAmount: { amount, uiAmount: 1.5, uiAmountString: '1.5' },
  } as unknown as RawTokenBalance;
}

/**
 * Run the stage over one pair of arrays.
 *
 * `undefined` means the field is absent from the metadata, which is different
 * from an empty array meaning the node recorded token balances and there were
 * none.
 */
function analyze(
  pre: readonly RawTokenBalance[] | undefined,
  post: readonly RawTokenBalance[] | undefined,
): readonly TokenBalanceChange[] {
  const meta: RawMeta = {
    err: null,
    fee: 5000,
    preBalances: [],
    postBalances: [],
    ...(pre === undefined ? {} : { preTokenBalances: pre }),
    ...(post === undefined ? {} : { postTokenBalances: post }),
  };

  const response: RawTransactionResponse = {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: ACCOUNT_KEYS,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions: [],
        recentBlockhash: 'Blockhash11111111111111111111111111111111111',
      },
      signatures: ['Signature111111111111111111111111111111111111'],
    },
    meta,
  };

  return deriveTokenBalances(response, resolveAccountKeys(response));
}

/** Every (accountIndex, mint) pair in output order. */
function keysOf(rows: readonly TokenBalanceChange[]): readonly string[] {
  return rows.map((row) => `${row.accountIndex}:${row.mint}`);
}

// ---------------------------------------------------------------------------
// Matched pairs — Requirements 20.2, 20.3, 20.7
// ---------------------------------------------------------------------------

describe('deriveTokenBalances matched entries', () => {
  it('records post - pre as an exact decimal string', () => {
    const rows = analyze(
      [entry(7, MINT_A, '2156243834114', { decimals: 9 })],
      [entry(7, MINT_A, '2156243895305', { decimals: 9 })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      accountIndex: 7,
      address: 'Account7',
      mint: MINT_A,
      pre: { mint: MINT_A, raw: '2156243834114', decimals: { known: true, value: 9 } },
      post: { mint: MINT_A, raw: '2156243895305', decimals: { known: true, value: 9 } },
      delta: { mint: MINT_A, raw: '61191', decimals: { known: true, value: 9 } },
      lifecycle: 'existing',
      confidence: 'full',
    });
  });

  it('records a negative delta when the balance decreased', () => {
    const rows = analyze([entry(1, MINT_A, '5510410830')], [entry(1, MINT_A, '0')]);

    expect(rows[0]?.delta.raw).toBe('-5510410830');
    expect(rows[0]?.lifecycle).toBe('existing');
  });

  it('stays exact above 2^53 in both directions', () => {
    const upward = analyze(
      [entry(2, MINT_A, '9007199254740993')],
      [entry(2, MINT_A, '18446744073709551615')],
    );
    const downward = analyze(
      [entry(2, MINT_A, '18446744073709551615')],
      [entry(2, MINT_A, '0')],
    );

    expect(upward[0]?.delta.raw).toBe('18437736874454810622');
    expect(downward[0]?.delta.raw).toBe('-18446744073709551615');
  });

  it('records a zero delta for an unchanged balance without special-casing it', () => {
    const rows = analyze([entry(3, MINT_A, '42')], [entry(3, MINT_A, '42')]);

    expect(rows[0]?.delta.raw).toBe('0');
    expect(rows[0]?.lifecycle).toBe('existing');
  });
});

// ---------------------------------------------------------------------------
// The composite key — Requirement 20.2
// ---------------------------------------------------------------------------

describe('deriveTokenBalances composite key', () => {
  it('keeps one account holding two mints as two rows', () => {
    const rows = analyze(
      [entry(4, MINT_A, '100'), entry(4, MINT_B, '700')],
      [entry(4, MINT_A, '150'), entry(4, MINT_B, '600')],
    );

    expect(keysOf(rows)).toEqual([`4:${MINT_A}`, `4:${MINT_B}`]);
    expect(rows.map((row) => row.delta.raw)).toEqual(['50', '-100']);
  });

  it('keeps one mint held by two accounts as two rows', () => {
    const rows = analyze(
      [entry(5, MINT_A, '100'), entry(6, MINT_A, '700')],
      [entry(5, MINT_A, '90'), entry(6, MINT_A, '710')],
    );

    expect(keysOf(rows)).toEqual([`5:${MINT_A}`, `6:${MINT_A}`]);
    expect(rows.map((row) => row.delta.raw)).toEqual(['-10', '10']);
  });

  it('does not match across mints on the same account or across accounts on the same mint', () => {
    // Pre has (4, A) and (5, B); post has (4, B) and (5, A). A join on either
    // component alone would produce two `existing` rows; the composite key
    // produces four rows, two closed and two created.
    const rows = analyze(
      [entry(4, MINT_A, '100'), entry(5, MINT_B, '200')],
      [entry(4, MINT_B, '300'), entry(5, MINT_A, '400')],
    );

    expect(keysOf(rows)).toEqual([`4:${MINT_A}`, `4:${MINT_B}`, `5:${MINT_A}`, `5:${MINT_B}`]);
    expect(rows.map((row) => row.lifecycle)).toEqual([
      'closed',
      'created',
      'created',
      'closed',
    ]);
    expect(rows.map((row) => row.delta.raw)).toEqual(['-100', '300', '400', '-200']);
  });
});

// ---------------------------------------------------------------------------
// Lifecycles — Requirements 20.5, 20.6
// ---------------------------------------------------------------------------

describe('deriveTokenBalances lifecycles', () => {
  it('reports post with no pre as created, with the post amount as the delta', () => {
    const rows = analyze([], [entry(8, MINT_A, '12345678901234567890', { decimals: 9 })]);

    expect(rows[0]).toEqual({
      accountIndex: 8,
      address: 'Account8',
      mint: MINT_A,
      pre: null,
      post: { mint: MINT_A, raw: '12345678901234567890', decimals: { known: true, value: 9 } },
      delta: { mint: MINT_A, raw: '12345678901234567890', decimals: { known: true, value: 9 } },
      lifecycle: 'created',
      confidence: 'full',
    });
  });

  it('reports pre with no post as closed, with the negated pre amount as the delta', () => {
    const rows = analyze([entry(9, MINT_A, '12345678901234567890', { decimals: 9 })], []);

    expect(rows[0]).toEqual({
      accountIndex: 9,
      address: 'Account9',
      mint: MINT_A,
      pre: { mint: MINT_A, raw: '12345678901234567890', decimals: { known: true, value: 9 } },
      post: null,
      delta: { mint: MINT_A, raw: '-12345678901234567890', decimals: { known: true, value: 9 } },
      lifecycle: 'closed',
      confidence: 'full',
    });
  });
});

// ---------------------------------------------------------------------------
// Absent arrays — Requirement 20.9
// ---------------------------------------------------------------------------

describe('deriveTokenBalances absent arrays', () => {
  it('yields an empty collection when both arrays are absent', () => {
    expect(analyze(undefined, undefined)).toEqual([]);
  });

  it('yields an empty collection when both arrays are present and empty', () => {
    expect(analyze([], [])).toEqual([]);
  });

  it('reports every post entry as created when only the pre array is absent', () => {
    const rows = analyze(undefined, [entry(10, MINT_A, '55')]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lifecycle).toBe('created');
    expect(rows[0]?.pre).toBeNull();
    expect(rows[0]?.delta.raw).toBe('55');
  });

  it('reports every pre entry as closed when only the post array is absent', () => {
    const rows = analyze([entry(11, MINT_A, '55')], undefined);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lifecycle).toBe('closed');
    expect(rows[0]?.post).toBeNull();
    expect(rows[0]?.delta.raw).toBe('-55');
  });
});

// ---------------------------------------------------------------------------
// Decimals — Requirements 20.4, 12.13, 12.14
// ---------------------------------------------------------------------------

describe('deriveTokenBalances decimals', () => {
  it('takes the unknown variant when decimals is missing, and never a default', () => {
    const rows = analyze(
      [entryWithoutDecimals(12, MINT_A, '1000')],
      [entryWithoutDecimals(12, MINT_A, '1500')],
    );

    expect(rows[0]?.pre?.decimals).toEqual({ known: false });
    expect(rows[0]?.post?.decimals).toEqual({ known: false });
    expect(rows[0]?.delta).toEqual({ mint: MINT_A, raw: '500', decimals: { known: false } });
    // The amounts are exact; what is unknown is the scale, so the row is partial
    // rather than full and no 6 or 9 was invented for it.
    expect(rows[0]?.confidence).toBe('partial');
    expect(JSON.stringify(rows)).not.toContain('"value"');
  });

  it('carries the mint and the decimals on every amount it produces', () => {
    const rows = analyze(
      [entry(4, MINT_A, '1', { decimals: 0 })],
      [entry(4, MINT_A, '2', { decimals: 0 })],
    );

    for (const amount of [rows[0]?.pre, rows[0]?.post, rows[0]?.delta]) {
      expect(amount?.mint).toBe(MINT_A);
      expect(amount?.decimals).toEqual({ known: true, value: 0 });
    }
  });

  it('marks the delta scale unknown when pre and post disagree about decimals', () => {
    const rows = analyze(
      [entry(4, MINT_A, '1000', { decimals: 6 })],
      [entry(4, MINT_A, '1500', { decimals: 9 })],
    );

    // Each side keeps the decimals reported beside it; the delta, derived from
    // both, is in neither scale.
    expect(rows[0]?.pre?.decimals).toEqual({ known: true, value: 6 });
    expect(rows[0]?.post?.decimals).toEqual({ known: true, value: 9 });
    expect(rows[0]?.delta.decimals).toEqual({ known: false });
    expect(rows[0]?.confidence).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// No float reaches the output — Requirements 20.7, 20.8
// ---------------------------------------------------------------------------

describe('deriveTokenBalances float discipline', () => {
  it('discards uiAmount and uiAmountString entirely', () => {
    const rows = analyze(
      [entry(7, MINT_A, '5510410830', { decimals: 6, uiAmount: 5510.41083 })],
      [entry(7, MINT_A, '5510410831', { decimals: 6, uiAmount: 5510.410831 })],
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('uiAmount');
    expect(serialized).not.toContain('5510.41083');
    expect(serialized).not.toContain('.');
    expect(numericLeaves(rows).every((n) => Number.isSafeInteger(n))).toBe(true);
  });

  it('emits every amount as a plain decimal integer string', () => {
    const rows = analyze(
      [entry(1, MINT_A, '+007'), entry(2, MINT_A, '-0')],
      [entry(1, MINT_A, '10'), entry(2, MINT_A, '0')],
    );

    for (const row of rows) {
      for (const raw of [row.pre?.raw, row.post?.raw, row.delta.raw]) {
        expect(raw).toMatch(/^-?(0|[1-9][0-9]*)$/);
      }
    }
    expect(rows[0]?.delta.raw).toBe('3');
    expect(rows[1]?.delta.raw).toBe('0');
  });
});

describe('deriveTokenBalances malformed amounts', () => {
  it('drops the whole key rather than reporting a false closure', () => {
    // A malformed post amount, dropped on its own, would leave the pre entry
    // looking like a closed account with a negated delta. Requirement 20 has no
    // gap case for this, and silence about the row is the smaller error.
    const rows = analyze(
      [entry(4, MINT_A, '100'), entry(5, MINT_A, '200')],
      [entry(4, MINT_A, '0x64'), entry(5, MINT_A, '250')],
    );

    expect(keysOf(rows)).toEqual([`5:${MINT_A}`]);
    expect(rows[0]?.delta.raw).toBe('50');
  });
});

/** Every `number` leaf reachable in the collection. */
function numericLeaves(value: unknown): readonly number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => numericLeaves(item));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((item) => numericLeaves(item));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Ordering — Requirements 9.1, 9.6, 9.7
// ---------------------------------------------------------------------------

describe('deriveTokenBalances ordering', () => {
  it('sorts by account index then mint regardless of the order the RPC listed entries', () => {
    const shuffled = [
      entry(9, MINT_Z, '1'),
      entry(1, MINT_Z, '2'),
      entry(9, MINT_A, '3'),
      entry(1, MINT_B, '4'),
      entry(1, MINT_A, '5'),
      entry(10, MINT_A, '6'),
    ];

    const rows = analyze(shuffled, [...shuffled].reverse());

    expect(keysOf(rows)).toEqual([
      `1:${MINT_A}`,
      `1:${MINT_B}`,
      `1:${MINT_Z}`,
      `9:${MINT_A}`,
      `9:${MINT_Z}`,
      `10:${MINT_A}`,
    ]);
  });
});
