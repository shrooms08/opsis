/**
 * Built-in decoder for the System Program (`11111111111111111111111111111111`).
 *
 * Satisfies Requirements 4.2, 4.4. Lamport values are carried as decimal
 * strings (Req 7.10, 9.2).
 *
 * **The discriminant is a 4-byte little-endian u32, not a single byte.** The
 * System Program's instruction enum is bincode-encoded, and bincode writes an
 * enum variant tag as a `u32`. Reading one byte instead would still produce a
 * tag for every payload the fixtures contain — a `Transfer` opens
 * `02 00 00 00`, so a one-byte read yields 2 as well — and would then read the
 * lamport amount three bytes early, producing a plausible-looking wrong number
 * that nothing downstream could detect. The width is the whole correctness
 * story of this file, which is why it is stated before the tables.
 *
 * Field encodings after the tag, all bincode:
 *
 * - `u64` little-endian for lamports and space.
 * - 32 raw bytes for a pubkey, re-encoded to base58 for output (Req 7.14).
 * - A seed `String` as a **`u64` little-endian length** followed by that many
 *   UTF-8 bytes. bincode uses fixed-width lengths, not the varint an
 *   Anchor/borsh reader would expect, so this is a different shape from the
 *   `u32` length borsh uses.
 *
 * Every `u64` is read with `DataView.getBigUint64` and rendered through
 * `BigInt.toString()`. It never passes through `Number`: a lamport balance
 * above 2^53 would round silently, and a rounded lamport value has the right
 * shape, the right magnitude, and the wrong digits.
 *
 * **Truncation policy.** A payload too short for the instruction it names
 * returns `partial` when at least one field was read in full, carrying those
 * fields plus the unread tail in `remaining` (Req 11.3), and `error` when
 * nothing could be read — including a payload shorter than the 4-byte tag,
 * where the instruction cannot even be named. The split is deliberate:
 * `partial` exists to report a decode that got somewhere, and a decoder with
 * zero fields to show has produced no information that a `raw` fallback would
 * not also produce, so it says so rather than claiming a partial read.
 *
 * That `remaining` is occasionally **empty** on a `partial` is deliberate and not
 * a bug: when the payload ends exactly where a field should have begun, earlier
 * fields were read in full and there is no tail. Reporting `full` would claim the
 * missing field had been read, and reporting `error` would throw away the fields
 * that were. The empty suffix is the honest third answer.
 *
 * An unrecognized tag is `no-match`, never `error`. `no-match` means "not mine,
 * keep going down the ladder"; a System payload carrying a variant this table
 * does not list is exactly that, and the registry's `Unknown` fallback
 * preserves its bytes.
 *
 * Nothing here writes to a stream and nothing throws. Every failure is one of
 * the four `DecodeOutcome` variants.
 */

import bs58 from 'bs58';

import type { AccountRef, Base58Address, DecodedField } from '../../model/analysis.js';
import type { DecodeOutcome, InstructionDecoder } from '../registry.js';

/** Requirement 4.4. */
export const SYSTEM_PROGRAM_ID: Base58Address = '11111111111111111111111111111111';

/** bincode writes an enum variant tag as a little-endian u32. */
const TAG_BYTES = 4;

const PUBKEY_BYTES = 32;

/**
 * One field of one instruction, as a reader step.
 *
 * The instruction table below is data rather than a `switch` full of byte math
 * so that each variant reads as its wire format and a missing field is visible
 * as an absent line rather than as absent code.
 */
type FieldKind = 'lamports' | 'u64' | 'pubkey' | 'string';

interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
}

/**
 * The System Program instruction enum, in variant order.
 *
 * Variants are keyed by their numeric tag rather than held in an array, so the
 * tag of each entry is written down next to its name instead of being implied
 * by position — a table where the index carries meaning invites a variant being
 * inserted in the middle and shifting every one below it.
 */
const INSTRUCTIONS: ReadonlyMap<number, { readonly name: string; readonly fields: readonly FieldSpec[] }> =
  new Map([
    [
      0,
      {
        name: 'CreateAccount',
        fields: [
          { name: 'lamports', kind: 'lamports' },
          { name: 'space', kind: 'u64' },
          { name: 'owner', kind: 'pubkey' },
        ],
      },
    ],
    [1, { name: 'Assign', fields: [{ name: 'owner', kind: 'pubkey' }] }],
    [2, { name: 'Transfer', fields: [{ name: 'lamports', kind: 'lamports' }] }],
    [
      3,
      {
        name: 'CreateAccountWithSeed',
        fields: [
          { name: 'base', kind: 'pubkey' },
          { name: 'seed', kind: 'string' },
          { name: 'lamports', kind: 'lamports' },
          { name: 'space', kind: 'u64' },
          { name: 'owner', kind: 'pubkey' },
        ],
      },
    ],
    [4, { name: 'AdvanceNonceAccount', fields: [] }],
    [5, { name: 'WithdrawNonceAccount', fields: [{ name: 'lamports', kind: 'lamports' }] }],
    [6, { name: 'InitializeNonceAccount', fields: [{ name: 'authority', kind: 'pubkey' }] }],
    [7, { name: 'AuthorizeNonceAccount', fields: [{ name: 'authority', kind: 'pubkey' }] }],
    [8, { name: 'Allocate', fields: [{ name: 'space', kind: 'u64' }] }],
    [
      9,
      {
        name: 'AllocateWithSeed',
        fields: [
          { name: 'base', kind: 'pubkey' },
          { name: 'seed', kind: 'string' },
          { name: 'space', kind: 'u64' },
          { name: 'owner', kind: 'pubkey' },
        ],
      },
    ],
    [
      10,
      {
        name: 'AssignWithSeed',
        fields: [
          { name: 'base', kind: 'pubkey' },
          { name: 'seed', kind: 'string' },
          { name: 'owner', kind: 'pubkey' },
        ],
      },
    ],
    [
      11,
      {
        name: 'TransferWithSeed',
        fields: [
          { name: 'lamports', kind: 'lamports' },
          { name: 'fromSeed', kind: 'string' },
          { name: 'fromOwner', kind: 'pubkey' },
        ],
      },
    ],
    [12, { name: 'UpgradeNonceAccount', fields: [] }],
  ]);

/**
 * A bounds-checked forward reader over the payload.
 *
 * Every read is guarded by an explicit `has` call, so no read is ever attempted
 * out of range and `noUncheckedIndexedAccess` never has an `undefined` to hand
 * back — the class does its multi-byte work through `DataView` and its slicing
 * through `subarray`, so it does not index the array at all.
 */
class Cursor {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  has(count: number): boolean {
    return count >= 0 && this.remaining >= count;
  }

  /** Little-endian, per the bincode enum tag width. */
  readU32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Little-endian. Returned as `bigint` so no value is ever narrowed. */
  readU64(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readPubkey(): Uint8Array {
    const value = this.bytes.subarray(this.offset, this.offset + PUBKEY_BYTES);
    this.offset += PUBKEY_BYTES;
    return value;
  }

  readUtf8(byteLength: number): string {
    const slice = this.bytes.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    // Non-fatal: malformed UTF-8 yields replacement characters rather than a
    // throw, because a seed is program-supplied bytes and an exception here
    // would escape a decoder that promises not to throw.
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }

  tail(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }
}

/**
 * Decode one System Program payload.
 *
 * Exported as a plain function alongside the `InstructionDecoder` value so a
 * test can call it directly without constructing a registry.
 */
export function decodeSystemProgramInstruction(data: Uint8Array): DecodeOutcome {
  const cursor = new Cursor(data);

  if (!cursor.has(TAG_BYTES)) {
    return {
      kind: 'error',
      detail:
        `System Program instruction data is ${data.length} byte(s), too short for the ` +
        `${TAG_BYTES}-byte little-endian discriminant, so the instruction could not be named`,
    };
  }

  const tag = cursor.readU32();
  const spec = INSTRUCTIONS.get(tag);
  if (spec === undefined) {
    // Not an error: the payload may belong to a rung further down the ladder,
    // and an unlisted variant is preserved verbatim by the `Unknown` fallback.
    return { kind: 'no-match' };
  }

  const fields: DecodedField[] = [];

  for (const field of spec.fields) {
    const read = readField(cursor, field);
    if (read === null) {
      // Ran out of bytes mid-instruction. What was fully read is reported; the
      // unread tail — the truncated field itself — becomes `remaining`.
      if (fields.length === 0) {
        return {
          kind: 'error',
          detail:
            `System Program ${spec.name} instruction data ends before its first field ` +
            `"${field.name}" could be read; ${cursor.remaining} byte(s) remained after the ` +
            `discriminant, so no field was recovered`,
        };
      }
      return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
    }
    fields.push(read);
  }

  if (cursor.remaining > 0) {
    // Requirement 11.3: the name resolved and the fields decoded, but the
    // payload carries a suffix this decoder does not account for. Reporting
    // `full` here would claim the trailing bytes had been understood.
    return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
  }

  return { kind: 'full', name: spec.name, fields };
}

/** One field, or `null` when the payload ran out before it was complete. */
function readField(cursor: Cursor, field: FieldSpec): DecodedField | null {
  switch (field.kind) {
    case 'lamports': {
      if (!cursor.has(8)) return null;
      // Decimal string via BigInt. Never `Number`. Req 7.10, 9.2.
      return { name: field.name, value: { type: 'lamports', value: cursor.readU64().toString(10) } };
    }
    case 'u64': {
      if (!cursor.has(8)) return null;
      return { name: field.name, value: { type: 'u64', value: cursor.readU64().toString(10) } };
    }
    case 'pubkey': {
      if (!cursor.has(PUBKEY_BYTES)) return null;
      return { name: field.name, value: { type: 'pubkey', value: bs58.encode(cursor.readPubkey()) } };
    }
    case 'string': {
      // bincode: u64 little-endian length, then that many UTF-8 bytes.
      if (!cursor.has(8)) return null;
      const declared = cursor.readU64();
      // A length is a count of bytes present in this payload, so it cannot
      // exceed the payload. Comparing in `bigint` avoids narrowing a hostile
      // length through `Number` before the check that would reject it.
      if (declared > BigInt(cursor.remaining)) return null;
      const byteLength = Number(declared);
      return { name: field.name, value: { type: 'string', value: cursor.readUtf8(byteLength) } };
    }
  }
}

/**
 * The registered decoder. `accounts` is unused: the System Program's account
 * roles are positional and fixed per variant, and naming them is the IDL
 * decoder's job (Req 7.12, 7.13), not this one's.
 */
export const systemProgramDecoder: InstructionDecoder = {
  source: 'builtin',
  programId: SYSTEM_PROGRAM_ID,
  decode(data: Uint8Array, _accounts: readonly AccountRef[]): DecodeOutcome {
    return decodeSystemProgramInstruction(data);
  },
};
