/**
 * Built-in decoder for SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
 *
 * Satisfies Requirements 4.2, 4.4.
 *
 * **The discriminant is a single leading byte, not a 4-byte word.** SPL Token
 * packs its instruction enum by hand rather than through bincode, so the tag
 * width here is genuinely different from the System Program's. Reading four
 * bytes instead of one would swallow the first three bytes of the payload — a
 * `Transfer` amount, say — and then read the rest from the wrong offset,
 * yielding a well-formed wrong answer. The two widths sitting side by side in
 * `decode/builtin/` is the reason each file states its own.
 *
 * Field encodings after the tag:
 *
 * - `u64` little-endian for every amount.
 * - `u8` for decimals, multisig `m`, and authority type.
 * - 32 raw bytes for a pubkey, re-encoded to base58 (Req 7.14).
 * - `COption<Pubkey>` as a 1-byte presence flag followed by 32 bytes when the
 *   flag is 1. `DecodedValue` has no optional variant, so the flag is reported
 *   as its own `bool` field named `<field>Present` and the pubkey field appears
 *   only when it is set. That keeps the encoding lossless in both directions:
 *   absent and present-but-unread are distinguishable.
 *
 * **Amounts are `u64`, not `tokenAmount`.** A `TokenAmount` carries its mint and
 * its `decimals` inseparably (Req 20.4, 12.11), and an instruction payload
 * contains neither — the mint is an account reference and the scale lives in the
 * mint account this tool never fetches. Emitting `tokenAmount` here would mean
 * inventing a mint and a decimals value. The raw `u64` is what the payload
 * actually says. `TransferChecked` and its siblings do carry a `decimals` byte,
 * reported as its own field, which is the program's assertion about the mint
 * rather than the mint's own value.
 *
 * Every amount is read with `DataView.getBigUint64` and rendered through
 * `BigInt.toString()`, never through `Number`: a token supply above 2^53 is
 * ordinary for a 9-decimal mint, and rounding it would produce the right
 * magnitude with the wrong digits.
 *
 * **Truncation policy.** Short data returns `partial` when at least one field
 * was read in full, carrying those fields plus the unread tail in `remaining`
 * (Req 11.3), and `error` when nothing was recovered — including empty data,
 * where not even the tag exists. A decoder with no fields to show has learned
 * nothing the `raw` fallback would not also report, so it does not claim a
 * partial read.
 *
 * `remaining` is occasionally **empty** on a `partial`, which is deliberate. A
 * `TransferChecked` whose payload stops after its 8-byte amount, one byte short
 * of `decimals`, has both a fully read field and no tail. `full` would claim the
 * decimals byte had been read and `error` would discard the amount that was, so
 * the empty suffix is the honest third answer.
 *
 * An unrecognized tag is `no-match`, so resolution continues down the ladder.
 * Nothing here writes to a stream and nothing throws.
 */

import bs58 from 'bs58';

import type {
  AccountRef,
  Base58Address,
  DecodedField,
  HexString,
} from '../../model/analysis.js';
import type { DecodeOutcome, InstructionDecoder } from '../registry.js';

/** Requirement 4.4. */
export const SPL_TOKEN_PROGRAM_ID: Base58Address = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** SPL Token packs its enum tag as one byte. */
const TAG_BYTES = 1;

const PUBKEY_BYTES = 32;

/**
 * One field, as a reader step.
 *
 * - `u64` — a little-endian amount, rendered as a decimal string.
 * - `u8` — a small bounded count: decimals, multisig threshold, authority type.
 * - `pubkey` — 32 bytes, base58 out.
 * - `coptionPubkey` — presence flag plus optional 32 bytes.
 * - `restBytes` — everything left, as hex. Used by `GetAccountDataSize`, whose
 *   trailing extension-type list is part of its format rather than a suffix the
 *   decoder failed to read.
 * - `restUtf8` — everything left, as a UTF-8 string with no length prefix,
 *   which is how `UiAmountToAmount` carries its argument.
 */
type FieldKind = 'u64' | 'u8' | 'pubkey' | 'coptionPubkey' | 'restBytes' | 'restUtf8';

interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
}

/**
 * The SPL Token instruction enum, keyed by tag.
 *
 * Keyed rather than positional so each tag is written beside its name; a
 * position-implied table invites an inserted variant silently renumbering every
 * one below it, and a renumbered variant decodes to the wrong instruction name
 * with fields that still parse.
 */
const INSTRUCTIONS: ReadonlyMap<
  number,
  { readonly name: string; readonly fields: readonly FieldSpec[] }
> = new Map([
  [
    0,
    {
      name: 'InitializeMint',
      fields: [
        { name: 'decimals', kind: 'u8' },
        { name: 'mintAuthority', kind: 'pubkey' },
        { name: 'freezeAuthority', kind: 'coptionPubkey' },
      ],
    },
  ],
  [1, { name: 'InitializeAccount', fields: [] }],
  [2, { name: 'InitializeMultisig', fields: [{ name: 'm', kind: 'u8' }] }],
  [3, { name: 'Transfer', fields: [{ name: 'amount', kind: 'u64' }] }],
  [4, { name: 'Approve', fields: [{ name: 'amount', kind: 'u64' }] }],
  [5, { name: 'Revoke', fields: [] }],
  [
    6,
    {
      name: 'SetAuthority',
      fields: [
        { name: 'authorityType', kind: 'u8' },
        { name: 'newAuthority', kind: 'coptionPubkey' },
      ],
    },
  ],
  [7, { name: 'MintTo', fields: [{ name: 'amount', kind: 'u64' }] }],
  [8, { name: 'Burn', fields: [{ name: 'amount', kind: 'u64' }] }],
  [9, { name: 'CloseAccount', fields: [] }],
  [10, { name: 'FreezeAccount', fields: [] }],
  [11, { name: 'ThawAccount', fields: [] }],
  [
    12,
    {
      name: 'TransferChecked',
      fields: [
        { name: 'amount', kind: 'u64' },
        { name: 'decimals', kind: 'u8' },
      ],
    },
  ],
  [
    13,
    {
      name: 'ApproveChecked',
      fields: [
        { name: 'amount', kind: 'u64' },
        { name: 'decimals', kind: 'u8' },
      ],
    },
  ],
  [
    14,
    {
      name: 'MintToChecked',
      fields: [
        { name: 'amount', kind: 'u64' },
        { name: 'decimals', kind: 'u8' },
      ],
    },
  ],
  [
    15,
    {
      name: 'BurnChecked',
      fields: [
        { name: 'amount', kind: 'u64' },
        { name: 'decimals', kind: 'u8' },
      ],
    },
  ],
  [16, { name: 'InitializeAccount2', fields: [{ name: 'owner', kind: 'pubkey' }] }],
  [17, { name: 'SyncNative', fields: [] }],
  [18, { name: 'InitializeAccount3', fields: [{ name: 'owner', kind: 'pubkey' }] }],
  [19, { name: 'InitializeMultisig2', fields: [{ name: 'm', kind: 'u8' }] }],
  [
    20,
    {
      name: 'InitializeMint2',
      fields: [
        { name: 'decimals', kind: 'u8' },
        { name: 'mintAuthority', kind: 'pubkey' },
        { name: 'freezeAuthority', kind: 'coptionPubkey' },
      ],
    },
  ],
  [21, { name: 'GetAccountDataSize', fields: [{ name: 'extensionTypes', kind: 'restBytes' }] }],
  [22, { name: 'InitializeImmutableOwner', fields: [] }],
  [23, { name: 'AmountToUiAmount', fields: [{ name: 'amount', kind: 'u64' }] }],
  [24, { name: 'UiAmountToAmount', fields: [{ name: 'uiAmount', kind: 'restUtf8' }] }],
]);

/**
 * A bounds-checked forward reader.
 *
 * Multi-byte reads go through `DataView` and slices through `subarray`, so the
 * payload is never indexed and `noUncheckedIndexedAccess` has no `undefined` to
 * produce. Every read is preceded by an explicit `has` check.
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

  readU8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  /** Little-endian. `bigint` so no amount is ever narrowed. */
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

  readRest(): Uint8Array {
    const value = this.bytes.subarray(this.offset);
    this.offset = this.bytes.length;
    return value;
  }

  tail(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }
}

/**
 * Decode one SPL Token payload.
 *
 * Exported as a plain function so a test can call it without a registry.
 */
export function decodeSplTokenInstruction(data: Uint8Array): DecodeOutcome {
  const cursor = new Cursor(data);

  if (!cursor.has(TAG_BYTES)) {
    return {
      kind: 'error',
      detail:
        'SPL Token instruction data is empty, so the single-byte discriminant is absent and ' +
        'the instruction could not be named',
    };
  }

  const tag = cursor.readU8();
  const spec = INSTRUCTIONS.get(tag);
  if (spec === undefined) {
    return { kind: 'no-match' };
  }

  const fields: DecodedField[] = [];

  for (const field of spec.fields) {
    const read = readField(cursor, field);
    if (read === null) {
      if (fields.length === 0) {
        return {
          kind: 'error',
          detail:
            `SPL Token ${spec.name} instruction data ends before its first field ` +
            `"${field.name}" could be read; ${cursor.remaining} byte(s) remained after the ` +
            `discriminant, so no field was recovered`,
        };
      }
      return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
    }
    fields.push(...read);
  }

  if (cursor.remaining > 0) {
    // Requirement 11.3: name and fields resolved, trailing bytes unaccounted
    // for. Claiming `full` would assert those bytes had been understood.
    return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
  }

  return { kind: 'full', name: spec.name, fields };
}

/**
 * One field, or `null` when the payload ran out before it was complete.
 *
 * Returns a list because `coptionPubkey` yields either one field or two, and
 * `restBytes` yields none when nothing is left.
 */
function readField(cursor: Cursor, field: FieldSpec): readonly DecodedField[] | null {
  switch (field.kind) {
    case 'u8': {
      if (!cursor.has(1)) return null;
      return [{ name: field.name, value: { type: 'u8', value: cursor.readU8() } }];
    }
    case 'u64': {
      if (!cursor.has(8)) return null;
      // Decimal string via BigInt. Never `Number`.
      return [{ name: field.name, value: { type: 'u64', value: cursor.readU64().toString(10) } }];
    }
    case 'pubkey': {
      if (!cursor.has(PUBKEY_BYTES)) return null;
      return [
        { name: field.name, value: { type: 'pubkey', value: bs58.encode(cursor.readPubkey()) } },
      ];
    }
    case 'coptionPubkey': {
      if (!cursor.has(1)) return null;
      const flag = cursor.readU8();
      const present = flag !== 0;
      const presence: DecodedField = {
        name: `${field.name}Present`,
        value: { type: 'bool', value: present },
      };
      if (!present) return [presence];
      if (!cursor.has(PUBKEY_BYTES)) return null;
      return [
        presence,
        { name: field.name, value: { type: 'pubkey', value: bs58.encode(cursor.readPubkey()) } },
      ];
    }
    case 'restBytes': {
      if (cursor.remaining === 0) return [];
      return [{ name: field.name, value: { type: 'bytes', value: toHex(cursor.readRest()) } }];
    }
    case 'restUtf8': {
      // Non-fatal decoding: malformed bytes become replacement characters
      // rather than a throw, because this decoder promises not to throw.
      const text = new TextDecoder('utf-8', { fatal: false }).decode(cursor.readRest());
      return [{ name: field.name, value: { type: 'string', value: text } }];
    }
  }
}

/** Lowercase hex, `0x`-prefixed, matching `HexString` (Req 11.5). */
function toHex(bytes: Uint8Array): HexString {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}

/**
 * The registered decoder. `accounts` is unused: SPL Token account roles are
 * positional and fixed per variant, and naming accounts is the IDL decoder's
 * job (Req 7.12, 7.13).
 */
export const splTokenDecoder: InstructionDecoder = {
  source: 'builtin',
  programId: SPL_TOKEN_PROGRAM_ID,
  decode(data: Uint8Array, _accounts: readonly AccountRef[]): DecodeOutcome {
    return decodeSplTokenInstruction(data);
  },
};
