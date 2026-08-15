/**
 * Unit tests for `locateFailure`.
 *
 * The tree in every case has depth-2 frames under both top-level instructions,
 * because the mistake this module exists to avoid is a mark that migrates into
 * `inner` — a plausible-looking `failed: true` on a nested CPI frame that no
 * part of `meta.err` licenses. A flat two-instruction tree would pass whether or
 * not the descent happened, so each assertion counts the marks over *every* node
 * at every depth rather than over the roots.
 */

import { describe, expect, it } from 'vitest';

import type { InstructionDecode, InstructionNode } from '../../src/model/analysis.js';
import type { RawMeta, RawTransactionError, RawTransactionResponse } from '../../src/model/rawResponse.js';
import { locateFailure } from '../../src/resolve/failure.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const RAW_DECODE: InstructionDecode = {
  kind: 'raw',
  name: 'Unknown',
  note: 'Unknown program',
  rawInstructionData: { label: 'raw_instruction_data', hex: '0x', byteLength: 0, truncated: false },
  errorDetail: null,
  confidence: 'raw',
};

function node(
  overrides: Partial<InstructionNode> & { readonly order: number; readonly depth: number },
): InstructionNode {
  return {
    parentOrder: null,
    programId: `Program${overrides.order}`,
    programName: null,
    decode: RAW_DECODE,
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

/**
 * Two top-level instructions, each with a CPI frame that itself invoked one:
 * orders 0-2 under top-level index 0, orders 3-5 under top-level index 1.
 *
 * `failed` is seeded `true` on two nodes — one root, one depth-2 frame — so that
 * every case below distinguishes "this module cleared it" from "nothing ever set
 * it", which is exactly what Requirement 5.3's "overriding any previously
 * assigned value" asks for.
 */
function tree(): readonly InstructionNode[] {
  return [
    node({
      order: 0,
      depth: 0,
      failed: true,
      inner: [
        node({
          order: 1,
          depth: 1,
          parentOrder: 0,
          inner: [node({ order: 2, depth: 2, parentOrder: 1, failed: true })],
        }),
      ],
    }),
    node({
      order: 3,
      depth: 0,
      inner: [
        node({
          order: 4,
          depth: 1,
          parentOrder: 3,
          inner: [node({ order: 5, depth: 2, parentOrder: 4 })],
        }),
      ],
    }),
  ];
}

function response(err: RawTransactionError | null): RawTransactionResponse {
  const meta: RawMeta = { err, fee: 5000, preBalances: [], postBalances: [] };
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
    meta,
  };
}

/** Every node in the located tree, at every depth, ascending by `order`. */
function allNodes(roots: readonly InstructionNode[]): readonly InstructionNode[] {
  const flat: InstructionNode[] = [];
  const stack = [...roots].reverse();
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    flat.push(next);
    for (const child of [...next.inner].reverse()) stack.push(child);
  }
  return flat.sort((a, b) => a.order - b.order);
}

/** Orders of the nodes marked failed, at every depth. */
function failedOrders(roots: readonly InstructionNode[]): readonly number[] {
  return allNodes(roots)
    .filter((child) => child.failed)
    .map((child) => child.order);
}

// ---------------------------------------------------------------------------
// Requirements 5.1, 5.2 — an in-range index marks exactly one top-level node
// ---------------------------------------------------------------------------

describe('locateFailure with an in-range InstructionError index', () => {
  it('marks exactly the named top-level node and no other node at any depth', () => {
    const located = locateFailure(response({ InstructionError: [1, { Custom: 6040 }] }), tree());

    expect(failedOrders(located.instructions)).toEqual([3]);
    // The seeded mark on order 0 is gone, so the flag was assigned rather than
    // merged, and the mark did not migrate to order 4 or 5 beneath the target.
    expect(allNodes(located.instructions)).toHaveLength(6);
  });

  it('records the index verbatim and hands the failing program and detail onward', () => {
    const located = locateFailure(response({ InstructionError: [1, { Custom: 6040 }] }), tree());

    expect(located.failure).toEqual({
      failingInstructionIndex: 1,
      indexOutOfRange: false,
      failingProgramId: 'Program3',
      errorDetail: { Custom: 6040 },
      cpiAttribution: null,
    });
  });

  it('accepts a bare-string detail, as built-in runtime failures spell it', () => {
    const located = locateFailure(
      response({ InstructionError: [0, 'InvalidAccountData'] }),
      tree(),
    );

    expect(failedOrders(located.instructions)).toEqual([0]);
    expect(located.failure?.errorDetail).toBe('InvalidAccountData');
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.4 — an index naming no instruction is preserved, not clamped
// ---------------------------------------------------------------------------

describe('locateFailure with an out-of-range InstructionError index', () => {
  it('preserves the value, flags it, and marks nothing at any depth', () => {
    const located = locateFailure(response({ InstructionError: [7, { Custom: 1 }] }), tree());

    expect(located.failure).toEqual({
      failingInstructionIndex: 7,
      indexOutOfRange: true,
      failingProgramId: null,
      errorDetail: { Custom: 1 },
      cpiAttribution: null,
    });
    expect(failedOrders(located.instructions)).toEqual([]);
  });

  it('does not clamp to the last top-level instruction', () => {
    const located = locateFailure(response({ InstructionError: [2, { Custom: 1 }] }), tree());

    // Two top-level instructions, so index 2 is one past the end — the value a
    // clamp would quietly turn into the real index 1.
    expect(located.failure?.failingInstructionIndex).toBe(2);
    expect(located.failure?.indexOutOfRange).toBe(true);
    expect(failedOrders(located.instructions)).toEqual([]);
  });

  it('treats a negative index the same way, value intact', () => {
    const located = locateFailure(response({ InstructionError: [-1, { Custom: 1 }] }), tree());

    expect(located.failure?.failingInstructionIndex).toBe(-1);
    expect(located.failure?.indexOutOfRange).toBe(true);
    expect(failedOrders(located.instructions)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.3 — success clears every mark
// ---------------------------------------------------------------------------

describe('locateFailure on a successful transaction', () => {
  it('reports no failure and forces failed false on every node, overriding earlier marks', () => {
    const located = locateFailure(response(null), tree());

    expect(located.failure).toBeNull();
    expect(failedOrders(located.instructions)).toEqual([]);
    expect(allNodes(located.instructions).every((child) => child.failed === false)).toBe(true);
  });

  it('treats absent metadata as no recorded failure', () => {
    const withoutMeta: RawTransactionResponse = { ...response(null), meta: null };

    const located = locateFailure(withoutMeta, tree());

    expect(located.failure).toBeNull();
    expect(failedOrders(located.instructions)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error payloads that carry no instruction index
// ---------------------------------------------------------------------------

describe('locateFailure with a non-InstructionError payload', () => {
  it('reports the failure without an index and marks nothing, for a string variant', () => {
    const located = locateFailure(response('AlreadyProcessed'), tree());

    expect(located.failure).toEqual({
      failingInstructionIndex: null,
      indexOutOfRange: false,
      failingProgramId: null,
      errorDetail: null,
      cpiAttribution: null,
    });
    expect(failedOrders(located.instructions)).toEqual([]);
  });

  it('does the same for another object variant', () => {
    const located = locateFailure(response({ DuplicateInstruction: 3 }), tree());

    expect(located.failure?.failingInstructionIndex).toBeNull();
    expect(located.failure?.indexOutOfRange).toBe(false);
    expect(failedOrders(located.instructions)).toEqual([]);
  });

  it('does the same for an InstructionError whose index is not a number', () => {
    // Untrusted input: the declared tuple shape describes a well-behaved node,
    // not what actually arrived.
    const malformed = { InstructionError: ['0', { Custom: 1 }] } as unknown as RawTransactionError;

    const located = locateFailure(response(malformed), tree());

    expect(located.failure?.failingInstructionIndex).toBeNull();
    expect(failedOrders(located.instructions)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.5 — the Phase 2 deferral, on every path
// ---------------------------------------------------------------------------

describe('locateFailure cpiAttribution', () => {
  it('is null on every report, in-range, out-of-range, or index-less', () => {
    const payloads: readonly RawTransactionError[] = [
      { InstructionError: [0, { Custom: 6040 }] },
      { InstructionError: [9, { Custom: 6040 }] },
      { DuplicateInstruction: 3 },
      'AlreadyProcessed',
    ];

    for (const payload of payloads) {
      const located = locateFailure(response(payload), tree());
      expect(located.failure).not.toBeNull();
      expect(located.failure?.cpiAttribution).toBeNull();
    }
  });
});
