/**
 * Unit tests for `resolveError` and `buildFailureReport`.
 *
 * Requirements 6.1-6.17.
 *
 * Two mistakes this module exists to prevent shape every case below, and both are
 * mistakes a naive implementation passes tests for:
 *
 * - **Resolving by numeric range.** System Program, SPL Token, and SPL ATA all
 *   number their errors from 0, so the same `Custom 1` means three different
 *   things. Every built-in case therefore asserts the resolved *name*, not just
 *   that something was resolved, and one case pins a code that exists in a
 *   different known program's table and must not be borrowed from it.
 * - **Resolving an Anchor band code without evidence.** The same code is run
 *   through with a matching `AnchorError` line, with a line reporting a different
 *   number, and with no line at all, because only the first of those licenses a
 *   framework answer.
 *
 * The IDL cases load real files through `loadIdlDirectory` rather than standing a
 * fake store in front of the resolver, so the `msg: null` case is exercised
 * through the same validation a user's `--idl-dir` file goes through.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveAccountKeys } from '../../src/decode/accountKeys.js';
import { buildInstructionTree } from '../../src/decode/instructionTree.js';
import { loadIdlDirectory, type IdlStore } from '../../src/decode/idl/idlStore.js';
import type { LogReport, ResolvedError } from '../../src/model/analysis.js';
import type { RawTransactionError, RawTransactionResponse } from '../../src/model/rawResponse.js';
import { buildFailureReport, resolveError } from '../../src/resolve/errorResolver.js';
import { locateFailure } from '../../src/resolve/failure.js';
import { captureLogs } from '../../src/resolve/logs.js';

// ---------------------------------------------------------------------------
// Fixtures and builders
// ---------------------------------------------------------------------------

const SYSTEM = '11111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** The pump-amm program, which `tests/golden/02-anchor-user-error` failed in. */
const ANCHOR_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const OTHER_PROGRAM = 'Prism8hsRo6Ww5jiN5Zeh3YDPLZHqHduCPSAV7JF7qv';

/** `{ InstructionError: [i, { Custom: code }] }`, the shape all five failing fixtures use. */
function customError(code: unknown, index = 0): RawTransactionError {
  return { InstructionError: [index, { Custom: code }] } as RawTransactionError;
}

/** A `LogReport` as `captureLogs` would produce for a present, untruncated array. */
function logs(...messages: readonly string[]): LogReport {
  return {
    messages,
    present: messages.length > 0,
    truncated: false,
    unattributed: [],
    confidence: messages.length > 0 ? 'full' : 'raw',
  };
}

const NO_LOGS = logs();

/** An `AnchorError` line in the `caused by account` shape, as Anchor emits it. */
function anchorErrorLine(name: string, code: number, message: string): string {
  return `Program log: AnchorError caused by account: pool. Error Code: ${name}. Error Number: ${code}. Error Message: ${message}.`;
}

// ---------------------------------------------------------------------------
// A real IDL on disk
// ---------------------------------------------------------------------------

let idlDir: string;
let idls: IdlStore;

beforeAll(async () => {
  idlDir = await mkdtemp(join(tmpdir(), 'opsis-error-idl-'));
  await writeFile(
    join(idlDir, 'pump_amm.json'),
    JSON.stringify({
      version: '0.1.0',
      name: 'pump_amm',
      instructions: [{ name: 'buy', accounts: [{ name: 'pool' }], args: [] }],
      errors: [
        { code: 6000, name: 'AmountTooSmall', msg: 'the amount is below the minimum' },
        // `msg` omitted entirely: the format allows it, and the loader keeps it
        // null rather than filling it in.
        { code: 6001, name: 'PoolDisabled' },
        {
          code: 6040,
          name: 'BuySlippageBelowMinBaseAmountOut',
          msg: 'a stale message from an older deployment',
        },
      ],
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
// Known program tables — membership, never range (Req 6.3, 6.8, 6.14)
// ---------------------------------------------------------------------------

describe('resolveError: the three known programs', () => {
  it('resolves the same numeric code differently depending on which program failed', () => {
    const fromSystem = resolveError(customError(1), SYSTEM, null, NO_LOGS);
    const fromToken = resolveError(customError(1), SPL_TOKEN, null, NO_LOGS);

    expect(fromSystem).toEqual({
      kind: 'resolved',
      code: 1,
      namespace: 'system-program',
      name: 'ResultWithNegativeLamports',
      message: 'account does not have enough SOL to perform the operation',
      attestation: 'program-id',
      programId: SYSTEM,
      confidence: 'full',
    });
    expect(fromToken).toEqual({
      kind: 'resolved',
      code: 1,
      namespace: 'spl-token',
      name: 'InsufficientFunds',
      message: 'Insufficient funds',
      attestation: 'program-id',
      programId: SPL_TOKEN,
      confidence: 'full',
    });
  });

  it('reports not-in-table for a code another known program defines but the failing one does not', () => {
    // The ATA program declares only code 0. Code 1 is defined by System Program
    // and by SPL Token, and borrowing either of those is the range-matching
    // mistake Requirement 6.3 forbids. This is `tests/golden/03`'s case.
    expect(resolveError(customError(1), SPL_ATA, null, NO_LOGS)).toEqual({
      kind: 'unresolved',
      code: 1,
      rawCode: '1',
      reason: 'not-in-table',
      programId: SPL_ATA,
      confidence: 'raw',
    });
  });

  it('resolves a known program code without any attestation, recording program-id', () => {
    const result = resolveError(customError(0), SPL_ATA, null, NO_LOGS);

    expect(result).toMatchObject({
      kind: 'resolved',
      name: 'InvalidOwner',
      namespace: 'spl-associated-token-account',
      attestation: 'program-id',
    });
  });
});

// ---------------------------------------------------------------------------
// The attestation gate — Requirements 6.2, 6.11, 6.15, 6.17
// ---------------------------------------------------------------------------

describe('resolveError: the framework band requires attestation', () => {
  const CODE = 2006;

  it('resolves through a matching AnchorError line, taking name and message from it', () => {
    const result = resolveError(
      customError(CODE),
      OTHER_PROGRAM,
      null,
      logs(
        `Program ${OTHER_PROGRAM} invoke [1]`,
        anchorErrorLine('ConstraintSeeds', CODE, 'A seeds constraint was violated'),
        `Program ${OTHER_PROGRAM} failed: custom program error: 0x7d6`,
      ),
    );

    expect(result).toEqual({
      kind: 'resolved',
      code: CODE,
      namespace: 'anchor-framework',
      name: 'ConstraintSeeds',
      message: 'A seeds constraint was violated',
      attestation: 'anchor-error-log',
      programId: OTHER_PROGRAM,
      confidence: 'full',
    });
  });

  it('reports unattested-namespace at raw confidence when no AnchorError line is present', () => {
    const result = resolveError(
      customError(CODE),
      OTHER_PROGRAM,
      null,
      logs(
        `Program ${OTHER_PROGRAM} invoke [1]`,
        'Program log: No profitable buy/sell pair was found.',
        `Program ${OTHER_PROGRAM} failed: custom program error: 0x7d6`,
      ),
    );

    expect(result).toEqual({
      kind: 'unresolved',
      code: CODE,
      rawCode: '2006',
      reason: 'unattested-namespace',
      programId: OTHER_PROGRAM,
      confidence: 'raw',
    });
  });

  it('does not treat an AnchorError line reporting a different number as attestation', () => {
    // The word alone attests nothing: a transaction runs several programs, and
    // this line belongs to whichever one raised 2006, not to the 2004 being
    // resolved. Requirement 6.15 makes the number the join key.
    const result = resolveError(
      customError(2004),
      OTHER_PROGRAM,
      null,
      logs(anchorErrorLine('ConstraintSeeds', 2006, 'A seeds constraint was violated')),
    );

    expect(result).toMatchObject({ kind: 'unresolved', reason: 'unattested-namespace', code: 2004 });
    expect(JSON.stringify(result)).not.toContain('anchor-framework');
  });

  it('resolves a framework code through the table when only an IDL attests the program', () => {
    const result = resolveError(customError(2003), ANCHOR_PROGRAM, idls, NO_LOGS);

    expect(result).toEqual({
      kind: 'resolved',
      code: 2003,
      namespace: 'anchor-framework',
      name: 'ConstraintRaw',
      message: 'A raw constraint was violated',
      attestation: 'idl',
      programId: ANCHOR_PROGRAM,
      confidence: 'full',
    });
  });

  it('reports not-in-table for an attested band code the framework table does not hold', () => {
    // 2600 sits inside 2000-5999 with nothing declared at it, so a table governs
    // the code and does not contain it (Req 6.10) — a different answer from
    // "nothing governs it" and from "nothing attested".
    expect(resolveError(customError(2600), ANCHOR_PROGRAM, idls, NO_LOGS)).toMatchObject({
      kind: 'unresolved',
      code: 2600,
      reason: 'not-in-table',
    });
  });
});

// ---------------------------------------------------------------------------
// User-defined codes — Requirements 6.1, 6.5, 6.10, 6.16
// ---------------------------------------------------------------------------

describe('resolveError: codes at or above 6000', () => {
  it('resolves through the IDL errors array and records attestation idl', () => {
    expect(resolveError(customError(6000), ANCHOR_PROGRAM, idls, NO_LOGS)).toEqual({
      kind: 'resolved',
      code: 6000,
      namespace: 'anchor-user',
      name: 'AmountTooSmall',
      message: 'the amount is below the minimum',
      attestation: 'idl',
      programId: ANCHOR_PROGRAM,
      confidence: 'full',
    });
  });

  it('keeps the message null when the IDL entry declares none, without substituting the name', () => {
    const result = resolveError(customError(6001), ANCHOR_PROGRAM, idls, NO_LOGS);

    expect(result).toMatchObject({ kind: 'resolved', name: 'PoolDisabled', message: null });
    if (result.kind !== 'resolved') throw new Error('expected a resolved error');
    expect(result.message).not.toBe(result.name);
  });

  it('prefers a matching log line over the IDL, since the IDL may describe another deployment', () => {
    const result = resolveError(
      customError(6040),
      ANCHOR_PROGRAM,
      idls,
      logs(anchorErrorLine('BuySlippageBelowMinBaseAmountOut', 6040, 'buy: slippage')),
    );

    expect(result).toMatchObject({
      kind: 'resolved',
      namespace: 'anchor-user',
      message: 'buy: slippage',
      attestation: 'anchor-error-log',
    });
  });

  it('reports not-in-table when the loaded IDL does not declare the code', () => {
    expect(resolveError(customError(6100), ANCHOR_PROGRAM, idls, NO_LOGS)).toMatchObject({
      kind: 'unresolved',
      code: 6100,
      reason: 'not-in-table',
    });
  });

  it('reports no-idl when a log line attests the program but names no message and no IDL is loaded', () => {
    // A truncated line: the number is there, so the program is attested and the
    // namespace is not in doubt, but nothing available says what 6040 means.
    // Requirement 6.5 is exactly this state.
    const result = resolveError(
      customError(6040),
      ANCHOR_PROGRAM,
      null,
      logs('Program log: AnchorError thrown in src/lib.rs:12. Error Number: 6040'),
    );

    expect(result).toEqual({
      kind: 'unresolved',
      code: 6040,
      rawCode: '6040',
      reason: 'no-idl',
      programId: ANCHOR_PROGRAM,
      confidence: 'raw',
    });
  });

  it('reports unattested-namespace, not no-idl, when nothing attests the program at all', () => {
    // The distinction is the point: `no-idl` says "it is Anchor and we lack the
    // artifact", which is a claim about the program that nothing here supports.
    expect(resolveError(customError(6040), OTHER_PROGRAM, null, NO_LOGS)).toMatchObject({
      kind: 'unresolved',
      code: 6040,
      reason: 'unattested-namespace',
    });
  });
});

// ---------------------------------------------------------------------------
// Codes nothing governs, and codes that are not codes — Req 6.6, 6.9
// ---------------------------------------------------------------------------

describe('resolveError: unreadable and ungoverned codes', () => {
  it('reports not-in-table for a code from a program with no table and no IDL', () => {
    // `tests/golden/07-unknown-program`: Custom 7 from an unknown program. Code 7
    // is outside every framework band, so no table governs it at all (Req 6.6).
    expect(resolveError(customError(7), OTHER_PROGRAM, idls, NO_LOGS)).toEqual({
      kind: 'unresolved',
      code: 7,
      rawCode: '7',
      reason: 'not-in-table',
      programId: OTHER_PROGRAM,
      confidence: 'raw',
    });
  });

  it('reports unparseable-code with code null for a code that is not an integer', () => {
    for (const value of ['not-a-number', 1.5, -1, null]) {
      expect(resolveError(customError(value), SYSTEM, null, NO_LOGS)).toMatchObject({
        kind: 'unresolved',
        code: null,
        reason: 'unparseable-code',
      });
    }
  });

  it('preserves the spelling of a hex-written code in rawCode', () => {
    expect(resolveError(customError('0x1771'), OTHER_PROGRAM, null, NO_LOGS)).toMatchObject({
      code: 6001,
      rawCode: '0x1771',
      reason: 'unattested-namespace',
    });
  });

  it('never writes a message key on an unresolved error, even a serialized one', () => {
    const unresolvedCases: readonly ResolvedError[] = [
      resolveError(customError(1), SPL_ATA, null, NO_LOGS),
      resolveError(customError(2006), OTHER_PROGRAM, null, NO_LOGS),
      resolveError(customError(6100), ANCHOR_PROGRAM, idls, NO_LOGS),
      resolveError(customError('nope'), SYSTEM, null, NO_LOGS),
      resolveError(customError(7), null, null, NO_LOGS),
    ];

    for (const value of unresolvedCases) {
      expect(value.kind).toBe('unresolved');
      expect('message' in value).toBe(false);
      expect(Object.keys(JSON.parse(JSON.stringify(value)) as object)).not.toContain('message');
    }
  });
});

// ---------------------------------------------------------------------------
// Non-Custom payloads — the variant name verbatim
// ---------------------------------------------------------------------------

describe('resolveError: payloads that are not Custom codes', () => {
  it('takes a built-in runtime failure name verbatim from the detail', () => {
    const err = { InstructionError: [2, 'InvalidAccountData'] } as RawTransactionError;

    expect(resolveError(err, SPL_TOKEN, null, NO_LOGS)).toEqual({
      kind: 'non-custom',
      variant: 'InvalidAccountData',
      detail: null,
      confidence: 'full',
    });
  });

  it('takes a data-carrying detail variant name verbatim and describes its payload', () => {
    const err = {
      InstructionError: [0, { BorshIoError: 'Unknown' }],
    } as unknown as RawTransactionError;

    expect(resolveError(err, SPL_TOKEN, null, NO_LOGS)).toEqual({
      kind: 'non-custom',
      variant: 'BorshIoError',
      detail: 'Unknown',
      confidence: 'full',
    });
  });

  it('handles a transaction-level variant that carries no instruction index', () => {
    expect(resolveError('AlreadyProcessed', null, null, NO_LOGS)).toMatchObject({
      kind: 'non-custom',
      variant: 'AlreadyProcessed',
      detail: null,
    });
    expect(resolveError({ DuplicateInstruction: 3 }, null, null, NO_LOGS)).toMatchObject({
      kind: 'non-custom',
      variant: 'DuplicateInstruction',
      detail: '3',
    });
  });
});

// ---------------------------------------------------------------------------
// Composition, against recorded responses
// ---------------------------------------------------------------------------

/** The whole resolve path over a recorded fixture, with no IDL directory. */
function reportFor(fixture: string, store: IdlStore | null = null) {
  const response = JSON.parse(
    readFileSync(`tests/golden/${fixture}/input.json`, 'utf8'),
  ) as RawTransactionResponse;

  const tree = buildInstructionTree(response, resolveAccountKeys(response));
  const located = locateFailure(response, tree);
  const failure = located.failure;
  if (failure === null) throw new Error(`${fixture} did not fail`);

  const err = response.meta?.err;
  if (err === null || err === undefined) throw new Error(`${fixture} has no error payload`);

  return {
    report: buildFailureReport(failure, err, store, captureLogs(response)),
    location: failure,
  };
}

describe('buildFailureReport: recorded responses', () => {
  it('resolves 02 through its own AnchorError line with no IDL loaded', () => {
    const { report } = reportFor('02-anchor-user-error');

    expect(report.error).toMatchObject({
      kind: 'resolved',
      code: 6040,
      namespace: 'anchor-user',
      name: 'BuySlippageBelowMinBaseAmountOut',
      message: 'buy: slippage - would buy less tokens than expected min_base_amount_out',
      attestation: 'anchor-error-log',
      programId: ANCHOR_PROGRAM,
    });
  });

  it('refuses the Anchor framework meaning for 04, whose logs attest nothing', () => {
    const { report } = reportFor('04-unattested-band-collision');

    expect(report.error).toMatchObject({
      kind: 'unresolved',
      code: 5000,
      reason: 'unattested-namespace',
      confidence: 'raw',
    });
    // Anchor declares `Deprecated` at 5000. It must appear nowhere.
    expect(JSON.stringify(report)).not.toContain('Deprecated');
  });

  it('reports 03 as not-in-table, without borrowing System Program code 1', () => {
    const { report } = reportFor('03-program-table-error');

    expect(report.error).toMatchObject({
      kind: 'unresolved',
      code: 1,
      reason: 'not-in-table',
      programId: SPL_ATA,
    });
    expect(JSON.stringify(report)).not.toContain('ResultWithNegativeLamports');
  });

  it('reports 07 as not-in-table for a program with no table', () => {
    expect(reportFor('07-unknown-program').report.error).toMatchObject({
      kind: 'unresolved',
      code: 7,
      reason: 'not-in-table',
    });
  });

  it('copies the location fields through unchanged', () => {
    const { report, location } = reportFor('02-anchor-user-error');

    expect(report.failingInstructionIndex).toBe(location.failingInstructionIndex);
    expect(report.indexOutOfRange).toBe(location.indexOutOfRange);
    expect(report.cpiAttribution).toBeNull();
  });
});
