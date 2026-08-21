/**
 * Program display names: the six mapped addresses, the `null` default, and the
 * fact that the name is inert.
 *
 * Three concerns, in three blocks.
 *
 * **The table itself.** The six canonical addresses are transcribed here as
 * literals and this file imports no program ID from `src/`, for the same reason
 * `builtinRegistration.test.ts` transcribes its three: `programNames.ts` imports
 * `SYSTEM_PROGRAM_ID`, `SPL_TOKEN_PROGRAM_ID`, and
 * `SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID` from the decoder modules, which is
 * the right coupling — the name table and the decoder registration cannot drift
 * — but it also means a typo in one of those constants leaves the table
 * perfectly self-consistent while no mainnet instruction ever matches it. Only a
 * test that states the addresses independently can catch that. Every one is also
 * asserted to base58-decode to exactly 32 bytes, because a transposed character
 * that stays inside the base58 alphabet is invisible to the eye and usually
 * changes the decoded length.
 *
 * **The wiring.** `buildInstructionTree` sets `programName` from the table, so a
 * synthetic message addressing all six programs plus an unmapped one pins both
 * the six names and the `null` default on the value a caller actually receives.
 *
 * **That the name is inert**, which is the constraint the whole feature rests on.
 * Two behavioural assertions and one structural one:
 *
 * 1. Two otherwise-identical instructions — same payload, same account list, one
 *    on Memo (in the table, no built-in decoder) and one on an unmapped program
 *    (neither) — run through the real pipeline. The names differ; the decodes are
 *    equal field for field. Memo is the right mapped program for this because it
 *    has no decoder, so the pair differs *only* in whether a name exists. Pairing
 *    SPL Token against an unmapped program would have confounded the name with
 *    the presence of a decoder.
 * 2. Failure location and error resolution run twice over the same tree, once
 *    with every `programName` stripped to `null`. The `FailureLocation` and the
 *    `FailureReport` are deep-equal, and the report is asserted to have actually
 *    resolved the error so the comparison is not two identical `null`s.
 * 3. A source-text guard: `programNames.js` has exactly one importer under
 *    `src/`, and the decode-selection, error-resolution, analysis, and confidence
 *    modules never mention `programName` at all. This is what makes the
 *    constraint structural rather than documented — a second consumer appearing
 *    in the decode or resolve path fails here instead of passing review.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { resolveAccountKeys } from '../../src/decode/accountKeys.js';
import { SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID } from '../../src/decode/builtin/splAssociatedTokenAccount.js';
import { SPL_TOKEN_PROGRAM_ID } from '../../src/decode/builtin/splToken.js';
import { SYSTEM_PROGRAM_ID } from '../../src/decode/builtin/systemProgram.js';
import { buildInstructionTree } from '../../src/decode/instructionTree.js';
import { PROGRAM_NAMES, programNameFor } from '../../src/decode/programNames.js';
import type {
  Base58Address,
  InstructionDecode,
  InstructionNode,
} from '../../src/model/analysis.js';
import type { RawTransactionResponse } from '../../src/model/rawResponse.js';
import { analyzeTransaction } from '../../src/pipeline.js';
import { buildFailureReport } from '../../src/resolve/errorResolver.js';
import { locateFailure } from '../../src/resolve/failure.js';
import { captureLogs } from '../../src/resolve/logs.js';

// ---------------------------------------------------------------------------
// The canonical addresses, transcribed rather than imported
// ---------------------------------------------------------------------------

const CANONICAL_SYSTEM_PROGRAM_ID: Base58Address = '11111111111111111111111111111111';
const CANONICAL_SPL_TOKEN_PROGRAM_ID: Base58Address =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CANONICAL_TOKEN_2022_PROGRAM_ID: Base58Address =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CANONICAL_SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: Base58Address =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const CANONICAL_COMPUTE_BUDGET_PROGRAM_ID: Base58Address =
  'ComputeBudget111111111111111111111111111111';
const CANONICAL_MEMO_PROGRAM_ID: Base58Address = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * The legacy memo program, deliberately **not** in the table. Present here so
 * the omission is pinned as a decision rather than read as an oversight, and so
 * a future addition has to change this file too.
 */
const CANONICAL_MEMO_V1_PROGRAM_ID: Base58Address = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

/** A well-formed 32-byte address that is in no table anywhere. */
const UNMAPPED_PROGRAM_ID: Base58Address = 'Unmapped11111111111111111111111111111111111';

/** Every Solana program ID is a 32-byte key or program address. */
const ADDRESS_BYTES = 32;

interface NameCase {
  readonly displayName: string;
  readonly canonicalAddress: Base58Address;
}

const CASES: readonly NameCase[] = [
  { displayName: 'System Program', canonicalAddress: CANONICAL_SYSTEM_PROGRAM_ID },
  { displayName: 'SPL Token', canonicalAddress: CANONICAL_SPL_TOKEN_PROGRAM_ID },
  { displayName: 'Token-2022', canonicalAddress: CANONICAL_TOKEN_2022_PROGRAM_ID },
  {
    displayName: 'SPL Associated Token Account',
    canonicalAddress: CANONICAL_SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  },
  { displayName: 'Compute Budget', canonicalAddress: CANONICAL_COMPUTE_BUDGET_PROGRAM_ID },
  { displayName: 'Memo', canonicalAddress: CANONICAL_MEMO_PROGRAM_ID },
];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe.each(CASES)('$displayName', (testCase: NameCase) => {
  it('has an address that base58-decodes to exactly 32 bytes', () => {
    // A character outside the base58 alphabet would already have thrown; one
    // inside it almost always changes the decoded length. Either way the entry
    // would otherwise be a key no instruction can ever match.
    expect(bs58.decode(testCase.canonicalAddress)).toHaveLength(ADDRESS_BYTES);
  });

  it('resolves to its display name through the lookup', () => {
    expect(programNameFor(testCase.canonicalAddress)).toBe(testCase.displayName);
  });

  it('is present in the exported table under the canonical address', () => {
    expect(PROGRAM_NAMES.get(testCase.canonicalAddress)).toBe(testCase.displayName);
  });
});

describe('the program name table', () => {
  it('covers exactly the six specified programs', () => {
    expect([...PROGRAM_NAMES.keys()].sort()).toEqual(
      CASES.map((testCase) => testCase.canonicalAddress).sort(),
    );
  });

  it('gives six pairwise distinct display names', () => {
    // Two programs sharing a label would make them indistinguishable in the
    // output while both lookups still returned a non-null string.
    expect(new Set(PROGRAM_NAMES.values()).size).toBe(CASES.length);
  });

  it('takes its three shared addresses from the built-in decoder modules', () => {
    // The imported constants are the table's keys, so if one of them drifted
    // from the canonical literal the table would silently stop matching that
    // program. Asserted at the constant rather than through the table so the
    // failure names which one moved.
    expect(SYSTEM_PROGRAM_ID).toBe(CANONICAL_SYSTEM_PROGRAM_ID);
    expect(SPL_TOKEN_PROGRAM_ID).toBe(CANONICAL_SPL_TOKEN_PROGRAM_ID);
    expect(SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID).toBe(
      CANONICAL_SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    );
  });

  it('returns null for a program it does not list', () => {
    expect(programNameFor(UNMAPPED_PROGRAM_ID)).toBeNull();
    expect(PROGRAM_NAMES.has(UNMAPPED_PROGRAM_ID)).toBe(false);
  });

  it('returns null for an unresolved program ID', () => {
    // `InstructionNode.programId` is null when the program index could not be
    // resolved (Req 3.7); such a node has no address, so it has no name.
    expect(programNameFor(null)).toBeNull();
  });

  it('leaves the legacy Memo v1 program unnamed', () => {
    // A distinct 32-byte address and a distinct deployed program, excluded on
    // purpose — see the header of `src/decode/programNames.ts`.
    expect(bs58.decode(CANONICAL_MEMO_V1_PROGRAM_ID)).toHaveLength(ADDRESS_BYTES);
    expect(CANONICAL_MEMO_V1_PROGRAM_ID).not.toBe(CANONICAL_MEMO_PROGRAM_ID);
    expect(programNameFor(CANONICAL_MEMO_V1_PROGRAM_ID)).toBeNull();
  });

  it('does not fall through to Object.prototype for a prototype-shaped key', () => {
    // Every letter of `constructor` and `toString` is in the base58 alphabet, so
    // a record-backed table could hand back a function here.
    expect(programNameFor('constructor')).toBeNull();
    expect(programNameFor('toString')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic responses
// ---------------------------------------------------------------------------

/** A memo payload: the UTF-8 bytes of `hi`, base58 as the RPC delivers data. */
const MEMO_PAYLOAD = bs58.encode(new TextEncoder().encode('hi'));

const FEE_PAYER: Base58Address = 'Fee11111111111111111111111111111111111111111';

/**
 * A successful response whose top-level instructions address, in order, each of
 * the six mapped programs and then one unmapped program.
 *
 * Every instruction carries the same payload and the same (empty) account list,
 * so the only thing that varies across the seven nodes is the program.
 */
function allProgramsResponse(): RawTransactionResponse {
  const programs = [...CASES.map((testCase) => testCase.canonicalAddress), UNMAPPED_PROGRAM_ID];
  const accountKeys = [FEE_PAYER, ...programs];

  return {
    slot: 1,
    blockTime: null,
    version: 'legacy',
    transaction: {
      message: {
        accountKeys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: programs.length,
        },
        instructions: programs.map((_program, offset) => ({
          // +1 to skip the fee payer at index 0.
          programIdIndex: offset + 1,
          accounts: [],
          data: MEMO_PAYLOAD,
          stackHeight: 1,
        })),
        recentBlockhash: '11111111111111111111111111111111',
      },
      signatures: ['sig'],
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: accountKeys.map(() => 0),
      postBalances: accountKeys.map(() => 0),
      innerInstructions: [],
      logMessages: [],
    },
  };
}

/**
 * A failing response whose single top-level instruction addresses SPL Token — a
 * mapped program whose error table is selected by address equality, so the error
 * genuinely resolves and the comparison below is not two unresolved values.
 */
function splTokenFailureResponse(): RawTransactionResponse {
  const accountKeys = [FEE_PAYER, CANONICAL_SPL_TOKEN_PROGRAM_ID];

  return {
    slot: 1,
    blockTime: null,
    version: 'legacy',
    transaction: {
      message: {
        accountKeys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        instructions: [
          { programIdIndex: 1, accounts: [], data: MEMO_PAYLOAD, stackHeight: 1 },
        ],
        recentBlockhash: '11111111111111111111111111111111',
      },
      signatures: ['sig'],
    },
    meta: {
      err: { InstructionError: [0, { Custom: 1 }] },
      fee: 5000,
      preBalances: accountKeys.map(() => 0),
      postBalances: accountKeys.map(() => 0),
      innerInstructions: [],
      logMessages: [],
    },
  };
}

function treeOf(response: RawTransactionResponse): readonly InstructionNode[] {
  return buildInstructionTree(response, resolveAccountKeys(response));
}

/** The same tree with every display name removed, at every depth. */
function withoutProgramNames(nodes: readonly InstructionNode[]): readonly InstructionNode[] {
  return nodes.map((node) => ({
    ...node,
    programName: null,
    inner: withoutProgramNames(node.inner),
  }));
}

// ---------------------------------------------------------------------------
// Wiring: the tree builder sets the field
// ---------------------------------------------------------------------------

describe('buildInstructionTree', () => {
  it('names each mapped program and leaves an unmapped one null', () => {
    const tree = treeOf(allProgramsResponse());

    expect(tree.map((node) => node.programName)).toEqual([
      ...CASES.map((testCase) => testCase.displayName),
      null,
    ]);
  });

  it('names programs the same way through the whole pipeline', () => {
    // The tree builder runs before decoding, and `pipeline.ts` rewrites `decode`
    // and `accounts` per node — so this checks the name survives that rewrite
    // rather than being dropped by the object spread that replaces it.
    const analysis = analyzeTransaction({ response: allProgramsResponse() });

    expect(analysis.instructions.map((node) => node.programName)).toEqual([
      ...CASES.map((testCase) => testCase.displayName),
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The name is inert: behaviour
// ---------------------------------------------------------------------------

/**
 * A `raw` decode with the program ID removed from its `errorDetail`.
 *
 * The floor's detail names the program it gave up on, so two decodes of the same
 * payload under different addresses differ in that one sentence and nowhere
 * else. Substituting a placeholder lets the rest of the value be compared whole
 * — including `rawInstructionData` and `confidence` — instead of field by
 * hand-picked field.
 */
function withoutProgramId(decode: InstructionDecode, programId: Base58Address): InstructionDecode {
  if (decode.kind !== 'raw') return decode;
  return {
    ...decode,
    errorDetail: decode.errorDetail?.replaceAll(programId, '<programId>') ?? null,
  };
}

describe('programName does not participate in decoding', () => {
  it('decodes two identical payloads identically whether or not the program is named', () => {
    // Memo is in the name table and has no built-in decoder; the unmapped
    // program has neither. Same payload, same accounts, so the only difference
    // between the two instructions is that one of them gets a label.
    const analysis = analyzeTransaction({ response: allProgramsResponse() });
    const named = analysis.instructions.at(-2);
    const unnamed = analysis.instructions.at(-1);
    if (named === undefined || unnamed === undefined) {
      throw new Error('expected the synthetic response to yield seven top-level nodes');
    }

    // The premise: these two nodes really do differ in name.
    expect(named.programName).toBe('Memo');
    expect(unnamed.programName).toBeNull();

    // And the conclusion: the decode is a function of the payload and the
    // registry alone. Both reach the `Unknown` floor because neither program has
    // a decoder — a name is not a decoder.
    expect(named.decode.kind).toBe('raw');
    expect(withoutProgramId(named.decode, CANONICAL_MEMO_PROGRAM_ID)).toEqual(
      withoutProgramId(unnamed.decode, UNMAPPED_PROGRAM_ID),
    );
    expect(named.confidence).toBe(unnamed.confidence);
    expect(named.decode.confidence).toBe(unnamed.decode.confidence);
  });

  it('resolves the failing error identically with the name stripped', () => {
    const response = splTokenFailureResponse();
    const err = response.meta?.err ?? null;
    if (err === null) throw new Error('expected the synthetic response to carry an error');
    const logs = captureLogs(response);

    const tree = treeOf(response);
    const stripped = withoutProgramNames(tree);
    // The premise again: the name is really there in one of the two trees.
    expect(tree[0]?.programName).toBe('SPL Token');
    expect(stripped[0]?.programName).toBeNull();

    const located = locateFailure(response, tree);
    const locatedStripped = locateFailure(response, stripped);
    if (located.failure === null || locatedStripped.failure === null) {
      throw new Error('expected both runs to locate the failure');
    }

    const report = buildFailureReport(located.failure, err, null, logs);
    const reportStripped = buildFailureReport(locatedStripped.failure, err, null, logs);

    // Not vacuous: the table really was selected and the code really was named,
    // by program ID, which is the selector Requirement 6.3 specifies.
    expect(report.error.kind).toBe('resolved');
    expect(report.failingInstructionIndex).toBe(0);

    expect(locatedStripped.failure).toEqual(located.failure);
    expect(reportStripped).toEqual(report);
  });
});

// ---------------------------------------------------------------------------
// The name is inert: structure
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/** Path relative to `src/`, with forward slashes, for readable assertions. */
function label(path: string): string {
  return relative(SRC_ROOT, path).split('\\').join('/');
}

describe('programName is structurally confined to display labelling', () => {
  const files = sourceFiles(SRC_ROOT);

  it('found the source tree it is asserting about', () => {
    // Without this, a moved `src/` would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map(label)).toContain('decode/programNames.ts');
  });

  it('is imported by exactly one module, the one that sets the field', () => {
    // The lookup is a pure `Base58Address -> string | null` with no other
    // inputs; this is the other half of the confinement — no other callers. A
    // new importer anywhere in the decode or resolve path fails here.
    const importers = files
      .filter((path) => label(path) !== 'decode/programNames.ts')
      .filter((path) => readFileSync(path, 'utf8').includes('programNames.js'))
      .map(label);

    expect(importers).toEqual(['decode/instructionTree.ts']);
  });

  it.each([
    'decode/registry.ts',
    'resolve/errorResolver.ts',
    'resolve/failure.ts',
    'model/confidence.ts',
    'analyze/assemble.ts',
    'analyze/compute.ts',
    'analyze/balances.ts',
    'analyze/tokenBalances.ts',
  ])('is never mentioned in %s', (relativePath: string) => {
    // Decoder selection, error namespace selection, confidence propagation, and
    // every analysis stage. None of them may read the field, so none of them has
    // any reason to name it — the token being absent is the cheapest check that
    // holds and the one that fails soonest if the constraint slips.
    const path = files.find((candidate) => label(candidate) === relativePath);
    if (path === undefined) throw new Error(`no such source file: ${relativePath}`);

    expect(readFileSync(path, 'utf8')).not.toContain('programName');
  });
});
