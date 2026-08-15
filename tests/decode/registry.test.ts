/**
 * The decoder registry: the precedence ladder, the raw fallback, and account
 * naming.
 *
 * Requirements 3.5, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 7.12, 7.13, 11.1, 11.2, 11.3,
 * 11.7.
 *
 * Every test here goes through a **real** decoder. The IDL rung is a real
 * `LoadedIdl` run through `createIdlDecoder`'s discriminator matching, and the
 * built-in rung is the actual System Program decoder registered at the actual
 * System Program address. Nothing is stubbed, because the two facts under test —
 * an IDL beats a built-in, and an IDL that does not recognize a payload steps
 * aside for one that might — are facts about how those two decoders interact. A
 * fake decoder returning a scripted `no-match` would exercise the loop and not
 * the ladder.
 *
 * The pairing worth the most is the fall-through case. An IDL registered for the
 * System Program that declares no `Transfer` must still leave a real `Transfer`
 * payload decoding through the built-in (Req 4.7). Get the ladder wrong in the
 * obvious way — treat a `no-match` as a decode — and that payload silently
 * becomes `Unknown` while every other test still passes.
 *
 * `source` is asserted on every decoded outcome. It is the only field that says
 * *which* rung answered, so a ladder that resolved the right name from the wrong
 * rung would otherwise read as a pass.
 */

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SPL_TOKEN_PROGRAM_ID } from '../../src/decode/builtin/splToken.js';
import { SYSTEM_PROGRAM_ID } from '../../src/decode/builtin/systemProgram.js';
import { anchorDiscriminator } from '../../src/decode/idl/idlDecoder.js';
import type {
  IdlInstruction,
  IdlInstructionAccount,
  IdlStore,
  LoadedIdl,
} from '../../src/decode/idl/idlStore.js';
import { createRegistry } from '../../src/decode/registry.js';
import type { AccountRef, Base58Address, InstructionDecode } from '../../src/model/analysis.js';
import type { RawInstruction } from '../../src/model/rawResponse.js';

/** A program with neither an IDL nor a built-in decoder. */
const UNKNOWN_PROGRAM: Base58Address = 'Ea4kQfwLwmL2c8dNxrgTgQuqbC6jvpKPRJPUuBwgS8Ln';

const FROM: Base58Address = 'MEisE1HzehtrDpAAT8PnLHjpSSkRYakotTuJRPjTpo8';
const TO: Base58Address = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// IDL and store construction
// ---------------------------------------------------------------------------

function idlFor(
  address: Base58Address,
  instructions: readonly IdlInstruction[],
): LoadedIdl {
  return {
    path: '/idls/example.json',
    version: '0.1.0',
    name: 'example_program',
    address,
    instructions,
    errors: [],
    accounts: [],
  };
}

/** A store holding exactly the IDLs given, keyed by their own `address`. */
function storeOf(...idls: readonly LoadedIdl[]): IdlStore {
  const byAddress = new Map(idls.map((idl) => [idl.address, idl]));
  return {
    get: (programId) => byAddress.get(programId),
    warnings: [],
    programIds: [...byAddress.keys()],
  };
}

function account(name: string): IdlInstructionAccount {
  return { kind: 'account', name };
}

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
 * A System Program `Transfer`: a 4-byte little-endian variant tag of 2 followed
 * by a u64 lamport amount. The same 12-byte shape the recorded fixture
 * `07-unknown-program` carries.
 */
function systemTransfer(lamports: bigint): Uint8Array {
  return concat(le(2n, 4), le(lamports, 8));
}

/** An Anchor payload: the instruction's discriminator, then its Borsh args. */
function anchorPayload(name: string, ...args: readonly Uint8Array[]): Uint8Array {
  return concat(anchorDiscriminator(name), ...args);
}

/** Wrap bytes as an RPC instruction, i.e. base58 in `data`. */
function instructionOf(bytes: Uint8Array): RawInstruction {
  return { programIdIndex: 0, accounts: [], data: bs58.encode(bytes) };
}

// ---------------------------------------------------------------------------
// Account refs
// ---------------------------------------------------------------------------

function resolvedRef(index: number, address: Base58Address): AccountRef {
  return {
    kind: 'resolved',
    index,
    address,
    signer: index === 0,
    role: 'writable',
    origin: { kind: 'static' },
    name: null,
    confidence: 'full',
  };
}

const TRANSFER_ACCOUNTS: readonly AccountRef[] = [resolvedRef(0, FROM), resolvedRef(1, TO)];

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function expectFull(decode: InstructionDecode): Extract<InstructionDecode, { kind: 'full' }> {
  if (decode.kind !== 'full') {
    throw new Error(`expected a full decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
  }
  return decode;
}

function expectPartial(decode: InstructionDecode): Extract<InstructionDecode, { kind: 'partial' }> {
  if (decode.kind !== 'partial') {
    throw new Error(`expected a partial decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
  }
  return decode;
}

function expectRaw(decode: InstructionDecode): Extract<InstructionDecode, { kind: 'raw' }> {
  if (decode.kind !== 'raw') {
    throw new Error(`expected a raw decode, got ${decode.kind}: ${JSON.stringify(decode)}`);
  }
  return decode;
}

/** Names in slot order, `null` where none was applied. */
function namesOf(accounts: readonly AccountRef[]): readonly (string | null)[] {
  return accounts.map((ref) => (ref.kind === 'resolved' ? ref.name : null));
}

// ---------------------------------------------------------------------------
// Rung 1 — the Anchor IDL, Requirements 4.1, 4.6
// ---------------------------------------------------------------------------

describe('the IDL rung', () => {
  /**
   * The one payload in this file **both** rungs can answer, which is what makes
   * Requirement 4.6 testable at all.
   *
   * `transfer_v119`'s Anchor discriminator is `03277640a95712ab`, and SPL Token
   * reads its variant from a single leading byte — so `0x03` is that program's
   * `Transfer`. Registering an IDL for SPL Token declaring `transfer_v119` puts
   * two decoders that both recognize these bytes on the same program, and the
   * name in the output says which one answered. Without a collision like this
   * one, an IDL match and a built-in match never overlap and a registry with its
   * rungs in the wrong order would still pass every other test here.
   *
   * The name was found by search, and the discriminator is asserted below rather
   * than assumed, because the collision is the premise of the test: if
   * `anchorDiscriminator` ever changed, the test would keep passing while testing
   * nothing.
   */
  const COLLIDING_NAME = 'transfer_v119';
  const collidingIdl = idlFor(SPL_TOKEN_PROGRAM_ID, [
    { name: COLLIDING_NAME, accounts: [], args: [{ name: 'amount', type: 'u64' }] },
  ]);
  const collidingPayload = anchorPayload(COLLIDING_NAME, le(7n, 8));

  it('collides with SPL Token on the payload the next two tests share', () => {
    expect(Buffer.from(anchorDiscriminator(COLLIDING_NAME)).toString('hex')).toBe(
      '03277640a95712ab',
    );
  });

  it('wins over a built-in decoder for the same program', () => {
    const registry = createRegistry(storeOf(collidingIdl));

    const decode = expectFull(registry.decodeFor(SPL_TOKEN_PROGRAM_ID, collidingPayload, []));

    expect(decode.source).toBe('anchor-idl');
    expect(decode.name).toBe(COLLIDING_NAME);
    expect(decode.fields).toEqual([{ name: 'amount', value: { type: 'u64', value: '7' } }]);
    expect(decode.confidence).toBe('full');
  });

  it('is the reason that payload is not read as SPL Token Transfer', () => {
    // The same bytes with the IDL removed. The built-in reads the leading `0x03`
    // as its `Transfer` variant, so the previous test's result is a precedence
    // decision and not the only reading available.
    const registry = createRegistry(null);

    const decode = expectPartial(registry.decodeFor(SPL_TOKEN_PROGRAM_ID, collidingPayload, []));

    expect(decode.source).toBe('builtin');
    expect(decode.name).toBe('Transfer');
  });

  it('carries decoded fields and the unconsumed suffix on a partial decode', () => {
    // One declared `u64` against a payload with eight surplus bytes after it.
    // Requirement 11.3: the name and the field are real, and the tail is not
    // claimed to have been understood.
    const idl = idlFor(UNKNOWN_PROGRAM, [
      { name: 'transfer', accounts: [], args: [{ name: 'amount', type: 'u64' }] },
    ]);
    const registry = createRegistry(storeOf(idl));

    const decode = expectPartial(
      registry.decodeFor(
        UNKNOWN_PROGRAM,
        anchorPayload('transfer', le(9n, 8), new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
        [],
      ),
    );

    expect(decode.source).toBe('anchor-idl');
    expect(decode.name).toBe('transfer');
    expect(decode.decodedFields).toEqual([
      { name: 'amount', value: { type: 'u64', value: '9' } },
    ]);
    expect(decode.undecodedData).toEqual({
      label: 'raw_instruction_data',
      hex: '0xdeadbeef',
      byteLength: 4,
      truncated: false,
    });
    expect(decode.confidence).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Rung 2 — built-in decoders, Requirements 4.2, 4.7
// ---------------------------------------------------------------------------

describe('the built-in rung', () => {
  it('decodes when no IDL is loaded at all', () => {
    const registry = createRegistry(null);

    const decode = expectFull(
      registry.decodeFor(SYSTEM_PROGRAM_ID, systemTransfer(1_000n), TRANSFER_ACCOUNTS),
    );

    expect(decode.source).toBe('builtin');
    expect(decode.name).toBe('Transfer');
    expect(decode.fields).toEqual([
      { name: 'lamports', value: { type: 'lamports', value: '1000' } },
    ]);
  });

  it('decodes when an IDL exists but declares no matching discriminator', () => {
    // Requirement 4.7. The IDL is for the System Program and is consulted first;
    // its one instruction's discriminator is not what this payload opens with, so
    // the built-in gets the payload rather than the fallback getting it.
    const idl = idlFor(SYSTEM_PROGRAM_ID, [
      { name: 'somethingElse', accounts: [], args: [{ name: 'amount', type: 'u64' }] },
    ]);
    const registry = createRegistry(storeOf(idl));

    const decode = expectFull(
      registry.decodeFor(SYSTEM_PROGRAM_ID, systemTransfer(42n), TRANSFER_ACCOUNTS),
    );

    expect(decode.source).toBe('builtin');
    expect(decode.name).toBe('Transfer');
    expect(decode.fields).toEqual([
      { name: 'lamports', value: { type: 'lamports', value: '42' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rung 3 — the Unknown fallback, Requirements 3.5, 4.3, 11.1, 11.7
// ---------------------------------------------------------------------------

describe('the Unknown fallback', () => {
  it('is reached when the program has neither an IDL nor a built-in decoder', () => {
    const registry = createRegistry(null);
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);

    const decode = expectRaw(registry.decodeFor(UNKNOWN_PROGRAM, bytes, []));

    expect(decode.name).toBe('Unknown');
    expect(decode.note).toContain('Unknown program');
    expect(decode.rawInstructionData).toEqual({
      label: 'raw_instruction_data',
      hex: '0x010203',
      byteLength: 3,
      truncated: false,
    });
    expect(decode.errorDetail).toBe(
      `no decoder or Anchor IDL is registered for program ${UNKNOWN_PROGRAM}`,
    );
    expect(decode.confidence).toBe('raw');
  });

  it('says so when the only IDL loaded declares no matching discriminator', () => {
    // The IDL-present, built-in-absent corner of Requirement 4.7: there is no
    // lower rung to fall to, and the reason names the IDL rather than claiming
    // nothing was registered.
    const idl = idlFor(UNKNOWN_PROGRAM, [
      { name: 'somethingElse', accounts: [], args: [] },
    ]);
    const registry = createRegistry(storeOf(idl));

    const decode = expectRaw(
      registry.decodeFor(UNKNOWN_PROGRAM, anchorPayload('transfer'), []),
    );

    expect(decode.errorDetail).toContain('declares no instruction with this discriminator');
    expect(decode.errorDetail).toContain('no built-in decoder is registered');
  });

  it('carries a decoder error as errorDetail rather than falling through', () => {
    // Two bytes is too short for the System Program's 4-byte variant tag, which
    // that decoder reports as `error` and not `no-match`. Requirement 11.7: the
    // explanation survives into the output, and the bytes are still preserved.
    const registry = createRegistry(null);
    const bytes = new Uint8Array([0x02, 0x00]);

    const decode = expectRaw(registry.decodeFor(SYSTEM_PROGRAM_ID, bytes, []));

    expect(decode.errorDetail).toContain('too short for the 4-byte little-endian discriminant');
    expect(decode.rawInstructionData.hex).toBe('0x0200');
    expect(decode.rawInstructionData.byteLength).toBe(2);
  });

  it('reports an unresolved program ID as a lookup that could not happen', () => {
    const registry = createRegistry(null);

    const decode = expectRaw(registry.decodeFor(null, systemTransfer(1n), []));

    expect(decode.errorDetail).toBe(
      'the program ID could not be resolved from the account keys, so no decoder or IDL lookup was possible',
    );
  });
});

// ---------------------------------------------------------------------------
// decodeInstruction — the base58 boundary, Requirement 3.5
// ---------------------------------------------------------------------------

describe('decodeInstruction', () => {
  it('reads the payload as base58 and decodes it', () => {
    const registry = createRegistry(null);

    const decode = expectFull(
      registry.decodeInstruction(
        SYSTEM_PROGRAM_ID,
        instructionOf(systemTransfer(5n)),
        TRANSFER_ACCOUNTS,
      ),
    );

    expect(decode.name).toBe('Transfer');
  });

  it('yields Unknown with no bytes when the payload is not valid base58', () => {
    const registry = createRegistry(null);

    const decode = expectRaw(
      registry.decodeInstruction(
        SYSTEM_PROGRAM_ID,
        { programIdIndex: 0, accounts: [], data: '0OIl' },
        [],
      ),
    );

    expect(decode.errorDetail).toContain('not valid base58');
    expect(decode.rawInstructionData).toEqual({
      label: 'raw_instruction_data',
      hex: '0x',
      byteLength: 0,
      truncated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Account naming — Requirements 7.12, 7.13
// ---------------------------------------------------------------------------

describe('nameAccounts', () => {
  const namedTransfer = idlFor(SPL_TOKEN_PROGRAM_ID, [
    {
      name: 'transfer',
      accounts: [account('source'), account('destination')],
      args: [{ name: 'amount', type: 'u64' }],
    },
  ]);

  it('applies the matched instruction names positionally', () => {
    const registry = createRegistry(storeOf(namedTransfer));

    const named = registry.nameAccounts(
      SPL_TOKEN_PROGRAM_ID,
      instructionOf(anchorPayload('transfer', le(1n, 8))),
      TRANSFER_ACCOUNTS,
    );

    expect(namesOf(named)).toEqual(['source', 'destination']);
    // Addresses are untouched; naming is the only change.
    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.address : null))).toEqual([FROM, TO]);
  });

  it('leaves every name null when the IDL declares no matching discriminator', () => {
    // Requirement 7.13. The IDL applies to the program but not to this
    // instruction, so no position receives a name and no address changes.
    const registry = createRegistry(storeOf(namedTransfer));

    const named = registry.nameAccounts(
      SPL_TOKEN_PROGRAM_ID,
      instructionOf(new Uint8Array([0x03, 0x01, 0x02])),
      TRANSFER_ACCOUNTS,
    );

    expect(namesOf(named)).toEqual([null, null]);
    expect(named).toBe(TRANSFER_ACCOUNTS);
  });

  it('leaves every name null when no IDL is loaded for the program', () => {
    const registry = createRegistry(null);

    const named = registry.nameAccounts(
      SPL_TOKEN_PROGRAM_ID,
      instructionOf(anchorPayload('transfer', le(1n, 8))),
      TRANSFER_ACCOUNTS,
    );

    expect(namesOf(named)).toEqual([null, null]);
  });

  it('leaves every name null when the program ID is unresolved', () => {
    const registry = createRegistry(storeOf(namedTransfer));

    const named = registry.nameAccounts(
      null,
      instructionOf(anchorPayload('transfer', le(1n, 8))),
      TRANSFER_ACCOUNTS,
    );

    expect(namesOf(named)).toEqual([null, null]);
  });
});
