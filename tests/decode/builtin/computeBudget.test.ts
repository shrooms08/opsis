/**
 * The Compute Budget built-in decoder: its five instructions, its two field
 * widths, and its degradation.
 *
 * Requirements 4.2, 4.5, 11.2, 11.3, 11.7.
 *
 * **The bytes this file trusts.** Two sources, and the distinction matters.
 *
 * 1. **Constructed payloads**, built here from the encoding
 *    `src/decode/builtin/computeBudget.ts` documents. These cover the whole
 *    table, every truncation boundary, and the `microLamports` range no fixture
 *    reaches. They prove the decoder is self-consistent with its own stated
 *    format, which is worth exactly that and no more: a decoder and a test that
 *    share a wrong belief about the wire format agree perfectly.
 * 2. **Recorded chain bytes**, read out of `tests/golden/02-anchor-user-error`
 *    and `tests/golden/07-unknown-program` at run time and base58-decoded here.
 *    These are the ones that can catch a wrong belief, so the last block asserts
 *    the decoded values of every Compute Budget instruction those two recordings
 *    actually contain. They are located by program ID rather than by index, so
 *    the block does not silently pass if a fixture is ever re-recorded with a
 *    different instruction order — a count assertion guards against it finding
 *    none.
 *
 * **What the fixtures cannot verify.** Every recorded Compute Budget payload is
 * tag 2, 3, or 4. Nothing on chain in this repo exercises `RequestUnits` (0) or
 * `RequestHeapFrame` (1), both deprecated, so their field widths rest on the
 * upstream encoding alone. The constructed cases below pin what the decoder
 * does with them; they cannot and do not claim fixture confirmation.
 *
 * **Why `microLamports` is asserted as a string above 2^53.** It is a `u64`, and
 * `Number` cannot hold every one. `9007199254740993` is the smallest integer a
 * double rounds — it becomes `9007199254740992` — so a decoder that passed the
 * value through `Number` would fail on exactly that input and pass on every
 * smaller one. Asserting the string rather than a numeric comparison is the
 * point: `toBe('9007199254740993')` fails on the rounded value, where
 * `toBeCloseTo` or a `Number` comparison would not.
 *
 * The registry-level cases go through `createRegistry(null)` so the built-in rung
 * is the only one that can answer, and so the `no-match` and `error` outcomes are
 * observed as the `InstructionDecode` a caller actually receives rather than only
 * as the decoder's internal report.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  computeBudgetDecoder,
  decodeComputeBudgetInstruction,
} from '../../../src/decode/builtin/computeBudget.js';
import { createRegistry, type DecodeOutcome } from '../../../src/decode/registry.js';
import type { DecodedField, InstructionDecode } from '../../../src/model/analysis.js';

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Little-endian, `byteLength` bytes wide. */
function le(value: bigint, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let rest = value;
  for (let index = 0; index < byteLength; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** A tag byte followed by whatever little-endian fields the tag declares. */
function payload(tag: number, ...fields: readonly Uint8Array[]): Uint8Array {
  return concat(new Uint8Array([tag]), ...fields);
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function expectFullOutcome(outcome: DecodeOutcome): Extract<DecodeOutcome, { kind: 'full' }> {
  if (outcome.kind !== 'full') {
    throw new Error(`expected a full outcome, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectPartialOutcome(outcome: DecodeOutcome): Extract<DecodeOutcome, { kind: 'partial' }> {
  if (outcome.kind !== 'partial') {
    throw new Error(`expected a partial outcome, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectErrorOutcome(outcome: DecodeOutcome): Extract<DecodeOutcome, { kind: 'error' }> {
  if (outcome.kind !== 'error') {
    throw new Error(`expected an error outcome, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectRawDecode(decode: InstructionDecode): Extract<InstructionDecode, { kind: 'raw' }> {
  if (decode.kind !== 'raw') {
    throw new Error(`expected a raw decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
  }
  return decode;
}

// ---------------------------------------------------------------------------
// The five instructions — Requirement 4.2
// ---------------------------------------------------------------------------

interface TableCase {
  readonly tag: number;
  readonly name: string;
  readonly data: Uint8Array;
  readonly fields: readonly DecodedField[];
}

const TABLE: readonly TableCase[] = [
  {
    tag: 0,
    name: 'RequestUnits',
    // The deprecated two-field form: a unit request and a prioritization fee.
    data: payload(0, le(200_000n, 4), le(5_000n, 4)),
    fields: [
      { name: 'units', value: { type: 'u32', value: 200_000 } },
      { name: 'additionalFee', value: { type: 'u32', value: 5_000 } },
    ],
  },
  {
    tag: 1,
    name: 'RequestHeapFrame',
    data: payload(1, le(262_144n, 4)),
    fields: [{ name: 'bytes', value: { type: 'u32', value: 262_144 } }],
  },
  {
    tag: 2,
    name: 'SetComputeUnitLimit',
    data: payload(2, le(1_400_000n, 4)),
    fields: [{ name: 'units', value: { type: 'u32', value: 1_400_000 } }],
  },
  {
    tag: 3,
    name: 'SetComputeUnitPrice',
    data: payload(3, le(59_214n, 8)),
    // A u64 carried as a decimal string, never a number. See the module header.
    fields: [{ name: 'microLamports', value: { type: 'u64', value: '59214' } }],
  },
  {
    tag: 4,
    name: 'SetLoadedAccountsDataSizeLimit',
    data: payload(4, le(33_554_432n, 4)),
    fields: [{ name: 'bytes', value: { type: 'u32', value: 33_554_432 } }],
  },
];

describe.each(TABLE)('discriminant $tag ($name)', (testCase: TableCase) => {
  it('decodes to its instruction name and fields', () => {
    const outcome = expectFullOutcome(decodeComputeBudgetInstruction(testCase.data));

    expect(outcome.name).toBe(testCase.name);
    expect(outcome.fields).toEqual(testCase.fields);
  });

  it('reaches the same decode through the registry with confidence full', () => {
    // The built-in rung is the only one wired, so this is the value a caller of
    // the public surface receives (Req 4.5, 11.2).
    const registry = createRegistry(null);

    const decode = registry.decodeFor(COMPUTE_BUDGET_PROGRAM_ID, testCase.data, []);
    if (decode.kind !== 'full') {
      throw new Error(`expected a full decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
    }

    expect(decode.name).toBe(testCase.name);
    expect(decode.source).toBe('builtin');
    expect(decode.confidence).toBe('full');
    expect(decode.fields).toEqual(testCase.fields);
  });
});

describe('the instruction table', () => {
  it('covers five pairwise distinct names', () => {
    // A copy-paste that gave two tags the same name would leave every case above
    // green while one instruction was reported as another.
    expect(new Set(TABLE.map((testCase) => testCase.name)).size).toBe(5);
  });

  it('declares the program ID the decoder is registered under', () => {
    expect(computeBudgetDecoder.programId).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(computeBudgetDecoder.source).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// microLamports is a u64 — Requirement 9.2's discipline, applied to a rate
// ---------------------------------------------------------------------------

describe('SetComputeUnitPrice.microLamports', () => {
  it('survives a value above 2^53 as an exact decimal string', () => {
    // 9007199254740993 is the smallest integer a double cannot hold; `Number`
    // would return 9007199254740992 and nothing downstream could tell.
    const outcome = expectFullOutcome(
      decodeComputeBudgetInstruction(payload(3, le(9_007_199_254_740_993n, 8))),
    );

    expect(outcome.fields).toEqual([
      { name: 'microLamports', value: { type: 'u64', value: '9007199254740993' } },
    ]);
  });

  it('survives the u64 maximum', () => {
    const outcome = expectFullOutcome(
      decodeComputeBudgetInstruction(payload(3, le(2n ** 64n - 1n, 8))),
    );

    expect(outcome.fields).toEqual([
      { name: 'microLamports', value: { type: 'u64', value: '18446744073709551615' } },
    ]);
  });

  it('reads zero as "0" rather than omitting the field', () => {
    const outcome = expectFullOutcome(decodeComputeBudgetInstruction(payload(3, le(0n, 8))));

    expect(outcome.fields).toEqual([
      { name: 'microLamports', value: { type: 'u64', value: '0' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Degradation — Requirements 4.3, 11.1, 11.3, 11.7
// ---------------------------------------------------------------------------

describe('an unrecognised discriminant', () => {
  // 5 is one past the table; 0xff is far outside it. Both must behave the same.
  it.each([5, 9, 0xff])('is no-match, not error, for tag %i', (tag: number) => {
    // `no-match` is "not mine, keep going down the ladder" — the same answer the
    // other built-ins give — so the bytes survive to the `Unknown` floor rather
    // than a diagnostic being manufactured for a payload this decoder never
    // claimed.
    expect(decodeComputeBudgetInstruction(payload(tag, le(1n, 4)))).toEqual<DecodeOutcome>({
      kind: 'no-match',
    });
  });

  it('reaches the Unknown floor with every byte preserved', () => {
    const registry = createRegistry(null);
    const data = payload(0xff, le(1n, 4));

    const decode = expectRawDecode(registry.decodeFor(COMPUTE_BUDGET_PROGRAM_ID, data, []));

    expect(decode.name).toBe('Unknown');
    expect(decode.confidence).toBe('raw');
    expect(decode.rawInstructionData).toEqual({
      label: 'raw_instruction_data',
      hex: '0xff01000000',
      byteLength: 5,
      truncated: false,
    });
    // The floor names the built-in that declined, rather than claiming nothing
    // was registered for the program.
    expect(decode.errorDetail).toBe(
      `the built-in decoder for program ${COMPUTE_BUDGET_PROGRAM_ID} did not recognize this payload`,
    );
  });
});

describe('an empty payload', () => {
  it('is an error naming the missing discriminant, not a named instruction', () => {
    // Unlike the Associated Token Account program, Compute Budget has no legacy
    // zero-length encoding, so there is no instruction an empty payload could be.
    const outcome = expectErrorOutcome(decodeComputeBudgetInstruction(new Uint8Array(0)));

    expect(outcome.detail).toContain('is 0 byte(s)');
    expect(outcome.detail).toContain('too short for the 1-byte discriminant');
    expect(outcome.detail).toContain('could not be named');
  });

  it('carries that explanation onto the raw decode', () => {
    // Requirement 11.7: the decoder's reason survives into the output, and
    // resolution stops rather than falling through to a lower rung.
    const registry = createRegistry(null);

    const decode = expectRawDecode(
      registry.decodeFor(COMPUTE_BUDGET_PROGRAM_ID, new Uint8Array(0), []),
    );

    expect(decode.errorDetail).toContain('too short for the 1-byte discriminant');
    expect(decode.rawInstructionData).toEqual({
      label: 'raw_instruction_data',
      hex: '0x',
      byteLength: 0,
      truncated: false,
    });
  });
});

/**
 * One truncation: a tag whose payload stops short of a field boundary.
 *
 * `fieldName` is the field that could not be read, and it appears in the
 * decoder's own message, so the assertion checks the diagnostic names the right
 * field rather than merely being non-empty.
 */
interface TruncationCase {
  readonly label: string;
  readonly tag: number;
  readonly instruction: string;
  readonly fieldName: string;
  /** Bytes after the tag — always one short of the field's width. */
  readonly partialField: Uint8Array;
}

const TRUNCATIONS: readonly TruncationCase[] = [
  {
    label: 'RequestUnits with three of its first four bytes',
    tag: 0,
    instruction: 'RequestUnits',
    fieldName: 'units',
    partialField: new Uint8Array([0x40, 0x0d, 0x03]),
  },
  {
    label: 'RequestHeapFrame with three of four',
    tag: 1,
    instruction: 'RequestHeapFrame',
    fieldName: 'bytes',
    partialField: new Uint8Array([0x00, 0x00, 0x04]),
  },
  {
    label: 'SetComputeUnitLimit with three of four',
    tag: 2,
    instruction: 'SetComputeUnitLimit',
    fieldName: 'units',
    partialField: new Uint8Array([0x40, 0x5d, 0x15]),
  },
  {
    label: 'SetComputeUnitPrice with seven of eight',
    tag: 3,
    instruction: 'SetComputeUnitPrice',
    fieldName: 'microLamports',
    partialField: new Uint8Array([0x4e, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x00]),
  },
  {
    label: 'SetLoadedAccountsDataSizeLimit with three of four',
    tag: 4,
    instruction: 'SetLoadedAccountsDataSizeLimit',
    fieldName: 'bytes',
    partialField: new Uint8Array([0xd5, 0x46, 0xce]),
  },
];

describe.each(TRUNCATIONS)('$label', (testCase: TruncationCase) => {
  it('is an error, because no field was recovered', () => {
    // The same split `systemProgram.ts` draws: a decode with zero fields has
    // produced nothing the `raw` fallback would not also produce, so it says
    // `error` rather than claiming a partial read of nothing.
    const outcome = expectErrorOutcome(
      decodeComputeBudgetInstruction(payload(testCase.tag, testCase.partialField)),
    );

    expect(outcome.detail).toContain(`Compute Budget ${testCase.instruction}`);
    expect(outcome.detail).toContain(`"${testCase.fieldName}"`);
    expect(outcome.detail).toContain(`${testCase.partialField.length} byte(s) remained`);
  });
});

describe('RequestUnits truncated between its two fields', () => {
  it('is partial with the first field read and an empty tail', () => {
    // The only reachable mid-instruction truncation in this program, since it is
    // the only instruction with a second field. The payload ends exactly where
    // `additionalFee` should have begun, so `remaining` is empty — honest rather
    // than a bug: `full` would claim the missing field had been read.
    const outcome = expectPartialOutcome(
      decodeComputeBudgetInstruction(payload(0, le(200_000n, 4))),
    );

    expect(outcome.name).toBe('RequestUnits');
    expect(outcome.fields).toEqual([{ name: 'units', value: { type: 'u32', value: 200_000 } }]);
    expect(outcome.remaining).toHaveLength(0);
  });

  it('surfaces as a partial decode carrying an empty undecoded suffix', () => {
    const registry = createRegistry(null);

    const decode = registry.decodeFor(COMPUTE_BUDGET_PROGRAM_ID, payload(0, le(7n, 4)), []);
    if (decode.kind !== 'partial') {
      throw new Error(`expected a partial decode, got ${decode.kind}`);
    }

    expect(decode.name).toBe('RequestUnits');
    expect(decode.confidence).toBe('partial');
    expect(decode.decodedFields).toEqual([
      { name: 'units', value: { type: 'u32', value: 7 } },
    ]);
    expect(decode.undecodedData).toEqual({
      label: 'raw_instruction_data',
      hex: '0x',
      byteLength: 0,
      truncated: false,
    });
  });

  it('is partial when it carries two extra bytes past its last field', () => {
    // Requirement 11.3 from the other side: the name resolved and both fields
    // decoded, but the suffix is unaccounted for.
    const outcome = expectPartialOutcome(
      decodeComputeBudgetInstruction(
        concat(payload(0, le(1n, 4), le(2n, 4)), new Uint8Array([0xaa, 0xbb])),
      ),
    );

    expect(outcome.name).toBe('RequestUnits');
    expect(outcome.fields).toHaveLength(2);
    expect([...outcome.remaining]).toEqual([0xaa, 0xbb]);
  });
});

// ---------------------------------------------------------------------------
// The recorded chain bytes — the only cases this file did not construct
// ---------------------------------------------------------------------------

interface RecordedInstruction {
  readonly fixture: string;
  /** Index in the fixture's top-level instruction list. */
  readonly index: number;
  /** The base58 `data` string exactly as the RPC delivered it. */
  readonly base58: string;
}

interface RecordedMessage {
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[];
      readonly instructions: readonly {
        readonly programIdIndex: number;
        readonly data: string;
      }[];
    };
  };
}

/**
 * Every Compute Budget instruction of one recording, located by program ID.
 *
 * By program ID rather than by index so that a re-recorded fixture with a
 * different instruction order does not silently change what is being asserted.
 */
function recordedComputeBudget(fixture: string): readonly RecordedInstruction[] {
  const path = fileURLToPath(new URL(`../../golden/${fixture}/input.json`, import.meta.url));
  const document = JSON.parse(readFileSync(path, 'utf8')) as RecordedMessage;
  const { accountKeys, instructions } = document.transaction.message;

  const found: RecordedInstruction[] = [];
  instructions.forEach((instruction, index) => {
    if (accountKeys.at(instruction.programIdIndex) !== COMPUTE_BUDGET_PROGRAM_ID) return;
    found.push({ fixture, index, base58: instruction.data });
  });
  return found;
}

/** What one recorded payload must decode to, asserted value by value. */
interface RecordedCase {
  readonly fixture: string;
  readonly index: number;
  /** The base58 string, transcribed here so a re-recording is visible. */
  readonly base58: string;
  readonly hex: string;
  readonly name: string;
  readonly fields: readonly DecodedField[];
}

const RECORDED: readonly RecordedCase[] = [
  {
    fixture: '07-unknown-program',
    index: 0,
    base58: 'F2HbJF',
    hex: '0224930100',
    name: 'SetComputeUnitLimit',
    fields: [{ name: 'units', value: { type: 'u32', value: 103_204 } }],
  },
  {
    fixture: '07-unknown-program',
    index: 1,
    base58: '3NSy4CxukFwu',
    hex: '0335bf000000000000',
    name: 'SetComputeUnitPrice',
    fields: [{ name: 'microLamports', value: { type: 'u64', value: '48949' } }],
  },
  {
    fixture: '02-anchor-user-error',
    index: 1,
    base58: 'KDm3So',
    hex: '02c8cd0100',
    name: 'SetComputeUnitLimit',
    fields: [{ name: 'units', value: { type: 'u32', value: 118_216 } }],
  },
  {
    fixture: '02-anchor-user-error',
    index: 2,
    base58: '3Sf1nmxa87mh',
    hex: '034ee7000000000000',
    name: 'SetComputeUnitPrice',
    fields: [{ name: 'microLamports', value: { type: 'u64', value: '59214' } }],
  },
  {
    fixture: '02-anchor-user-error',
    index: 3,
    base58: 'YdKTyy',
    hex: '04d546ce00',
    name: 'SetLoadedAccountsDataSizeLimit',
    fields: [{ name: 'bytes', value: { type: 'u32', value: 13_518_549 } }],
  },
];

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

describe('the recorded Compute Budget payloads', () => {
  it('are exactly the five this file accounts for', () => {
    // Without this the block below could pass while finding nothing, and a
    // re-recorded fixture that dropped a Compute Budget instruction would look
    // like a clean run.
    const found = [
      ...recordedComputeBudget('07-unknown-program'),
      ...recordedComputeBudget('02-anchor-user-error'),
    ];

    expect(
      found.map((instruction) => ({
        fixture: instruction.fixture,
        index: instruction.index,
        base58: instruction.base58,
      })),
    ).toEqual(
      RECORDED.map((testCase) => ({
        fixture: testCase.fixture,
        index: testCase.index,
        base58: testCase.base58,
      })),
    );
  });
});

describe.each(RECORDED)('$fixture instruction $index', (testCase: RecordedCase) => {
  it('base58-decodes to the byte string this file expects', () => {
    // The encoding claim, separated from the decode claim: `data` is base58 and
    // not base64, so a change of encoding upstream fails here with the two byte
    // strings side by side rather than as a confusing field mismatch.
    const found = recordedComputeBudget(testCase.fixture).find(
      (instruction) => instruction.index === testCase.index,
    );
    if (found === undefined) throw new Error(`no Compute Budget instruction at ${testCase.index}`);

    expect(found.base58).toBe(testCase.base58);
    expect(hexOf(bs58.decode(found.base58))).toBe(testCase.hex);
  });

  it('decodes to its instruction name and fields', () => {
    const outcome = expectFullOutcome(
      decodeComputeBudgetInstruction(bs58.decode(testCase.base58)),
    );

    expect(outcome.name).toBe(testCase.name);
    expect(outcome.fields).toEqual(testCase.fields);
  });

  it('consumes the whole payload, so no suffix is left unexplained', () => {
    // The width check that matters: a u64 read as a u32 would still produce a
    // plausible number from every one of these payloads, and would then report
    // trailing bytes. `full` is the only outcome that rules that out.
    const registry = createRegistry(null);

    const decode = registry.decodeFor(
      COMPUTE_BUDGET_PROGRAM_ID,
      bs58.decode(testCase.base58),
      [],
    );

    expect(decode.kind).toBe('full');
    expect(decode.confidence).toBe('full');
  });
});
