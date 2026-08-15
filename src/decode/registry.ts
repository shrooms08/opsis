/**
 * Instruction decoder registry — the precedence ladder and the raw fallback.
 *
 * Satisfies Requirements 3.5, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 7.12, 7.13, 11.1,
 * 11.2, 11.3, 11.5, 11.6, 11.7.
 *
 * This module is the **sole producer** of `InstructionDecode` (design.md,
 * `decode/registry.ts`). Confidence is not a step a caller performs: each
 * variant of `InstructionDecode` pins `confidence` as a literal type, so the
 * only way to build a value is to build one that already carries its marker
 * (Req 4.5, 11.2, 11.4). No other module in the codebase constructs one.
 *
 * **The ladder, in the one order Requirement 4 permits.**
 *
 * 1. The program's Anchor IDL, matched by 8-byte instruction discriminator
 *    (Req 4.1). An IDL wins over a built-in whenever both exist (Req 4.6),
 *    which is why the IDL map is consulted before the built-in map and not
 *    merged with it.
 * 2. A built-in decoder (Req 4.2) — System Program, SPL Token, SPL Associated
 *    Token Account (Req 4.4). Reached both when no IDL is loaded for the
 *    program *and* when one is loaded but declares no instruction with this
 *    discriminator (Req 4.7). That second case is ordinary, not exceptional: an
 *    IDL describes one program's instructions, and a payload it does not
 *    recognize is a payload some other decoder may.
 * 3. `Unknown`, with every byte preserved (Req 4.3, 11.1).
 *
 * The ladder is data, not control flow: `rungsFor` returns the decoders that
 * apply to a program in precedence order, and one loop walks them. Adding a
 * fourth source of decodes is a change to that function alone, and no caller
 * can reorder the rungs because no caller can see them.
 *
 * **`DecodeOutcome` routing**, which is the whole of how a decoder's report
 * becomes an analysis value:
 *
 * - `full` → the `full` variant, `confidence: 'full'`.
 * - `partial` → the `partial` variant, `confidence: 'partial'`, carrying the
 *   decoded fields *and* the unconsumed suffix as `undecodedData` (Req 11.3).
 * - `no-match` → the next rung down. Not a failure (Req 4.7).
 * - `error` → the `Unknown` fallback with `errorDetail: outcome.detail`
 *   (Req 11.7). Resolution **stops** here rather than continuing to the next
 *   rung: a decoder that recognized the instruction and then failed on its
 *   payload has said something about this instruction, and letting a lower rung
 *   answer over the top of it would discard the one diagnostic that explains
 *   what went wrong.
 *
 * **Account naming (Req 7.12, 7.13)** is a second, separate question about the
 * same bytes, and it is on this interface for the same reason decoding is: only
 * the registry knows which IDL governs a program. `nameAccounts` applies the
 * matched IDL instruction's positional names and returns the accounts untouched
 * when no IDL applies or none of its discriminators match — every `name` stays
 * `null` and every address stays exactly as it was (Req 7.13). It is deliberately
 * not folded into `decodeFor`: `InstructionDecode` has no channel for account
 * names, and widening it to carry them would put the same accounts in two places
 * in the output.
 *
 * **Two things about the payload encoding, both easy to get wrong and both
 * silent when wrong.**
 *
 * 1. `RawInstruction.data` from the RPC `json` encoding is **base58**, not
 *    base64 and not hex. This was confirmed against the recorded fixtures, not
 *    inferred: `tests/golden/07-unknown-program` carries
 *    `"3Bxs3zzi5fYNaKPd"`, which decodes under base58 to the 12 bytes of a
 *    System transfer payload (a 4-byte little-endian variant tag of 2 followed
 *    by a u64 lamport amount) and to noise under any other encoding. Reading it
 *    as base64 would still "work" — it would produce plausible-looking hex of
 *    the wrong bytes, and nothing downstream could tell.
 * 2. The 256 in Requirement 11.6 is a count of **bytes**, not of hex
 *    characters. A truncated payload therefore yields 512 hex characters. Off
 *    by that factor of two, the tool would withhold half the data it promised.
 *
 * Nothing here writes to a stream, throws, or exits. An unreadable payload is a
 * value — the `raw` variant with `errorDetail` set — because Requirement 3.5
 * wants the bytes preserved and the run continued, not a failure.
 */

import bs58 from 'bs58';

import type {
  AccountRef,
  Base58Address,
  DecodedField,
  DecoderSource,
  InstructionDecode,
  RawData,
} from '../model/analysis.js';
import type { RawInstruction } from '../model/rawResponse.js';
import {
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  splAssociatedTokenAccountDecoder,
} from './builtin/splAssociatedTokenAccount.js';
import { SPL_TOKEN_PROGRAM_ID, splTokenDecoder } from './builtin/splToken.js';
import { SYSTEM_PROGRAM_ID, systemProgramDecoder } from './builtin/systemProgram.js';
import { createIdlDecoders, type IdlDecoder } from './idl/idlDecoder.js';
import type { IdlStore } from './idl/idlStore.js';

// ---------------------------------------------------------------------------
// Decoder contract — design.md, `decode/registry.ts`
// ---------------------------------------------------------------------------

/**
 * One program's decoder. Implemented by the built-in decoders and by the
 * IDL-backed decoder.
 *
 * `decode` receives the payload already base58-decoded, so an implementation
 * never touches the wire encoding, and returns an outcome rather than throwing
 * — see `DecodeOutcome.error`.
 */
export interface InstructionDecoder {
  readonly source: DecoderSource;
  readonly programId: Base58Address;
  decode(data: Uint8Array, accounts: readonly AccountRef[]): DecodeOutcome;
}

/**
 * What a decoder concluded about one payload.
 *
 * Deliberately *not* `InstructionDecode`: a decoder reports what it read, and
 * the registry alone turns that into the confidence-bearing analysis value.
 * That split is what keeps `confidence` unforgeable — a decoder has no way to
 * claim `full` for a partial read.
 *
 * - `full` — the whole payload was consumed into `fields`.
 * - `partial` — `fields` were read and `remaining` is the unconsumed suffix,
 *   which the registry preserves as hex (Req 11.3).
 * - `no-match` — this decoder does not recognize the payload, so resolution
 *   continues down the ladder. Not an error: an IDL without the instruction's
 *   discriminator is the ordinary case behind Requirement 4.7.
 * - `error` — the decoder failed. `detail` becomes `errorDetail` on the `raw`
 *   variant (Req 11.7).
 */
export type DecodeOutcome =
  | { readonly kind: 'full'; readonly name: string; readonly fields: readonly DecodedField[] }
  | {
      readonly kind: 'partial';
      readonly name: string;
      readonly fields: readonly DecodedField[];
      readonly remaining: Uint8Array;
    }
  | { readonly kind: 'no-match' }
  | { readonly kind: 'error'; readonly detail: string };

/**
 * The registry's public surface.
 *
 * `decodeFor` is design.md's entry point and takes bytes. `decodeInstruction`
 * sits one step earlier, taking the verbatim `RawInstruction` and owning the
 * base58 decode. Both exist on purpose: base58 handling belongs in exactly one
 * place, and it belongs *here* rather than in the tree builder, because a
 * payload that will not decode is a decode outcome (`raw` with `errorDetail`,
 * Req 3.5) and not a malformed instruction. A caller holding an RPC response
 * should reach for `decodeInstruction`; a caller that already has bytes — a
 * test, or a future decoder composing over a slice — uses `decodeFor`.
 */
export interface DecoderRegistry {
  /**
   * Resolve and decode one payload. `programId` is `null` when the
   * instruction's program index could not be resolved to an address, which is
   * itself a lookup failure and reported as one.
   */
  decodeFor(
    programId: Base58Address | null,
    data: Uint8Array,
    accounts: readonly AccountRef[],
  ): InstructionDecode;

  /**
   * Decode one instruction straight from the RPC response, base58 payload and
   * all. Never throws: an undecodable payload yields the `raw` variant.
   */
  decodeInstruction(
    programId: Base58Address | null,
    instruction: RawInstruction,
    accounts: readonly AccountRef[],
  ): InstructionDecode;

  /**
   * Apply the program's IDL account names to one instruction's accounts
   * positionally (Req 7.12).
   *
   * Returns `accounts` unchanged — every `name` still `null`, every address
   * intact — when no IDL is loaded for the program, when the loaded IDL declares
   * no instruction with this discriminator, when the program ID is unresolved, or
   * when the payload is not decodable base58 (Req 7.13). All four are "no
   * applicable IDL entry", and none of them is an error.
   *
   * Takes the verbatim `RawInstruction` rather than bytes, unlike the decode
   * pair above, because the sole caller — `applyDecodes` in `pipeline.ts` — holds
   * one, and a bytes-taking twin would be surface with no caller. The base58
   * decode is the same one `decodeInstruction` performs, and a payload that will
   * not decode simply names nothing.
   */
  nameAccounts(
    programId: Base58Address | null,
    instruction: RawInstruction,
    accounts: readonly AccountRef[],
  ): readonly AccountRef[];
}

// ---------------------------------------------------------------------------
// Raw data presentation — Requirements 11.5, 11.6
// ---------------------------------------------------------------------------

/**
 * Payload bytes hex-encoded beyond this length are cut here (Req 11.6).
 *
 * **Bytes, not hex characters.** 256 bytes render as 512 characters.
 */
export const RAW_DATA_BYTE_LIMIT = 256;

/** Appended verbatim when the hex was cut short (Req 11.6). */
export const TRUNCATION_MARKER = '... (truncated)';

/** Label required on every raw payload (Req 11.5). */
const RAW_DATA_LABEL = 'raw_instruction_data';

/**
 * Present payload bytes as a `RawData` (Req 11.5, 11.6).
 *
 * `byteLength` is always the **true** length, including the bytes withheld by
 * truncation. That is the point of recording it separately from the hex: the
 * reader can see how much was not shown, so a truncated payload reads as
 * "1024 bytes, here are the first 256" rather than as a 256-byte payload. A
 * `byteLength` derived from the emitted hex would quietly misreport the
 * transaction.
 *
 * Used for the whole payload on a `raw` decode and for the unconsumed suffix on
 * a `partial` one; the rules are identical in both cases, which is why there is
 * one function rather than two.
 */
export function toRawData(bytes: Uint8Array): RawData {
  const byteLength = bytes.length;
  const truncated = byteLength > RAW_DATA_BYTE_LIMIT;
  const shown = truncated ? bytes.subarray(0, RAW_DATA_BYTE_LIMIT) : bytes;
  const hex = `0x${toLowercaseHex(shown)}${truncated ? TRUNCATION_MARKER : ''}`;

  return { label: RAW_DATA_LABEL, hex, byteLength, truncated };
}

/**
 * Lowercase hex, no separators, no prefix (Req 11.5).
 *
 * Hand-rolled rather than `Buffer.from(bytes).toString('hex')` only to keep the
 * lowercasing a property of this code instead of of a Node implementation
 * detail, and to accept any `Uint8Array` view without a copy.
 */
function toLowercaseHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// The `Unknown` fallback — Requirements 3.5, 4.3, 11.1, 11.7
// ---------------------------------------------------------------------------

/**
 * Requirement 11.1 requires this text in the note; Requirement 4.3 requires the
 * name `Unknown`. The note explains, the name classifies.
 */
const UNKNOWN_PROGRAM_NOTE =
  'Unknown program: no built-in decoder or Anchor IDL resolved this instruction, so the raw data is preserved unmodified';

/**
 * Build the `raw` variant: name `Unknown`, every byte preserved, confidence
 * pinned to `raw`.
 *
 * `errorDetail` carries why resolution ended here (Req 11.7). It is typed
 * nullable because design.md distinguishes "no decoder applies" from "a lookup
 * failed with an error", and the precedence ladder may want that distinction
 * later. Today every path into this function knows a specific reason, so every
 * value produced here carries one — a reason is strictly more useful to a
 * reader than a `null`, and the note already covers the general case.
 */
function unknownDecode(bytes: Uint8Array, errorDetail: string): InstructionDecode {
  return {
    kind: 'raw',
    name: 'Unknown',
    note: UNKNOWN_PROGRAM_NOTE,
    rawInstructionData: toRawData(bytes),
    errorDetail,
    confidence: 'raw',
  };
}

/** Shared by every `raw` result whose payload never decoded. */
const NO_BYTES = new Uint8Array(0);

// ---------------------------------------------------------------------------
// The upper two rungs — Requirements 4.1, 4.2, 4.4, 4.6, 4.7, 11.2, 11.3
// ---------------------------------------------------------------------------

/**
 * The built-in decoders, keyed by the program each one is about (Req 4.2, 4.4).
 *
 * Module-level and shared: the three decoders are stateless singletons, so
 * rebuilding this map per registry would allocate for no gain. The program IDs
 * come from the decoders' own modules rather than being re-spelled here, so a
 * decoder and its registration cannot disagree about which address they cover —
 * the same discipline `resolve/errorResolver.ts` applies to its error tables.
 */
const BUILTIN_DECODERS: ReadonlyMap<Base58Address, InstructionDecoder> = new Map([
  [SYSTEM_PROGRAM_ID, systemProgramDecoder],
  [SPL_TOKEN_PROGRAM_ID, splTokenDecoder],
  [SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID, splAssociatedTokenAccountDecoder],
]);

/** Shared by every registry built without an IDL store. */
const EMPTY_IDL_DECODERS: ReadonlyMap<Base58Address, IdlDecoder> = new Map();

/**
 * Turn a decoder's `full` outcome into the `full` variant.
 *
 * `source` is taken from the decoder rather than passed in, so a built-in cannot
 * be reported as `anchor-idl` or the reverse.
 */
function fullDecode(decoder: InstructionDecoder, name: string, fields: readonly DecodedField[]): InstructionDecode {
  return { kind: 'full', name, source: decoder.source, fields, confidence: 'full' };
}

/**
 * Turn a decoder's `partial` outcome into the `partial` variant (Req 11.3).
 *
 * `remaining` is occasionally empty — a decoder that read every argument but
 * could not represent one of them reports `partial` with nothing left over — and
 * `toRawData` handles that honestly: `byteLength: 0`, `hex: "0x"`. The field is
 * still emitted, because its absence would be indistinguishable from a `full`
 * decode.
 */
function partialDecode(
  decoder: InstructionDecoder,
  name: string,
  fields: readonly DecodedField[],
  remaining: Uint8Array,
): InstructionDecode {
  return {
    kind: 'partial',
    name,
    source: decoder.source,
    decodedFields: fields,
    undecodedData: toRawData(remaining),
    confidence: 'partial',
  };
}

/**
 * Why resolution reached the floor after every applicable rung declined.
 *
 * Four distinct sentences rather than one, because the four situations are
 * genuinely different things for a reader to act on: load an IDL, check the IDL
 * is the right version, accept that the program is unsupported, or look at why a
 * built-in did not recognize a payload it should have.
 */
function exhaustedDetail(
  programId: Base58Address,
  hasIdl: boolean,
  hasBuiltin: boolean,
): string {
  if (hasIdl && hasBuiltin) {
    return (
      `the Anchor IDL loaded for program ${programId} declares no instruction with ` +
      `this discriminator, and its built-in decoder did not recognize the payload either`
    );
  }
  if (hasIdl) {
    return (
      `the Anchor IDL loaded for program ${programId} declares no instruction with ` +
      `this discriminator, and no built-in decoder is registered for that program`
    );
  }
  if (hasBuiltin) {
    return `the built-in decoder for program ${programId} did not recognize this payload`;
  }
  return `no decoder or Anchor IDL is registered for program ${programId}`;
}

/**
 * Base58-decode an instruction payload.
 *
 * `decodeUnsafe` is used rather than `decode` because it reports failure by
 * returning `undefined` instead of throwing, which is the shape this module
 * wants: an unreadable payload is a value, not an exception. The `try` is
 * belt-and-braces against a future `base-x` that throws on some input class.
 */
function decodeBase58(data: string): Uint8Array | null {
  try {
    return bs58.decodeUnsafe(data) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Create a registry over the loaded Anchor IDLs.
 *
 * `idls` is nullable rather than required, widening design.md's
 * `createRegistry(idls: IdlStore)`, because `--idl-dir` is optional: with no
 * flag there is no store, and `null` says that in the type. An empty `IdlStore`
 * would be the alternative spelling and would require the caller to fabricate
 * one, which is a store that claims to have been loaded from somewhere.
 *
 * `createIdlDecoders` is called **once**, here. It precomputes every
 * instruction discriminator of every loaded IDL, so per-decode work is two map
 * lookups and no hashing. Building the decoders inside `decodeFor` would rehash
 * every IDL for every instruction of every transaction.
 *
 * The returned object holds only immutable state and is safe to share.
 */
export function createRegistry(idls: IdlStore | null): DecoderRegistry {
  const idlDecoders: ReadonlyMap<Base58Address, IdlDecoder> =
    idls === null ? EMPTY_IDL_DECODERS : createIdlDecoders(idls);

  /**
   * The decoders that apply to one program, in precedence order (Req 4.6).
   *
   * At most two entries, and the IDL is always first when present. Returning a
   * list rather than branching is what keeps "IDL beats built-in" a single fact
   * stated in one place instead of a condition repeated at each use.
   */
  function rungsFor(programId: Base58Address): readonly InstructionDecoder[] {
    const idl = idlDecoders.get(programId);
    const builtin = BUILTIN_DECODERS.get(programId);
    if (idl !== undefined && builtin !== undefined) return [idl, builtin];
    if (idl !== undefined) return [idl];
    if (builtin !== undefined) return [builtin];
    return [];
  }

  function decodeFor(
    programId: Base58Address | null,
    data: Uint8Array,
    accounts: readonly AccountRef[],
  ): InstructionDecode {
    if (programId === null) {
      // No address, so neither map can be consulted. Requirement 3.7 already
      // marked the node invalid; this is the same fact seen from the decode side.
      return unknownDecode(
        data,
        'the program ID could not be resolved from the account keys, so no decoder or IDL lookup was possible',
      );
    }

    const rungs = rungsFor(programId);

    for (const decoder of rungs) {
      const outcome = decoder.decode(data, accounts);

      switch (outcome.kind) {
        case 'full':
          return fullDecode(decoder, outcome.name, outcome.fields);
        case 'partial':
          return partialDecode(decoder, outcome.name, outcome.fields, outcome.remaining);
        case 'no-match':
          // Requirement 4.7: this decoder does not know the payload, so the next
          // rung gets it. The loop ending is the fallback.
          continue;
        case 'error':
          // The decoder recognized the instruction and failed on it. Its
          // explanation is more useful than a lower rung's guess, so resolution
          // ends here with that explanation attached (Req 11.7).
          return unknownDecode(data, outcome.detail);
      }
    }

    return unknownDecode(
      data,
      exhaustedDetail(
        programId,
        idlDecoders.has(programId),
        BUILTIN_DECODERS.has(programId),
      ),
    );
  }

  function decodeInstruction(
    programId: Base58Address | null,
    instruction: RawInstruction,
    accounts: readonly AccountRef[],
  ): InstructionDecode {
    const bytes = decodeBase58(instruction.data);
    if (bytes === null) {
      // Requirement 3.5: the payload is unreadable, so there are no bytes to
      // preserve and `byteLength` is honestly 0 — the true length is unknowable
      // when the encoding itself did not parse. The instruction is still real;
      // only its data was unreadable, which is why this is a decode outcome and
      // not an invalid instruction.
      return unknownDecode(
        NO_BYTES,
        'instruction data is not valid base58, so the payload could not be recovered',
      );
    }

    return decodeFor(programId, bytes, accounts);
  }

  function nameAccounts(
    programId: Base58Address | null,
    instruction: RawInstruction,
    accounts: readonly AccountRef[],
  ): readonly AccountRef[] {
    if (programId === null) return accounts;

    const decoder = idlDecoders.get(programId);
    if (decoder === undefined) return accounts;

    const bytes = decodeBase58(instruction.data);
    if (bytes === null) return accounts;

    // `IdlDecoder.nameAccounts` is itself the Requirement 7.13 floor: it returns
    // the accounts unchanged when no discriminator matches, so a program with an
    // IDL for a *different* instruction names nothing here.
    return decoder.nameAccounts(bytes, accounts);
  }

  return { decodeFor, decodeInstruction, nameAccounts };
}
