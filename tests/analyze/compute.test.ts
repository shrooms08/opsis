/**
 * Unit tests for `analyzeCompute`.
 *
 * Three things are checked here that nothing else can check: that a genuine `0`
 * survives as a measurement rather than collapsing into an absence, that the
 * `available: false` variant carries **no `value` key** when serialized (Req
 * 8.2 asks for the absence of the key, and `value === undefined` would also hold
 * for a variant that carried the key holding `undefined`), and that every path
 * which cannot establish the scope alignment refuses to pair rather than
 * guessing positionally.
 *
 * The fixture block at the end is the evidence for the module's documented
 * deviation from design.md — it measures the outermost-scope count against the
 * top-level instruction count on all six recorded responses. It reads
 * `input.json` only and writes nothing; the full golden output belongs to task 9.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeCompute, readTotalComputeUnits } from '../../src/analyze/compute.js';
import type { InstructionDecode, InstructionNode } from '../../src/model/analysis.js';
import type { RawMeta, RawTransactionResponse } from '../../src/model/rawResponse.js';
import type { FailureLocation } from '../../src/resolve/failure.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DECODE: InstructionDecode = {
  kind: 'raw',
  name: 'Unknown',
  note: 'Unknown program',
  rawInstructionData: {
    label: 'raw_instruction_data',
    hex: '0x',
    byteLength: 0,
    truncated: false,
  },
  errorDetail: null,
  confidence: 'raw',
};

/**
 * A distinct base58 program id of address length, tagged by its first character
 * so a log line and the node it should land on are legible side by side.
 */
function pid(tag: string): string {
  return tag + '1'.repeat(43);
}

function node(
  order: number,
  options: { readonly depth?: number; readonly inner?: readonly InstructionNode[] } = {},
): InstructionNode {
  const depth = options.depth ?? 0;
  return {
    order,
    depth,
    parentOrder: depth === 0 ? null : 0,
    programId: pid('A'),
    programName: null,
    decode: DECODE,
    accounts: [],
    failed: false,
    valid: true,
    invalidReason: null,
    // The tree builder's placeholder. Every assertion below is about what
    // `analyzeCompute` replaces it with, so it must not already be the answer.
    computeUnits: { available: false, confidence: 'raw' },
    logs: [],
    inner: options.inner ?? [],
    confidence: 'raw',
  };
}

/** `count` top-level nodes, ordered `0..count-1`. */
function topLevel(count: number): readonly InstructionNode[] {
  return Array.from({ length: count }, (_, index) => node(index));
}

function response(meta: Partial<RawMeta> | null): RawTransactionResponse {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: ['sig'],
      message: { accountKeys: [], header: EMPTY_HEADER, instructions: [], recentBlockhash: 'bh' },
    },
    meta: meta === null ? null : (meta as RawMeta),
  } as RawTransactionResponse;
}

const EMPTY_HEADER = {
  numRequiredSignatures: 1,
  numReadonlySignedAccounts: 0,
  numReadonlyUnsignedAccounts: 0,
};

const invoke = (tag: string, depth: number): string =>
  `Program ${pid(tag)} invoke [${depth}]`;
const ok = (tag: string): string => `Program ${pid(tag)} success`;
const failed = (tag: string): string => `Program ${pid(tag)} failed: custom program error: 0x1`;
const consumed = (tag: string, units: number): string =>
  `Program ${pid(tag)} consumed ${units} of 200000 compute units`;

/** A failure at `index`, as `locateFailure` would report it. */
function failureAt(index: number | null, outOfRange = false): FailureLocation {
  return {
    failingInstructionIndex: index,
    indexOutOfRange: outOfRange,
    failingProgramId: null,
    errorDetail: null,
    cpiAttribution: null,
  };
}

/** The per-instruction values in `order`, with `null` for an absent value. */
function values(instructions: readonly InstructionNode[]): readonly (number | null)[] {
  return instructions.map((n) => (n.computeUnits.available ? n.computeUnits.value : null));
}

// ---------------------------------------------------------------------------
// The transaction total — Requirements 8.1, 8.2, 8.4, 8.5
// ---------------------------------------------------------------------------

describe('the transaction total', () => {
  it('is read verbatim from meta.computeUnitsConsumed', () => {
    const total = readTotalComputeUnits(response({ computeUnitsConsumed: 109350 }));
    expect(total).toEqual({ available: true, value: 109350, confidence: 'full' });
  });

  it('reports a genuine zero as 0, distinguishably from an absent value', () => {
    const zero = readTotalComputeUnits(response({ computeUnitsConsumed: 0 }));
    const absent = readTotalComputeUnits(response({}));

    // Req 8.4: zero is a measurement. Req 8.2: absence is the other variant.
    expect(zero).toEqual({ available: true, value: 0, confidence: 'full' });
    expect(zero.available).toBe(true);
    expect(absent.available).toBe(false);
    expect(zero).not.toEqual(absent);
  });

  it('reports an absent value as available: false at raw confidence', () => {
    expect(readTotalComputeUnits(response({}))).toEqual({
      available: false,
      confidence: 'raw',
    });
    expect(readTotalComputeUnits(response(null))).toEqual({
      available: false,
      confidence: 'raw',
    });
  });

  it('rejects a value that is not a non-negative integer rather than reporting zero', () => {
    // All reachable out of `JSON.parse` despite what `RawMeta` declares.
    for (const raw of [-1, 1.5, Number.NaN, '5', null]) {
      const total = readTotalComputeUnits(
        response({ computeUnitsConsumed: raw as unknown as number }),
      );
      expect(total).toEqual({ available: false, confidence: 'raw' });
    }
  });

  it('is not cross-checked against the sum of the per-instruction values', () => {
    // Req 8.5. The total here is nowhere near the sum of 10 + 20, because
    // transaction-level overhead is not attributed to any instruction. Nothing
    // is adjusted, and no path reports a problem.
    const logs = [
      invoke('A', 1),
      consumed('A', 10),
      ok('A'),
      invoke('B', 1),
      consumed('B', 20),
      ok('B'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 999_999, logMessages: logs, err: null }),
      topLevel(2),
      null,
    );

    expect(result.compute.total).toEqual({ available: true, value: 999_999, confidence: 'full' });
    expect(values(result.instructions)).toEqual([10, 20]);
    expect(result.alignment.kind).toBe('aligned');
  });

  it('is reported even when the per-instruction alignment degrades entirely', () => {
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 4242, err: null }),
      topLevel(2),
      null,
    );

    expect(result.compute.total).toEqual({ available: true, value: 4242, confidence: 'full' });
    expect(result.alignment).toMatchObject({ kind: 'degraded', reason: 'logs-absent' });
  });
});

// ---------------------------------------------------------------------------
// Positional attribution — Requirement 8.1
// ---------------------------------------------------------------------------

describe('positional attribution', () => {
  it('pairs the k-th outermost scope with the k-th top-level instruction', () => {
    const logs = [
      invoke('A', 1),
      consumed('A', 17913),
      ok('A'),
      invoke('B', 1),
      // A genuine zero at instruction level, reported as 0 (Req 8.4).
      consumed('B', 0),
      ok('B'),
      invoke('C', 1),
      consumed('C', 118),
      ok('C'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 18_500, logMessages: logs, err: null }),
      topLevel(3),
      null,
    );

    expect(result.alignment).toEqual({
      kind: 'aligned',
      scopeCount: 3,
      expectedScopeCount: 3,
      executedCount: 3,
    });
    expect(values(result.instructions)).toEqual([17913, 0, 118]);
    expect(result.instructions[1]?.computeUnits).toEqual({
      available: true,
      value: 0,
      confidence: 'full',
    });
    expect(result.unattributed).toEqual([]);
  });

  it('records no-compute-line for a scope that emitted no consumed line', () => {
    // Native loader programs routinely do not; both ComputeBudget instructions
    // in every recorded fixture behave this way.
    const logs = [invoke('A', 1), ok('A'), invoke('B', 1), consumed('B', 55), ok('B')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 205, logMessages: logs, err: null }),
      topLevel(2),
      null,
    );

    expect(values(result.instructions)).toEqual([null, 55]);
    expect(result.unattributed).toEqual([{ order: 0, reason: 'no-compute-line' }]);
  });

  it('takes the scope own consumed line, not a nested invocation of the same program', () => {
    // The `01-success-cpi-heavy` shape: the top-level program appears again at
    // depth 2, and both invocations emit a consumed line naming the same id.
    // The outer instruction must take 91019, never the inner 106.
    const logs = [
      invoke('J', 1),
      invoke('J', 2),
      consumed('J', 106),
      ok('J'),
      consumed('J', 91019),
      `Program return: ${pid('J')} vc96DgAAAAA=`,
      ok('J'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 91_319, logMessages: logs, err: null }),
      topLevel(1),
      null,
    );

    expect(values(result.instructions)).toEqual([91019]);
  });
});

// ---------------------------------------------------------------------------
// The truncated tail — the documented deviation from design.md
// ---------------------------------------------------------------------------

describe('a failed transaction with an unexecuted tail', () => {
  it('attributes scopes 0..failingIndex and marks the rest never-executed', () => {
    // Four top-level instructions, failure at index 1, so only two scopes exist:
    // the runtime halted and instructions 2 and 3 never ran.
    const logs = [
      invoke('A', 1),
      consumed('A', 150),
      ok('A'),
      invoke('B', 1),
      consumed('B', 75237),
      failed('B'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 75_837, logMessages: logs }),
      topLevel(4),
      failureAt(1),
    );

    expect(result.alignment).toEqual({
      kind: 'aligned',
      scopeCount: 2,
      expectedScopeCount: 2,
      executedCount: 2,
    });
    expect(values(result.instructions)).toEqual([150, 75237, null, null]);
    // "never executed" is a fact about the runtime and gets its own wording; it
    // is not the same claim as "this tool did not attribute a value".
    expect(result.unattributed).toEqual([
      { order: 2, reason: 'never-executed' },
      { order: 3, reason: 'never-executed' },
    ]);
  });

  it('accepts a failure in the final instruction, where both rules agree', () => {
    // The `04-unattested-band-collision` shape: failingIndex + 1 equals the
    // instruction count, so design.md's flat equality also holds.
    const logs = [invoke('A', 1), ok('A'), invoke('B', 1), consumed('B', 68670), failed('B')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 69_420, logMessages: logs }),
      topLevel(2),
      failureAt(1),
    );

    expect(result.alignment.kind).toBe('aligned');
    expect(values(result.instructions)).toEqual([null, 68670]);
  });
});

// ---------------------------------------------------------------------------
// Refusing to guess — Requirement 8.2
// ---------------------------------------------------------------------------

describe('an alignment that cannot be established', () => {
  /** Every top-level node unavailable, every one blamed on the alignment. */
  function expectFullyDegraded(
    result: ReturnType<typeof analyzeCompute>,
    reason: string,
    count: number,
  ): void {
    expect(result.alignment).toMatchObject({ kind: 'degraded', reason });
    expect(values(result.instructions)).toEqual(Array.from({ length: count }, () => null));
    expect(result.unattributed).toEqual(
      Array.from({ length: count }, (_, order) => ({ order, reason: 'alignment-unknown' })),
    );
  }

  it('degrades every top-level node on an unbalanced marker sequence', () => {
    // `A` opens and never closes; `B` opens inside it and closes. The sequence is
    // broken, so the two scopes cannot be trusted to mean what their order says.
    const logs = [invoke('A', 1), invoke('B', 1), consumed('B', 500), ok('B')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, logMessages: logs, err: null }),
      topLevel(2),
      null,
    );

    expectFullyDegraded(result, 'unbalanced-scopes', 2);
  });

  it('degrades every top-level node on a truncated log array', () => {
    const logs = [invoke('A', 1), consumed('A', 150), ok('A'), invoke('B', 1), 'log truncated'];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, logMessages: logs, err: null }),
      topLevel(2),
      null,
    );

    // Truncation settles the question before the markers are read: `A` looks
    // perfectly well-formed, and is still not paired.
    expectFullyDegraded(result, 'logs-truncated', 2);
  });

  it('degrades every top-level node when the log array is absent', () => {
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, err: null }),
      topLevel(2),
      null,
    );
    expectFullyDegraded(result, 'logs-absent', 2);
  });

  it('degrades when the scope count matches neither expectation', () => {
    // Three instructions, failure at index 0 — so one scope is expected and
    // three would be expected on success. Two matches neither.
    const logs = [
      invoke('A', 1),
      consumed('A', 10),
      ok('A'),
      invoke('B', 1),
      consumed('B', 20),
      ok('B'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, logMessages: logs }),
      topLevel(3),
      failureAt(0),
    );

    expect(result.alignment).toEqual({
      kind: 'degraded',
      reason: 'scope-count-mismatch',
      scopeCount: 2,
      expectedScopeCount: 1,
    });
    expectFullyDegraded(result, 'scope-count-mismatch', 3);
  });

  it('degrades on an out-of-range failing index', () => {
    const logs = [invoke('A', 1), consumed('A', 10), ok('A')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, logMessages: logs }),
      topLevel(1),
      failureAt(9, true),
    );

    expectFullyDegraded(result, 'failing-index-out-of-range', 1);
  });

  it('degrades when the failure names no instruction index', () => {
    // `"AlreadyProcessed"` and friends: the transaction failed, but where
    // execution stopped is exactly what the payload does not say.
    const logs = [invoke('A', 1), consumed('A', 10), ok('A')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 700, logMessages: logs }),
      topLevel(1),
      failureAt(null),
    );

    expectFullyDegraded(result, 'failing-index-absent', 1);
  });
});

// ---------------------------------------------------------------------------
// Nested instructions — the Phase 2 deferral
// ---------------------------------------------------------------------------

describe('nested instructions', () => {
  it('are available: false at raw confidence with no value key, even with a consumed line', () => {
    const child = node(1, { depth: 1 });
    const grandchild = node(2, { depth: 2 });
    const parent = node(0, { inner: [{ ...child, inner: [grandchild] }] });

    const logs = [
      invoke('A', 1),
      invoke('B', 2),
      // A real nested consumed line, present in the stream and deliberately not
      // attributed: placing it correctly is the Phase 2 work.
      consumed('B', 6024),
      ok('B'),
      consumed('A', 75237),
      ok('A'),
    ];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 75_837, logMessages: logs, err: null }),
      [parent],
      null,
    );

    const top = result.instructions[0];
    const nested = top?.inner[0];
    const deep = nested?.inner[0];

    expect(top?.computeUnits).toEqual({ available: true, value: 75237, confidence: 'full' });
    expect(nested?.computeUnits).toEqual({ available: false, confidence: 'raw' });
    expect(deep?.computeUnits).toEqual({ available: false, confidence: 'raw' });

    // Req 8.2 asks for the absence of the key, not for an undefined value. Both
    // the own-property check and the serialized form are asserted, because
    // `value === undefined` would pass on a variant that carried the key.
    expect(Object.hasOwn(nested?.computeUnits ?? {}, 'value')).toBe(false);
    expect(JSON.stringify(nested?.computeUnits)).toBe('{"available":false,"confidence":"raw"}');
    expect(JSON.stringify(deep?.computeUnits)).not.toContain('value');
  });

  it('are not listed in unattributed, which covers top-level nodes only', () => {
    const parent = node(0, { inner: [node(1, { depth: 1 })] });
    const logs = [invoke('A', 1), invoke('B', 2), ok('B'), consumed('A', 42), ok('A')];
    const result = analyzeCompute(
      response({ computeUnitsConsumed: 100, logMessages: logs, err: null }),
      [parent],
      null,
    );

    expect(result.unattributed).toEqual([]);
    expect(result.instructions[0]?.inner[0]?.computeUnits.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The recorded fixtures — evidence for the deviation from design.md
// ---------------------------------------------------------------------------

describe('the six recorded fixtures', () => {
  interface Measured {
    readonly topLevelCount: number;
    readonly scopeCount: number;
    readonly failingIndex: number | null;
    readonly result: ReturnType<typeof analyzeCompute>;
  }

  function measure(name: string): Measured {
    const raw = JSON.parse(
      readFileSync(`tests/golden/${name}/input.json`, 'utf8'),
    ) as RawTransactionResponse;

    const count = raw.transaction.message.instructions.length;
    const err: unknown = raw.meta?.err ?? null;
    let failure: FailureLocation | null = null;
    if (err !== null) {
      const tuple = (err as Record<string, unknown>)['InstructionError'];
      const index = Array.isArray(tuple) && typeof tuple[0] === 'number' ? tuple[0] : null;
      failure = failureAt(index, index !== null && index >= count);
    }

    const result = analyzeCompute(raw, topLevel(count), failure);
    return {
      topLevelCount: count,
      scopeCount: result.alignment.scopeCount,
      failingIndex: failure?.failingInstructionIndex ?? null,
      result,
    };
  }

  it('align under the expected-count rule where a flat equality holds on only 2 of 6', () => {
    const names = [
      '01-success-cpi-heavy',
      '02-anchor-user-error',
      '03-program-table-error',
      '04-unattested-band-collision',
      '06-nested-cpi-failure',
      '07-unknown-program',
    ];
    const measured = names.map((name) => measure(name));

    // The module comment's table, asserted rather than asserted-to-have-been-true.
    expect(measured.map((m) => [m.topLevelCount, m.scopeCount, m.failingIndex])).toEqual([
      [5, 5, null],
      [7, 5, 4],
      [9, 4, 3],
      [6, 6, 5],
      [6, 4, 3],
      [5, 3, 2],
    ]);

    // design.md's flat equality: 2 of 6. This is the measurement the deviation
    // rests on, and it fails loudly if a future recording changes it.
    expect(measured.filter((m) => m.scopeCount === m.topLevelCount)).toHaveLength(2);

    // The expected-count rule: 6 of 6, so no fixture loses its compute values.
    for (const m of measured) expect(m.result.alignment.kind).toBe('aligned');
  });

  it('pin the per-instruction values on the fixture with a same-program nested call', () => {
    const { result } = measure('01-success-cpi-heavy');

    // Instruction 3 is the JUP6 route, which invokes itself again at depth 2.
    // 91019 is its own line; 106 belongs to the nested invocation.
    expect(values(result.instructions)).toEqual([null, null, 17913, 91019, 118]);
    expect(result.compute.total).toEqual({ available: true, value: 109350, confidence: 'full' });

    // Req 8.5, on real data: 17913 + 91019 + 118 = 109050, and the total is 300
    // higher. The two are not expected to agree.
    expect(17913 + 91019 + 118).not.toBe(109350);
  });

  it('mark the unexecuted tail of a failed fixture never-executed', () => {
    const { result } = measure('02-anchor-user-error');

    expect(values(result.instructions)).toEqual([null, null, null, null, 75237, null, null]);
    expect(result.unattributed.filter((u) => u.reason === 'never-executed')).toEqual([
      { order: 5, reason: 'never-executed' },
      { order: 6, reason: 'never-executed' },
    ]);
  });
});
