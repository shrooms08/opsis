/**
 * Unit tests for `captureLogs` and `walkLogScopes`. Requirements 21.1, 21.5,
 * 21.6, and the scope structure Requirement 8's compute attribution rests on.
 *
 * Nothing else tests this module directly. `analyze/compute.test.ts` exercises
 * the walker incidentally — it asserts what `analyzeCompute` concluded, which is
 * a statement about alignment and compute values, not about the scopes
 * themselves. So the facts pinned here are the ones a compute assertion cannot
 * distinguish: the exact `openIndex`/`closeIndex`/`lineIndices` of each scope,
 * that the assignment of a line to a scope is exclusive, and that an unbalanced
 * sequence leaves `closeIndex` null rather than borrowing a neighbour's marker.
 *
 * The verbatim-copy block is deliberate and named: log conservation (design.md
 * property 29) quantifies over attributed messages and is Phase 2, so v1's
 * standing guarantee is the weaker exact one — `LogReport.messages` equals
 * `meta.logMessages` element for element, in order. It is asserted over all six
 * recorded responses rather than over a constructed array, because the claim is
 * about real recorded data passing through unchanged.
 *
 * Recorded fixtures where the assertion is about real logs; synthetic arrays for
 * the shapes no recording contains — a truncated array, an unbalanced marker
 * sequence, a forged depth, marker-shaped program output.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RawMeta, RawTransactionResponse } from '../../src/model/rawResponse.js';
import { captureLogs, walkLogScopes, type LogScope } from '../../src/resolve/logs.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A distinct base58 program id of address length, tagged by its first character. */
function pid(tag: string): string {
  return tag + '1'.repeat(43);
}

const invoke = (tag: string, depth: number): string => `Program ${pid(tag)} invoke [${depth}]`;
const ok = (tag: string): string => `Program ${pid(tag)} success`;
const failed = (tag: string): string => `Program ${pid(tag)} failed: custom program error: 0x1`;

/** The runtime's own truncation line, the only truncation signal there is. */
const TRUNCATED = 'log truncated';

function response(meta: Partial<RawMeta> | null): RawTransactionResponse {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [],
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions: [],
        recentBlockhash: 'bh',
      },
    },
    meta: meta === null ? null : (meta as RawMeta),
  } as RawTransactionResponse;
}

const FIXTURE_NAMES = [
  '01-success-cpi-heavy',
  '02-anchor-user-error',
  '03-program-table-error',
  '04-unattested-band-collision',
  '06-nested-cpi-failure',
  '07-unknown-program',
] as const;

function fixture(name: string): RawTransactionResponse {
  return JSON.parse(readFileSync(`tests/golden/${name}/input.json`, 'utf8')) as RawTransactionResponse;
}

/** The recorded log array of a fixture, which every one of the six has. */
function recordedLogs(name: string): readonly string[] {
  const raw = fixture(name).meta?.logMessages;
  if (raw === undefined || raw === null) {
    throw new Error(`${name} was expected to carry a recorded log array`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The collection confidence — Requirements 21.5, 21.6
// ---------------------------------------------------------------------------

describe('captureLogs collection confidence', () => {
  it('is full when logMessages is present and untruncated', () => {
    expect(captureLogs(response({ logMessages: [invoke('A', 1), ok('A')] }))).toEqual({
      messages: [invoke('A', 1), ok('A')],
      present: true,
      truncated: false,
      unattributed: [],
      confidence: 'full',
    });
  });

  it('is partial when the array ends with the runtime truncation line', () => {
    // Truncation is reported inside the array; there is no metadata flag to read.
    expect(captureLogs(response({ logMessages: [invoke('A', 1), TRUNCATED] }))).toEqual({
      messages: [invoke('A', 1), TRUNCATED],
      present: true,
      truncated: true,
      unattributed: [],
      confidence: 'partial',
    });
  });

  it('is raw when logMessages is absent', () => {
    expect(captureLogs(response({}))).toEqual({
      messages: [],
      present: false,
      truncated: false,
      unattributed: [],
      confidence: 'raw',
    });
  });

  it('treats an explicit null array and a null meta as the same absence', () => {
    const absent = captureLogs(response({}));
    expect(captureLogs(response({ logMessages: null as unknown as string[] }))).toEqual(absent);
    expect(captureLogs(response(null))).toEqual(absent);
  });

  it('is full for a present but empty array, which is not an absence', () => {
    const report = captureLogs(response({ logMessages: [] }));
    expect({ present: report.present, confidence: report.confidence }).toEqual({
      present: true,
      confidence: 'full',
    });
  });

  it('reads truncation from the final line only, so program output cannot claim it', () => {
    // A program is free to write the truncation text into the stream. Reading it
    // anywhere but last would let a program describe the completeness of data it
    // does not control.
    const report = captureLogs(
      response({ logMessages: [`Program log: ${TRUNCATED}`, TRUNCATED.toUpperCase(), ok('A')] }),
    );
    expect({ truncated: report.truncated, confidence: report.confidence }).toEqual({
      truncated: false,
      confidence: 'full',
    });
  });

  it('accepts the runtime line with surrounding whitespace or different case', () => {
    for (const line of ['  log truncated ', 'Log Truncated']) {
      expect(captureLogs(response({ logMessages: [ok('A'), line] })).truncated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Verbatim copy — Requirement 21.1, and v1's stand-in for log conservation
// ---------------------------------------------------------------------------

describe('captureLogs is a verbatim copy', () => {
  it('equals meta.logMessages element for element, in order, on all six fixtures', () => {
    for (const name of FIXTURE_NAMES) {
      const recorded = recordedLogs(name);
      const { messages } = captureLogs(fixture(name));

      // Length first: nothing lost and nothing duplicated.
      expect(messages).toHaveLength(recorded.length);
      // Then position by position: nothing reordered and nothing rewritten.
      for (let index = 0; index < recorded.length; index += 1) {
        expect(messages[index]).toBe(recorded[index]);
      }
      // And the whole array at once, which also catches a trailing addition.
      expect(messages).toEqual(recorded);
    }
  });

  it('keeps lines that look like markers, truncation, or nothing at all', () => {
    // `03-program-table-error` records a program writing a bare sentence into the
    // stream. It is content, and content is copied as-is like everything else.
    const recorded = recordedLogs('03-program-table-error');
    const { messages } = captureLogs(fixture('03-program-table-error'));

    expect(messages).toContain('Transfer: insufficient lamports 1588537, need 2039280');
    expect(messages.indexOf('Transfer: insufficient lamports 1588537, need 2039280')).toBe(
      recorded.indexOf('Transfer: insufficient lamports 1588537, need 2039280'),
    );
  });

  it('does not alias the response array', () => {
    const logMessages = [invoke('A', 1), ok('A')];
    const report = captureLogs(response({ logMessages }));

    expect(report.messages).not.toBe(logMessages);
    expect(report.messages).toEqual(logMessages);
  });

  it('attributes nothing and marks nothing in v1', () => {
    // `unattributed` is empty because no line was placed, not because a line was
    // dropped: `messages` already holds every one.
    for (const name of FIXTURE_NAMES) {
      expect(captureLogs(fixture(name)).unattributed).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// walkLogScopes on recorded log arrays
// ---------------------------------------------------------------------------

describe('walkLogScopes on recorded logs', () => {
  it('reports the exact scope structure of the smallest recorded fixture', () => {
    // Seven lines, three top-level invocations, the last one failing.
    const scopes = walkLogScopes(recordedLogs('07-unknown-program'));

    expect(scopes).toEqual<readonly LogScope[]>([
      {
        depth: 1,
        programId: 'ComputeBudget111111111111111111111111111111',
        openIndex: 0,
        closeIndex: 1,
        lineIndices: [],
      },
      {
        depth: 1,
        programId: 'ComputeBudget111111111111111111111111111111',
        openIndex: 2,
        closeIndex: 3,
        lineIndices: [],
      },
      {
        depth: 1,
        programId: '8JyjPyw5JhWwij6SpucNUZg4baLWj6nyGgmgdJX4n9gv',
        openIndex: 4,
        // The failure marker closes the scope exactly as a success marker does.
        closeIndex: 6,
        lineIndices: [5],
      },
    ]);
  });

  it('nests depth-2 scopes inside their caller and keeps each caller consumed line its own', () => {
    // `03-program-table-error`: two top-level ATA invocations wrapping SPL Token
    // and System calls at depth 2, ten scopes in all.
    const scopes = walkLogScopes(recordedLogs('03-program-table-error'));

    expect(scopes.map((scope) => [scope.depth, scope.openIndex, scope.closeIndex])).toEqual([
      [1, 0, 1],
      [1, 2, 3],
      [1, 4, 20],
      [2, 6, 9],
      [2, 10, 11],
      [2, 13, 15],
      [2, 16, 18],
      [1, 21, 31],
      [2, 23, 26],
      [2, 27, 29],
    ]);

    // The first ATA scope emitted lines 5 and 12 itself and consumed line 19 —
    // and none of the lines its four callees emitted, including their consumed
    // lines at 7, 14 and 17. That exclusion is what makes a per-instruction
    // compute value belong to the invocation that spent the units.
    expect(scopes[2]?.lineIndices).toEqual([5, 12, 19]);
    expect(scopes[3]?.lineIndices).toEqual([7, 8]);

    // The bare sentence at line 28 lands on the System scope that emitted it,
    // not on the ATA program that called it.
    expect(scopes[9]?.lineIndices).toEqual([28]);
    expect(scopes[7]?.lineIndices).toEqual([22, 30]);
  });

  it('assigns every line index to at most one scope across all six fixtures', () => {
    for (const name of FIXTURE_NAMES) {
      const scopes = walkLogScopes(recordedLogs(name));
      const markers = new Set<number>();
      for (const scope of scopes) {
        markers.add(scope.openIndex);
        if (scope.closeIndex !== null) markers.add(scope.closeIndex);
      }

      const seen = new Set<number>();
      for (const scope of scopes) {
        for (const index of scope.lineIndices) {
          expect(seen.has(index), `${name}: line ${index} was assigned twice`).toBe(false);
          expect(markers.has(index), `${name}: line ${index} is a marker`).toBe(false);
          seen.add(index);
        }
      }
    }
  });

  it('accounts for every recorded line as a marker or as exactly one scope content line', () => {
    // True of all six because each recording opens a scope before its first line
    // and every marker is balanced. A recording that stopped being so would fail
    // here rather than quietly drop lines out of the partition.
    for (const name of FIXTURE_NAMES) {
      const messages = recordedLogs(name);
      const scopes = walkLogScopes(messages);
      const covered = new Set<number>();
      for (const scope of scopes) {
        covered.add(scope.openIndex);
        if (scope.closeIndex !== null) covered.add(scope.closeIndex);
        for (const index of scope.lineIndices) covered.add(index);
      }

      expect(covered.size, `${name} leaves lines unaccounted for`).toBe(messages.length);
    }
  });

  it('returns scopes ordered by openIndex ascending', () => {
    for (const name of FIXTURE_NAMES) {
      const opens = walkLogScopes(recordedLogs(name)).map((scope) => scope.openIndex);
      expect(opens).toEqual([...opens].sort((left, right) => left - right));
    }
  });
});

// ---------------------------------------------------------------------------
// walkLogScopes on shapes no recording contains
// ---------------------------------------------------------------------------

describe('walkLogScopes on an unbalanced or truncated sequence', () => {
  it('leaves closeIndex null for a scope that never closes', () => {
    const scopes = walkLogScopes([invoke('A', 1)]);

    expect(scopes).toEqual<readonly LogScope[]>([
      { depth: 1, programId: pid('A'), openIndex: 0, closeIndex: null, lineIndices: [] },
    ]);
  });

  it('leaves closeIndex null for an inner scope still open when its caller closes', () => {
    // `B` opens inside `A` and never closes; `A`'s own marker closes `A`. The
    // honest report is that `B`'s boundary is unknown, not that `A`'s marker
    // belonged to it.
    const scopes = walkLogScopes([invoke('A', 1), invoke('B', 2), ok('A')]);

    expect(scopes.map((scope) => [scope.programId, scope.openIndex, scope.closeIndex])).toEqual([
      [pid('A'), 0, 2],
      [pid('B'), 1, null],
    ]);
  });

  it('leaves the open scope unclosed when the array is cut short mid-invocation', () => {
    const scopes = walkLogScopes([invoke('A', 1), ok('A'), invoke('B', 1), TRUNCATED]);

    expect(scopes.map((scope) => [scope.openIndex, scope.closeIndex])).toEqual([
      [0, 1],
      [2, null],
    ]);
    // The truncation line is content of whatever was open, like any other line.
    expect(scopes[1]?.lineIndices).toEqual([3]);
  });

  it('treats a close marker with no matching open as content, or drops it when nothing is open', () => {
    const inside = walkLogScopes([invoke('A', 1), ok('B'), ok('A')]);
    expect(inside).toHaveLength(1);
    expect(inside[0]?.lineIndices).toEqual([1]);

    expect(walkLogScopes([ok('A'), failed('B')])).toEqual([]);
  });

  it('closes the innermost open scope on the id-less failure line', () => {
    const scopes = walkLogScopes([invoke('A', 1), invoke('B', 2), 'Program failed to complete']);

    expect(scopes.map((scope) => [scope.programId, scope.closeIndex])).toEqual([
      [pid('A'), null],
      [pid('B'), 2],
    ]);
  });

  it('reports depth as the marker spelled it, not as the stack height', () => {
    // A forged depth inflates the count of outermost scopes, which is precisely
    // the disagreement `analyzeCompute` checks before pairing anything.
    const scopes = walkLogScopes([invoke('A', 1), invoke('B', 1), ok('B'), ok('A')]);

    expect(scopes.map((scope) => scope.depth)).toEqual([1, 1]);
    expect(scopes.filter((scope) => scope.depth === 1)).toHaveLength(2);
  });

  it('opens no scope for a line that only resembles a marker', () => {
    for (const line of [
      'Program short invoke [1]',
      `Program ${pid('A')} invoke [0]`,
      `Program ${pid('A')} invoke [99999999999999999999]`,
      `Program log: Program ${pid('A')} invoke [1]`,
      `Program ${pid('A')} failed: `,
      'Program failed to complete now',
    ]) {
      expect(walkLogScopes([line]), line).toEqual([]);
    }
  });

  it('returns no scopes for an empty array', () => {
    expect(walkLogScopes([])).toEqual([]);
  });
});
