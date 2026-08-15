/**
 * Unit tests for `assembleAnalysis` — the two guarantees it alone owns.
 *
 * Ordering and confidence propagation are both properties of the *whole*
 * assembled object, so neither can be checked at any earlier stage. The
 * propagation cases are written as the smallest trees that distinguish the rule
 * from its plausible near-misses: a plain minimum over children (which would
 * drop a container to `raw`) and an unconditional floor (which would upgrade a
 * container that is itself `raw`).
 */

import { describe, expect, it } from 'vitest';

import { assembleAnalysis, type AnalysisInput } from '../../src/analyze/assemble.js';
import type {
  AccountEntry,
  AccountRef,
  Confidence,
  InstructionDecode,
  InstructionNode,
  LamportBalanceChange,
  TokenBalanceChange,
} from '../../src/model/analysis.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const FULL_DECODE: InstructionDecode = {
  kind: 'full',
  name: 'transfer',
  source: 'builtin',
  fields: [],
  confidence: 'full',
};

const RAW_DECODE: InstructionDecode = {
  kind: 'raw',
  name: 'Unknown',
  note: 'Unknown program',
  rawInstructionData: { label: 'raw_instruction_data', hex: '0x00', byteLength: 1, truncated: false },
  errorDetail: null,
  confidence: 'raw',
};

function node(overrides: Partial<InstructionNode> & { readonly order: number }): InstructionNode {
  return {
    depth: 0,
    parentOrder: null,
    programId: 'Program1111111111111111111111111111111111111',
    programName: null,
    decode: FULL_DECODE,
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

function resolvedAccount(index: number, confidence: Confidence): AccountRef {
  return {
    kind: 'resolved',
    index,
    address: 'Account11111111111111111111111111111111111',
    signer: false,
    role: 'readonly',
    origin: { kind: 'static' },
    name: null,
    confidence,
  };
}

function accountEntry(index: number, referencedBy: readonly number[] = []): AccountEntry {
  return {
    index,
    address: `Account${index}`,
    signer: false,
    role: 'readonly',
    origin: { kind: 'static' },
    referencedBy,
    name: null,
    confidence: 'full',
  };
}

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    signature: 'Signature1111111111111111111111111111111111',
    messageVersion: 'legacy',
    outcome: { succeeded: true, error: null },
    accountKeys: [],
    instructions: [],
    failure: null,
    lamportBalances: [],
    tokenBalances: [],
    compute: { total: { available: false, confidence: 'raw' } },
    logs: { messages: [], present: false, truncated: false, unattributed: [], confidence: 'raw' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ordering — Requirements 9.1, 9.6
// ---------------------------------------------------------------------------

describe('assembleAnalysis ordering', () => {
  it('sorts account keys by index and their referencedBy ascending', () => {
    const analysis = assembleAnalysis(
      input({ accountKeys: [accountEntry(2, [5, 1]), accountEntry(0), accountEntry(1)] }),
    );

    expect(analysis.accountKeys.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(analysis.accountKeys[2]?.referencedBy).toEqual([1, 5]);
  });

  it('sorts top-level instructions and nested instructions by order', () => {
    const analysis = assembleAnalysis(
      input({
        instructions: [
          node({ order: 3 }),
          node({
            order: 0,
            inner: [node({ order: 2, depth: 1 }), node({ order: 1, depth: 1 })],
          }),
        ],
      }),
    );

    expect(analysis.instructions.map((n) => n.order)).toEqual([0, 3]);
    expect(analysis.instructions[0]?.inner.map((n) => n.order)).toEqual([1, 2]);
  });

  it('sorts lamport balances by account index', () => {
    const balance = (accountIndex: number): LamportBalanceChange => ({
      kind: 'post-only',
      accountIndex,
      address: `Account${accountIndex}`,
      post: '1',
      confidence: 'partial',
    });

    const analysis = assembleAnalysis(
      input({ lamportBalances: [balance(4), balance(0), balance(2)] }),
    );

    expect(analysis.lamportBalances.map((b) => b.accountIndex)).toEqual([0, 2, 4]);
  });

  it('sorts token balances by account index then mint', () => {
    const balance = (accountIndex: number, mint: string): TokenBalanceChange => ({
      accountIndex,
      address: `Account${accountIndex}`,
      mint,
      pre: null,
      post: null,
      delta: { mint, raw: '0', decimals: { known: false } },
      lifecycle: 'existing',
      confidence: 'partial',
    });

    const analysis = assembleAnalysis(
      input({
        tokenBalances: [balance(1, 'Zmint'), balance(0, 'Bmint'), balance(1, 'Amint')],
      }),
    );

    expect(analysis.tokenBalances.map((b) => [b.accountIndex, b.mint])).toEqual([
      [0, 'Bmint'],
      [1, 'Amint'],
      [1, 'Zmint'],
    ]);
  });

  it('leaves log messages in RPC order', () => {
    const messages = ['Program log: second', 'Program log: first'];
    const analysis = assembleAnalysis(
      input({
        logs: { messages, present: true, truncated: false, unattributed: [], confidence: 'full' },
      }),
    );

    expect(analysis.logs.messages).toEqual(messages);
  });
});

// ---------------------------------------------------------------------------
// Confidence propagation — Requirements 11.2, 11.4
// ---------------------------------------------------------------------------

describe('assembleAnalysis confidence propagation', () => {
  it('caps a container with a raw decode at partial rather than dropping it to raw', () => {
    const analysis = assembleAnalysis(
      input({ instructions: [node({ order: 0, decode: RAW_DECODE })] }),
    );

    expect(analysis.instructions[0]?.confidence).toBe('partial');
    // The child keeps its own marker; only its pull on the parent is bounded.
    expect(analysis.instructions[0]?.decode.confidence).toBe('raw');
  });

  it('caps a container with an unresolved account reference at partial', () => {
    const analysis = assembleAnalysis(
      input({
        instructions: [
          node({
            order: 0,
            accounts: [
              resolvedAccount(0, 'full'),
              { kind: 'unresolved', index: 9, reason: 'out of range', confidence: 'raw' },
            ],
          }),
        ],
      }),
    );

    expect(analysis.instructions[0]?.confidence).toBe('partial');
  });

  it('never upgrades a container that is itself raw', () => {
    const analysis = assembleAnalysis(
      input({
        instructions: [
          node({
            order: 0,
            confidence: 'raw',
            inner: [node({ order: 1, depth: 1, parentOrder: 0 })],
          }),
        ],
      }),
    );

    expect(analysis.instructions[0]?.confidence).toBe('raw');
  });

  it('propagates a raw grandchild up to every enclosing container', () => {
    const analysis = assembleAnalysis(
      input({
        instructions: [
          node({
            order: 0,
            inner: [
              node({
                order: 1,
                depth: 1,
                parentOrder: 0,
                inner: [node({ order: 2, depth: 2, parentOrder: 1, decode: RAW_DECODE })],
              }),
            ],
          }),
        ],
      }),
    );

    const top = analysis.instructions[0];
    expect(top?.confidence).toBe('partial');
    expect(top?.inner[0]?.confidence).toBe('partial');
    expect(top?.inner[0]?.inner[0]?.confidence).toBe('partial');
  });

  it('leaves the log report confidence alone when nothing is attributed', () => {
    const analysis = assembleAnalysis(
      input({
        logs: {
          messages: ['log truncated'],
          present: true,
          truncated: true,
          unattributed: [],
          confidence: 'partial',
        },
      }),
    );

    expect(analysis.logs.confidence).toBe('partial');
  });

  it('does not fold computeUnits or attributed logs into a node marker', () => {
    // Both are `raw`/`partial` in v1 by deferral rather than by a decode
    // failure, so folding them would cap every node in every transaction.
    const analysis = assembleAnalysis(
      input({
        instructions: [
          node({
            order: 0,
            computeUnits: { available: false, confidence: 'raw' },
            logs: [{ index: 0, message: 'Program log: hello', confidence: 'partial' }],
          }),
        ],
      }),
    );

    expect(analysis.instructions[0]?.confidence).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Unbounded depth — Requirement 3.6
// ---------------------------------------------------------------------------

describe('assembleAnalysis over a deep tree', () => {
  it('rewrites a chain far deeper than the call stack would allow', () => {
    const depth = 20_000;
    let chain = node({ order: depth, depth, parentOrder: depth - 1, decode: RAW_DECODE });
    for (let level = depth - 1; level >= 1; level -= 1) {
      chain = node({ order: level, depth: level, parentOrder: level - 1, inner: [chain] });
    }
    const root = node({ order: 0, inner: [chain] });

    const analysis = assembleAnalysis(input({ instructions: [root] }));

    // The single raw leaf at the bottom is visible at the top.
    expect(analysis.instructions[0]?.confidence).toBe('partial');
  });
});
