/**
 * The Anchor IDL instruction decoder: discriminator matching, the Borsh type
 * grammar, and positional account naming.
 *
 * Requirements 4.1, 4.7, 7.12, 7.13, 9.2, 9.3, 11.3.
 *
 * Three things here are worth more than the rest.
 *
 * The `initialize` discriminator is asserted against `afaf6d1f0d989bed`, a value
 * every Anchor program on mainnet carries and which was not produced by the code
 * under test. A wrong discriminator fails silently — every instruction of the
 * program simply stops matching and degrades to `Unknown` — so one independently
 * known constant is the only thing that pins it.
 *
 * `u64` values above 2^53 are asserted as exact decimal digit strings. A `Number`
 * anywhere in the read path rounds them, and a rounded value has the right
 * shape, the right magnitude, and the wrong digits (Req 9.2).
 *
 * A float argument is asserted to yield `unsupported` *and* to leave the
 * instruction `partial` even when the payload was consumed to its last byte.
 * That pairing is the whole reason the `unsupported` variant exists (Req 9.3).
 */

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import {
  anchorDiscriminator,
  applyAccountNames,
  createIdlDecoder,
  createIdlDecoders,
  decodeArgs,
  flattenIdlAccountNames,
  toSnakeCase,
} from '../../../src/decode/idl/idlDecoder.js';
import type {
  IdlField,
  IdlInstruction,
  IdlInstructionAccount,
  IdlStore,
  IdlTypeNode,
  LoadedIdl,
} from '../../../src/decode/idl/idlStore.js';
import { toRawData, type DecodeOutcome } from '../../../src/decode/registry.js';
import type { AccountRef, DecodedField } from '../../../src/model/analysis.js';

const PROGRAM_ID = 'Ea4kQfwLwmL2c8dNxrgTgQuqbC6jvpKPRJPUuBwgS8Ln';
const OWNER = 'MEisE1HzehtrDpAAT8PnLHjpSSkRYakotTuJRPjTpo8';

// ---------------------------------------------------------------------------
// IDL construction
// ---------------------------------------------------------------------------

function instruction(
  name: string,
  args: readonly IdlField[] = [],
  accounts: readonly IdlInstructionAccount[] = [],
): IdlInstruction {
  return { name, accounts, args };
}

function idlWith(...instructions: readonly IdlInstruction[]): LoadedIdl {
  return {
    path: '/idls/example.json',
    version: '0.1.0',
    name: 'example_program',
    address: PROGRAM_ID,
    instructions,
    errors: [],
    accounts: [],
  };
}

/** One instruction named `initialize` taking `args`. */
function idlTaking(...args: readonly IdlField[]): LoadedIdl {
  return idlWith(instruction('initialize', args));
}

function arg(name: string, type: IdlTypeNode): IdlField {
  return { name, type };
}

// ---------------------------------------------------------------------------
// Borsh payload construction
// ---------------------------------------------------------------------------

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Little-endian two's complement of `value` in `byteLength` bytes. */
function le(value: bigint, byteLength: number): Uint8Array {
  const bits = BigInt(byteLength) * 8n;
  const unsigned = value < 0n ? value + (1n << bits) : value;
  const out = new Uint8Array(byteLength);
  let rest = unsigned;
  for (let index = 0; index < byteLength; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const u8 = (value: number): Uint8Array => le(BigInt(value), 1);
const u32 = (value: number): Uint8Array => le(BigInt(value), 4);
const u64 = (value: bigint): Uint8Array => le(value, 8);

/** Borsh string or bytes: a u32 little-endian length, then the bytes. */
function borshBytes(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

function borshString(value: string): Uint8Array {
  return borshBytes(new TextEncoder().encode(value));
}

const SOME = u8(1);
const NONE = u8(0);

/** A payload for `name`: its discriminator followed by the encoded arguments. */
function payloadFor(name: string, ...args: readonly Uint8Array[]): Uint8Array {
  return concat(anchorDiscriminator(name), ...args);
}

// ---------------------------------------------------------------------------
// Outcome narrowing
// ---------------------------------------------------------------------------

function expectFull(outcome: DecodeOutcome): {
  readonly name: string;
  readonly fields: readonly DecodedField[];
} {
  if (outcome.kind !== 'full') {
    throw new Error(`expected a full decode, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectPartial(outcome: DecodeOutcome): {
  readonly name: string;
  readonly fields: readonly DecodedField[];
  readonly remaining: Uint8Array;
} {
  if (outcome.kind !== 'partial') {
    throw new Error(`expected a partial decode, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectError(outcome: DecodeOutcome): string {
  if (outcome.kind !== 'error') {
    throw new Error(`expected an error, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome.detail;
}

/** Decode `args` against a one-instruction IDL and return the fields. */
function fieldsOf(args: readonly IdlField[], ...encoded: readonly Uint8Array[]): readonly DecodedField[] {
  const decoder = createIdlDecoder(idlTaking(...args));
  return expectFull(decoder.decode(payloadFor('initialize', ...encoded), [])).fields;
}

// ---------------------------------------------------------------------------
// Account refs
// ---------------------------------------------------------------------------

function resolvedRef(index: number, address: string): AccountRef {
  return {
    kind: 'resolved',
    index,
    address,
    signer: false,
    role: 'readonly',
    origin: { kind: 'static' },
    name: null,
    confidence: 'full',
  };
}

function unresolvedRef(index: number): AccountRef {
  return { kind: 'unresolved', index, reason: 'out of range', confidence: 'raw' };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Discriminators — Requirement 4.1
// ---------------------------------------------------------------------------

describe('anchorDiscriminator', () => {
  it('computes the known Anchor discriminator for "initialize"', () => {
    // sha256("global:initialize")[0..8]. Not derived from the code under test.
    expect(toHex(anchorDiscriminator('initialize'))).toBe('afaf6d1f0d989bed');
    expect(anchorDiscriminator('initialize')).toHaveLength(8);
  });

  it('derives the same discriminator from a camelCase and a snake_case name', () => {
    // Some Anchor versions emit camelCase instruction names while the
    // discriminator still comes from the snake_case Rust function.
    expect(toHex(anchorDiscriminator('createOrder'))).toBe(toHex(anchorDiscriminator('create_order')));
    expect(toHex(anchorDiscriminator('create_order'))).toBe('8d3625cfedd2fad7');
  });

  it('leaves an already snake_case name alone and splits runs of capitals', () => {
    expect(toSnakeCase('create_order')).toBe('create_order');
    expect(toSnakeCase('createOrder')).toBe('create_order');
    expect(toSnakeCase('initNFTMint')).toBe('init_nft_mint');
  });
});

describe('discriminator matching', () => {
  const decoder = createIdlDecoder(idlTaking(arg('amount', 'u64')));

  it('matches a declared instruction and names it from the IDL', () => {
    const outcome = decoder.decode(payloadFor('initialize', u64(7n)), []);

    expect(expectFull(outcome).name).toBe('initialize');
    expect(decoder.match(payloadFor('initialize', u64(7n)))?.name).toBe('initialize');
  });

  it('reports no-match for a discriminator the IDL does not declare', () => {
    // Requirement 4.7: the registry falls through to a built-in decoder here,
    // so this is deliberately not an error.
    const outcome = decoder.decode(payloadFor('someOtherInstruction', u64(7n)), []);

    expect(outcome).toEqual({ kind: 'no-match' });
    expect(decoder.match(payloadFor('someOtherInstruction'))).toBeNull();
  });

  it('reports no-match for a payload too short to carry a discriminator', () => {
    expect(decoder.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), [])).toEqual({ kind: 'no-match' });
    expect(decoder.decode(new Uint8Array(0), [])).toEqual({ kind: 'no-match' });
  });

  it('exposes the program ID and source the registry keys it under', () => {
    expect(decoder.programId).toBe(PROGRAM_ID);
    expect(decoder.source).toBe('anchor-idl');
  });
});

// ---------------------------------------------------------------------------
// Scalar types
// ---------------------------------------------------------------------------

describe('scalar arguments', () => {
  it('decodes bool from its single byte', () => {
    expect(fieldsOf([arg('flag', 'bool')], u8(1))).toEqual([
      { name: 'flag', value: { type: 'bool', value: true } },
    ]);
    expect(fieldsOf([arg('flag', 'bool')], u8(0))).toEqual([
      { name: 'flag', value: { type: 'bool', value: false } },
    ]);
  });

  it('decodes the 8, 16, and 32 bit integers as numbers, signed ones negative', () => {
    const args = [
      arg('a', 'u8'),
      arg('b', 'i8'),
      arg('c', 'u16'),
      arg('d', 'i16'),
      arg('e', 'u32'),
      arg('f', 'i32'),
    ];
    const encoded = concat(
      le(255n, 1),
      le(-1n, 1),
      le(65535n, 2),
      le(-2n, 2),
      le(4294967295n, 4),
      le(-2147483648n, 4),
    );

    expect(fieldsOf(args, encoded)).toEqual([
      { name: 'a', value: { type: 'u8', value: 255 } },
      { name: 'b', value: { type: 'i8', value: -1 } },
      { name: 'c', value: { type: 'u16', value: 65535 } },
      { name: 'd', value: { type: 'i16', value: -2 } },
      { name: 'e', value: { type: 'u32', value: 4294967295 } },
      { name: 'f', value: { type: 'i32', value: -2147483648 } },
    ]);
  });

  it('decodes a u64 above 2^53 to its exact decimal digits', () => {
    // 2^53 + 1 is the smallest integer a double cannot represent, and u64 max is
    // the ceiling. Both are asserted as digit strings, never as numbers.
    expect(fieldsOf([arg('amount', 'u64')], u64(9007199254740993n))).toEqual([
      { name: 'amount', value: { type: 'u64', value: '9007199254740993' } },
    ]);
    expect(fieldsOf([arg('amount', 'u64')], u64(18446744073709551615n))).toEqual([
      { name: 'amount', value: { type: 'u64', value: '18446744073709551615' } },
    ]);
  });

  it('decodes i64, u128, and i128 as decimal strings', () => {
    const args = [arg('a', 'i64'), arg('b', 'u128'), arg('c', 'i128')];
    const encoded = concat(
      le(-9223372036854775808n, 8),
      le(340282366920938463463374607431768211455n, 16),
      le(-170141183460469231731687303715884105728n, 16),
    );

    expect(fieldsOf(args, encoded)).toEqual([
      { name: 'a', value: { type: 'i64', value: '-9223372036854775808' } },
      { name: 'b', value: { type: 'u128', value: '340282366920938463463374607431768211455' } },
      { name: 'c', value: { type: 'i128', value: '-170141183460469231731687303715884105728' } },
    ]);
  });

  it('decodes a string from its u32 length prefix and UTF-8 bytes', () => {
    expect(fieldsOf([arg('seed', 'string')], borshString('hello wörld'))).toEqual([
      { name: 'seed', value: { type: 'string', value: 'hello wörld' } },
    ]);
    expect(fieldsOf([arg('seed', 'string')], borshString(''))).toEqual([
      { name: 'seed', value: { type: 'string', value: '' } },
    ]);
  });

  it('decodes a 32-byte publicKey back to base58, under either spelling', () => {
    const key = bs58.decode(OWNER);

    expect(fieldsOf([arg('owner', 'publicKey')], key)).toEqual([
      { name: 'owner', value: { type: 'pubkey', value: OWNER } },
    ]);
    expect(fieldsOf([arg('owner', 'pubkey')], key)).toEqual([
      { name: 'owner', value: { type: 'pubkey', value: OWNER } },
    ]);
  });

  it('decodes bytes to prefixed lowercase hex', () => {
    expect(fieldsOf([arg('blob', 'bytes')], borshBytes(new Uint8Array([0xde, 0xad, 0x00, 0xbe])))).toEqual([
      { name: 'blob', value: { type: 'bytes', value: '0xdead00be' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Composite types
// ---------------------------------------------------------------------------

describe('vec arguments', () => {
  it('decodes a vec into a length field and one field per element', () => {
    const encoded = concat(u32(2), u64(1n), u64(9007199254740993n));

    expect(fieldsOf([arg('amounts', { vec: 'u64' })], encoded)).toEqual([
      { name: 'amounts.len', value: { type: 'u32', value: 2 } },
      { name: 'amounts[0]', value: { type: 'u64', value: '1' } },
      { name: 'amounts[1]', value: { type: 'u64', value: '9007199254740993' } },
    ]);
  });

  it('keeps an empty vec visible as a zero length field', () => {
    expect(fieldsOf([arg('amounts', { vec: 'u64' })], u32(0))).toEqual([
      { name: 'amounts.len', value: { type: 'u32', value: 0 } },
    ]);
  });

  it('decodes a vec of u8 as one bytes value rather than numbered fields', () => {
    const encoded = concat(u32(3), new Uint8Array([1, 2, 255]));

    expect(fieldsOf([arg('data', { vec: 'u8' })], encoded)).toEqual([
      { name: 'data', value: { type: 'bytes', value: '0x0102ff' } },
    ]);
  });

  it('decodes a vec of pubkeys positionally', () => {
    const encoded = concat(u32(1), bs58.decode(OWNER));

    expect(fieldsOf([arg('signers', { vec: 'publicKey' })], encoded)).toEqual([
      { name: 'signers.len', value: { type: 'u32', value: 1 } },
      { name: 'signers[0]', value: { type: 'pubkey', value: OWNER } },
    ]);
  });
});

describe('option arguments', () => {
  it('decodes a present option as a true marker plus the value', () => {
    expect(fieldsOf([arg('amount', { option: 'u64' })], concat(SOME, u64(42n)))).toEqual([
      { name: 'amount.isSome', value: { type: 'bool', value: true } },
      { name: 'amount', value: { type: 'u64', value: '42' } },
    ]);
  });

  it('decodes an absent option as a false marker and no value', () => {
    // No fabricated zero and no silently omitted field: `DecodedValue` has no
    // null, so absence is stated rather than implied.
    expect(fieldsOf([arg('amount', { option: 'u64' })], NONE)).toEqual([
      { name: 'amount.isSome', value: { type: 'bool', value: false } },
    ]);
  });

  it('consumes only the tag byte for an absent option, leaving later args aligned', () => {
    const args = [arg('amount', { option: 'u64' }), arg('flag', 'bool')];

    expect(fieldsOf(args, concat(NONE, u8(1)))).toEqual([
      { name: 'amount.isSome', value: { type: 'bool', value: false } },
      { name: 'flag', value: { type: 'bool', value: true } },
    ]);
  });
});

describe('array arguments', () => {
  it('decodes a fixed array with no length field, since the length is in the IDL', () => {
    const encoded = concat(u32(7), u32(8), u32(9));

    expect(fieldsOf([arg('slots', { array: ['u32', 3] })], encoded)).toEqual([
      { name: 'slots[0]', value: { type: 'u32', value: 7 } },
      { name: 'slots[1]', value: { type: 'u32', value: 8 } },
      { name: 'slots[2]', value: { type: 'u32', value: 9 } },
    ]);
  });

  it('decodes a fixed byte array as one bytes value', () => {
    const key = bs58.decode(OWNER);

    expect(fieldsOf([arg('hash', { array: ['u8', 32] })], key)).toEqual([
      { name: 'hash', value: { type: 'bytes', value: `0x${toHex(key)}` } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unrepresentable types — Requirements 9.2, 9.3
// ---------------------------------------------------------------------------

describe('unsupported argument types', () => {
  it('decodes a float to unsupported and forces the instruction to partial', () => {
    const decoder = createIdlDecoder(idlTaking(arg('rate', 'f64'), arg('amount', 'u64')));
    // Eight bytes of float followed by a u64 that must still land correctly.
    const outcome = decoder.decode(payloadFor('initialize', u64(0n), u64(18446744073709551615n)), []);
    const partial = expectPartial(outcome);

    expect(partial.name).toBe('initialize');
    expect(partial.fields).toEqual([
      { name: 'rate', value: { type: 'unsupported', idlType: 'f64' } },
      { name: 'amount', value: { type: 'u64', value: '18446744073709551615' } },
    ]);
    // The payload was consumed to its last byte. The decode is still `partial`,
    // because one field has no representation in `Analysis`.
    expect(partial.remaining).toHaveLength(0);
  });

  it('skips exactly four bytes for an f32', () => {
    const decoder = createIdlDecoder(idlTaking(arg('rate', 'f32'), arg('flag', 'bool')));
    const partial = expectPartial(decoder.decode(payloadFor('initialize', u32(0), u8(1)), []));

    expect(partial.fields).toEqual([
      { name: 'rate', value: { type: 'unsupported', idlType: 'f32' } },
      { name: 'flag', value: { type: 'bool', value: true } },
    ]);
    expect(partial.remaining).toHaveLength(0);
  });

  it('stops at a defined type rather than guessing its layout', () => {
    const decoder = createIdlDecoder(
      idlTaking(arg('amount', 'u64'), arg('config', { defined: 'OrderConfig' }), arg('flag', 'bool')),
    );
    const tail = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const partial = expectPartial(decoder.decode(payloadFor('initialize', u64(5n), tail), []));

    expect(partial.fields).toEqual([
      { name: 'amount', value: { type: 'u64', value: '5' } },
      { name: 'config', value: { type: 'unsupported', idlType: '{"defined":"OrderConfig"}' } },
    ]);
    // Everything from the unreadable field onward is unaccounted for, including
    // the bytes the argument after it would have claimed.
    expect([...partial.remaining]).toEqual([...tail]);
  });

  it('treats an unrecognized named type as unknown width', () => {
    const decoder = createIdlDecoder(idlTaking(arg('big', 'u256')));
    const partial = expectPartial(decoder.decode(payloadFor('initialize', new Uint8Array(32)), []));

    expect(partial.fields).toEqual([{ name: 'big', value: { type: 'unsupported', idlType: 'u256' } }]);
    expect(partial.remaining).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// Trailing and truncated payloads — Requirement 11.3
// ---------------------------------------------------------------------------

describe('trailing and truncated payloads', () => {
  it('reports a trailing suffix as partial and preserves it for undecodedData', () => {
    const decoder = createIdlDecoder(idlTaking(arg('amount', 'u64')));
    const suffix = new Uint8Array([0x01, 0x02, 0x03]);
    const partial = expectPartial(decoder.decode(payloadFor('initialize', u64(1n), suffix), []));

    expect(partial.fields).toEqual([{ name: 'amount', value: { type: 'u64', value: '1' } }]);
    expect([...partial.remaining]).toEqual([0x01, 0x02, 0x03]);
    // What the registry makes of the suffix: the `undecodedData` of Req 11.3.
    expect(toRawData(partial.remaining)).toEqual({
      label: 'raw_instruction_data',
      hex: '0x010203',
      byteLength: 3,
      truncated: false,
    });
  });

  it('reports a payload too short for a declared argument as a decode failure', () => {
    const decoder = createIdlDecoder(idlTaking(arg('amount', 'u64')));
    const detail = expectError(decoder.decode(payloadFor('initialize', new Uint8Array(3)), []));

    // Named, so the reader can see which argument ran out, and not zero-filled.
    expect(detail).toContain('initialize');
    expect(detail).toContain('"amount"');
    expect(detail).toContain('8 more byte(s)');
    expect(detail).toContain('3 remain');
  });

  it('reports a string whose declared length exceeds the payload as a failure', () => {
    const decoder = createIdlDecoder(idlTaking(arg('seed', 'string')));
    const outcome = decoder.decode(payloadFor('initialize', u32(64), new Uint8Array(2)), []);

    expect(expectError(outcome)).toContain('"seed"');
  });

  it('reports a vec whose declared count exceeds the payload as a failure', () => {
    const decoder = createIdlDecoder(idlTaking(arg('amounts', { vec: 'u64' })));
    const outcome = decoder.decode(payloadFor('initialize', u32(1000), u64(1n)), []);

    expect(expectError(outcome)).toContain('"amounts"');
  });

  it('decodes an instruction with no declared arguments and an empty payload as full', () => {
    const decoder = createIdlDecoder(idlTaking());
    const full = expectFull(decoder.decode(payloadFor('initialize'), []));

    expect(full).toEqual({ kind: 'full', name: 'initialize', fields: [] });
  });
});

// ---------------------------------------------------------------------------
// Positional account naming — Requirements 7.12, 7.13
// ---------------------------------------------------------------------------

describe('positional account naming', () => {
  const declared: readonly IdlInstructionAccount[] = [
    { kind: 'account', name: 'payer' },
    {
      kind: 'group',
      name: 'orderState',
      accounts: [
        { kind: 'account', name: 'bids' },
        { kind: 'group', name: 'nested', accounts: [{ kind: 'account', name: 'asks' }] },
      ],
    },
    { kind: 'account', name: 'systemProgram' },
  ];

  const decoder = createIdlDecoder(
    idlWith(instruction('initialize', [arg('amount', 'u64')], declared)),
  );
  const data = payloadFor('initialize', u64(1n));

  it('flattens group slots depth-first, counting leaves only', () => {
    expect(flattenIdlAccountNames(declared)).toEqual(['payer', 'bids', 'asks', 'systemProgram']);
  });

  it('names the k-th account from the k-th flattened slot', () => {
    const accounts = [
      resolvedRef(3, OWNER),
      resolvedRef(5, PROGRAM_ID),
      resolvedRef(6, OWNER),
      resolvedRef(0, PROGRAM_ID),
    ];

    const named = decoder.nameAccounts(data, accounts);

    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.name : null))).toEqual([
      'payer',
      'bids',
      'asks',
      'systemProgram',
    ]);
    // Addresses, indices, and confidence are untouched by naming.
    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.address : null))).toEqual([
      OWNER,
      PROGRAM_ID,
      OWNER,
      PROGRAM_ID,
    ]);
    expect(named.map((ref) => ref.index)).toEqual([3, 5, 6, 0]);
    expect(named.every((ref) => ref.confidence === 'full')).toBe(true);
  });

  it('leaves accounts beyond the IDL declaration unnamed', () => {
    const accounts = [
      resolvedRef(0, OWNER),
      resolvedRef(1, OWNER),
      resolvedRef(2, OWNER),
      resolvedRef(3, OWNER),
      resolvedRef(4, OWNER),
      resolvedRef(5, OWNER),
    ];

    const named = decoder.nameAccounts(data, accounts);

    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.name : null))).toEqual([
      'payer',
      'bids',
      'asks',
      'systemProgram',
      null,
      null,
    ]);
    // The surplus positions still carry their addresses.
    expect(named.slice(4).map((ref) => (ref.kind === 'resolved' ? ref.address : null))).toEqual([
      OWNER,
      OWNER,
    ]);
  });

  it('accepts fewer accounts than the IDL declares', () => {
    const named = decoder.nameAccounts(data, [resolvedRef(0, OWNER), resolvedRef(1, OWNER)]);

    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.name : null))).toEqual(['payer', 'bids']);
  });

  it('leaves an unresolved account ref exactly as it was', () => {
    const accounts = [unresolvedRef(9), resolvedRef(1, OWNER)];

    expect(decoder.nameAccounts(data, accounts)).toEqual([
      { kind: 'unresolved', index: 9, reason: 'out of range', confidence: 'raw' },
      { ...resolvedRef(1, OWNER), name: 'bids' },
    ]);
  });

  it('leaves every name null when no IDL instruction matches, addresses intact', () => {
    // Requirement 7.13: the address is recorded, the name is not invented.
    const accounts = [resolvedRef(0, OWNER), resolvedRef(1, PROGRAM_ID)];
    const named = decoder.nameAccounts(payloadFor('unknownInstruction', u64(1n)), accounts);

    expect(named).toEqual(accounts);
    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.name : 'unresolved'))).toEqual([null, null]);
    expect(named.map((ref) => (ref.kind === 'resolved' ? ref.address : null))).toEqual([
      OWNER,
      PROGRAM_ID,
    ]);
  });

  it('names nothing when the IDL instruction declares no accounts', () => {
    const bare = createIdlDecoder(idlWith(instruction('initialize', [], [])));
    const accounts = [resolvedRef(0, OWNER)];

    expect(bare.nameAccounts(payloadFor('initialize'), accounts)).toEqual(accounts);
  });

  it('applies names from an instruction directly, without a payload', () => {
    const entry = instruction('initialize', [], declared);

    expect(
      applyAccountNames(entry, [resolvedRef(0, OWNER)]).map((ref) =>
        ref.kind === 'resolved' ? ref.name : null,
      ),
    ).toEqual(['payer']);
  });
});

// ---------------------------------------------------------------------------
// Store-wide construction
// ---------------------------------------------------------------------------

describe('createIdlDecoders', () => {
  it('builds one decoder per loaded IDL, keyed by program ID', () => {
    const idl = idlTaking(arg('amount', 'u64'));
    const store: IdlStore = {
      get: (programId) => (programId === PROGRAM_ID ? idl : undefined),
      warnings: [],
      programIds: [PROGRAM_ID],
    };

    const decoders = createIdlDecoders(store);

    expect([...decoders.keys()]).toEqual([PROGRAM_ID]);
    expect(decoders.get(PROGRAM_ID)?.idl).toBe(idl);
    expect(decoders.get(OWNER)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeArgs directly
// ---------------------------------------------------------------------------

describe('decodeArgs', () => {
  it('decodes a payload with the discriminator already stripped', () => {
    const entry = instruction('initialize', [arg('amount', 'u64')]);

    expect(decodeArgs(entry, u64(3n))).toEqual({
      kind: 'full',
      name: 'initialize',
      fields: [{ name: 'amount', value: { type: 'u64', value: '3' } }],
    });
  });
});
