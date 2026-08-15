/**
 * Built-in decoder registration: the three program IDs of Requirement 4.4, and
 * the fact that a real payload sent to each of those addresses reaches its
 * decoder.
 *
 * Requirement 4.4.
 *
 * **Why the addresses are spelled out here instead of imported.** The registry
 * keys its built-in map with `SYSTEM_PROGRAM_ID`, `SPL_TOKEN_PROGRAM_ID`, and
 * `SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID` taken from the decoder modules
 * themselves, which is the right coupling — a decoder and its registration
 * cannot disagree — but it means a typo in one of those constants leaves the
 * map perfectly self-consistent. The decoder would be registered under the
 * typo'd address and looked up under the same typo'd address, so a test that
 * imported the constant would pass while no mainnet instruction ever reached
 * the decoder again. The only test that can catch that is one that states the
 * canonical addresses independently, so the three literals below are typed out
 * from Requirement 4.4 and this file imports no program ID from `src/`.
 *
 * Three assertions per program, each catching a different way the registration
 * can be wrong:
 *
 * 1. The literal base58-decodes to exactly 32 bytes. A transposed character
 *    that stays inside the base58 alphabet usually changes the decoded length,
 *    so this catches the class of typo that the literal comparison alone would
 *    only catch if the reader spotted it by eye.
 * 2. The decoder's own `programId` equals the canonical literal, and its
 *    `source` is `'builtin'`. This is the constant-level check: it fails on the
 *    typo directly, at the module that owns it.
 * 3. A payload that program genuinely recognizes, handed to
 *    `createRegistry(null).decodeFor(<canonical address>, ...)`, comes back with
 *    a real instruction name and `source: 'builtin'`. This is the end-to-end
 *    statement, and the one that would fail on a typo even if the constants
 *    were somehow bypassed: registration means "this address resolves through
 *    the public registry surface", not "the map contains an entry".
 *
 * The payloads are the real wire shapes, not stand-ins, because a decoder that
 * answers `no-match` is indistinguishable at the registry surface from a
 * decoder that was never registered — both produce `Unknown`. Each payload is
 * built from the encoding its own module documents: a 4-byte little-endian
 * variant tag for the System Program, a single tag byte for SPL Token and for
 * the Associated Token Account program.
 *
 * The precedence ladder is not retested here; `registry.test.ts` owns it. This
 * file is only about which addresses the built-in rung answers for.
 */

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { splAssociatedTokenAccountDecoder } from '../../src/decode/builtin/splAssociatedTokenAccount.js';
import { splTokenDecoder } from '../../src/decode/builtin/splToken.js';
import { systemProgramDecoder } from '../../src/decode/builtin/systemProgram.js';
import { createRegistry, type InstructionDecoder } from '../../src/decode/registry.js';
import type { Base58Address, InstructionDecode } from '../../src/model/analysis.js';

// ---------------------------------------------------------------------------
// The canonical addresses, transcribed from Requirement 4.4
// ---------------------------------------------------------------------------

const CANONICAL_SYSTEM_PROGRAM_ID: Base58Address = '11111111111111111111111111111111';
const CANONICAL_SPL_TOKEN_PROGRAM_ID: Base58Address =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CANONICAL_SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: Base58Address =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Every Solana program ID is a 32-byte ed25519 public key or program address. */
const ADDRESS_BYTES = 32;

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

function le(value: bigint, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let rest = value;
  for (let index = 0; index < byteLength; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * A System Program `Transfer`: a 4-byte little-endian variant tag of 2, then a
 * u64 lamport amount. The 12-byte shape the recorded fixtures carry.
 */
const SYSTEM_TRANSFER = concat(le(2n, 4), le(7_000n, 8));

/**
 * An SPL Token `Transfer`: a single tag byte of 3, then a u64 amount. The tag
 * width genuinely differs from the System Program's, which is why this payload
 * is built from SPL Token's own documented encoding rather than by analogy.
 */
const SPL_TOKEN_TRANSFER = concat(new Uint8Array([3]), le(11n, 8));

/**
 * An ATA `CreateIdempotent`: the tag byte 1 and nothing else, since no
 * instruction of that program takes arguments.
 *
 * `CreateIdempotent` rather than `Create` on purpose. A zero-length payload also
 * decodes to `Create` — the legacy encoding — so a decoder reached with an empty
 * payload would name `Create` even if the tag table were empty. Tag 1 can only
 * be answered by the table, so the decode proves the real decoder ran.
 */
const ATA_CREATE_IDEMPOTENT = new Uint8Array([1]);

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function expectFull(decode: InstructionDecode): Extract<InstructionDecode, { kind: 'full' }> {
  if (decode.kind !== 'full') {
    throw new Error(`expected a full decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
  }
  return decode;
}

// ---------------------------------------------------------------------------
// One case per built-in decoder — Requirement 4.4
// ---------------------------------------------------------------------------

interface BuiltinCase {
  /** How the program is named in Requirement 4.4. */
  readonly label: string;
  /** Transcribed from the requirement, never imported from `src/`. */
  readonly canonicalAddress: Base58Address;
  readonly decoder: InstructionDecoder;
  /** A payload this program genuinely recognizes, in its own wire encoding. */
  readonly payload: Uint8Array;
  /** The instruction name that payload must resolve to. */
  readonly instructionName: string;
}

const CASES: readonly BuiltinCase[] = [
  {
    label: 'System Program',
    canonicalAddress: CANONICAL_SYSTEM_PROGRAM_ID,
    decoder: systemProgramDecoder,
    payload: SYSTEM_TRANSFER,
    instructionName: 'Transfer',
  },
  {
    label: 'SPL Token',
    canonicalAddress: CANONICAL_SPL_TOKEN_PROGRAM_ID,
    decoder: splTokenDecoder,
    payload: SPL_TOKEN_TRANSFER,
    instructionName: 'Transfer',
  },
  {
    label: 'SPL Associated Token Account',
    canonicalAddress: CANONICAL_SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    decoder: splAssociatedTokenAccountDecoder,
    payload: ATA_CREATE_IDEMPOTENT,
    instructionName: 'CreateIdempotent',
  },
];

describe.each(CASES)('$label built-in decoder', (testCase: BuiltinCase) => {
  it('is registered under an address that base58-decodes to 32 bytes', () => {
    // A typo that leaves the base58 alphabet would already have thrown here; one
    // that stays inside it almost always changes the decoded length.
    const decoded = bs58.decode(testCase.canonicalAddress);

    expect(decoded).toHaveLength(ADDRESS_BYTES);
  });

  it('declares the canonical program ID as its own programId', () => {
    // The constant-level check, at the module that owns the constant. A typo in
    // `src/decode/builtin/*.ts` fails right here, where the registry's own
    // self-consistency cannot hide it.
    expect(testCase.decoder.programId).toBe(testCase.canonicalAddress);
    expect(testCase.decoder.source).toBe('builtin');
  });

  it('answers a real payload sent to the canonical address through the registry', () => {
    // The end-to-end statement of registration (Req 4.4): the decode arrives via
    // the public surface, addressed by the canonical literal, with no IDL loaded
    // so the built-in rung is the only one that can answer.
    const registry = createRegistry(null);

    const decode = expectFull(registry.decodeFor(testCase.canonicalAddress, testCase.payload, []));

    expect(decode.name).toBe(testCase.instructionName);
    expect(decode.name).not.toBe('Unknown');
    expect(decode.source).toBe('builtin');
    expect(decode.confidence).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// The three registrations are three distinct registrations
// ---------------------------------------------------------------------------

describe('the three built-in registrations', () => {
  it('cover three pairwise distinct addresses', () => {
    // A copy-paste that gave two decoders the same program ID would register one
    // of them over the other, leaving the displaced program silently undecoded
    // while both `programId` assertions above still passed.
    const addresses = CASES.map((testCase) => testCase.canonicalAddress);

    expect(new Set(addresses).size).toBe(CASES.length);
  });

  it('cover three distinct decoders', () => {
    const decoders = CASES.map((testCase) => testCase.decoder);

    expect(new Set(decoders).size).toBe(CASES.length);
  });
});
