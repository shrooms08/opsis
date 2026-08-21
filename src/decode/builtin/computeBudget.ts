/**
 * Built-in decoder for the Compute Budget program
 * (`ComputeBudget111111111111111111111111111111`).
 *
 * Satisfies Requirements 4.2, 4.4.
 *
 * **The discriminant is a single leading byte**, as in SPL Token and the
 * Associated Token Account program, and unlike the System Program's 4-byte
 * little-endian bincode enum tag. The distinction matters more here than
 * anywhere else in `decode/builtin/`, because almost every mainnet transaction
 * opens with two or three Compute Budget instructions: reading a 4-byte tag off
 * `02 c8 cd 01 00` would produce the tag 30 below and then run out of payload,
 * degrading the most common instruction on the chain to `Unknown`.
 *
 * After the tag the payload is a fixed-width little-endian record, with no
 * length prefix and no variable-width field anywhere:
 *
 * | tag | instruction                       | payload                        |
 * | --- | --------------------------------- | ------------------------------ |
 * | 0   | `RequestUnits`                    | u32 `units`, u32 `additionalFee`|
 * | 1   | `RequestHeapFrame`                | u32 `bytes`                    |
 * | 2   | `SetComputeUnitLimit`             | u32 `units`                    |
 * | 3   | `SetComputeUnitPrice`             | u64 `microLamports`            |
 * | 4   | `SetLoadedAccountsDataSizeLimit`  | u32 `bytes`                    |
 *
 * Tags 0 and 1 are the deprecated pair that `SetComputeUnitLimit` and
 * `SetComputeUnitPrice` replaced. `RequestUnits` carries **two** u32 fields, not
 * one: the original instruction bundled a prioritization fee with the unit
 * request, and the fee field was dropped rather than the instruction. Nothing in
 * the recorded fixtures exercises either tag — see the note below — so the two
 * widths here rest on the upstream encoding alone and are marked as such rather
 * than presented as fixture-verified.
 *
 * **What the fixtures do verify.** Every Compute Budget payload in
 * `tests/golden/` is tag 2, 3, or 4, and each one matches this table exactly:
 * `0224930100` and `02c8cd0100` and `02f5600500` are five bytes — tag plus one
 * u32; `0335bf000000000000` and `034ee7000000000000` and `03c810000000000000`
 * are nine — tag plus one u64; `04d546ce00` and `04c0c5fc00` are five. A u64
 * `microLamports` read as a u32 would still produce a plausible number from
 * every one of those payloads, since the high four bytes are zero, and would
 * then report four unexplained trailing bytes. `tests/decode/builtin/
 * computeBudget.test.ts` decodes those recorded bytes directly so the widths are
 * pinned against the chain and not only against constructed input.
 *
 * **`microLamports` is a `u64` and is carried as a decimal string via `bigint`,
 * never through `Number`.** It is a price per compute unit set by the fee payer,
 * and nothing bounds it below 2^53; a value above that would round silently and
 * a rounded fee has the right magnitude and the wrong digits.
 *
 * It is deliberately **not** the `lamports` variant of `DecodedValue`, even
 * though both spell their value as a decimal string. `LamportAmount` means "an
 * integer count of lamports", and the text renderer acts on that meaning by
 * converting the value to SOL. A micro-lamport is 10^-6 of a lamport and the
 * quantity is a *rate* rather than an amount, so labelling it `lamports` would
 * render a price of 59214 micro-lamports per unit as though it were a balance
 * change of 59214 lamports — off by a factor of a million and wrong in kind. The
 * `u64` variant makes no claim about units, which is the honest one to make
 * here; the field name carries the unit.
 *
 * The u32 fields stay `number`. A u32 is exactly representable as a double, so
 * `DecodedValue`'s `u32` variant loses nothing, and widening them to strings
 * would make a compute unit limit inconsistent with every other u32 in the
 * model.
 *
 * **Truncation policy, identical to `systemProgram.ts` and for the same
 * reasons.** A payload with no tag byte at all is `error`: the instruction
 * cannot even be named, so there is nothing a `partial` could report that the
 * `raw` fallback does not already preserve. A payload that ends before its first
 * field is also `error`, for the same reason. A payload that ends after at least
 * one field was read in full is `partial`, carrying those fields and the unread
 * tail — which is reachable only on `RequestUnits`, the one instruction with two
 * fields, and whose tail is **empty** when the payload stops exactly at the
 * field boundary. An empty `remaining` on a `partial` is honest rather than a
 * bug: `full` would claim the missing field had been read. Trailing bytes past
 * the last field are `partial` too (Req 11.3).
 *
 * An unrecognized tag is `no-match`, never `error` — "not mine, keep going down
 * the ladder" — and the registry's `Unknown` fallback preserves its bytes.
 *
 * Nothing here writes to a stream and nothing throws. Every failure is one of
 * the four `DecodeOutcome` variants.
 */

import type { AccountRef, Base58Address, DecodedField } from '../../model/analysis.js';
import type { DecodeOutcome, InstructionDecoder } from '../registry.js';

/**
 * Requirement 4.4.
 *
 * Owned here rather than in `decode/programNames.ts`, which imports it. Both
 * directions were available and only one of them is safe: `programNames.ts` is
 * display labelling and `tests/decode/programNames.test.ts` asserts that
 * `decode/instructionTree.ts` is its *only* importer in `src/`, so a decoder
 * reaching into it would fail that test and, worse, would put a display module
 * on the decode path. The reverse direction is the pattern already in place —
 * `registry.ts` keys each built-in by the constant its own decoder module
 * exports, and `programNames.ts` already imports the other three program IDs
 * from `decode/builtin/`.
 */
export const COMPUTE_BUDGET_PROGRAM_ID: Base58Address =
  'ComputeBudget111111111111111111111111111111';

/** The discriminant is one byte. See the module header. */
const TAG_BYTES = 1;

const U32_BYTES = 4;
const U64_BYTES = 8;

/**
 * One field, as a reader step.
 *
 * Only two widths exist in this program, and the union is closed at two so that
 * a future instruction cannot be given a field kind with no reader.
 */
type FieldKind = 'u32' | 'u64';

interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
}

/**
 * The Compute Budget instruction enum, keyed by tag.
 *
 * Keyed rather than positional for the reason the other built-ins give: a tag
 * written beside its name cannot be silently renumbered by an insertion above
 * it. Held as a `Map` rather than a record so lookups cannot fall through to
 * `Object.prototype`.
 */
const INSTRUCTIONS: ReadonlyMap<
  number,
  { readonly name: string; readonly fields: readonly FieldSpec[] }
> = new Map([
  [
    0,
    {
      name: 'RequestUnits',
      fields: [
        { name: 'units', kind: 'u32' },
        { name: 'additionalFee', kind: 'u32' },
      ],
    },
  ],
  [1, { name: 'RequestHeapFrame', fields: [{ name: 'bytes', kind: 'u32' }] }],
  [2, { name: 'SetComputeUnitLimit', fields: [{ name: 'units', kind: 'u32' }] }],
  [3, { name: 'SetComputeUnitPrice', fields: [{ name: 'microLamports', kind: 'u64' }] }],
  [4, { name: 'SetLoadedAccountsDataSizeLimit', fields: [{ name: 'bytes', kind: 'u32' }] }],
]);

/**
 * A bounds-checked forward reader over the payload.
 *
 * Every read is guarded by an explicit `has` call, and all multi-byte work goes
 * through `DataView` while slicing goes through `subarray`, so the class never
 * indexes the array and `noUncheckedIndexedAccess` has no `undefined` to hand
 * back.
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
    this.offset += TAG_BYTES;
    return value;
  }

  /** Little-endian. */
  readU32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += U32_BYTES;
    return value;
  }

  /** Little-endian. Returned as `bigint` so no value is ever narrowed. */
  readU64(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += U64_BYTES;
    return value;
  }

  tail(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }
}

/**
 * Decode one Compute Budget payload.
 *
 * Exported as a plain function alongside the `InstructionDecoder` value so a
 * test can call it directly without constructing a registry.
 */
export function decodeComputeBudgetInstruction(data: Uint8Array): DecodeOutcome {
  const cursor = new Cursor(data);

  if (!cursor.has(TAG_BYTES)) {
    return {
      kind: 'error',
      detail:
        `Compute Budget instruction data is ${data.length} byte(s), too short for the ` +
        `${TAG_BYTES}-byte discriminant, so the instruction could not be named`,
    };
  }

  const tag = cursor.readU8();
  const spec = INSTRUCTIONS.get(tag);
  if (spec === undefined) {
    // Not an error: an unlisted tag may belong to a rung further down the
    // ladder, and the `Unknown` fallback preserves the bytes verbatim.
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
            `Compute Budget ${spec.name} instruction data ends before its first field ` +
            `"${field.name}" could be read; ${cursor.remaining} byte(s) remained after the ` +
            `discriminant, so no field was recovered`,
        };
      }
      // At least one field was read in full. Report those and hand back the
      // unread tail, which is empty when the payload stopped exactly at the
      // boundary of the field that is missing.
      return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
    }
    fields.push(read);
  }

  if (cursor.remaining > 0) {
    // Requirement 11.3: the name resolved and every declared field decoded, but
    // the payload carries a suffix this decoder cannot account for. `full` would
    // claim those bytes had been understood.
    return { kind: 'partial', name: spec.name, fields, remaining: cursor.tail() };
  }

  return { kind: 'full', name: spec.name, fields };
}

/** One field, or `null` when the payload ran out before it was complete. */
function readField(cursor: Cursor, field: FieldSpec): DecodedField | null {
  switch (field.kind) {
    case 'u32': {
      if (!cursor.has(U32_BYTES)) return null;
      // A u32 is exactly representable as a double, so `number` loses nothing.
      return { name: field.name, value: { type: 'u32', value: cursor.readU32() } };
    }
    case 'u64': {
      if (!cursor.has(U64_BYTES)) return null;
      // Decimal string via BigInt. Never `Number`: see the module header on
      // `microLamports`.
      return { name: field.name, value: { type: 'u64', value: cursor.readU64().toString(10) } };
    }
  }
}

/**
 * The registered decoder.
 *
 * `accounts` is unused, and here that is not merely a division of labour: every
 * Compute Budget instruction takes **no accounts at all**. The whole of each
 * instruction is in its data.
 */
export const computeBudgetDecoder: InstructionDecoder = {
  source: 'builtin',
  programId: COMPUTE_BUDGET_PROGRAM_ID,
  decode(data: Uint8Array, _accounts: readonly AccountRef[]): DecodeOutcome {
    return decodeComputeBudgetInstruction(data);
  },
};
