/**
 * The error namespace decision table, asserted as a grid rather than as cases.
 *
 * Requirements 6.3, 6.8, 6.10, and 6.11.
 *
 * `errorResolver.test.ts` already pins the individual behaviours: code 1 meaning
 * two different things depending on which program failed, code 1 absent from the
 * ATA table, and the attestation gate over the framework band. This file exists
 * for a different reason. Each of those is one example of a rule, and one example
 * is what a wrong implementation passes: a resolver that consulted the tables in
 * a fixed order, or compared codes against a range, or held a slightly wrong
 * boundary, can satisfy a handful of hand-written cases and still be wrong about
 * most of the grid.
 *
 * So the grid is written out. Three sections, each a table of inputs with the
 * whole expected output beside it:
 *
 * 1. **Every code the three built-in tables define, resolved against all three
 *    programs.** Twenty codes by three programs, sixty outcomes, asserted as one
 *    aligned matrix so a change to any table or to the resolution order arrives
 *    as a readable diff. `BUILTIN_GRID` is written by hand from the three table
 *    files rather than computed from them — a grid derived from
 *    `table.lookup` would agree with the resolver by construction and prove
 *    nothing. What keeps the hand-written grid honest is
 *    `covers every code the three tables actually define`, which compares the
 *    grid's own coverage against the exported code maps, so a table that gains
 *    or loses a row fails here instead of silently going untested.
 * 2. **The band boundaries.** 1999, 2000, 5999, 6000, each with and without
 *    attestation. An off-by-one in either comparison lives at exactly these four
 *    numbers and nothing else pins them.
 * 3. **An Anchor band code raised by one of the three built-ins**, which
 *    Requirement 6.11 excludes by name, so it falls through to that program's
 *    own table and reports `not-in-table` rather than `unattested-namespace`.
 *
 * **One discrepancy, recorded and asserted as implemented.** Requirements 6.6
 * and 6.11 divide on whether the code "falls outside every numeric range that a
 * framework error table uses". The Anchor framework table declares rows at 100
 * through 103, 1000 through 1002, and 1500, so on the plainest reading of 6.11
 * those numbers are inside a range that a framework table uses, and an unattested
 * 1500 would be `unattested-namespace`. The resolver instead gates on 2000–5999
 * and ≥6000 — the two bands Requirements 6.1 and 6.2 name — so 1500 reports
 * `not-in-table`. That reading is defensible and is the one design.md encodes,
 * but it is not what 6.11 says on its face, so the case is in the boundary table
 * below with this note attached rather than left implicit.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIdlDirectory, type IdlStore } from '../../src/decode/idl/idlStore.js';
import type {
  Base58Address,
  ErrorNamespace,
  LogReport,
  ResolvedError,
} from '../../src/model/analysis.js';
import type { RawTransactionError } from '../../src/model/rawResponse.js';
import { resolveError } from '../../src/resolve/errorResolver.js';
import { SPL_ASSOCIATED_TOKEN_ACCOUNT_ERROR_CODES } from '../../src/resolve/tables/splAssociatedTokenAccount.js';
import { SPL_TOKEN_ERROR_CODES } from '../../src/resolve/tables/splToken.js';
import { SYSTEM_PROGRAM_ERROR_CODES } from '../../src/resolve/tables/systemProgram.js';
import type { ErrorCodeMap } from '../../src/resolve/tables/errorTable.js';

// ---------------------------------------------------------------------------
// Inputs, built the way `errorResolver.test.ts` builds them
// ---------------------------------------------------------------------------

const SYSTEM = '11111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** The pump-amm program: not a built-in, and the one the temp IDL is written for. */
const ANCHOR_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function customError(code: number): RawTransactionError {
  return { InstructionError: [0, { Custom: code }] } as RawTransactionError;
}

const NO_LOGS: LogReport = {
  messages: [],
  present: false,
  truncated: false,
  unattributed: [],
  confidence: 'raw',
};

/**
 * An IDL for `ANCHOR_PROGRAM` declaring exactly one user code, 6000.
 *
 * Loaded from disk through `loadIdlDirectory` for the same reason the sibling
 * file does it: the store the resolver reads is then the store a user's
 * `--idl-dir` produces. Its only job here is to be `'idl'` attestation for a
 * program that is not one of the three built-ins.
 */
let idlDir: string;
let idls: IdlStore;

beforeAll(async () => {
  idlDir = await mkdtemp(join(tmpdir(), 'opsis-namespace-grid-'));
  await writeFile(
    join(idlDir, 'pump_amm.json'),
    JSON.stringify({
      version: '0.1.0',
      name: 'pump_amm',
      instructions: [{ name: 'buy', accounts: [{ name: 'pool' }], args: [] }],
      errors: [{ code: 6000, name: 'AmountTooSmall', msg: 'the amount is below the minimum' }],
      metadata: { address: ANCHOR_PROGRAM },
    }),
  );
  idls = await loadIdlDirectory(idlDir);
  expect(idls.warnings).toEqual([]);
});

afterAll(async () => {
  await rm(idlDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Rendering one outcome
// ---------------------------------------------------------------------------

/**
 * The one thing a grid cell says: the resolved name, or the unresolved reason.
 *
 * The reason is rendered in the same column as a name on purpose. `not-in-table`
 * and `InsufficientFunds` are alternative answers to the same question, and
 * seeing them in one column is what makes a wrong table selection legible — a
 * resolver that borrowed the System Program's row for an ATA failure shows up as
 * a name where the matrix expects `not-in-table`.
 */
function cellOf(result: ResolvedError): string {
  switch (result.kind) {
    case 'resolved':
      return result.name;
    case 'unresolved':
      return result.reason;
    default:
      return `non-custom:${result.variant}`;
  }
}

/** `InvalidNumberOfProvidedSigners` is the longest name in any built-in table. */
const CELL_WIDTH = 30;

function renderRow(code: number, cells: readonly string[]): string {
  const columns = cells.map((cell) => cell.padEnd(CELL_WIDTH)).join(' | ');
  return `Custom ${String(code).padStart(2)} | ${columns}`.trimEnd();
}

// ---------------------------------------------------------------------------
// Section 1: every built-in code against every built-in program
// ---------------------------------------------------------------------------

interface Column {
  readonly programId: Base58Address;
  readonly namespace: ErrorNamespace;
  /** The exported row data, for the coverage check. */
  readonly codes: ErrorCodeMap;
  /** This column's expected name for a row, or `null` for `not-in-table`. */
  readonly expected: (row: GridRow) => string | null;
}

/** `[code, system-program, spl-token, spl-associated-token-account]`. */
type GridRow = readonly [number, string | null, string | null, string | null];

const COLUMNS: readonly Column[] = [
  {
    programId: SYSTEM,
    namespace: 'system-program',
    codes: SYSTEM_PROGRAM_ERROR_CODES,
    expected: (row) => row[1],
  },
  {
    programId: SPL_TOKEN,
    namespace: 'spl-token',
    codes: SPL_TOKEN_ERROR_CODES,
    expected: (row) => row[2],
  },
  {
    programId: SPL_ATA,
    namespace: 'spl-associated-token-account',
    codes: SPL_ASSOCIATED_TOKEN_ACCOUNT_ERROR_CODES,
    expected: (row) => row[3],
  },
];

/**
 * Every code any of the three built-in tables defines, and what each of the three
 * programs resolves it to. `null` is `not-in-table`.
 *
 * Transcribed from `tables/systemProgram.ts` (codes 0–8), `tables/splToken.ts`
 * (0–19), and `tables/splAssociatedTokenAccount.ts` (0 only). The ATA column is
 * almost entirely `null` and that is the table, not an oversight — upstream
 * declares one variant.
 *
 * Read down a column and it is one program's enum. Read across a row and it is
 * the reason Requirement 6.3 forbids a numeric test: row 1 holds three unrelated
 * answers, and rows 9 through 19 hold a real name in one column and nothing in
 * the other two.
 */
const BUILTIN_GRID: readonly GridRow[] = [
  //     system-program                  spl-token                        spl-associated-token-account
  [0, 'AccountAlreadyInUse', 'NotRentExempt', 'InvalidOwner'],
  [1, 'ResultWithNegativeLamports', 'InsufficientFunds', null],
  [2, 'InvalidProgramId', 'InvalidMint', null],
  [3, 'InvalidAccountDataLength', 'MintMismatch', null],
  [4, 'MaxSeedLengthExceeded', 'OwnerMismatch', null],
  [5, 'AddressWithSeedMismatch', 'FixedSupply', null],
  [6, 'NonceNoRecentBlockhashes', 'AlreadyInUse', null],
  [7, 'NonceBlockhashNotExpired', 'InvalidNumberOfProvidedSigners', null],
  [8, 'NonceUnexpectedBlockhashValue', 'InvalidNumberOfRequiredSigners', null],
  [9, null, 'UninitializedState', null],
  [10, null, 'NativeNotSupported', null],
  [11, null, 'NonNativeHasBalance', null],
  [12, null, 'InvalidInstruction', null],
  [13, null, 'InvalidState', null],
  [14, null, 'Overflow', null],
  [15, null, 'AuthorityTypeNotSupported', null],
  [16, null, 'MintCannotFreeze', null],
  [17, null, 'AccountFrozen', null],
  [18, null, 'MintDecimalsMismatch', null],
  [19, null, 'NonNativeNotSupported', null],
];

describe('the built-in program decision table', () => {
  it('resolves all 60 (program, code) pairs exactly as the matrix says', () => {
    const expected = BUILTIN_GRID.map((row) =>
      renderRow(
        row[0],
        COLUMNS.map((column) => column.expected(row) ?? 'not-in-table'),
      ),
    );

    const actual = BUILTIN_GRID.map((row) =>
      renderRow(
        row[0],
        COLUMNS.map((column) =>
          cellOf(resolveError(customError(row[0]), column.programId, null, NO_LOGS)),
        ),
      ),
    );

    expect(actual).toEqual(expected);
  });

  it('covers every code the three tables actually define, and no others', () => {
    // The guard on the hand-written grid: if a table gains a row, or a row is
    // renumbered, the matrix above stops describing it and this fails first.
    const covered = new Set(BUILTIN_GRID.map((row) => row[0]));
    const defined = new Set(
      COLUMNS.flatMap((column) => Object.keys(column.codes).map((code) => Number(code))),
    );
    expect([...covered].sort((a, b) => a - b)).toEqual([...defined].sort((a, b) => a - b));

    for (const column of COLUMNS) {
      const inGrid = BUILTIN_GRID.filter((row) => column.expected(row) !== null).map((row) => row[0]);
      const inTable = Object.keys(column.codes).map((code) => Number(code));
      expect({ namespace: column.namespace, codes: inGrid }).toEqual({
        namespace: column.namespace,
        codes: inTable.sort((a, b) => a - b),
      });
    }
  });

  for (const column of COLUMNS) {
    it(`carries the ${column.namespace} namespace and program-id attestation on every hit`, () => {
      for (const row of BUILTIN_GRID) {
        const code = row[0];
        const result = resolveError(customError(code), column.programId, null, NO_LOGS);
        const where = `${column.namespace} Custom ${String(code)}`;

        if (column.expected(row) === null) {
          expect({ where, ...result }).toEqual({
            where,
            kind: 'unresolved',
            code,
            rawCode: String(code),
            reason: 'not-in-table',
            programId: column.programId,
            confidence: 'raw',
          });
          // Requirement 6.10 leaves nothing to say about the meaning.
          expect(`${where}: ${String('message' in result)}`).toBe(`${where}: false`);
          continue;
        }

        expect({ where, ...result }).toMatchObject({
          where,
          kind: 'resolved',
          code,
          namespace: column.namespace,
          name: column.expected(row),
          attestation: 'program-id',
          programId: column.programId,
          confidence: 'full',
        });
        if (result.kind !== 'resolved') throw new Error(`${where}: expected a resolved error`);
        // The message comes from the table, so it is present and is not the name
        // restated. Requirement 6.4 wants both fields to be worth reading.
        expect(`${where}: ${String(result.message)}`).not.toBe(`${where}: null`);
        expect(result.message).not.toBe(result.name);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Section 2: the band boundaries
// ---------------------------------------------------------------------------

interface BoundaryCase {
  readonly code: number;
  readonly attested: boolean;
  /** The resolved name, or the unresolved reason. */
  readonly outcome: string;
  readonly namespace: ErrorNamespace | null;
  readonly why: string;
}

/**
 * The four boundary numbers of the two Anchor bands, plus 1500.
 *
 * Attestation is an IDL loaded for `ANCHOR_PROGRAM`, so every row uses the same
 * non-built-in program and the only thing that varies down the pairs is whether
 * evidence exists. That is the variable Requirement 6.11 turns on.
 *
 * 1999/2000 bracket `FRAMEWORK_CODE_MIN` and 5999/6000 bracket both
 * `FRAMEWORK_CODE_MAX` and `USER_CODE_MIN`, which is every comparison in the
 * gate. 5999 attested is the case worth reading twice: it is inside the band, so
 * the framework table governs it and does not hold it, which is Requirement
 * 6.10's `not-in-table` and not Requirement 6.6's.
 */
const BOUNDARIES: readonly BoundaryCase[] = [
  {
    code: 1500,
    attested: true,
    outcome: 'not-in-table',
    namespace: null,
    why: 'the framework table declares 1500, but the gate starts at 2000 — see the header',
  },
  {
    code: 1500,
    attested: false,
    outcome: 'not-in-table',
    namespace: null,
    why: 'below the gate, so no framework range is held to cover it (see the header)',
  },
  {
    code: 1999,
    attested: true,
    outcome: 'not-in-table',
    namespace: null,
    why: 'one below the framework band: attestation does not widen it',
  },
  {
    code: 1999,
    attested: false,
    outcome: 'not-in-table',
    namespace: null,
    why: 'outside every band, so Requirement 6.6 governs, not 6.11',
  },
  {
    code: 2000,
    attested: true,
    outcome: 'ConstraintMut',
    namespace: 'anchor-framework',
    why: 'the first code of the framework band, and the table declares it',
  },
  {
    code: 2000,
    attested: false,
    outcome: 'unattested-namespace',
    namespace: null,
    why: 'in the band, nothing attests the program: Requirement 6.11',
  },
  {
    code: 5999,
    attested: true,
    outcome: 'not-in-table',
    namespace: null,
    why: 'the last code of the framework band; the table declares nothing at it',
  },
  {
    code: 5999,
    attested: false,
    outcome: 'unattested-namespace',
    namespace: null,
    why: 'still in the band, so the gate applies rather than Requirement 6.6',
  },
  {
    code: 6000,
    attested: true,
    outcome: 'AmountTooSmall',
    namespace: 'anchor-user',
    why: "ERROR_CODE_OFFSET exactly: the IDL's own errors array governs",
  },
  {
    code: 6000,
    attested: false,
    outcome: 'unattested-namespace',
    namespace: null,
    why: 'the user band is a fact about the number, not about the program',
  },
];

describe('the band boundary decision table', () => {
  it('resolves all 10 (code, attestation) pairs exactly as the matrix says', () => {
    const render = (rowCase: BoundaryCase, outcome: string, namespace: ErrorNamespace | null) =>
      renderRow(rowCase.code, [
        rowCase.attested ? 'attested' : 'unattested',
        outcome,
        namespace ?? '-',
      ]);

    const expected = BOUNDARIES.map((rowCase) =>
      render(rowCase, rowCase.outcome, rowCase.namespace),
    );

    const actual = BOUNDARIES.map((rowCase) => {
      const result = resolveError(
        customError(rowCase.code),
        ANCHOR_PROGRAM,
        rowCase.attested ? idls : null,
        NO_LOGS,
      );
      return render(
        rowCase,
        cellOf(result),
        result.kind === 'resolved' ? result.namespace : null,
      );
    });

    expect(actual).toEqual(expected);
  });

  it('marks every unresolved boundary raw and every resolved one full, with the code preserved', () => {
    for (const rowCase of BOUNDARIES) {
      const result = resolveError(
        customError(rowCase.code),
        ANCHOR_PROGRAM,
        rowCase.attested ? idls : null,
        NO_LOGS,
      );
      const where = `Custom ${String(rowCase.code)} ${
        rowCase.attested ? 'attested' : 'unattested'
      } (${rowCase.why})`;

      expect({ where, ...result }).toMatchObject({
        where,
        code: rowCase.code,
        programId: ANCHOR_PROGRAM,
        confidence: rowCase.namespace === null ? 'raw' : 'full',
      });
      if (rowCase.namespace === null) {
        expect({ where, kind: result.kind }).toEqual({ where, kind: 'unresolved' });
        expect(`${where}: ${String('message' in result)}`).toBe(`${where}: false`);
      } else {
        // The IDL is what established the namespace in both resolved rows, even
        // the framework one whose message came from the framework table (Req 6.12).
        if (result.kind !== 'resolved') throw new Error(`${where}: expected a resolved error`);
        expect({ where, attestation: result.attestation }).toEqual({ where, attestation: 'idl' });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: an Anchor band code raised by a built-in program
// ---------------------------------------------------------------------------

/**
 * Requirement 6.11's gate excludes System Program, SPL Token, and SPL ATA by
 * name, because their identity is address equality rather than inference. So a
 * band code raised by one of them is not `unattested-namespace`: its own table
 * governs, the table does not declare the code, and the answer is
 * Requirement 6.10's `not-in-table`.
 *
 * The three tables number their errors below 20, so none of these codes can
 * resolve — which is the point. The wrong answers here are the two neighbours:
 * `unattested-namespace` (the gate misapplied to a known program) and a
 * framework name such as `ConstraintMut` (the band consulted without evidence).
 */
describe('an Anchor band code raised by one of the three built-ins', () => {
  const BAND_CODES: readonly number[] = [2000, 5000, 5999, 6000, 6040];

  for (const column of COLUMNS) {
    it(`falls through to the ${column.namespace} table, not to unattested-namespace`, () => {
      const expected = BAND_CODES.map((code) => renderRow(code, ['not-in-table']));
      const actual = BAND_CODES.map((code) =>
        renderRow(code, [cellOf(resolveError(customError(code), column.programId, null, NO_LOGS))]),
      );

      expect(actual).toEqual(expected);

      // 2000 is `ConstraintMut` and 5000 is `Deprecated` in the framework table.
      // Neither name, and no Anchor namespace, may appear in any of these.
      const serialized = BAND_CODES.map((code) =>
        JSON.stringify(resolveError(customError(code), column.programId, null, NO_LOGS)),
      ).join('\n');
      expect(serialized).not.toContain('anchor');
      expect(serialized).not.toContain('ConstraintMut');
      expect(serialized).not.toContain('Deprecated');
    });
  }
});
