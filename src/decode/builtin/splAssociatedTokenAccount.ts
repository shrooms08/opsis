/**
 * Built-in decoder for the SPL Associated Token Account program
 * (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).
 *
 * Satisfies Requirements 4.2, 4.4.
 *
 * **The discriminant is a single leading byte**, as in SPL Token and unlike the
 * System Program's 4-byte little-endian word. None of this program's
 * instructions carry any argument, so the payload is the tag and nothing else —
 * which makes the tag width the only thing this decoder can get wrong, and the
 * reason it is stated first.
 *
 * **Empty data is `Create`, not a truncation.** The original ATA `Create`
 * predates the instruction enum and was encoded as a zero-length payload; the
 * tag byte was introduced when `CreateIdempotent` was added, with `0` assigned
 * to `Create` so the two encodings agree. Treating an empty payload as too short
 * to read would degrade every legacy `Create` on chain to `Unknown`, so it is
 * decoded as `Create` here and the equivalence is recorded rather than inferred
 * at each call site.
 *
 * Everything this program needs is in its accounts, not its data: the funding
 * payer, the associated account being created, its owner, the mint, and the two
 * programs invoked. Those are `AccountRef`s on the instruction node already, and
 * naming them positionally is the IDL decoder's job (Req 7.12, 7.13), so this
 * decoder reports the instruction name and an empty field list rather than
 * duplicating the account list as pseudo-fields.
 *
 * An unrecognized tag is `no-match`, so resolution continues down the ladder to
 * the `Unknown` fallback with the bytes preserved. Nothing here writes to a
 * stream and nothing throws.
 */

import type { AccountRef, Base58Address } from '../../model/analysis.js';
import type { DecodeOutcome, InstructionDecoder } from '../registry.js';

/** Requirement 4.4. */
export const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: Base58Address =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * The ATA instruction enum, keyed by tag.
 *
 * Every variant takes its arguments as accounts, so the field list is empty in
 * all three cases. The table exists to name the tag, and is keyed rather than
 * positional for the same reason as the other built-ins: a tag written beside
 * its name cannot be silently renumbered by an insertion above it.
 */
const INSTRUCTION_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'Create'],
  [1, 'CreateIdempotent'],
  [2, 'RecoverNested'],
]);

/**
 * The name the zero-length legacy encoding resolves to. Held as a constant so
 * the empty-payload path and the `tag === 0` path cannot drift apart.
 */
const LEGACY_CREATE_NAME = 'Create';

/**
 * Decode one ATA payload.
 *
 * Exported as a plain function so a test can call it without a registry.
 */
export function decodeSplAssociatedTokenAccountInstruction(data: Uint8Array): DecodeOutcome {
  if (data.length === 0) {
    // The legacy zero-length `Create` encoding. Complete, not truncated.
    return { kind: 'full', name: LEGACY_CREATE_NAME, fields: [] };
  }

  // `DataView` rather than an index read, so `noUncheckedIndexedAccess` has no
  // `undefined` to hand back and the length check above is the only guard needed.
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint8(0);

  const name = INSTRUCTION_NAMES.get(tag);
  if (name === undefined) {
    return { kind: 'no-match' };
  }

  const remaining = data.subarray(1);
  if (remaining.length > 0) {
    // Requirement 11.3: the name resolved, but this program's instructions take
    // no arguments, so any byte after the tag is a suffix this decoder cannot
    // account for. `full` would assert those bytes had been understood.
    return { kind: 'partial', name, fields: [], remaining };
  }

  return { kind: 'full', name, fields: [] };
}

/**
 * The registered decoder. `accounts` is unused here for the reason given in the
 * module header: account naming belongs to the IDL decoder.
 */
export const splAssociatedTokenAccountDecoder: InstructionDecoder = {
  source: 'builtin',
  programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  decode(data: Uint8Array, _accounts: readonly AccountRef[]): DecodeOutcome {
    return decodeSplAssociatedTokenAccountInstruction(data);
  },
};
